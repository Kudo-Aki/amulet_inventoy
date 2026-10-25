/**
 * Migration.gs - アカウント移行の自動化ヘルパー
 *
 * 個人アカウント → Google Workspace アカウントへ移すときの手作業を減らすための関数群。
 * 手順の全体は docs/workspace_migration_guide.md を参照。
 *
 * ── 使い方 ─────────────────────────────────────────────
 *
 * 【旧アカウント】のプロジェクトにこのファイルを追加して、上から順に実行:
 *   migration_1_snapshot()   現状を「移行メモ」シートに記録（読み取りのみ・何度でも安全）
 *   migration_2_freeze()     未処理を捌く → 旧フォームの受付停止 → 旧トリガー全削除
 *   migration_3_share()      新アカウントへ共有し、退避コピーを作る
 *
 * 【うまくいかないとき】
 *   migration_diagnoseForms()      どの Forms API が失敗するのか調べる（何も変更しない）
 *   migration_closeOldForms()      旧フォームの受付停止だけをやり直す
 *   migration_2_freeze_skipForms() フォームを閉じられないまま先へ進む（URL未配布のときだけ）
 *
 * 【新アカウント】のプロジェクトに gas/ の全ファイル（これを含む）を貼ってから:
 *   migration_4_adopt()      旧ブックを自分のドライブへコピー → プロパティ設定 → 設定シートのID類を空に
 *   （ここで setupFormIntegration() を実行し、ウェブアプリをデプロイする）
 *   migration_5_verify()     箱番号・フォーム・トリガー・設定を移行メモと突き合わせて合否判定
 *
 * ── 自動化しないこと（人がやるべきもの）─────────────────
 *   - OAuth の承認（何を許可するかは人が見て決める）
 *   - デプロイと「アクセスできるユーザー: 全員」の設定（公開範囲の判断）
 *   - 4つのフォームからの実送信テスト（匿名で本当に通るかは人しか確かめられない）
 *   - 各端末の API URL 貼り替え（localStorage は端末ごと）
 *   - 旧アカウントの課金解約
 */

// ========================================
// 実行前に記入する項目
// ========================================

/** migration_3_share() で共有する先。新しい Workspace アカウントのメールアドレス */
var MIGRATION_NEW_ACCOUNT_EMAIL = '';

/** migration_4_adopt() でコピー元にする、旧アカウントのスプレッドシートID */
var MIGRATION_OLD_SPREADSHEET_ID = '';

var MIGRATION_MEMO_SHEET_ = '移行メモ';
var MIGRATION_MEMO_HEADERS_ = ['項目', '値'];

// 設定シートのうち、移行時に空にすべき「自動設定」のキー。
// 空にしないと setupFormIntegration が旧アカウントのIDを掴んだままになり、
// 旧フォームの選択肢を上書きするか、作り直して旧フォームを孤児化させる。
var MIGRATION_CLEAR_KEYS_ = [
  'driveFolderId', 'labelTemplateId',
  'inFormId', 'inFormUrl', 'inFormEditUrl',
  'outFormId', 'outFormUrl', 'outFormEditUrl',
  'invFormId', 'invFormUrl', 'invFormEditUrl',
  'productFormId', 'productFormUrl', 'productFormEditUrl',
  'adminEmail'
];

// ========================================
// 1. 現状の記録（読み取りのみ）
// ========================================

/**
 * いまの状態を「移行メモ」シートに書き出す。何度実行しても安全。
 *
 * このシートはスプレッドシートの中に作るので、新アカウントへコピーしたときに
 * 一緒についてくる。移行後に migration_5_verify() がこれと突き合わせる。
 */
function migration_1_snapshot() {
  var ss = getSpreadsheet();
  var rows = [];
  var push = function(k, v) { rows.push([k, v === undefined || v === null ? '' : v]); };

  push('記録日時', nowJa_());
  push('スプレッドシート名', ss.getName());
  push('スプレッドシートID', ss.getId());
  push('スプレッドシートURL', ss.getUrl());

  var products = {};
  try { products = getProductsData().data; } catch (e) { products = {}; }
  push('商品数', Object.keys(products).length);

  var hist = ss.getSheetByName(SHEET_NAMES.HISTORY);
  push('履歴の行数', hist ? Math.max(hist.getLastRow() - 1, 0) : 0);

  var staff = ss.getSheetByName(FI_SHEETS_.STAFF);
  push('入力者シートの行数', staff ? Math.max(staff.getLastRow() - 1, 0) : 0);
  try { push('有効な入力者', getStaffList_().length); } catch (e) { push('有効な入力者', '取得できず'); }

  // 箱台帳: 商品×年ごとの最大番号。移行後にここが一致しないと既発行ラベルと衝突する
  var ledgerSheet = ss.getSheetByName(FI_SHEETS_.LEDGER);
  var maxima = {};
  var ledgerRowCount = 0;
  if (ledgerSheet && ledgerSheet.getLastRow() >= 2) {
    var lv = ledgerSheet.getRange(2, 1, ledgerSheet.getLastRow() - 1, FI_LEDGER_HEADERS_.length).getValues();
    lv.forEach(function(r) {
      if (!String(r[0] || '').trim()) return;
      ledgerRowCount++;
      var key = String(r[1]).toUpperCase() + '-' + String(r[2]);
      var n = Number(r[3]) || 0;
      if (!maxima[key] || n > maxima[key]) maxima[key] = n;
    });
  }
  push('箱台帳の行数', ledgerRowCount);
  Object.keys(maxima).sort().forEach(function(k) { push('箱番号最大: ' + k, maxima[k]); });

  // 回答シートの行数（移行後、_旧 に退避されたものと突き合わせる材料）
  FI_KIND_ORDER_.forEach(function(kind) {
    var spec = getFormSpec_(kind);
    var sh = ss.getSheetByName(responseSheetName_(spec));
    push('回答シート行数: ' + spec.label, sh ? Math.max(sh.getLastRow() - 1, 0) : 0);
  });

  // バックアップ
  var bkLedger = ss.getSheetByName(FI_BACKUP_SHEETS_.LEDGER);
  push('バックアップ世代数', bkLedger ? Math.max(bkLedger.getLastRow() - 1, 0) : 0);

  // フォームの状態
  FI_KIND_ORDER_.forEach(function(kind) {
    var spec = getFormSpec_(kind);
    var id = getConfigValue_(spec.formIdKey, '');
    push('旧フォームID: ' + spec.label, id);
    var form = openFormIfExists_(id);
    if (!form) {
      push('旧フォーム状態: ' + spec.label, '開けません（IDが無効か権限なし）');
      return;
    }
    var accepting = '不明';
    try { accepting = form.isAcceptingResponses() ? '受付中' : '受付停止'; } catch (e) { accepting = '不明'; }
    push('旧フォーム状態: ' + spec.label, accepting);
  });

  // トリガー
  var handlers = [];
  try {
    ScriptApp.getProjectTriggers().forEach(function(t) { handlers.push(t.getHandlerFunction()); });
  } catch (e) {
    handlers = ['取得できず'];
  }
  push('トリガー', handlers.sort().join(' / ') || 'なし');

  // 人が記入した設定（署名など）。自動設定キーは移行時に空にするので記録しない
  var cfg = getConfigMap_();
  Object.keys(cfg).sort().forEach(function(k) {
    if (MIGRATION_CLEAR_KEYS_.indexOf(k) >= 0) return;
    push('設定: ' + k, cfg[k]);
  });

  var sheet = ensureSheetWithHeaders_(ss, MIGRATION_MEMO_SHEET_, MIGRATION_MEMO_HEADERS_, '#1a237e');
  var last = sheet.getLastRow();
  if (last >= 2) sheet.getRange(2, 1, last - 1, MIGRATION_MEMO_HEADERS_.length).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, 2).setValues(rows);

  var log = ['=== 移行メモを記録しました（シート「' + MIGRATION_MEMO_SHEET_ + '」）==='];
  rows.forEach(function(r) { log.push('  ' + r[0] + ': ' + r[1]); });
  Logger.log(log.join('\n'));
  return log.join('\n');
}

/** 「移行メモ」シートを {項目: 値} で読む */
function migration_readMemo_(ss) {
  var sheet = (ss || getSpreadsheet()).getSheetByName(MIGRATION_MEMO_SHEET_);
  if (!sheet || sheet.getLastRow() < 2) return null;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  var map = {};
  values.forEach(function(r) {
    var k = String(r[0] || '').trim();
    if (k) map[k] = r[1];
  });
  return map;
}

// ========================================
// 2. 旧環境を止める
// ========================================

/**
 * 未処理の回答を捌いてから、旧フォームの受付を止め、旧トリガーを全削除する。
 *
 * ★トリガーは「スクリプト×作成したユーザー」単位で、他のアカウントからは
 *   見ることも削除することもできない。だからこの関数は**旧アカウント本人**が
 *   実行する必要がある。移行後に気づいても手遅れになる。
 *
 * ★旧トリガーを残したまま新環境を動かすと在庫が二重計上される。
 *   LockService はスクリプトプロジェクト単位なので、別プロジェクト間では
 *   冪等ガード（処理結果が空か確認してから書く）が効かない。
 *
 * やり直しは効く: フォームは画面から受付を再開でき、トリガーは
 * setupFormIntegration() で作り直せる。
 */
function migration_2_freeze() {
  return migration_freeze_(true);
}

/**
 * migration_2_freeze() と同じだが、旧フォームを閉じられなくても先へ進む。
 *
 * ★フォームのURLを誰にも配っていない場合だけ使うこと。
 *   URLを知っている人がいる状態でこれを使うと、「回答はできるが誰も処理しない」
 *   状態になる。その回答は在庫に反映されず、エラー通知も出ない。
 */
function migration_2_freeze_skipForms() {
  return migration_freeze_(false);
}

/**
 * @param {boolean} requireFormsClosed 旧フォームを1本でも閉じられなければ中断するか
 */
function migration_freeze_(requireFormsClosed) {
  var ss = getSpreadsheet();
  if (!migration_readMemo_(ss)) {
    throw new Error('先に migration_1_snapshot() を実行してください。' +
      '移行メモが無いと、移行後に箱番号などを突き合わせられなくなります。');
  }

  var log = ['=== 旧環境を止めます ==='];

  // --- 未処理の回答を捌く ---
  var pending = processPendingResponses();
  log.push('未処理の回答を処理: ' + JSON.stringify(pending.processed));

  var stillPending = migration_countPending_(ss);
  if (stillPending > 0) {
    throw new Error('未処理の回答が ' + stillPending + ' 行残っています。' +
      '回答シートの「エラー」列を確認して解消してから、もう一度実行してください。' +
      '（未処理のまま移行すると、その回答は永久に処理されません）');
  }
  log.push('未処理の回答: 0 行');

  // --- フォームの受付を止める ---
  // ★トリガー削除より先にやる。順序を逆にすると、フォームを閉じられなかったときに
  //   「回答はできるが誰も処理しない」という最悪の中間状態を作ってしまう。
  var forms = migration_closeOldForms();
  log.push('');
  log.push(forms.log);

  if (forms.failed.length && requireFormsClosed) {
    throw new Error(
      '旧フォームの受付を止められませんでした: ' + forms.failed.join(' / ') + '\n' +
      '\n' +
      '★トリガーはまだ削除していません（意図した動作です）。\n' +
      '  フォームが受付中のままトリガーだけ消すと、回答できるのに誰も処理しない\n' +
      '  状態になります。その回答は在庫に反映されず、エラー通知も出ません。\n' +
      '\n' +
      '対処1: 各フォームを開く → 上の「回答」タブ → 「回答を受け付けています」をオフ\n' +
      '       （または右上の「公開」を解除）→ migration_2_freeze() をもう一度実行\n' +
      '対処2: どの API が失敗しているか調べる → migration_diagnoseForms()\n' +
      '対処3: フォームのURLを誰にも配っておらず回答される心配が無いなら、\n' +
      '       migration_2_freeze_skipForms() を実行（この関門を飛ばします）');
  }
  if (forms.failed.length) {
    log.push('');
    log.push('★フォームを閉じられないまま先へ進みました（migration_2_freeze_skipForms）。');
    log.push('  URLを知っている人がいる場合は、画面から必ず受付を止めてください。');
  }

  // --- トリガーを全削除 ---
  var triggers = ScriptApp.getProjectTriggers();
  var names = triggers.map(function(t) { return t.getHandlerFunction(); });
  triggers.forEach(function(t) { ScriptApp.deleteTrigger(t); });
  log.push('トリガーを削除: ' + (names.length ? names.join(' / ') : 'なし'));

  var remain = ScriptApp.getProjectTriggers().length;
  log.push('残っているトリガー: ' + remain + ' 本' + (remain === 0 ? '' : ' ★0本になるまで繰り返してください'));

  log.push('');
  if (remain === 0 && !forms.failed.length) {
    log.push('次: migration_3_share() を実行してください');
  } else {
    log.push('★未解決の項目があります。上を確認してから migration_3_share() に進んでください。');
  }
  Logger.log(log.join('\n'));
  return log.join('\n');
}

/** 全ての回答シートで「処理結果」が空の行を数える */
function migration_countPending_(ss) {
  var count = 0;
  FI_KIND_ORDER_.forEach(function(kind) {
    var sheet = getResponseSheet_(kind);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    var statusCol = headers.indexOf('処理結果');
    if (statusCol < 0) return;
    var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    values.forEach(function(r) {
      var hasTimestamp = r[0] !== '' && r[0] !== null;
      if (hasTimestamp && !String(r[statusCol] || '')) count++;
    });
  });
  return count;
}

// ----------------------------------------
// 2-a. 旧フォームの受付停止（単独で再実行できる）
// ----------------------------------------

var MIGRATION_CLOSED_MESSAGE_ =
  'このフォームは移行のため受付を終了しました。新しいフォームのURLは担当者にお問い合わせください。';

/**
 * 旧フォーム4本の受付を止める。これだけを単独で何度でも実行できる。
 *
 * フォームの閉じ方は2通りある。Google 側の仕様変更でどちらかが通らないことがあるため、
 * 両方を独立に試し、**最後に読み戻して本当に閉じたか確認する**。
 *   (1) setPublished(false)          … 新しい公開モデル。未公開のフォームは回答できない
 *   (2) setAcceptingResponses(false) … 従来のモデル
 *
 * 「成功」とログに出ても閉じていないことがあるので、判定は読み戻した状態だけで行う。
 *
 * @return {{closed: Array, failed: Array, skipped: Array, log: string}}
 */
function migration_closeOldForms() {
  var log = ['=== 旧フォームの受付を止めます ==='];
  var closed = [];
  var failed = [];
  var skipped = [];

  FI_KIND_ORDER_.forEach(function(kind) {
    var spec = getFormSpec_(kind);
    var id = String(getConfigValue_(spec.formIdKey, '') || '').trim();
    if (!id) {
      log.push(spec.label + 'フォーム: 設定シートにIDがありません → 対象外');
      skipped.push(spec.label);
      return;
    }
    var form = openFormIfExists_(id);
    if (!form) {
      log.push(spec.label + 'フォーム: 開けませんでした（ID: ' + id + '）');
      failed.push(spec.label + '=フォームを開けない');
      return;
    }

    log.push(spec.label + 'フォーム（' + id + '）');
    log.push('  いまの状態: ' + migration_formState_(form));

    var reasons = [];
    [['setPublished', false], ['setAcceptingResponses', false]].forEach(function(pair) {
      var r = migration_tryFormCall_(form, pair[0], pair[1]);
      log.push('  ' + pair[0] + '(false): ' + migration_callResultText_(r));
      if (r.available && !r.ok) reasons.push(pair[0] + ' → ' + r.error);
    });

    // 閉鎖メッセージは本質ではないので独立した試行にする。失敗しても停止の成否には含めない
    var rm = migration_tryFormCall_(form, 'setCustomClosedFormMessage', MIGRATION_CLOSED_MESSAGE_);
    log.push('  閉鎖メッセージ: ' + migration_callResultText_(rm) +
      (rm.available && !rm.ok ? '（受付停止の成否には影響しません）' : ''));

    // ★ここだけが判定の根拠。ログの「成功」は証拠にしない
    var state = migration_isFormClosed_(form);
    log.push('  停止後の状態: ' + migration_formState_(form));
    if (state === true) {
      log.push('  → 受付を停止しました');
      closed.push(spec.label);
    } else if (state === false) {
      log.push('  → ★まだ回答を受け付けます');
      failed.push(spec.label + '=まだ受付中' + (reasons.length ? '（' + reasons.join(' / ') + '）' : ''));
    } else {
      log.push('  → ★状態を読み取れないため、停止できたか確認できません');
      failed.push(spec.label + '=確認できない' + (reasons.length ? '（' + reasons.join(' / ') + '）' : ''));
    }
  });

  log.push('');
  log.push('停止できた: ' + (closed.length ? closed.join(' / ') : 'なし'));
  if (skipped.length) log.push('対象外（IDなし）: ' + skipped.join(' / '));
  if (failed.length) {
    log.push('★停止できなかった: ' + failed.join(' / '));
    log.push('  手動で閉じる: フォームを開く → 上の「回答」タブ → 「回答を受け付けています」をオフ');
    log.push('  （または右上の「公開」を解除）→ migration_closeOldForms() で確認');
    log.push('  原因を調べる: migration_diagnoseForms()');
  }

  Logger.log(log.join('\n'));
  return { closed: closed, failed: failed, skipped: skipped, log: log.join('\n') };
}

/**
 * どの Forms API が使えて、どれが失敗するのかを1本ずつ試して報告する。
 *
 * ★状態は変えない。setter も「いま読み取れた値と同じ値」を書くだけなので、
 *   成功しても受付状態は変わらない（いまの値が読めないときは試さない）。
 *
 * 受付停止が失敗したときに1回実行して、ログをそのまま共有すれば原因が切り分けられる。
 */
function migration_diagnoseForms() {
  var log = ['=== Forms API の診断（状態は変更しません）==='];

  FI_KIND_ORDER_.forEach(function(kind) {
    var spec = getFormSpec_(kind);
    var id = String(getConfigValue_(spec.formIdKey, '') || '').trim();
    log.push('');
    log.push('【' + spec.label + 'フォーム】');
    if (!id) { log.push('  設定シートにIDがありません'); return; }
    log.push('  ID: ' + id);

    var form = openFormIfExists_(id);
    if (!form) { log.push('  ★開けません（IDが無効か、このアカウントに権限がない）'); return; }

    try { log.push('  タイトル: ' + form.getTitle()); } catch (e) { log.push('  タイトル: 読めません → ' + e); }

    // getter を試す。読めた値は setter の no-op 書き込みに使う
    var reads = {};
    [['isPublished', '公開状態'], ['isAcceptingResponses', '受付状態'],
     ['getCustomClosedFormMessage', '閉鎖メッセージ']].forEach(function(pair) {
      var name = pair[0];
      if (typeof form[name] !== 'function') { log.push('  ' + name + '(): このバージョンには無い'); return; }
      try {
        var v = form[name]();
        reads[name] = v;
        log.push('  ' + name + '() = ' + JSON.stringify(v) + '（' + pair[1] + '）');
      } catch (e) {
        log.push('  ' + name + '(): ★読めません → ' + e);
      }
    });

    // setter を「いまと同じ値」で試す（状態は変わらない）
    [['setPublished', 'isPublished'],
     ['setAcceptingResponses', 'isAcceptingResponses'],
     ['setCustomClosedFormMessage', 'getCustomClosedFormMessage']].forEach(function(pair) {
      var setter = pair[0];
      if (typeof form[setter] !== 'function') { log.push('  ' + setter + '(): このバージョンには無い'); return; }
      if (!(pair[1] in reads)) {
        log.push('  ' + setter + '(): いまの値が読めないので試しません（状態を変えないため）');
        return;
      }
      var r = migration_tryFormCall_(form, setter, reads[pair[1]]);
      log.push('  ' + setter + '(いまと同じ値): ' + migration_callResultText_(r));
    });
  });

  log.push('');
  log.push('※ 受付を実際に止めるには migration_closeOldForms() を実行してください。');
  Logger.log(log.join('\n'));
  return log.join('\n');
}

/**
 * form[name](arg) を試す。例外は投げず結果を返す。
 * @return {{ok: boolean, available: boolean, error: *}}
 */
function migration_tryFormCall_(form, name, arg) {
  if (typeof form[name] !== 'function') return { ok: false, available: false, error: null };
  try {
    form[name](arg);
    return { ok: true, available: true, error: null };
  } catch (e) {
    return { ok: false, available: true, error: e };
  }
}

/** migration_tryFormCall_ の結果を人が読める1行にする */
function migration_callResultText_(r) {
  if (!r.available) return 'このバージョンには無い';
  return r.ok ? '成功' : '★失敗 → ' + r.error;
}

/** フォームの受付状態を人が読める文字列にする */
function migration_formState_(form) {
  var parts = [];
  if (typeof form.isPublished === 'function') {
    try { parts.push(form.isPublished() ? '公開' : '未公開'); } catch (e) { parts.push('公開状態は不明'); }
  }
  if (typeof form.isAcceptingResponses === 'function') {
    try { parts.push(form.isAcceptingResponses() ? '受付中' : '受付停止'); } catch (e) { parts.push('受付状態は不明'); }
  }
  return parts.length ? parts.join(' / ') : '不明';
}

/**
 * 読み戻して「本当に回答を受け付けないか」を判定する。
 * 未公開か、受付停止のどちらかが確認できれば閉じている。
 * @return {boolean|null} true=閉じている / false=まだ受け付ける / null=判定できない
 */
function migration_isFormClosed_(form) {
  var known = false;
  if (typeof form.isPublished === 'function') {
    try {
      if (!form.isPublished()) return true;   // 未公開のフォームは回答を受け付けない
      known = true;
    } catch (e) {}
  }
  if (typeof form.isAcceptingResponses === 'function') {
    try {
      if (!form.isAcceptingResponses()) return true;
      known = true;
    } catch (e) {}
  }
  return known ? false : null;
}

// ========================================
// 3. 新アカウントへ渡す
// ========================================

/**
 * スプレッドシートとラベルPDFフォルダを新アカウントへ共有し、退避コピーを作る。
 * 実行前に MIGRATION_NEW_ACCOUNT_EMAIL を記入すること。
 */
function migration_3_share() {
  var email = String(MIGRATION_NEW_ACCOUNT_EMAIL || '').trim();
  if (!email || email.indexOf('@') < 0) {
    throw new Error('このファイルの先頭にある MIGRATION_NEW_ACCOUNT_EMAIL に、' +
      '新しい Workspace アカウントのメールアドレスを記入してから実行してください。');
  }

  var ss = getSpreadsheet();
  var log = ['=== 新アカウントへ渡します: ' + email + ' ==='];

  // --- スプレッドシートを共有 ---
  var file = DriveApp.getFileById(ss.getId());
  file.addEditor(email);
  log.push('スプレッドシートを編集者として共有しました');
  log.push('  ' + ss.getName());
  log.push('  ID: ' + ss.getId());
  log.push('  URL: ' + ss.getUrl());

  // --- ラベルPDFフォルダを共有（無くても移行はできる。新環境で作り直されるため）---
  try {
    var folderId = getConfigValue_('driveFolderId', '');
    if (folderId) {
      DriveApp.getFolderById(folderId).addEditor(email);
      log.push('ラベルPDFフォルダも共有しました（過去のPDFを見たい場合のため）');
    }
  } catch (e) {
    log.push('ラベルPDFフォルダの共有はできませんでした: ' + e + '（新環境で作り直されるので支障ありません）');
  }

  // --- 退避コピー（旧アカウント側に残す保険）---
  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm');
  var backup = file.makeCopy(ss.getName() + '_移行前退避_' + stamp);
  log.push('退避コピーを作りました: ' + backup.getName());
  log.push('  URL: ' + backup.getUrl());

  log.push('');
  log.push('★ 次の値を控えてください（新アカウント側で使います）');
  log.push('   MIGRATION_OLD_SPREADSHEET_ID = \'' + ss.getId() + '\'');
  log.push('');
  log.push('次: 新しい Workspace アカウントで空のプロジェクトを作り、gas/ の全ファイルを貼ってから');
  log.push('    migration_4_adopt() を実行してください');
  Logger.log(log.join('\n'));
  return log.join('\n');
}

// ========================================
// 4. 新環境で引き取る
// ========================================

/**
 * 旧アカウントのスプレッドシートを自分のドライブへコピーし、
 * スクリプトプロパティを設定して、設定シートの「自動設定」キーを空にする。
 *
 * 実行前に MIGRATION_OLD_SPREADSHEET_ID を記入すること。
 * この関数は新しい（空の）プロジェクトで1回だけ実行する。
 */
function migration_4_adopt() {
  var oldId = String(MIGRATION_OLD_SPREADSHEET_ID || '').trim();
  if (!oldId) {
    throw new Error('このファイルの先頭にある MIGRATION_OLD_SPREADSHEET_ID に、' +
      '旧アカウントのスプレッドシートIDを記入してから実行してください' +
      '（migration_3_share() のログに出ています）。');
  }

  // 二重コピー防止。既に有効なブックを掴んでいたら止める
  var current = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_KEY);
  if (current) {
    var openable = null;
    try { openable = SpreadsheetApp.openById(current); } catch (e) { openable = null; }
    if (openable) {
      throw new Error('このプロジェクトは既にスプレッドシートを掴んでいます: ' +
        openable.getName() + '（ID: ' + current + '）\n' +
        'もう一度コピーすると重複したブックができます。やり直したい場合は' +
        '「プロジェクトの設定 → スクリプト プロパティ」で ' + SPREADSHEET_ID_KEY +
        ' を削除してから実行してください。');
    }
  }

  var log = ['=== 旧ブックを引き取ります ==='];

  var src = DriveApp.getFileById(oldId);
  var copy = src.makeCopy('お守り在庫管理データ');
  var ss = SpreadsheetApp.openById(copy.getId());
  log.push('コピーしました: ' + ss.getName());
  log.push('  新しいID: ' + ss.getId());
  log.push('  URL: ' + ss.getUrl());

  PropertiesService.getScriptProperties().setProperty(SPREADSHEET_ID_KEY, ss.getId());
  log.push('スクリプトプロパティ ' + SPREADSHEET_ID_KEY + ' を設定しました');

  FI_CONFIG_CACHE_ = null;

  // --- 設定シートの「自動設定」キーを空にする ---
  // ここを飛ばすと setupFormIntegration が旧アカウントのIDを掴んだままになる。
  // openFormIfExists_ は権限エラーと無効IDを区別しないため、
  // 旧フォームに権限が残っていれば選択肢を上書きし、無ければ作り直して孤児化させる。
  var cleared = migration_clearAutoConfig_(ss);
  log.push('設定シートの自動設定キーを空にしました: ' + cleared.join(', '));

  var memo = migration_readMemo_(ss);
  log.push('');
  if (memo) {
    log.push('移行メモを引き継ぎました（記録日時: ' + memo['記録日時'] + '）');
    log.push('  商品数: ' + memo['商品数'] + ' / 箱台帳の行数: ' + memo['箱台帳の行数']);
  } else {
    log.push('★ 移行メモが見つかりません。旧アカウントで migration_1_snapshot() を');
    log.push('   実行していない可能性があります。移行後の突き合わせができません。');
  }

  log.push('');
  log.push('次の順に進めてください:');
  log.push('  1. 設定シートの dailyBackupHour（毎日バックアップの時刻）を決める');
  log.push('     ※ ensureTriggers_ は既存トリガーの時刻を更新しないので setup は1回勝負です');
  log.push('  2. setupFormIntegration() を実行');
  log.push('  3. ウェブアプリをデプロイ（アクセスできるユーザー: 全員）');
  log.push('  4. migration_5_verify() を実行');
  Logger.log(log.join('\n'));
  return log.join('\n');
}

/** 設定シートの「自動設定」キーの値を空にする。空にしたキー名を返す */
function migration_clearAutoConfig_(ss) {
  var sheet = (ss || getSpreadsheet()).getSheetByName(FI_SHEETS_.CONFIG);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  var cleared = [];
  for (var i = 0; i < values.length; i++) {
    var key = String(values[i][0] || '').trim();
    if (MIGRATION_CLEAR_KEYS_.indexOf(key) < 0) continue;
    if (String(values[i][1] || '') === '') continue;
    sheet.getRange(i + 2, 2).setValue('');
    cleared.push(key);
  }
  FI_CONFIG_CACHE_ = null;
  return cleared;
}

// ========================================
// 5. 移行後の突き合わせ
// ========================================

/**
 * setupFormIntegration() とデプロイのあとに実行する。
 * 移行メモと今の状態を突き合わせ、合否をログに出す。
 *
 * ★箱番号の一致がいちばん重要。ここがずれていると、既に印刷して箱に貼った
 *   ラベルと新しく採番した番号が衝突する。
 */
function migration_5_verify() {
  var ss = getSpreadsheet();
  var memo = migration_readMemo_(ss);
  var log = ['=== 移行後の突き合わせ ==='];
  var ng = 0;
  var check = function(label, ok, detail) {
    log.push((ok ? '  OK   ' : '  ★NG ') + label + (detail ? ' — ' + detail : ''));
    if (!ok) ng++;
  };

  log.push('掴んでいるブック: ' + ss.getName());
  log.push('  ID: ' + ss.getId());
  log.push('  URL: ' + ss.getUrl());
  log.push('');

  if (!memo) {
    log.push('★ 移行メモが無いため、旧環境との突き合わせができません。');
    log.push('  旧アカウントで migration_1_snapshot() を実行してから移行し直すか、');
    log.push('  以下の新環境チェックだけで判断してください。');
  }

  // --- データの引き継ぎ ---
  log.push('【データ】');
  var products = getProductsData().data;
  var productCount = Object.keys(products).length;
  if (memo) check('商品数', String(productCount) === String(memo['商品数']),
    '移行前 ' + memo['商品数'] + ' → 現在 ' + productCount);
  else log.push('  --   商品数: ' + productCount);

  var ledgerSheet = ss.getSheetByName(FI_SHEETS_.LEDGER);
  var maxima = {};
  var ledgerRowCount = 0;
  if (ledgerSheet && ledgerSheet.getLastRow() >= 2) {
    var lv = ledgerSheet.getRange(2, 1, ledgerSheet.getLastRow() - 1, FI_LEDGER_HEADERS_.length).getValues();
    lv.forEach(function(r) {
      if (!String(r[0] || '').trim()) return;
      ledgerRowCount++;
      var key = String(r[1]).toUpperCase() + '-' + String(r[2]);
      var n = Number(r[3]) || 0;
      if (!maxima[key] || n > maxima[key]) maxima[key] = n;
    });
  }

  if (memo) {
    check('箱台帳の行数', String(ledgerRowCount) === String(memo['箱台帳の行数']),
      '移行前 ' + memo['箱台帳の行数'] + ' → 現在 ' + ledgerRowCount);

    // 移行メモに記録された箱番号の最大値と1件ずつ突き合わせる
    var memoKeys = Object.keys(memo).filter(function(k) { return k.indexOf('箱番号最大: ') === 0; });
    var mismatched = [];
    memoKeys.forEach(function(k) {
      var name = k.replace('箱番号最大: ', '');
      var before = Number(memo[k]) || 0;
      var now = Number(maxima[name]) || 0;
      if (before !== now) mismatched.push(name + '（移行前 ' + before + ' → 現在 ' + now + '）');
    });
    check('箱番号の最大値（' + memoKeys.length + '件）', mismatched.length === 0,
      mismatched.length ? mismatched.join(' / ') : 'すべて一致');
    if (mismatched.length) {
      log.push('       ★ このまま入荷フォームを使うと、既に印刷したラベルと番号が衝突します。');
      log.push('          箱台帳シートを旧環境からコピーし直してください。');
    }
  } else {
    log.push('  --   箱台帳の行数: ' + ledgerRowCount);
  }

  var hist = ss.getSheetByName(SHEET_NAMES.HISTORY);
  var histCount = hist ? Math.max(hist.getLastRow() - 1, 0) : 0;
  if (memo) check('履歴の行数', String(histCount) === String(memo['履歴の行数']),
    '移行前 ' + memo['履歴の行数'] + ' → 現在 ' + histCount);
  else log.push('  --   履歴の行数: ' + histCount);

  // --- 新環境のセットアップ ---
  log.push('');
  log.push('【新環境】');
  FI_KIND_ORDER_.forEach(function(kind) {
    var spec = getFormSpec_(kind);
    var id = getConfigValue_(spec.formIdKey, '');
    if (!id) { check(spec.label + 'フォーム', false, 'IDが設定されていません（setupFormIntegration 未実行？）'); return; }
    var form = openFormIfExists_(id);
    if (!form) { check(spec.label + 'フォーム', false, 'IDはあるが開けません: ' + id); return; }

    var problems = [];
    try { if (typeof form.isPublished === 'function' && !form.isPublished()) problems.push('未公開'); } catch (e) {}
    try { if (typeof form.isAcceptingResponses === 'function' && !form.isAcceptingResponses()) problems.push('受付停止'); } catch (e) {}
    check(spec.label + 'フォーム', problems.length === 0,
      problems.length ? problems.join(' / ') + ' ← このままでは回答を受け付けません' : form.getPublishedUrl());
  });

  var handlers = {};
  try {
    ScriptApp.getProjectTriggers().forEach(function(t) { handlers[t.getHandlerFunction()] = true; });
  } catch (e) {}
  ['onFormSubmit', 'syncFormChoices', 'processPendingResponses', 'dailyBackupJob'].forEach(function(h) {
    check('トリガー ' + h, !!handlers[h], handlers[h] ? '' : 'setupFormIntegration() を実行してください');
  });

  check('ラベルテンプレート', !!getConfigValue_('labelTemplateId', ''), '');
  check('ラベルPDFフォルダ', !!getConfigValue_('driveFolderId', ''), '');

  var admin = getConfigValue_('adminEmail', '');
  check('通知先（adminEmail）', !!admin && admin.indexOf('@') > 0, admin || '未設定');
  if (admin && admin.indexOf('@gmail.com') > 0) {
    log.push('       ※ 通知先が個人アドレスのままです。Workspace のアドレスにするなら');
    log.push('          設定シートの adminEmail を空にして setupFormIntegration() を再実行してください。');
  }

  // --- 旧フォーム（移行メモに記録されたIDで確認する）---
  // 設定シートのIDは移行時に空にしてあるので、旧フォームの手がかりは移行メモにしかない。
  // 旧フォームが受付中のまま残ると、回答できるのに誰も処理しない状態になる。
  if (memo) {
    log.push('');
    log.push('【旧フォーム】');
    var oldKeys = Object.keys(memo).filter(function(k) { return k.indexOf('旧フォームID: ') === 0; });
    var currentIds = {};
    FI_KIND_ORDER_.forEach(function(kind) {
      var cid = String(getConfigValue_(getFormSpec_(kind).formIdKey, '') || '').trim();
      if (cid) currentIds[cid] = true;
    });

    var openedCount = 0;
    var listedCount = 0;
    oldKeys.forEach(function(k) {
      var label = k.replace('旧フォームID: ', '');
      var oldId = String(memo[k] || '').trim();
      if (!oldId) return;
      listedCount++;
      if (currentIds[oldId]) { log.push('  --   ' + label + ': いま使っているフォームと同じIDです'); return; }
      var form = openFormIfExists_(oldId);
      if (!form) { log.push('  --   ' + label + ': 開けません（' + oldId + '）'); return; }
      openedCount++;
      var state = migration_isFormClosed_(form);
      check(label + 'フォーム（旧）', state !== false,
        state === true ? '受付停止' :
        state === false ? '★まだ受付中（' + migration_formState_(form) + '）— 回答されても誰も処理しません' :
        '状態を読み取れません');
    });

    if (!listedCount) {
      log.push('  --   移行メモに旧フォームIDがありません');
    } else if (!openedCount) {
      log.push('  （旧フォームは新アカウントからは開けないのが普通です。');
      log.push('    旧アカウントで migration_closeOldForms() を実行して確認してください）');
    }
  }

  // --- 人が確かめるしかないもの ---
  log.push('');
  log.push('【ここからは人が確認してください（コードからは判定できません）】');
  log.push('  □ 4つのフォームURLをシークレットウィンドウで開き、実際に送信できるか');
  log.push('     → 送信後、スプレッドシートの行を直接見て反映を確認すること');
  log.push('  □ ウェブアプリを「新しいデプロイ」で公開し、/exec URL を控えたか');
  log.push('  □ test_sampleLabelPdf() でラベルPDFが作れるか');
  log.push('  □ 全端末の API URL を新しい /exec に貼り替えたか');
  log.push('  □ 旧アカウントで migration_closeOldForms() を実行し、旧フォームが閉じているか');

  log.push('');
  log.push(ng === 0 ? '=== 自動で確認できる範囲はすべて OK ===' : '=== ★ ' + ng + ' 件が NG です。上を確認してください ===');
  Logger.log(log.join('\n'));
  return log.join('\n');
}
