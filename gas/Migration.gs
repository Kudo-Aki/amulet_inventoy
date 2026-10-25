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
 * 【うまくいかないとき】※ いずれも【旧アカウント】で実行する
 *   migration_diagnoseForms()      どの Forms API が読めないのか調べる（読み取りだけ）
 *   migration_diagnoseFormsDeep()  setter も試す（いまと同じ値だけ書き込む）
 *   migration_closeOldForms()      旧フォームの受付停止だけをやり直す
 *   migration_2_freeze_skipForms() フォームを閉じられないまま先へ進む（URL未配布のときだけ）
 *
 * 【新アカウント】のプロジェクトに gas/ の全ファイル（これを含む）を貼ってから:
 *   migration_checkCode()    ★最初にこれ。貼り忘れ・Drive v3・古いコードを検出（スプレッドシート不要）
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
// 0. コードが正しく入ったかの自己点検
// ========================================

// 各ファイルの代表関数。無ければそのファイルを貼り忘れている。
// typeof は未宣言の識別子に対しても例外にならないので、関数で包んで安全に調べる。
var MIGRATION_EXPECTED_FILES_ = [
  { file: 'Code.gs',            fn: 'doGet',                        has: function() { return typeof doGet === 'function'; } },
  { file: 'QRCode.gs',          fn: 'qrPngBytes_',                  has: function() { return typeof qrPngBytes_ === 'function'; } },
  { file: 'LabelTemplate.gs',   fn: 'getLabelTemplatePptxBlob_',    has: function() { return typeof getLabelTemplatePptxBlob_ === 'function'; } },
  { file: 'LabelPdf.gs',        fn: 'buildLabelPdf_',               has: function() { return typeof buildLabelPdf_ === 'function'; } },
  { file: 'FormIntegration.gs', fn: 'setupFormIntegration',         has: function() { return typeof setupFormIntegration === 'function'; } },
  { file: 'Migration.gs',       fn: 'migration_1_snapshot',         has: function() { return typeof migration_1_snapshot === 'function'; } },
  { file: 'Tests.gs',           fn: 'test_formSpecs',               has: function() { return typeof test_formSpecs === 'function'; } }
];

// 「古いコードが入っていないか」の目印。
// ★旧プロジェクトを複製すると、そのプロジェクトのコードがそのまま来る。
//   PR で関数が増えていない修正は、関数のソース文字列を見るしか手が無い
//   （String(関数) で本文が取れる）。何を探しているかはコメントに残す。
var MIGRATION_EXPECTED_FIXES_ = [
  {
    label: 'Migration.gs が新しいか',
    has: function() { return typeof migration_assertOldEnvironment_ === 'function'; },
    hint: 'gas/Migration.gs を貼り直してください（旧アカウント専用のガードがありません。' +
          '新アカウントで凍結系を実行すると、動いているフォームとトリガーを壊します）'
  },
  {
    label: 'FormIntegration.gs がフォームを公開するか',
    has: function() {
      return typeof createIntakeForm_ === 'function' &&
        String(createIntakeForm_).indexOf('setPublished') >= 0;
    },
    hint: 'gas/FormIntegration.gs を貼り直してください（作ったフォームが未公開のままになり、' +
          'URLを配っても回答を受け付けません）'
  },
  {
    label: 'Code.gs が initializeSpreadsheet を守るか',
    has: function() {
      return typeof initializeSpreadsheet === 'function' &&
        String(initializeSpreadsheet).indexOf('アプリが既存データを見られなくなります') >= 0;
    },
    hint: 'gas/Code.gs を貼り直してください（一度の誤実行で既存データへのリンクを' +
          '黙って失う経路が残っています）'
  }
];

/**
 * gas/ のコードが正しく入ったかを点検する。
 *
 * ★スプレッドシートを必要としない。だから新しいプロジェクトにコードを貼った直後、
 *   スクリプトプロパティを設定する前に実行できる（＝新環境で最初にできる確認）。
 *
 * 見るのは3点:
 *   (a) 7ファイルが全部あるか     … 手で貼ると1つ抜けることがある
 *   (b) Drive 詳細サービスが v2 か … v3 だとラベルPDFと起案書作成だけが後から壊れる
 *   (c) 最近の修正が入っているか   … 旧プロジェクトを複製すると古いコードが来る
 */
function migration_checkCode() {
  var r = migration_checkCode_();
  Logger.log(r.log);
  return r.log;
}

/** @return {{ok: boolean, ng: Array, log: string}} */
function migration_checkCode_() {
  var log = ['=== コードの自己点検 ==='];
  var ng = [];
  var check = function(label, ok, detail) {
    log.push((ok ? '  OK   ' : '  ★NG ') + label + (detail ? ' — ' + detail : ''));
    if (!ok) ng.push(label);
  };

  // --- (a) ファイルが揃っているか ---
  log.push('【ファイル】');
  var missing = [];
  MIGRATION_EXPECTED_FILES_.forEach(function(e) {
    var ok = false;
    try { ok = !!e.has(); } catch (err) { ok = false; }
    check(e.file, ok, ok ? '' : e.fn + '() がありません');
    if (!ok) missing.push(e.file);
  });
  if (missing.length) {
    log.push('       → リポジトリの gas/ から ' + missing.join(' / ') + ' を貼ってください');
  }

  // --- (b) Drive 詳細サービス（v2 か v3 か）---
  log.push('');
  log.push('【Drive 詳細サービス】');
  var drive = migration_checkDriveVersion_();
  check('Drive API', drive.ok, drive.detail);
  if (!drive.ok) {
    log.push('       → 歯車「プロジェクトの設定」→「appsscript.json マニフェスト ファイルを');
    log.push('          エディタで表示する」にチェック → gas/appsscript.json の内容を貼り直す');
    log.push('          （エディタの「サービス」から手で Drive を足すと v3 が既定で選ばれます）');
  }

  // --- (c) 古いコードが入っていないか ---
  log.push('');
  log.push('【コードの新しさ】');
  MIGRATION_EXPECTED_FIXES_.forEach(function(e) {
    var ok = false;
    try { ok = !!e.has(); } catch (err) { ok = false; }
    check(e.label, ok, ok ? '' : '古い版です');
    if (!ok) log.push('       → ' + e.hint);
  });

  log.push('');
  log.push(ng.length === 0
    ? '=== コードは正しく入っています ==='
    : '=== ★ ' + ng.length + ' 件が NG です: ' + ng.join(' / ') + ' ===');

  return { ok: ng.length === 0, ng: ng, log: log.join('\n') };
}

/**
 * Drive 詳細サービスが v2 か v3 かを見る。
 * コードは v2 の Drive.Files.insert を呼ぶ（gas/LabelPdf.gs, gas/Code.gs）。
 * v3 では insert が無く create になるため、ラベルPDFと起案書作成だけが失敗する。
 */
function migration_checkDriveVersion_() {
  if (typeof Drive === 'undefined' || !Drive) {
    return { ok: false, detail: '詳細なサービスに Drive がありません' };
  }
  var files = null;
  try { files = Drive.Files; } catch (e) { files = null; }
  if (!files) return { ok: false, detail: 'Drive.Files が見つかりません' };
  if (typeof files.insert === 'function') return { ok: true, detail: 'v2（Files.insert があります）' };
  if (typeof files.create === 'function') {
    return { ok: false, detail: '★v3 が選ばれています（Files.create しかありません）。' +
      'コードは v2 の Files.insert を呼ぶため、ラベルPDFと起案書作成が失敗します' };
  }
  return { ok: false, detail: 'Files.insert も Files.create も見つかりません' };
}

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
    // migration_closeOldForms() と同じ読み方にする。片方だけ見ていると
    // 「メモは受付中、停止処理は成功」のように同じフォームで食い違う
    push('旧フォーム状態: ' + spec.label, migration_formState_(form));
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
 * ★次のどちらかを満たす場合だけ使うこと。
 *   ・フォームのURLを誰にも配っていない（回答される心配が無い）
 *   ・シークレットウィンドウでフォームを開き、回答できないことを自分で確認した
 *
 *   どちらでもない状態で使うと「回答はできるが誰も処理しない」状態になる。
 *   その回答は在庫に反映されず、エラー通知も出ない。
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
  // ★新アカウントで実行すると、動いているトリガーとフォームを壊してしまう
  migration_assertOldEnvironment_('migration_2_freeze()');

  var log = ['=== 旧環境を止めます ==='];

  // --- 未処理の回答を捌く ---
  var pending = processPendingResponses();
  log.push('未処理の回答を処理: ' + JSON.stringify(pending.processed));

  var stillPending = migration_countPending_(ss);
  if (stillPending > 0) {
    Logger.log(log.join('\n'));      // throw でログを失わない
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
    var msg =
      '旧フォームの受付を止められませんでした: ' + forms.failed.join(' / ') + '\n' +
      '\n' +
      '★トリガーはまだ削除していません（意図した動作です）。\n' +
      '  フォームが受付中のままトリガーだけ消すと、回答できるのに誰も処理しない\n' +
      '  状態になります。その回答は在庫に反映されず、エラー通知も出ません。\n' +
      '\n' +
      '対処1: ' + MIGRATION_MANUAL_CLOSE_ + '\n' +
      '       → 閉じたら migration_2_freeze() をもう一度実行\n' +
      '対処2: どの API が失敗しているか調べる → migration_diagnoseForms()\n';
    if (forms.unopenable.length) {
      msg +=
        '\n' +
        '★「フォームを開けない」が出ています: ' + forms.unopenable.join(' / ') + '\n' +
        '  これは対処1では解消できません（画面から開けないフォームだからです）。\n' +
        '  ・本当に消えている場合: Drive のゴミ箱と「owner:me」検索で確認し、\n' +
        '    設定シートの該当IDを空にしてから再実行してください\n' +
        '    （IDは移行メモの「旧フォームID: ◯◯」に残っています）\n' +
        '  ・権限が無いだけの場合: フォームは生きているので、絶対に飛ばさないこと\n';
    }
    if (forms.unconfirmed.length) {
      msg +=
        '\n' +
        '★「確認できない」が出ています: ' + forms.unconfirmed.join(' / ') + '\n' +
        '  未公開なのに受付中と読めるなど、2つのフラグが食い違っています。\n' +
        '  「未公開なら回答を受け付けない」は推測なので、コードからは断定できません。\n' +
        '  確実な確かめ方: フォームのURLをシークレットウィンドウで開いてください。\n' +
        '    回答できなければ閉じています（これが最も確実な証拠です）。\n';
    }
    msg +=
      '\n' +
      '対処3: 次のどちらかなら、この関門を飛ばして構いません\n' +
      '       → migration_2_freeze_skipForms() を実行\n' +
      '  ・フォームのURLを誰にも配っておらず、回答される心配が無い\n' +
      '  ・シークレットウィンドウで開いて、回答できないことを自分で確認した';
    Logger.log(log.join('\n'));      // throw でログを失わない
    throw new Error(msg);
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
  if (remain === 0 && !forms.failed.length && !forms.skipped.length) {
    log.push('次: migration_3_share() を実行してください');
  } else {
    log.push('★未解決の項目があります。上を確認してから migration_3_share() に進んでください。');
    if (forms.skipped.length) {
      log.push('  （設定シートにIDが無いフォームは確認できていません: ' +
        forms.skipped.join(' / ') + '）');
    }
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

/** フォームを手動で閉じる手順。新しいUIを先に案内する */
var MIGRATION_MANUAL_CLOSE_ =
  'フォームを開く → 右上の「公開」から公開を停止（新しいUI）。' +
  'それが無ければ「回答」タブの「回答を受け付けています」をオフ（従来のUI）';

/**
 * いま走っているプロジェクトが【旧アカウント】側かを移行メモで確かめる。
 *
 * ★これが無いと事故る。migration_closeOldForms() は設定シートのIDを読むので、
 *   新アカウントで実行すると「いま運用している新しいフォーム4本」を閉じてしまう。
 *   旧環境では移行メモのIDといま掴んでいるIDが一致し、新環境では
 *   migration_4_adopt() がコピーを作るので一致しない。
 */
function migration_assertOldEnvironment_(funcName) {
  var ss = getSpreadsheet();
  var memo = migration_readMemo_(ss);
  if (!memo) {
    throw new Error(funcName + ' は移行メモを必要とします。' +
      '旧アカウントで migration_1_snapshot() を実行してください。');
  }
  var memoId = String(memo['スプレッドシートID'] || '').trim();
  if (memoId && memoId !== ss.getId()) {
    throw new Error(
      funcName + ' は【旧アカウント】で実行する関数です。\n' +
      'いま掴んでいるブックは移行メモに記録されたものと違います（コピー後の新しいブックです）。\n' +
      '  移行メモのID: ' + memoId + '\n' +
      '  いまのID:     ' + ss.getId() + '\n' +
      '\n' +
      '★このまま実行すると、いま運用している新しいフォーム4本を閉じてしまいます。\n' +
      '  新環境の確認は migration_5_verify() を使ってください。\n' +
      '  旧フォームを閉じたいときは、旧アカウントのプロジェクトで実行してください。');
  }
}

/**
 * 旧フォーム4本の受付を止める。これだけを単独で何度でも実行できる。
 *
 * 閉じ方は2通りあり、Google 側の仕様変更でどちらかが通らないことがあるため両方を
 * 独立に試す。ただし**判定は読み戻した状態だけで行う**（ログの「成功」は証拠にしない）。
 *   (1) setPublished(false)          … 新しい公開モデル
 *   (2) setAcceptingResponses(false) … 従来のモデル
 *
 * ★「未公開なら回答を受け付けない」はこちらの推測で確認が取れていない。
 *   そのため「未公開なのに受付中」と読めた場合は閉じたと判定せず、判定不能にして止める。
 *
 * ★閉じていても毎回書き込みは行う（閉鎖メッセージは上書きされる）。読み取り専用ではない。
 *
 * @return {{closed: Array, failed: Array, skipped: Array, unopenable: Array,
 *            unconfirmed: Array, log: string}}
 */
function migration_closeOldForms() {
  migration_assertOldEnvironment_('migration_closeOldForms()');

  var log = ['=== 旧フォームの受付を止めます ==='];
  var closed = [];
  var failed = [];
  var skipped = [];
  var unopenable = [];
  var unconfirmed = [];

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
      // openFormIfExists_ は「消えている」と「権限が無い」を区別できない。
      // 権限が無いだけならフォームは生きているので、飛ばしてよいとは言えない。
      log.push(spec.label + 'フォーム: ★開けませんでした（ID: ' + id + '）');
      log.push('    消えているのか、権限が無いだけなのかは区別できません');
      failed.push(spec.label + '=フォームを開けない');
      unopenable.push(spec.label + '（ID: ' + id + '）');
      return;
    }

    log.push(spec.label + 'フォーム（' + id + '）');
    var pre = migration_isFormClosed_(form);
    log.push('  いまの状態: ' + migration_formState_(form));

    var reasons = [];
    var anyOk = false;
    [['setPublished', false], ['setAcceptingResponses', false]].forEach(function(pair) {
      var r = migration_tryFormCall_(form, pair[0], pair[1]);
      log.push('  ' + pair[0] + '(false): ' + migration_callResultText_(r));
      if (r.ok) anyOk = true;
      if (r.available && !r.ok) reasons.push(pair[0] + ' → ' + r.error);
    });

    // 閉鎖メッセージは本質ではないので独立した試行にする。失敗しても停止の成否には含めない
    var rm = migration_tryFormCall_(form, 'setCustomClosedFormMessage', MIGRATION_CLOSED_MESSAGE_);
    log.push('  閉鎖メッセージ: ' + migration_callResultText_(rm) +
      (rm.available && !rm.ok ? '（受付停止の成否には影響しません）' : ''));

    // ★ここだけが判定の根拠
    var state = migration_isFormClosed_(form);
    var why = reasons.length ? '（' + reasons.join(' / ') + '）' : '';
    log.push('  停止後の状態: ' + migration_formState_(form));

    if (state === true && !anyOk && pre !== true) {
      // 書き込みが1つも通らず、元から閉じていたわけでもない。
      // 状態が変わる理由が無いので「閉じた」とは言えない
      log.push('  → ★書き込みが1つも通っていないため、停止できたと判断できません');
      failed.push(spec.label + '=確認できない' + why);
      unconfirmed.push(spec.label);
    } else if (state === true) {
      log.push('  → 受付を停止しました');
      closed.push(spec.label);
    } else if (state === false) {
      log.push('  → ★まだ回答を受け付けます');
      failed.push(spec.label + '=まだ受付中' + why);
    } else {
      log.push('  → ★停止できたか確認できません（' + migration_formState_(form) + '）');
      failed.push(spec.label + '=確認できない' + why);
      unconfirmed.push(spec.label);
    }
  });

  log.push('');
  log.push('停止できた: ' + (closed.length ? closed.join(' / ') : 'なし'));
  if (skipped.length) {
    log.push('対象外（設定シートにIDが無い）: ' + skipped.join(' / '));
    if (!closed.length && !failed.length) {
      log.push('  ★1本も確認していません。設定シートのIDが空なので、このログは');
      log.push('    「フォームが閉じている」証拠になりません。');
      log.push('    旧フォームのIDは移行メモの「旧フォームID: ◯◯」に残っています。');
    }
  }
  if (failed.length) {
    log.push('★停止できなかった: ' + failed.join(' / '));
    log.push('  手動で閉じる: ' + MIGRATION_MANUAL_CLOSE_);
    log.push('  → 閉じたら migration_closeOldForms() を再実行して確認');
    log.push('  原因を調べる: migration_diagnoseForms()');
  }

  Logger.log(log.join('\n'));
  return { closed: closed, failed: failed, skipped: skipped, unopenable: unopenable,
           unconfirmed: unconfirmed, log: log.join('\n') };
}

/**
 * どの Forms API が読めて、どれが読めないのかを1本ずつ試して報告する。
 * **読み取りだけ**なので、フォームには一切書き込まない。
 *
 * 受付停止が失敗したときに1回実行して、ログをそのまま共有すれば切り分けられる。
 * 書き込み側も試したい場合は migration_diagnoseFormsDeep() を使う。
 */
function migration_diagnoseForms() {
  return migration_diagnose_(false);
}

/**
 * migration_diagnoseForms() に加えて、setter も「いま読み取れた値と同じ値」で試す。
 *
 * ★同じ値でも書き込みは書き込みである。通常は状態が変わらないが、保証はできない。
 *   「開く方向」（true を書く / 閉鎖メッセージを消す）になる書き込みは行わない。
 */
function migration_diagnoseFormsDeep() {
  return migration_diagnose_(true);
}

/** @param {boolean} probeSetters setter も試すか */
function migration_diagnose_(probeSetters) {
  var log = ['=== Forms API の診断' +
    (probeSetters ? '（setter も試します。いまと同じ値だけ書き込みます）' : '（読み取りだけ・書き込みません）') +
    ' ==='];

  FI_KIND_ORDER_.forEach(function(kind) {
    var spec = getFormSpec_(kind);
    var id = String(getConfigValue_(spec.formIdKey, '') || '').trim();
    log.push('');
    log.push('【' + spec.label + 'フォーム】');
    if (!id) { log.push('  設定シートにIDがありません'); return; }
    log.push('  ID: ' + id);

    var form = openFormIfExists_(id);
    if (!form) {
      log.push('  ★開けません（消えているか、このアカウントに権限が無い。区別はできません）');
      return;
    }

    try { log.push('  タイトル: ' + form.getTitle()); } catch (e) { log.push('  タイトル: ★読めません → ' + e); }

    // --- getter ---
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

    var flags = migration_readFormFlags_(form);
    if (flags.published === false && flags.accepting === true) {
      log.push('  ★2つのフラグが食い違っています（未公開なのに受付中）。');
      log.push('    この状態では「未公開だから閉じている」と判断できません。');
    }

    if (!probeSetters) return;

    // --- setter（いまと同じ値だけ。開く方向は試さない）---
    [['setPublished', 'isPublished'],
     ['setAcceptingResponses', 'isAcceptingResponses'],
     ['setCustomClosedFormMessage', 'getCustomClosedFormMessage']].forEach(function(pair) {
      var setter = pair[0];
      if (typeof form[setter] !== 'function') { log.push('  ' + setter + '(): このバージョンには無い'); return; }
      if (!(pair[1] in reads)) {
        log.push('  ' + setter + '(): いまの値が読めないので試しません（状態を変えないため）');
        return;
      }
      var value = reads[pair[1]];
      if (value === true || value === '') {
        log.push('  ' + setter + '(): 開く方向の書き込みになるので試しません' +
          '（いまの値が ' + JSON.stringify(value) + '）');
        return;
      }
      var r = migration_tryFormCall_(form, setter, value);
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

/**
 * 公開状態と受付状態を読む。読めないものは null。
 * @return {{published: boolean|null, accepting: boolean|null}}
 */
function migration_readFormFlags_(form) {
  var published = null;
  var accepting = null;
  if (typeof form.isPublished === 'function') {
    try { published = !!form.isPublished(); } catch (e) { published = null; }
  }
  if (typeof form.isAcceptingResponses === 'function') {
    try { accepting = !!form.isAcceptingResponses(); } catch (e) { accepting = null; }
  }
  return { published: published, accepting: accepting };
}

/** フォームの状態を人が読める文字列にする */
function migration_formState_(form) {
  var f = migration_readFormFlags_(form);
  var parts = [];
  if (f.published !== null) parts.push(f.published ? '公開' : '未公開');
  else if (typeof form.isPublished === 'function') parts.push('公開状態は不明');
  if (f.accepting !== null) parts.push(f.accepting ? '受付中' : '受付停止');
  else if (typeof form.isAcceptingResponses === 'function') parts.push('受付状態は不明');
  if (!parts.length) return '不明';
  if (f.published === false && f.accepting === true) return parts.join(' / ') + '（★食い違い）';
  return parts.join(' / ');
}

/**
 * 読み戻して「本当に回答を受け付けないか」を判定する。
 *
 * ★「未公開なら回答を受け付けない」は推測で、一次情報で確認できていない。
 *   だから「未公開なのに受付中」と読めたときは true を返さない。
 *   閉じたと誤判定してトリガーを消すのが、この移行で最悪の結果だから。
 *
 * @return {boolean|null} true=閉じている / false=まだ受け付ける / null=判定できない
 */
function migration_isFormClosed_(form) {
  var f = migration_readFormFlags_(form);
  if (f.accepting === false) return true;                 // 受付停止はどちらのモデルでも確定
  if (f.published === false) {
    return f.accepting === true ? null : true;             // 食い違いなら確定させない
  }
  if (f.published === null && f.accepting === null) return null;
  return false;                                            // 公開中、または受付中と読めた
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

  // --- コードが正しく入っているか（データの照合より先に見る）---
  // ファイルを1つ貼り忘れていたり Drive が v3 になっていたら、
  // 以降の判定が全部 OK でも本番で壊れる
  var code = migration_checkCode_();
  log.push(code.log);
  ng += code.ng.length;
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
    var sameIdCount = 0;
    oldKeys.forEach(function(k) {
      var label = k.replace('旧フォームID: ', '');
      var oldId = String(memo[k] || '').trim();
      if (!oldId) return;
      listedCount++;
      if (currentIds[oldId]) {
        sameIdCount++;
        log.push('  --   ' + label + ': いま使っているフォームと同じIDです');
        return;
      }
      var form = openFormIfExists_(oldId);
      if (!form) { log.push('  --   ' + label + ': 開けません（' + oldId + '）'); return; }
      openedCount++;
      var state = migration_isFormClosed_(form);
      if (state === null) {
        // 「OK ― 状態を読み取れません」は矛盾している。判定しないほうが正直
        log.push('  --   ' + label + 'フォーム（旧）: 状態を読み取れません' +
          '（旧アカウントで migration_closeOldForms() を実行して確認してください）');
        return;
      }
      check(label + 'フォーム（旧）', state === true,
        state === true ? '受付停止'
          : '★まだ受付中（' + migration_formState_(form) + '）— 回答されても誰も処理しません');
    });

    if (!listedCount) {
      log.push('  --   移行メモに旧フォームIDがありません');
    } else if (sameIdCount === listedCount) {
      log.push('  ★移行メモが新アカウントで上書きされています');
      log.push('    （migration_1_snapshot() を新アカウントで実行すると、商品数や箱番号の');
      log.push('      突き合わせも自分自身との比較になり意味を失います）');
      log.push('    旧フォームの確認は旧アカウントのプロジェクトで行ってください。');
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
