/**
 * FormIntegration.gs - Googleフォーム連携（入荷・出荷の記録 → 在庫反映 → ラベルPDF送付）
 *
 * 構成:
 *   1. 設定（「設定」シート）            getConfigMap_ / getConfigValue_ / setConfigValue_
 *   2. セットアップ                        setupFormIntegration()  ← エディタから1回実行
 *   3. フォーム選択肢の同期                syncFormChoices()       ← 毎朝 + マスタ保存時
 *   4. フォーム送信の処理                  onFormSubmit(e) / processResponseRow_ / processPendingResponses()
 *   5. 発注（分納）の消し込み              consumeDeliveries_      ← js/app.js updateOrderQuantityOnDelivery の移植
 *   6. 箱台帳（採番・二重計上防止）        reserveBoxNumbers_ / ledgerRegister_ / ledgerCheck_ / ledgerMark_
 *   7. メール                              sendLabelMail_ / sendAdminMail_ / sendLowStockMail_
 *   8. Web アクション（doGet から委譲）    routeExtended_(action, data, e)
 *
 * 既存の Code.gs の関数（getProductsData / updateSingleProduct / addHistoryRecord など）を
 * そのまま利用し、既存シート（商品管理・履歴）の構成は変更しません。
 */

// ========================================
// 定数
// ========================================

var FI_SHEETS_ = {
  CONFIG: '設定',
  STAFF: '入力者',
  LEDGER: '箱台帳',
  IN_RESP: 'フォーム回答_入荷',
  OUT_RESP: 'フォーム回答_出荷',
  INV_RESP: 'フォーム回答_棚卸'
};

var FI_FORM_TITLES_ = {
  IN: 'お守り入荷登録',
  OUT: 'お守り出荷登録',
  INV: 'お守り棚卸登録'
};

// フォームの質問タイトル（回答シートのヘッダー名にもなる。変更する場合はフォームも作り直す）
var FI_Q_ = {
  STAFF: '入力者',
  IN_DATE: '入荷日',
  OUT_DATE: '出荷日',
  INV_DATE: '棚卸日',
  ACTUAL: '実在庫数',  // 実在庫数1, 実在庫数2, ...（棚卸）
  PRODUCT: '商品',    // 商品1, 商品2, ...
  BOXES: '箱数',      // 箱数1, 箱数2, ...
  PIECES: '端数',     // 端数1, ...（出荷のみ。箱に満たない個数）
  DEST: '出荷先',
  NOTE: '備考'
};

var FI_IN_SLOTS_ = 10;   // 入荷フォームの商品枠数
var FI_OUT_SLOTS_ = 3;   // 出荷フォームの商品枠数
var FI_INV_SLOTS_ = 10;  // 棚卸フォームの商品枠数

// 回答シートに GAS が追記する列
var FI_RESULT_COLS_ = ['処理結果', '処理日時', '在庫反映内容', 'ラベル番号範囲', 'PDF URL', 'バックアップ', 'エラー'];

var FI_STATUS_ = {
  PROCESSING: '処理中',
  STOCK_DONE: '在庫反映済',
  DONE: '完了',
  PDF_FAILED: '在庫反映済/PDF失敗',
  ERROR: 'エラー'
};

var FI_LEDGER_HEADERS_ = ['qrCode', 'productCode', 'year', 'boxNumber', 'status', 'issuedAt', 'source', 'inAt', 'outAt', 'ref', 'note'];
var FI_LEDGER_STATUS_ = { ISSUED: '発行済', IN: '入庫済', OUT: '出庫済' };

var FI_STAFF_HEADERS_ = ['名前', 'メール', '有効', '備考'];

// 設定シートの既定値 [key, 既定値, 説明]
var FI_CONFIG_DEFAULTS_ = [
  ['adminEmail', '', 'エラー通知・控えの送信先（管理者）'],
  ['driveFolderId', '', 'ラベルPDFの保存先フォルダID（自動設定）'],
  ['labelTemplateId', '', 'ラベル用 A4縦 Googleスライド テンプレートID（自動設定）'],
  ['inFormId', '', '入荷フォームID（自動設定）'],
  ['inFormUrl', '', '入荷フォーム 回答用URL（自動設定）'],
  ['inFormEditUrl', '', '入荷フォーム 編集用URL（自動設定）'],
  ['outFormId', '', '出荷フォームID（自動設定）'],
  ['outFormUrl', '', '出荷フォーム 回答用URL（自動設定）'],
  ['outFormEditUrl', '', '出荷フォーム 編集用URL（自動設定）'],
  ['inResponseSheet', 'フォーム回答_入荷', '入荷の回答シート名'],
  ['outResponseSheet', 'フォーム回答_出荷', '出荷の回答シート名'],
  ['invFormId', '', '棚卸フォームID（自動設定）'],
  ['invFormUrl', '', '棚卸フォーム 回答用URL（自動設定）'],
  ['invFormEditUrl', '', '棚卸フォーム 編集用URL（自動設定）'],
  ['invResponseSheet', 'フォーム回答_棚卸', '棚卸の回答シート名'],
  ['maxInventoryCount', 100000, '棚卸で1商品に入力できる実在庫数の上限（桁の入力ミス対策）'],
  ['offsetX_mm', 0, 'ラベル印字位置の微調整 横（mm、右が＋）'],
  ['offsetY_mm', 0, 'ラベル印字位置の微調整 縦（mm、下が＋）'],
  ['maxBoxesPerLine', 50, '1商品あたりの箱数上限（フォーム）'],
  ['maxBoxesPerSubmission', 80, '1回の送信の箱数合計上限（ラベル10ページ分）'],
  ['maxLabelsPerPdf', 200, '1つのPDFに入れるラベル枚数の上限'],
  ['lowStockMail', 'TRUE', '出荷で安心在庫を下回ったらメール通知する（TRUE/FALSE）'],
  ['pdfShareAnyoneWithLink', 'FALSE', 'PDFを「リンクを知っている全員」に共有する（TRUE/FALSE）'],
  ['labelFontFamily', 'Noto Sans JP', 'ラベルの日本語フォント'],
  ['qrCellSize', 10, 'QR画像の1モジュールのピクセル数（大きいほど高精細）'],
  ['mailSenderName', 'お守り在庫管理', 'メールの差出人名'],
  ['orgName', '', '神社名（見積メール・起案書に使用）'],
  ['senderName', '', '署名用の氏名（見積メール・起案書の起案者）'],
  ['senderShortName', '', '本文の名乗り（例: 山田）。未設定なら senderName'],
  ['senderEmail', '', '署名のメールアドレス'],
  ['senderAddress', '', '署名の住所（〒から1行）'],
  ['senderTel', '', '署名の電話番号'],
  ['senderFax', '', '署名のFAX番号'],
  ['senderMobile', '', '署名の携帯番号'],
  ['maxBackups', 30, 'バックアップの保持世代数（超えた分は古い順に削除）'],
  ['backupBeforeFormInventory', 'TRUE', '棚卸フォームの反映前に自動バックアップする（TRUE/FALSE）'],
  ['backupBeforeAppInventory', 'TRUE', 'アプリの棚卸反映前に自動バックアップする（TRUE/FALSE）'],
  ['backupBeforeStockSave', 'FALSE', '在庫管理画面の「在庫を保存」前に自動バックアップする（TRUE/FALSE・既定OFF）'],
  ['dailyBackup', 'FALSE', '毎日決まった時刻に自動バックアップする（TRUE/FALSE・既定OFF）'],
  ['dailyBackupHour', 3, '毎日バックアップの時刻（0〜23）']
];

// ========================================
// 1. 設定
// ========================================

var FI_CONFIG_CACHE_ = null;

function getConfigSheet_(create) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(FI_SHEETS_.CONFIG);
  if (!sheet && create) {
    sheet = ss.insertSheet(FI_SHEETS_.CONFIG);
    sheet.getRange(1, 1, 1, 3).setValues([['キー', '値', '説明']])
      .setBackground('#4a4a4a').setFontColor('#FFFFFF').setFontWeight('bold');
    sheet.setColumnWidth(1, 200);
    sheet.setColumnWidth(2, 360);
    sheet.setColumnWidth(3, 360);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 設定シートを {キー: 値} で返す（1実行内でキャッシュ）
 */
function getConfigMap_() {
  if (FI_CONFIG_CACHE_) return FI_CONFIG_CACHE_;
  var map = {};
  try {
    var sheet = getConfigSheet_(false);
    if (sheet) {
      var values = sheet.getDataRange().getValues();
      for (var i = 1; i < values.length; i++) {
        var key = String(values[i][0] || '').trim();
        if (key) map[key] = values[i][1];
      }
    }
  } catch (e) {
    // スプレッドシート未初期化など → 空設定
  }
  FI_CONFIG_CACHE_ = map;
  return map;
}

function getConfigValue_(key, defaultValue) {
  var map = getConfigMap_();
  var v = map[key];
  if (v === undefined || v === null || v === '') return defaultValue;
  return v;
}

function setConfigValue_(key, value) {
  var sheet = getConfigSheet_(true);
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      FI_CONFIG_CACHE_ = null;
      return;
    }
  }
  var desc = '';
  FI_CONFIG_DEFAULTS_.forEach(function(d) { if (d[0] === key) desc = d[2]; });
  sheet.appendRow([key, value, desc]);
  FI_CONFIG_CACHE_ = null;
}

/**
 * 設定シートを作成し、無いキーだけ既定値で追加する（既存の値は上書きしない）
 */
function ensureConfigSheet_() {
  var sheet = getConfigSheet_(true);
  var values = sheet.getDataRange().getValues();
  var existing = {};
  for (var i = 1; i < values.length; i++) {
    var key = String(values[i][0] || '').trim();
    if (key) existing[key] = true;
  }
  var rows = [];
  FI_CONFIG_DEFAULTS_.forEach(function(d) {
    if (!existing[d[0]]) rows.push([d[0], d[1], d[2]]);
  });
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  }
  FI_CONFIG_CACHE_ = null;
  if (!getConfigValue_('adminEmail', '')) {
    try {
      var me = Session.getEffectiveUser().getEmail();
      if (me) setConfigValue_('adminEmail', me);
    } catch (e) {
      // 取得できない環境では空のまま
    }
  }
  return sheet;
}

function nowJa_() {
  return new Date().toLocaleString('ja-JP');
}

// ========================================
// 1.5 フォーム種別の仕様表
// ========================================
//
// 入荷・出荷・棚卸・商品登録は「フォームを作る → 回答シートを読む → 商品管理へ反映する」
// という同じ流れを共有している。種別ごとの違いはすべてこの表に集約してあり、
// createIntakeForm_ / getResponseSheet_ / syncFormChoices / processPendingResponses /
// processResponseRow_ は表を引くだけになっている。
// 種別を増やすときは、この表に1件足して handle（ロック内の反映）と
// postLock（ロック外のPDF・メール）を書けばよい。

var FI_KIND_ORDER_ = ['in', 'out', 'inv'];

var FI_ROLE_ = { STAFF: 'staff', PRODUCT: 'product' };

var FI_WHOLE_NUMBER_ = { kind: 'wholeNumber', help: '整数を入力してください' };
var FI_STAFF_PLACEHOLDER_ = '（入力者シートを設定後に syncFormChoices を実行）';
var FI_PRODUCT_PLACEHOLDER_ = '（商品マスタを設定後に syncFormChoices を実行）';

function fiListQuestion_(title, required, help, choices, role) {
  return { type: 'list', title: title, required: !!required, help: help || '', choices: choices || [], role: role || null };
}
function fiTextQuestion_(title, required, help, validation) {
  return { type: 'text', title: title, required: !!required, help: help || '', validation: validation || null };
}
function fiDateQuestion_(title, required, help) {
  return { type: 'date', title: title, required: !!required, help: help || '' };
}
function fiParagraphQuestion_(title, required, help) {
  return { type: 'paragraph', title: title, required: !!required, help: help || '' };
}

var FI_FORM_SPECS_CACHE_ = null;

function buildFormSpecs_() {
  var specs = {};

  specs['in'] = {
    kind: 'in',
    label: '入荷',
    formTitle: FI_FORM_TITLES_.IN,
    description: '届いた箱の数を登録します。送信すると在庫に反映され、箱に貼るラベル（QR付き）のPDFが入力者宛にメールで届きます。',
    confirmation: '登録しました。在庫に反映し、ラベルPDFを入力者宛にメールします（届くまで1〜2分かかることがあります）。',
    formIdKey: 'inFormId', formUrlKey: 'inFormUrl', formEditUrlKey: 'inFormEditUrl',
    sheetKey: 'inResponseSheet', sheetDefault: FI_SHEETS_.IN_RESP,
    slots: FI_IN_SLOTS_,
    dateTitle: FI_Q_.IN_DATE,
    sign: 1,              // 在庫を増やす
    hasPieces: false,     // 端数欄なし
    hasDest: false,       // 出荷先欄なし
    reserveBoxes: true,   // 箱台帳に採番して登録する
    checkLowStock: false,
    head: [
      fiListQuestion_(FI_Q_.STAFF, true, 'ご自身の名前を選んでください（入力者シートに登録された人）', [FI_STAFF_PLACEHOLDER_], FI_ROLE_.STAFF),
      fiDateQuestion_(FI_Q_.IN_DATE, false, '空欄の場合は送信日になります（QRの年はこの日付の西暦下2桁）')
    ],
    // スロットの質問は「枠1だけ必須」。required は枠1にのみ適用される（formQuestionPlan_ 参照）
    slotQuestions: [
      fiListQuestion_(FI_Q_.PRODUCT, true, '', [FI_PRODUCT_PLACEHOLDER_], FI_ROLE_.PRODUCT),
      fiTextQuestion_(FI_Q_.BOXES, true, '届いた箱の数（1以上の整数）', FI_WHOLE_NUMBER_)
    ],
    tail: [fiParagraphQuestion_(FI_Q_.NOTE, false)],
    handle: handleStockLines_,
    postLock: postLockIntake_
  };

  specs['out'] = {
    kind: 'out',
    label: '出荷',
    formTitle: FI_FORM_TITLES_.OUT,
    description: '倉庫から持ち出した数を登録します。送信すると在庫から減算されます。',
    confirmation: '登録しました。在庫に反映します。',
    formIdKey: 'outFormId', formUrlKey: 'outFormUrl', formEditUrlKey: 'outFormEditUrl',
    sheetKey: 'outResponseSheet', sheetDefault: FI_SHEETS_.OUT_RESP,
    slots: FI_OUT_SLOTS_,
    dateTitle: FI_Q_.OUT_DATE,
    sign: -1,             // 在庫を減らす（0未満にはしない）
    hasPieces: true,
    hasDest: true,
    reserveBoxes: false,
    checkLowStock: true,
    head: [
      fiListQuestion_(FI_Q_.STAFF, true, 'ご自身の名前を選んでください（入力者シートに登録された人）', [FI_STAFF_PLACEHOLDER_], FI_ROLE_.STAFF),
      fiDateQuestion_(FI_Q_.OUT_DATE, false, '空欄の場合は送信日になります')
    ],
    slotQuestions: [
      fiListQuestion_(FI_Q_.PRODUCT, true, '', [FI_PRODUCT_PLACEHOLDER_], FI_ROLE_.PRODUCT),
      fiTextQuestion_(FI_Q_.BOXES, true, '持ち出した箱の数（整数。箱単位でなければ 0 にして端数に個数を入力）', FI_WHOLE_NUMBER_),
      fiTextQuestion_(FI_Q_.PIECES, false, '箱に満たない個数（任意）', FI_WHOLE_NUMBER_)
    ],
    tail: [
      fiTextQuestion_(FI_Q_.DEST, false, '授与所名など（任意）', null),
      fiParagraphQuestion_(FI_Q_.NOTE, false)
    ],
    handle: handleStockLines_,
    postLock: postLockShipping_
  };

  specs['inv'] = {
    kind: 'inv',
    label: '棚卸',
    formTitle: FI_FORM_TITLES_.INV,
    description: '数えた実際の在庫数を登録します。送信すると、入力した商品だけ在庫がその数に置き換わります（入力していない商品はそのままです）。反映の前に自動でバックアップを取ります。',
    confirmation: '登録しました。入力した商品の在庫を、数えた数に置き換えます。',
    formIdKey: 'invFormId', formUrlKey: 'invFormUrl', formEditUrlKey: 'invFormEditUrl',
    sheetKey: 'invResponseSheet', sheetDefault: FI_SHEETS_.INV_RESP,
    slots: FI_INV_SLOTS_,
    dateTitle: FI_Q_.INV_DATE,
    head: [
      fiListQuestion_(FI_Q_.STAFF, true, 'ご自身の名前を選んでください（入力者シートに登録された人）', [FI_STAFF_PLACEHOLDER_], FI_ROLE_.STAFF),
      fiDateQuestion_(FI_Q_.INV_DATE, false, '空欄の場合は送信日になります')
    ],
    slotQuestions: [
      fiListQuestion_(FI_Q_.PRODUCT, true, '', [FI_PRODUCT_PLACEHOLDER_], FI_ROLE_.PRODUCT),
      fiTextQuestion_(FI_Q_.ACTUAL, true, '数えた実際の個数（箱数ではなく個数）。0 と空欄は意味が違います: 0 は「在庫ゼロ」、空欄は「数えていない」です', FI_WHOLE_NUMBER_)
    ],
    tail: [fiParagraphQuestion_(FI_Q_.NOTE, false)],
    handle: handleInventory_,
    postLock: null
  };

  return specs;
}

function getFormSpecs_() {
  if (!FI_FORM_SPECS_CACHE_) FI_FORM_SPECS_CACHE_ = buildFormSpecs_();
  return FI_FORM_SPECS_CACHE_;
}

function getFormSpec_(kind) {
  return getFormSpecs_()[kind] || null;
}

/**
 * 回答シート名（設定シートで変更できる）
 */
function responseSheetName_(spec) {
  return getConfigValue_(spec.sheetKey, spec.sheetDefault);
}

/**
 * 回答シート名から種別を引く
 */
function kindForResponseSheet_(sheetName) {
  var found = null;
  FI_KIND_ORDER_.forEach(function(kind) {
    if (found) return;
    var spec = getFormSpec_(kind);
    if (spec && sheetName === responseSheetName_(spec)) found = kind;
  });
  return found;
}

/**
 * 仕様表から、フォームに並べる質問を順番どおりに展開する
 * @return {Array<{q:Object, title:string, required:boolean, slot:number|undefined}>}
 */
function formQuestionPlan_(spec) {
  var plan = [];
  (spec.head || []).forEach(function(q) {
    plan.push({ q: q, title: q.title, required: !!q.required });
  });
  for (var i = 1; i <= (spec.slots || 0); i++) {
    (spec.slotQuestions || []).forEach(function(q) {
      // 枠1だけ必須にする（枠2以降を必須にすると1商品だけの送信ができなくなる）
      plan.push({ q: q, title: q.title + i, required: !!q.required && i === 1, slot: i });
    });
  }
  (spec.tail || []).forEach(function(q) {
    plan.push({ q: q, title: q.title, required: !!q.required });
  });
  return plan;
}

function buildTextValidation_(v) {
  var b = FormApp.createTextValidation().setHelpText(v.help || '');
  if (v.kind === 'wholeNumber') b = b.requireWholeNumber();
  else if (v.kind === 'pattern') b = b.requireTextMatchesPattern(v.pattern);
  else throw new Error('未知の入力検証: ' + v.kind);
  return b.build();
}

function addFormQuestion_(form, q, title, required) {
  var item;
  if (q.type === 'list') {
    item = form.addListItem().setTitle(title).setRequired(!!required);
    if (q.help) item.setHelpText(q.help);
    item.setChoiceValues(q.choices && q.choices.length ? q.choices : ['（未設定）']);
  } else if (q.type === 'text') {
    item = form.addTextItem().setTitle(title).setRequired(!!required);
    if (q.help) item.setHelpText(q.help);
    if (q.validation) item.setValidation(buildTextValidation_(q.validation));
  } else if (q.type === 'date') {
    item = form.addDateItem().setTitle(title).setRequired(!!required);
    if (q.help) item.setHelpText(q.help);
  } else if (q.type === 'paragraph') {
    item = form.addParagraphTextItem().setTitle(title).setRequired(!!required);
    if (q.help) item.setHelpText(q.help);
  } else {
    throw new Error('未知の質問タイプ: ' + q.type);
  }
  return item;
}

// ========================================
// 2. セットアップ
// ========================================

/**
 * フォーム連携の初期セットアップ（何度実行しても安全）
 *  - 設定 / 入力者 / 箱台帳 シートの作成
 *  - ラベルPDF フォルダとテンプレートの作成
 *  - 入荷・出荷フォームの作成とスプレッドシートへの紐づけ
 *  - トリガーの設置
 *  - フォーム選択肢の同期
 * 実行後、設定シートの署名項目と入力者シートを記入してください。
 */
function setupFormIntegration() {
  var ss = getSpreadsheet();
  var log = [];

  ensureConfigSheet_();
  log.push('設定シート: OK');

  ensureSheetWithHeaders_(ss, FI_SHEETS_.STAFF, FI_STAFF_HEADERS_, '#8B0000');
  log.push('入力者シート: OK');

  ensureSheetWithHeaders_(ss, FI_SHEETS_.LEDGER, FI_LEDGER_HEADERS_, '#4a4a4a');
  log.push('箱台帳シート: OK');

  var folder = getLabelFolder_();
  log.push('ラベルPDFフォルダ: ' + folder.getUrl());

  var templateWarning = null;
  try {
    ensureLabelTemplate_();
    log.push('ラベルテンプレート: OK');
  } catch (e) {
    templateWarning = String(e.message || e);
    log.push('ラベルテンプレート: 要確認 → ' + templateWarning);
  }

  var forms = ensureForms_(ss, folder);
  FI_KIND_ORDER_.forEach(function(kind) {
    log.push(getFormSpec_(kind).label + 'フォーム: ' + forms[kind].getPublishedUrl());
  });

  ensureBackupSheets_();
  log.push('バックアップ台帳・明細シート: OK');

  ensureTriggers_(ss);
  log.push('トリガー: OK（onFormSubmit / syncFormChoices 毎日6時 / processPendingResponses 10分毎 / dailyBackupJob）');

  var sync = syncFormChoices();
  log.push('選択肢の同期: 商品 ' + sync.products + ' 件 / 入力者 ' + sync.staff + ' 件');

  log.push('');
  log.push('次の作業:');
  log.push('1. 「入力者」シートに 名前・メール・有効(TRUE) を記入');
  log.push('2. 「設定」シートの adminEmail と署名項目（orgName, senderName ...）を記入');
  log.push('3. syncFormChoices() を実行（入力者を追加・変更したとき）');
  log.push('4. test_sampleLabelPdf() を実行して印刷し、位置を確認（ズレは offsetX_mm / offsetY_mm で調整）');
  log.push('5. Web アプリを「新しいバージョン」でデプロイ（管理画面のフォーム連携表示に必要）');
  if (templateWarning) {
    log.push('');
    log.push('※ ラベルテンプレートの確認が必要です: ' + templateWarning);
  }
  Logger.log(log.join('\n'));
  return log.join('\n');
}

function ensureSheetWithHeaders_(ss, name, headers, color) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  var lastCol = sheet.getLastColumn();
  var current = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var needHeader = headers.some(function(h, i) { return String(current[i] || '') !== h; });
  if (needHeader) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setBackground(color || '#4a4a4a').setFontColor('#FFFFFF').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 入荷・出荷フォームを作成（未作成のときだけ）し、スプレッドシートに紐づける
 */
function ensureForms_(ss, folder) {
  var forms = {};
  FI_KIND_ORDER_.forEach(function(kind) {
    var spec = getFormSpec_(kind);
    var form = openFormIfExists_(getConfigValue_(spec.formIdKey, ''));
    if (!form) form = createIntakeForm_(ss, folder, kind);
    forms[kind] = form;
    // 回答シートの追記列を確認
    ensureResponseSheetColumns_(getResponseSheet_(kind));
  });
  return forms;
}

function openFormIfExists_(formId) {
  if (!formId) return null;
  try {
    return FormApp.openById(formId);
  } catch (e) {
    return null;
  }
}

function createIntakeForm_(ss, folder, kind) {
  var spec = getFormSpec_(kind);
  if (!spec) throw new Error('未知のフォーム種別: ' + kind);

  var form = FormApp.create(spec.formTitle);
  form.setDescription(spec.description);
  form.setCollectEmail(false);
  form.setLimitOneResponsePerUser(false);
  form.setAllowResponseEdits(false);
  form.setShowLinkToRespondAgain(true);
  form.setConfirmationMessage(spec.confirmation);

  formQuestionPlan_(spec).forEach(function(entry) {
    addFormQuestion_(form, entry.q, entry.title, entry.required);
  });

  // 回答先をスプレッドシートに設定 → 新しくできた回答シートを見つけてリネーム
  var beforeNames = ss.getSheets().map(function(s) { return s.getName(); });
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  SpreadsheetApp.flush();
  var respSheet = findNewResponseSheet_(ss.getId(), form.getId(), beforeNames);
  var targetName = responseSheetName_(spec);
  if (respSheet) {
    var ssFresh = SpreadsheetApp.openById(ss.getId());
    if (ssFresh.getSheetByName(targetName) && respSheet.getName() !== targetName) {
      // 同名の古いシートがあれば退避
      ssFresh.getSheetByName(targetName).setName(targetName + '_旧' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMddHHmm'));
    }
    respSheet.setName(targetName);
    ensureResponseSheetColumns_(respSheet);
  } else {
    Logger.log('警告: フォームの回答シートを特定できませんでした。手動で「' + targetName + '」に名前を変更してください。');
  }

  // フォームファイルをフォルダへ移動
  try {
    DriveApp.getFileById(form.getId()).moveTo(folder);
  } catch (e) {
    // 移動できなくても動作に支障なし
  }

  setConfigValue_(spec.formIdKey, form.getId());
  setConfigValue_(spec.formUrlKey, form.getPublishedUrl());
  setConfigValue_(spec.formEditUrlKey, form.getEditUrl());
  return form;
}

/**
 * setDestination 後に増えた回答シートを特定する（フォームIDで照合、なければシート名の差分）
 */
function findNewResponseSheet_(spreadsheetId, formId, beforeNames) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var url = '';
    try { url = sheets[i].getFormUrl() || ''; } catch (e) { url = ''; }
    if (url && url.indexOf(formId) >= 0) return sheets[i];
  }
  for (var j = 0; j < sheets.length; j++) {
    if (beforeNames.indexOf(sheets[j].getName()) < 0) return sheets[j];
  }
  return null;
}

function getResponseSheet_(kind) {
  var spec = getFormSpec_(kind);
  if (!spec) return null;
  return getSpreadsheet().getSheetByName(responseSheetName_(spec));
}

/**
 * 回答シートに「処理結果」などの列を追加（無いものだけ右端に追記）
 */
function ensureResponseSheetColumns_(sheet) {
  if (!sheet) return;
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h || ''); });
  var missing = FI_RESULT_COLS_.filter(function(c) { return headers.indexOf(c) < 0; });
  if (missing.length) {
    var start = headers.length;
    // 末尾の空ヘッダーを詰める
    while (start > 0 && !headers[start - 1]) start--;
    sheet.getRange(1, start + 1, 1, missing.length).setValues([missing])
      .setBackground('#8B0000').setFontColor('#FFFFFF').setFontWeight('bold');
  }
}

/**
 * トリガーを設置（同じ関数のトリガーが既にあれば作らない）
 */
function ensureTriggers_(ss) {
  var existing = {};
  ScriptApp.getProjectTriggers().forEach(function(t) { existing[t.getHandlerFunction()] = true; });
  if (!existing['onFormSubmit']) {
    ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(ss.getId()).onFormSubmit().create();
  }
  if (!existing['syncFormChoices']) {
    ScriptApp.newTrigger('syncFormChoices').timeBased().atHour(6).everyDays(1).create();
  }
  if (!existing['processPendingResponses']) {
    ScriptApp.newTrigger('processPendingResponses').timeBased().everyMinutes(10).create();
  }
  // 毎日バックアップのトリガーは常に設置する。実行するかどうかは発火時に
  // 設定シートの dailyBackup を読んで決めるので、設定を切り替えるだけで
  // 有効化でき、トリガーの再設置も Web アプリの再デプロイも要らない。
  if (!existing['dailyBackupJob']) {
    var hour = Number(getConfigValue_('dailyBackupHour', 3));
    if (!isFinite(hour) || hour < 0 || hour > 23) hour = 3;
    ScriptApp.newTrigger('dailyBackupJob').timeBased().atHour(hour).everyDays(1).create();
  }
}

// ========================================
// 3. フォーム選択肢の同期
// ========================================

/**
 * 商品マスタと入力者シートから、フォームのプルダウン選択肢を更新する
 */
function syncFormChoices() {
  var products = getProductsData().data;
  var productChoices = Object.keys(products).sort().map(function(code) {
    return formatProductChoice_(products[code].name, code);
  });
  if (!productChoices.length) productChoices = ['（商品マスタが空です）'];

  var staff = getStaffList_();
  var staffChoices = staff.map(function(s) { return s.name; });
  if (!staffChoices.length) staffChoices = ['（入力者シートに名前を登録してください）'];

  var updated = 0;
  FI_KIND_ORDER_.forEach(function(kind) {
    var spec = getFormSpec_(kind);
    var form = openFormIfExists_(getConfigValue_(spec.formIdKey, ''));
    if (!form) return;
    // タイトル → 役割 の対応表を仕様から作る。
    // 「商品」の前方一致で判定すると、商品登録フォームの「商品名」「商品コード」まで
    // 商品スロットと誤認して選択肢で上書きしてしまう。
    var roles = {};
    formQuestionPlan_(spec).forEach(function(entry) {
      if (entry.q.role) roles[entry.title] = entry.q.role;
    });
    form.getItems(FormApp.ItemType.LIST).forEach(function(item) {
      var role = roles[item.getTitle()];
      if (!role) return;
      var list = item.asListItem();
      if (role === FI_ROLE_.STAFF) {
        list.setChoiceValues(staffChoices);
        updated++;
      } else if (role === FI_ROLE_.PRODUCT) {
        list.setChoiceValues(productChoices);
        updated++;
      }
    });
  });
  return { success: true, products: Object.keys(products).length, staff: staff.length, updatedItems: updated };
}

/**
 * フォームの商品選択肢の書式（admin/qr-generator.html の表示と同じ「商品名（CODE）」）
 */
function formatProductChoice_(name, code) {
  return String(name || code) + '（' + String(code) + '）';
}

/**
 * 「商品名（CODE）」から商品コードを取り出す
 */
function extractProductCode_(choice) {
  var s = String(choice || '').trim();
  var m = s.match(/[（(]\s*([A-Z0-9_-]+)\s*[)）]\s*$/i);
  if (m) return m[1].toUpperCase();
  return s.toUpperCase();
}

/**
 * 入力者シート（有効 = TRUE のみ）
 */
function getStaffList_() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(FI_SHEETS_.STAFF);
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < values.length; i++) {
    var name = String(values[i][0] || '').trim();
    if (!name) continue;
    var active = values[i][2];
    var isActive = (active === true) || (String(active).toUpperCase() === 'TRUE') || active === '' || active === undefined || active === null;
    if (!isActive) continue;
    list.push({ name: name, email: String(values[i][1] || '').trim(), note: String(values[i][3] || '') });
  }
  return list;
}

function resolveStaff_(name) {
  var target = String(name || '').trim();
  var list = getStaffList_();
  for (var i = 0; i < list.length; i++) {
    if (list[i].name === target) return list[i];
  }
  return null;
}

// ========================================
// 4. フォーム送信の処理
// ========================================

/**
 * スプレッドシートの「フォーム送信時」トリガーから呼ばれる
 */
function onFormSubmit(e) {
  try {
    if (!e || !e.range) {
      Logger.log('onFormSubmit: イベントに range がありません（手動実行？）。processPendingResponses() を使ってください。');
      return;
    }
    var sheet = e.range.getSheet();
    var row = e.range.getRow();
    processResponseRow_(sheet, row, {});
  } catch (err) {
    Logger.log('onFormSubmit エラー: ' + err);
    sendAdminMail_('【お守り在庫】フォーム処理でエラー', 'onFormSubmit で例外が発生しました。\n\n' + err + '\n\n' + (err && err.stack ? err.stack : ''));
  }
}

/**
 * 未処理（処理結果が空）の回答行をすべて処理する（トリガーの取りこぼし対策・手動再処理）
 */
function processPendingResponses() {
  var results = {};
  FI_KIND_ORDER_.forEach(function(kind) { results[kind] = 0; });
  results.errors = 0;

  FI_KIND_ORDER_.forEach(function(kind) {
    var sheet = getResponseSheet_(kind);
    if (!sheet) return;
    ensureResponseSheetColumns_(sheet);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    var statusCol = headers.indexOf('処理結果');
    var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    for (var i = 0; i < values.length; i++) {
      var hasTimestamp = values[i][0] !== '' && values[i][0] !== null;
      var status = statusCol >= 0 ? String(values[i][statusCol] || '') : '';
      if (!hasTimestamp || status) continue;
      try {
        var r = processResponseRow_(sheet, i + 2, {});
        if (r && r.status === FI_STATUS_.ERROR) results.errors++;
        else results[kind]++;
      } catch (err) {
        results.errors++;
        Logger.log('processPendingResponses 行 ' + (i + 2) + ': ' + err);
      }
    }
  });
  Logger.log('processPendingResponses: ' + JSON.stringify(results));
  return { success: true, processed: results };
}

/**
 * 回答シートの1行を処理する（冪等: 処理結果が入っている行は再処理しない）
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 回答シート
 * @param {number} row 行番号（1始まり）
 * @param {{force?:boolean}} opts
 * @return {{status:string, message?:string}}
 */
function processResponseRow_(sheet, row, opts) {
  opts = opts || {};
  var sheetName = sheet.getName();
  var kind = kindForResponseSheet_(sheetName);
  if (!kind) return { status: 'skipped', message: '対象外のシート: ' + sheetName };
  var spec = getFormSpec_(kind);

  ensureResponseSheetColumns_(sheet);
  var ref = sheetName + '!R' + row;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    writeResultCells_(sheet, row, { 'エラー': 'ロック取得に失敗（混雑）。10分毎の再処理で自動的に再試行されます: ' + e });
    return { status: 'locked' };
  }

  var rowData, staff, summaryText, c, post = {};
  try {
    rowData = readRowMap_(sheet, row);
    var currentStatus = String(rowData.map['処理結果'] || '');
    if (currentStatus && !opts.force) {
      return { status: 'already', message: '処理済み: ' + currentStatus };
    }
    if (rowData.values[0] === '' || rowData.values[0] === null) {
      return { status: 'skipped', message: 'タイムスタンプが空' };
    }

    writeResultCells_(sheet, row, { '処理結果': FI_STATUS_.PROCESSING, '処理日時': nowJa_(), 'エラー': '' });
    SpreadsheetApp.flush();

    staff = resolveStaff_(rowData.map[FI_Q_.STAFF]);
    var baseDate = toDate_(spec.dateTitle ? rowData.map[spec.dateTitle] : null) || toDate_(rowData.values[0]) || new Date();
    c = {
      spec: spec,
      kind: kind,
      sheet: sheet,
      row: row,
      ref: ref,
      rowData: rowData,
      map: rowData.map,
      products: getProductsData().data,
      staff: staff,
      staffName: String(rowData.map[FI_Q_.STAFF] || '').trim() || '不明',
      baseDate: baseDate,
      yy: yearSuffix_(baseDate)
    };

    // --- 在庫・履歴・発注の更新（ここは業務上重要なので先に確定させる） ---
    var handled = spec.handle(c) || {};
    summaryText = handled.summary || '';
    post = handled.post || {};

    var cells = {
      '処理結果': FI_STATUS_.STOCK_DONE,
      '処理日時': nowJa_(),
      '在庫反映内容': summaryText,
      'ラベル番号範囲': '',
      'バックアップ': ''
    };
    Object.keys(handled.cells || {}).forEach(function(k) { cells[k] = handled.cells[k]; });
    writeResultCells_(sheet, row, cells);
    SpreadsheetApp.flush();
  } catch (err) {
    writeResultCells_(sheet, row, { '処理結果': FI_STATUS_.ERROR, '処理日時': nowJa_(), 'エラー': String(err.message || err) });
    sendAdminMail_('【お守り在庫】フォーム回答の処理に失敗（' + ref + '）',
      '回答行: ' + ref + '\n\nエラー: ' + (err.message || err) + '\n\n' + (err.stack || '') +
      '\n\n※ 在庫は更新されていない可能性があります。回答シートの内容を確認し、必要なら手動で在庫を調整してください。');
    return { status: FI_STATUS_.ERROR, message: String(err.message || err) };
  } finally {
    lock.releaseLock();
  }

  // --- ロック外: PDF 作成とメール（失敗しても在庫は確定済み） ---
  var recipient = (staff && staff.email) ? staff.email : getConfigValue_('adminEmail', '');
  var staffLabel = c.staffName;
  try {
    var doneCells = (spec.postLock ? spec.postLock(c, post, recipient, staffLabel, summaryText) : null) || {};
    var finalCells = { '処理結果': FI_STATUS_.DONE, '処理日時': nowJa_() };
    Object.keys(doneCells).forEach(function(k) { finalCells[k] = doneCells[k]; });
    writeResultCells_(sheet, row, finalCells);
  } catch (err2) {
    writeResultCells_(sheet, row, { '処理結果': FI_STATUS_.PDF_FAILED, '処理日時': nowJa_(), 'エラー': String(err2.message || err2) });
    sendAdminMail_('【お守り在庫】ラベルPDF/メールの作成に失敗（' + ref + '）',
      '在庫の反映は完了していますが、PDF作成またはメール送信に失敗しました。\n\n回答行: ' + ref + '\nエラー: ' + (err2.message || err2) +
      '\n\n管理画面の「未処理の回答を再処理」ではなく、PDF再送（resendLabelPdf）を使ってください。\n\n' + (err2.stack || ''));
    return { status: FI_STATUS_.PDF_FAILED, message: String(err2.message || err2) };
  }
  return { status: FI_STATUS_.DONE };
}

/**
 * 入荷・出荷の反映（ロック内）。仕様表の sign / hasDest / reserveBoxes / checkLowStock で分岐する。
 *
 * @param {Object} c processResponseRow_ が組み立てた処理コンテキスト
 * @return {{summary:string, cells:Object, post:Object}}
 */
function handleStockLines_(c) {
  var spec = c.spec;
  var products = c.products;
  var lines = parseLines_(c.kind, c.map, products);
  var dest = spec.hasDest ? String(c.map[FI_Q_.DEST] || '').trim() : '';

  var summaryLines = [];
  var lowStock = [];
  var labelItems = [];

  lines.forEach(function(line) {
    var p = products[line.code];
    var before = Number(p.stock) || 0;
    var after = spec.sign > 0 ? before + line.quantity : Math.max(0, before - line.quantity);
    var partial = { stock: after };
    if (spec.sign > 0) {
      var consumed = consumeDeliveries_(p, line.quantity);
      if (consumed) {
        partial.ordered = consumed.ordered;
        partial.deliveries = consumed.deliveries;
      }
    }
    updateSingleProduct(line.code, partial);

    var note = spec.sign > 0
      ? 'フォーム入荷: ' + line.boxes + '箱 入力者:' + c.staffName
      : 'フォーム出荷: ' + line.boxes + '箱' + (line.pieces ? '(+' + line.pieces + '個)' : '') + ' 入力者:' + c.staffName + (dest ? ' 出荷先:' + dest : '');
    addHistoryRecord({
      date: nowJa_(),
      type: c.kind,
      productCode: line.code,
      productName: p.name,
      quantity: line.quantity,
      note: note
    });

    summaryLines.push(p.name + '（' + line.code + '）: ' + (spec.sign > 0 ? '+' : '-') + line.quantity + '個 → 在庫 ' + after + '個');

    if (spec.checkLowStock) {
      var safe = Number(p.safeStock) || 0;
      if (after < safe) lowStock.push({ code: line.code, name: p.name, stock: after, safeStock: safe });
    }
    line.after = after;
    line.name = p.name;
    line.unitQuantity = Number(p.quantity) || 0;
  });

  // --- 箱台帳: 採番と登録（入荷のみ） ---
  var rangeText = '';
  if (spec.reserveBoxes) {
    var rangeParts = [];
    lines.forEach(function(line) {
      var numbers = reserveBoxNumbers_(line.code, c.yy, line.boxes, 'form', c.ref);
      labelItems.push({ productCode: line.code, productName: line.name, unitQuantity: line.unitQuantity, year: c.yy, numbers: numbers });
      rangeParts.push(formatQrText_(line.code, c.yy, numbers[0]) + '〜' + pad4_(numbers[numbers.length - 1]));
    });
    rangeText = rangeParts.join(', ');
  }

  return {
    summary: summaryLines.join('\n'),
    cells: { 'ラベル番号範囲': rangeText },
    post: { labelItems: labelItems, lowStock: lowStock }
  };
}

/**
 * 入荷のロック外処理: ラベルPDFを作って入力者へメールする
 */
function postLockIntake_(c, post, recipient, staffLabel, summaryText) {
  var labelItems = post.labelItems || [];
  var labels = labelsFromBoxItems_(labelItems);
  var fileName = 'ラベル_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm') + '_' +
    labelItems.map(function(it) { return it.productCode; }).join('+').slice(0, 60);
  var pdf = buildLabelPdf_(labels, { fileName: fileName });
  sendLabelMail_(recipient, staffLabel, pdf, labelItems, summaryText, !(c.staff && c.staff.email));
  return { 'PDF URL': pdf.pdfFile.getUrl() };
}

/**
 * 出荷のロック外処理: 安心在庫を下回っていれば通知する
 */
function postLockShipping_(c, post, recipient, staffLabel, summaryText) {
  var lowStock = post.lowStock || [];
  if (lowStock.length && String(getConfigValue_('lowStockMail', 'TRUE')).toUpperCase() === 'TRUE') {
    sendLowStockMail_(recipient, lowStock, staffLabel);
  }
  return {};
}

/**
 * 行をヘッダー名 → 値 のマップで読む
 */
function readRowMap_(sheet, row) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h || '').trim(); });
  var values = sheet.getRange(row, 1, 1, lastCol).getValues()[0];
  var map = {};
  headers.forEach(function(h, i) { if (h) map[h] = values[i]; });
  return { headers: headers, values: values, map: map };
}

function writeResultCells_(sheet, row, obj) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h || '').trim(); });
  Object.keys(obj).forEach(function(key) {
    var idx = headers.indexOf(key);
    if (idx >= 0) sheet.getRange(row, idx + 1).setValue(obj[key]);
  });
}

/**
 * その欄に回答があったか。
 *
 * ★数値の 0 は「回答あり」。String(0) === '0' なので空文字と区別できる。
 *   ここを if (!v) や if (v) に書き換えると、棚卸で「実在庫 0 個」が
 *   「数えていない（未計上）」に化けて、在庫が実態と合わなくなる。
 */
function hasAnswer_(v) {
  if (v === undefined || v === null) return false;
  return String(v).trim() !== '';
}

/**
 * 棚卸フォームの 商品n / 実在庫数n を検証して配列にする。
 *
 * 空欄と 0 の扱い:
 *   商品も実在庫数も空 → 未計上（在庫を触らない）
 *   実在庫数が 0      → 在庫ゼロとして反映する
 *   どちらか片方だけ  → 入れ忘れとしてエラー（黙って捨てない）
 *
 * 入数は検証しない。棚卸は箱数ではなく絶対個数の申告なので、
 * 入数が 0 のまま登録されている既存商品でも数えられる必要がある。
 *
 * @return {Array<{slot:number, code:string, name:string, before:number, actual:number, diff:number}>}
 */
function parseInventoryLines_(map, products) {
  var spec = getFormSpec_('inv');
  var slots = spec ? spec.slots : FI_INV_SLOTS_;
  var maxCount = Number(getConfigValue_('maxInventoryCount', 100000));
  if (!isFinite(maxCount) || maxCount < 1) maxCount = 100000;
  var lines = [];
  var seen = {};

  for (var i = 1; i <= slots; i++) {
    var choice = map[FI_Q_.PRODUCT + i];
    var actualRaw = map[FI_Q_.ACTUAL + i];
    var hasChoice = hasAnswer_(choice);
    var hasActual = hasAnswer_(actualRaw);
    if (!hasChoice && !hasActual) continue;   // 数えていない枠
    if (!hasChoice) throw new Error('商品' + i + ' が選択されていません（実在庫数' + i + ' だけ入力されています）');
    if (!hasActual) throw new Error('実在庫数' + i + ' が入力されていません（数えていないなら商品' + i + ' も空にしてください。0 は「在庫ゼロ」の意味になります）');

    var code = extractProductCode_(choice);
    var p = products[code];
    // 未知のコードをここで止める。updateSingleProduct は未知コードを追記するため、
    // 通してしまうと商品管理シートに中身の無い行ができる。
    if (!p) throw new Error('商品' + i + ' のコードが商品マスタにありません: ' + choice + '（商品登録フォームで先に登録してください）');
    if (seen[code]) throw new Error('同じ商品が複数の枠に入力されています: ' + code + '（1つの枠にまとめてください）');
    seen[code] = true;

    var actual = Number(String(actualRaw).trim());
    if (!isFinite(actual) || actual < 0 || Math.floor(actual) !== actual) {
      throw new Error('実在庫数' + i + ' は 0 以上の整数で入力してください: ' + actualRaw);
    }
    if (actual > maxCount) {
      throw new Error('実在庫数' + i + ' が上限（' + maxCount + '個）を超えています: ' + actual + '（桁の入力ミスではありませんか）');
    }

    var before = Number(p.stock) || 0;
    lines.push({ slot: i, code: code, name: p.name, before: before, actual: actual, diff: actual - before });
  }

  if (!lines.length) throw new Error('商品が1つも入力されていません');
  return lines;
}

/**
 * 棚卸の反映（ロック内）。
 *
 * ★処理順は「解析 → バックアップ → 書き込み」。
 *   先にバックアップを取ると、入力ミスで解析に失敗しただけの回答でも
 *   バックアップ世代を1つ消費し、本当に必要な世代を押し出してしまう。
 */
function handleInventory_(c) {
  var products = c.products;
  var lines = parseInventoryLines_(c.map, products);

  var backupId = '';
  if (getConfigFlag_('backupBeforeFormInventory', 'TRUE')) {
    // ここは既に processResponseRow_ のロックの中。ロックを取らない takeBackup_ を使う
    backupId = takeBackup_('棚卸(フォーム)', c.staffName, c.ref, {}).backupId;
  }

  var note = String(c.map[FI_Q_.NOTE] || '').trim();
  var summaryLines = [];
  var changed = 0;

  lines.forEach(function(line) {
    updateSingleProduct(line.code, { stock: line.actual });
    if (line.diff !== 0) {
      changed++;
      addHistoryRecord({
        date: nowJa_(),
        type: line.diff > 0 ? 'in' : 'out',
        productCode: line.code,
        productName: line.name,
        quantity: Math.abs(line.diff),
        note: '棚卸(フォーム): ' + line.before + '→' + line.actual + ' (' + (line.diff > 0 ? '+' : '') + line.diff + ') 入力者:' + c.staffName + (note ? ' ' + note : '')
      });
    }
    summaryLines.push(line.name + '（' + line.code + '）: ' + line.before + ' → ' + line.actual + '個' +
      (line.diff === 0 ? '（差異なし）' : '（' + (line.diff > 0 ? '+' : '') + line.diff + '）'));
  });

  var untouched = Object.keys(products).length - lines.length;
  summaryLines.push('計上 ' + lines.length + '件 / 差異あり ' + changed + '件 / 未計上 ' + untouched + '件');

  return {
    summary: summaryLines.join('\n'),
    cells: { 'バックアップ': backupId },
    post: { backupId: backupId, changed: changed }
  };
}

/**
 * 回答行の 商品n / 箱数n / 端数n を検証して配列にする
 * @return {Array<{slot:number, code:string, boxes:number, pieces:number, quantity:number}>}
 */
function parseLines_(kind, map, products) {
  var spec = getFormSpec_(kind);
  var slots = spec ? spec.slots : 0;
  var maxPerLine = Number(getConfigValue_('maxBoxesPerLine', 50)) || 50;
  var maxTotal = Number(getConfigValue_('maxBoxesPerSubmission', 80)) || 80;
  var lines = [];
  var seen = {};
  var totalBoxes = 0;

  for (var i = 1; i <= slots; i++) {
    var choice = map[FI_Q_.PRODUCT + i];
    var boxesRaw = map[FI_Q_.BOXES + i];
    var piecesRaw = map[FI_Q_.PIECES + i];
    var hasChoice = hasAnswer_(choice);
    var hasBoxes = hasAnswer_(boxesRaw);
    var hasPieces = hasAnswer_(piecesRaw);
    if (!hasChoice && !hasBoxes && !hasPieces) continue;
    if (!hasChoice) throw new Error('商品' + i + ' が選択されていません');

    var code = extractProductCode_(choice);
    var p = products[code];
    if (!p) throw new Error('商品' + i + ' のコードが商品マスタにありません: ' + choice);
    if (seen[code]) throw new Error('同じ商品が複数の枠に入力されています: ' + code + '（1つの枠にまとめてください）');
    seen[code] = true;

    var boxes = hasBoxes ? Number(String(boxesRaw).trim()) : 0;
    var pieces = (spec.hasPieces && hasPieces) ? Number(String(piecesRaw).trim()) : 0;
    if (!isFinite(boxes) || boxes < 0 || Math.floor(boxes) !== boxes) throw new Error('箱数' + i + ' は 0 以上の整数で入力してください: ' + boxesRaw);
    if (!isFinite(pieces) || pieces < 0 || Math.floor(pieces) !== pieces) throw new Error('端数' + i + ' は 0 以上の整数で入力してください: ' + piecesRaw);
    if (kind === 'in' && boxes < 1) throw new Error('箱数' + i + ' は 1 以上で入力してください');
    if (boxes > maxPerLine) throw new Error('箱数' + i + ' が上限（' + maxPerLine + '箱）を超えています: ' + boxes);

    var unit = Number(p.quantity) || 0;
    var quantity = boxes * unit + pieces;
    if (kind === 'in' && unit <= 0) throw new Error('商品 ' + code + ' の入数が 0 のため数量を計算できません（商品マスタを確認）');
    if (quantity <= 0) throw new Error('商品' + i + ' の数量が 0 です');

    totalBoxes += boxes;
    lines.push({ slot: i, code: code, boxes: boxes, pieces: pieces, quantity: quantity });
  }

  if (!lines.length) throw new Error('商品が1つも入力されていません');
  if (kind === 'in' && totalBoxes > maxTotal) throw new Error('箱数の合計が上限（' + maxTotal + '箱）を超えています: ' + totalBoxes + '箱。複数回に分けて送信してください');
  return lines;
}

function toDate_(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function yearSuffix_(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yy');
}

function pad4_(n) {
  var s = String(n);
  while (s.length < 4) s = '0' + s;
  return s;
}

// ========================================
// 5. 発注（分納）の消し込み  ← js/app.js updateOrderQuantityOnDelivery と同じ考え方
// ========================================

/**
 * 納品数量を、納期が早い分納から順に消化する
 * @param {{ordered:boolean, deliveries:Array<{quantity:number, date:string}>}} product 商品管理の1行
 * @param {number} deliveredQuantity 入荷した個数
 * @return {{ordered:boolean, deliveries:Array}|null} 変更が無ければ null
 */
function consumeDeliveries_(product, deliveredQuantity) {
  if (!product || !product.ordered) return null;
  var deliveries = (product.deliveries || []).map(function(d) {
    return { quantity: Number(d.quantity) || 0, date: (d.date === undefined || d.date === null) ? '' : String(d.date) };
  });
  if (!deliveries.length) return null;

  deliveries.sort(compareDeliveryDates_);

  var remaining = deliveredQuantity;
  var updated = [];
  deliveries.forEach(function(d) {
    if (remaining <= 0) {
      updated.push(d);
    } else if (remaining >= d.quantity) {
      remaining -= d.quantity;   // この分納を完全に消化
    } else {
      updated.push({ quantity: d.quantity - remaining, date: d.date });
      remaining = 0;
    }
  });

  return { ordered: updated.length > 0, deliveries: updated };
}

/**
 * 納期の比較（早い順。空は最後）。'2026-01-31' / '2026/1/31' / '1/31'（当年扱い）に対応
 */
function compareDeliveryDates_(a, b) {
  var ta = parseDeliveryDate_(a.date);
  var tb = parseDeliveryDate_(b.date);
  if (ta === tb) return 0;
  if (ta === null) return 1;
  if (tb === null) return -1;
  return ta - tb;
}

function parseDeliveryDate_(s) {
  if (s === undefined || s === null) return null;
  if (s instanceof Date) return isNaN(s.getTime()) ? null : s.getTime();
  var str = String(s).trim();
  if (!str || str === '未定') return null;
  var m;
  if ((m = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/))) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  }
  if ((m = str.match(/^(\d{1,2})[-\/](\d{1,2})$/))) {
    var now = new Date();
    return new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2])).getTime();
  }
  var d = new Date(str);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// ========================================
// 6. 箱台帳（採番・二重計上防止）
// ========================================

function getLedgerSheet_() {
  var ss = getSpreadsheet();
  return ensureSheetWithHeaders_(ss, FI_SHEETS_.LEDGER, FI_LEDGER_HEADERS_, '#4a4a4a');
}

function readLedger_() {
  var sheet = getLedgerSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { sheet: sheet, rows: [], index: {} };
  var values = sheet.getRange(2, 1, lastRow - 1, FI_LEDGER_HEADERS_.length).getValues();
  var index = {};
  values.forEach(function(r, i) {
    var qr = String(r[0] || '').trim();
    if (qr) index[qr] = i + 2;
  });
  return { sheet: sheet, rows: values, index: index };
}

/**
 * 商品コード×年の最大箱番号+1 から count 個を採番し、台帳に登録する
 * @return {number[]} 採番した箱番号
 */
function reserveBoxNumbers_(productCode, year, count, source, ref) {
  var ledger = readLedger_();
  var yy = String(year);
  var max = 0;
  ledger.rows.forEach(function(r) {
    if (String(r[1]).toUpperCase() === String(productCode).toUpperCase() && String(r[2]) === yy) {
      var n = Number(r[3]) || 0;
      if (n > max) max = n;
    }
  });
  var numbers = [];
  var rows = [];
  var now = nowJa_();
  for (var i = 1; i <= count; i++) {
    var num = max + i;
    numbers.push(num);
    rows.push([formatQrText_(productCode, yy, num), String(productCode).toUpperCase(), yy, num,
      source === 'form' ? FI_LEDGER_STATUS_.IN : FI_LEDGER_STATUS_.ISSUED, now, source || '', source === 'form' ? now : '', '', ref || '', '']);
  }
  if (rows.length) {
    ledger.sheet.getRange(ledger.sheet.getLastRow() + 1, 1, rows.length, FI_LEDGER_HEADERS_.length).setValues(rows);
  }
  return numbers;
}

function getNextBoxNumber_(productCode, year) {
  var ledger = readLedger_();
  var yy = String(year);
  var max = 0;
  ledger.rows.forEach(function(r) {
    if (String(r[1]).toUpperCase() === String(productCode).toUpperCase() && String(r[2]) === yy) {
      var n = Number(r[3]) || 0;
      if (n > max) max = n;
    }
  });
  return max + 1;
}

/**
 * 指定範囲の箱を台帳に登録する（既に存在する QR は登録せず conflicts に返す）
 */
function ledgerRegister_(productCode, year, start, count, status, source, ref) {
  var ledger = readLedger_();
  var yy = String(year);
  var now = nowJa_();
  var rows = [];
  var conflicts = [];
  for (var i = 0; i < count; i++) {
    var num = start + i;
    var qr = formatQrText_(productCode, yy, num);
    if (ledger.index[qr]) {
      conflicts.push(qr);
      continue;
    }
    rows.push([qr, String(productCode).toUpperCase(), yy, num, status, now, source || '', status === FI_LEDGER_STATUS_.IN ? now : '', status === FI_LEDGER_STATUS_.OUT ? now : '', ref || '', '']);
  }
  if (rows.length) {
    ledger.sheet.getRange(ledger.sheet.getLastRow() + 1, 1, rows.length, FI_LEDGER_HEADERS_.length).setValues(rows);
  }
  return { registered: rows.length, conflicts: conflicts };
}

/**
 * QR文字列ごとの台帳状態を返す（未登録は status: 'unknown'）
 */
function ledgerCheck_(qrCodes) {
  var ledger = readLedger_();
  var result = {};
  (qrCodes || []).forEach(function(qr) {
    var key = String(qr || '').trim();
    var rowIdx = ledger.index[key];
    if (!rowIdx) {
      result[key] = { status: 'unknown' };
    } else {
      var r = ledger.rows[rowIdx - 2];
      result[key] = { status: String(r[4] || ''), issuedAt: String(r[5] || ''), source: String(r[6] || ''), inAt: String(r[7] || ''), outAt: String(r[8] || ''), ref: String(r[9] || '') };
    }
  });
  return result;
}

/**
 * QR文字列の状態を更新（未登録なら QR から商品コード・年・番号を解釈して追加）
 */
function ledgerMark_(qrCodes, status, source, ref) {
  var ledger = readLedger_();
  var now = nowJa_();
  var appended = [];
  var updated = 0;
  (qrCodes || []).forEach(function(qr) {
    var key = String(qr || '').trim();
    if (!key) return;
    var rowIdx = ledger.index[key];
    if (rowIdx) {
      var r = ledger.rows[rowIdx - 2];
      r[4] = status;
      if (status === FI_LEDGER_STATUS_.IN) r[7] = now;
      if (status === FI_LEDGER_STATUS_.OUT) r[8] = now;
      r[9] = ref || r[9];
      ledger.sheet.getRange(rowIdx, 1, 1, FI_LEDGER_HEADERS_.length).setValues([r]);
      updated++;
    } else {
      var m = key.match(/^([A-Z0-9_-]+)-(\d{2})-(\d{4})$/i);
      var code = m ? m[1].toUpperCase() : '';
      var yy = m ? m[2] : '';
      var num = m ? Number(m[3]) : '';
      appended.push([key, code, yy, num, status, now, source || '', status === FI_LEDGER_STATUS_.IN ? now : '', status === FI_LEDGER_STATUS_.OUT ? now : '', ref || '', '旧ラベル（初回スキャン時に登録）']);
    }
  });
  if (appended.length) {
    ledger.sheet.getRange(ledger.sheet.getLastRow() + 1, 1, appended.length, FI_LEDGER_HEADERS_.length).setValues(appended);
  }
  return { updated: updated, added: appended.length };
}

// ========================================
// 6.5 バックアップと復元
// ========================================
//
// 棚卸は在庫を絶対値で上書きするため、取り違えると元に戻す手段が無い。
// そこで「商品管理シートの行そのもの」を2枚のシートに台帳として貯める。
//
//   バックアップ台帳: 1世代1行（backupId / 日時 / きっかけ / 実行者 / 商品数 / 備考）
//   バックアップ明細: 1世代 商品数ぶんの行（backupId + 商品管理の A〜K 列）
//
// シートを copyTo() で複製しない理由: copyTo は使用範囲ではなくグリッド全体
// （既定 1000×26 = 26,000 セル）を複製するため、30世代で 78 万セル（ブック上限の 7.8%）
// を占める。さらにタブが増えると findNewResponseSheet_ の予備ロジックが
// バックアップシートを回答シートと誤認する危険がある。

var FI_BACKUP_SHEETS_ = {
  LEDGER: 'バックアップ台帳',
  DETAIL: 'バックアップ明細'
};

var FI_BACKUP_LEDGER_HEADERS_ = ['backupId', '日時', 'きっかけ', '実行者', '商品数', '備考'];

// 商品管理の A〜K 列を保存する。L（更新日時）は保存しない（復元時は「今」を刻む）
var FI_PRODUCT_COLS_ = 11;
var FI_PRODUCT_COL_LABELS_ = ['商品コード', '商品名', '入数', '単価（税込）', '発注先', '担当者', 'メールアドレス', '現在庫', '安心在庫', '発注状況', '発注数/納期'];
var FI_BACKUP_DETAIL_HEADERS_ = ['backupId'].concat(FI_PRODUCT_COL_LABELS_);

// 復元の範囲。cols は商品管理シートの列番号（1始まり）。A列（商品コード）は照合キーなので変えない
var FI_RESTORE_SCOPES_ = {
  stock: { label: '在庫のみ（現在庫・安心在庫）', cols: [8, 9] },
  all: { label: 'すべて（商品名〜発注数/納期）', cols: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
};

var FI_BACKUP_ID_PREFIX_ = 'BK_';
var FI_RESTORE_ID_PREFIX_ = 'RS_';

/**
 * 設定シートの TRUE/FALSE を読む
 */
function getConfigFlag_(key, defaultValue) {
  return String(getConfigValue_(key, defaultValue)).trim().toUpperCase() === 'TRUE';
}

function getProductsSheet_() {
  var sheet = getSpreadsheet().getSheetByName(SHEET_NAMES.PRODUCTS);
  if (!sheet) throw new Error('商品管理シートが見つかりません');
  return sheet;
}

/**
 * 商品管理の A〜K を読む（ヘッダー行を除き、商品コードのある行だけ）
 */
function readProductRows_() {
  var sheet = getProductsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { sheet: sheet, rows: [] };
  var values = sheet.getRange(2, 1, lastRow - 1, FI_PRODUCT_COLS_).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0] === undefined || values[i][0] === null ? '' : values[i][0]).trim() === '') continue;
    rows.push(values[i]);
  }
  return { sheet: sheet, rows: rows };
}

function ensureBackupSheets_() {
  var ss = getSpreadsheet();
  return {
    ledger: ensureSheetWithHeaders_(ss, FI_BACKUP_SHEETS_.LEDGER, FI_BACKUP_LEDGER_HEADERS_, '#2e5d34'),
    detail: ensureSheetWithHeaders_(ss, FI_BACKUP_SHEETS_.DETAIL, FI_BACKUP_DETAIL_HEADERS_, '#2e5d34')
  };
}

/**
 * BK_yyyyMMdd_HHmmss（同じ秒に2回走ったら _2, _3 …）。文字列順＝時系列順になる
 */
function nextBackupId_(ledger, prefix) {
  var base = (prefix || FI_BACKUP_ID_PREFIX_) + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  var existing = {};
  var lastRow = ledger.getLastRow();
  if (lastRow >= 2) {
    ledger.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function(r) {
      var id = String(r[0] || '').trim();
      if (id) existing[id] = true;
    });
  }
  if (!existing[base]) return base;
  for (var n = 2; n <= 99; n++) {
    if (!existing[base + '_' + n]) return base + '_' + n;
  }
  throw new Error('backupId を採番できませんでした: ' + base);
}

/**
 * 商品管理の現在の内容を1世代ぶん書き出す。
 *
 * ★この関数は ScriptLock を取らない。
 *   棚卸フォームの処理（processResponseRow_）のロック内から呼ばれるため、
 *   ここでロックを取ると 30 秒待って必ず例外になる（ScriptLock は再入できない）。
 *   単独で呼ぶときは takeBackupLocked_ を使うこと。
 *
 * @param {string} reason きっかけ（「棚卸(フォーム)」「復元前」「手動」など）
 * @param {string} actor 実行者
 * @param {string} note 備考
 * @param {{prune?:boolean}} opts prune:false で世代整理をしない（復元前の控えなど）
 * @return {{backupId:string, count:number}}
 */
function takeBackup_(reason, actor, note, opts) {
  opts = opts || {};
  var sheets = ensureBackupSheets_();
  var read = readProductRows_();
  var id = nextBackupId_(sheets.ledger, FI_BACKUP_ID_PREFIX_);
  if (read.rows.length) {
    var out = read.rows.map(function(r) { return [id].concat(r); });
    sheets.detail.getRange(sheets.detail.getLastRow() + 1, 1, out.length, FI_BACKUP_DETAIL_HEADERS_.length).setValues(out);
  }
  sheets.ledger.appendRow([id, nowJa_(), String(reason || ''), String(actor || ''), read.rows.length, String(note || '')]);
  if (opts.prune !== false) pruneBackups_();
  return { backupId: id, count: read.rows.length };
}

/**
 * 単独で呼ぶとき用（Webアクション・毎日のジョブ）。ロック内からは呼ばないこと
 */
function takeBackupLocked_(reason, actor, note) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return takeBackup_(reason, actor, note, {});
  } finally {
    lock.releaseLock();
  }
}

/**
 * 保持世代数を超えた古いバックアップを消す。
 * 台帳・明細とも「残す行だけ書き戻す」方式（行ごとの削除は行数が増えると遅いため）。
 * 復元の記録（RS_）はバックアップ本体（BK_）とは別枠で数える。
 */
function pruneBackups_() {
  var max = Number(getConfigValue_('maxBackups', 30));
  if (!isFinite(max) || max < 1) max = 30;
  var sheets = ensureBackupSheets_();
  var lastRow = sheets.ledger.getLastRow();
  if (lastRow < 2) return { removed: 0 };

  var lcols = FI_BACKUP_LEDGER_HEADERS_.length;
  var rows = sheets.ledger.getRange(2, 1, lastRow - 1, lcols).getValues()
    .filter(function(r) { return String(r[0] || '').trim() !== ''; });

  var drop = {};
  [FI_BACKUP_ID_PREFIX_, FI_RESTORE_ID_PREFIX_].forEach(function(prefix) {
    var group = rows.filter(function(r) { return String(r[0]).indexOf(prefix) === 0; });
    if (group.length <= max) return;
    group.slice(0, group.length - max).forEach(function(r) { drop[String(r[0])] = true; });
  });
  var dropIds = Object.keys(drop);
  if (!dropIds.length) return { removed: 0 };

  var keep = rows.filter(function(r) { return !drop[String(r[0])]; });
  sheets.ledger.getRange(2, 1, lastRow - 1, lcols).clearContent();
  if (keep.length) sheets.ledger.getRange(2, 1, keep.length, lcols).setValues(keep);

  var dLast = sheets.detail.getLastRow();
  if (dLast >= 2) {
    var dcols = FI_BACKUP_DETAIL_HEADERS_.length;
    var all = sheets.detail.getRange(2, 1, dLast - 1, dcols).getValues();
    var keepDetail = all.filter(function(r) {
      var id = String(r[0] || '').trim();
      return id !== '' && !drop[id];
    });
    sheets.detail.getRange(2, 1, dLast - 1, dcols).clearContent();
    if (keepDetail.length) sheets.detail.getRange(2, 1, keepDetail.length, dcols).setValues(keepDetail);
  }
  return { removed: dropIds.length };
}

/**
 * バックアップ一覧（新しい順）。復元の記録（RS_）は含めない
 */
function listBackups_(limit) {
  var sheets = ensureBackupSheets_();
  var lastRow = sheets.ledger.getLastRow();
  if (lastRow < 2) return [];
  var values = sheets.ledger.getRange(2, 1, lastRow - 1, FI_BACKUP_LEDGER_HEADERS_.length).getValues();
  var list = [];
  values.forEach(function(r) {
    var id = String(r[0] || '').trim();
    if (id.indexOf(FI_BACKUP_ID_PREFIX_) !== 0) return;
    list.push({
      backupId: id,
      at: cellText_(r[1]),
      reason: String(r[2] || ''),
      actor: String(r[3] || ''),
      count: Number(r[4]) || 0,
      note: String(r[5] || '')
    });
  });
  list.reverse();
  var n = Number(limit) || 0;
  return n > 0 ? list.slice(0, n) : list;
}

function readBackupRows_(backupId) {
  var id = String(backupId || '').trim();
  if (!id) throw new Error('backupId を指定してください');
  var sheets = ensureBackupSheets_();
  var lastRow = sheets.detail.getLastRow();
  var rows = [];
  if (lastRow >= 2) {
    var cols = FI_BACKUP_DETAIL_HEADERS_.length;
    sheets.detail.getRange(2, 1, lastRow - 1, cols).getValues().forEach(function(r) {
      if (String(r[0] || '').trim() === id) rows.push(r.slice(1));
    });
  }
  if (!rows.length) {
    throw new Error('バックアップが見つかりません: ' + id + '（保持世代数を超えて削除された可能性があります）');
  }
  return rows;
}

/**
 * セルの値を比較用の文字列にする（数値の 100 と文字列の "100" を同じ値として扱う）
 */
function cellText_(v) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  return String(v).trim();
}

function sameCellValue_(a, b) {
  return cellText_(a) === cellText_(b);
}

function normalizeRestoreScope_(scope) {
  return FI_RESTORE_SCOPES_[scope] ? scope : 'stock';
}

/**
 * 復元したら何が変わるかを、書き込まずに調べる
 * @return {{backupId, scope, scopeLabel, changes, changeCount, truncated, added, missing}}
 *   changes: 値が変わる商品   added: バックアップに無いので据え置く商品
 *   missing: バックアップにあるが今の商品管理に無い商品（復活させない）
 */
function previewRestore_(backupId, scope) {
  var scopeKey = normalizeRestoreScope_(scope);
  var sc = FI_RESTORE_SCOPES_[scopeKey];
  var backupRows = readBackupRows_(backupId);
  var byCode = {};
  backupRows.forEach(function(r) { byCode[String(r[0] || '').trim()] = r; });

  var read = readProductRows_();
  var changes = [], added = [], missing = [], seen = {};
  read.rows.forEach(function(cur) {
    var code = String(cur[0] || '').trim();
    var b = byCode[code];
    if (!b) { added.push({ code: code, name: String(cur[1] || '') }); return; }
    seen[code] = true;
    var fields = [];
    sc.cols.forEach(function(col) {
      var idx = col - 1;
      if (!sameCellValue_(cur[idx], b[idx])) {
        fields.push({ label: FI_PRODUCT_COL_LABELS_[idx], from: cellText_(cur[idx]), to: cellText_(b[idx]) });
      }
    });
    if (fields.length) changes.push({ code: code, name: String(cur[1] || ''), fields: fields });
  });
  Object.keys(byCode).forEach(function(code) {
    if (!seen[code]) missing.push({ code: code, name: String(byCode[code][1] || '') });
  });

  var limit = 200;
  return {
    backupId: String(backupId),
    scope: scopeKey,
    scopeLabel: sc.label,
    changes: changes.length > limit ? changes.slice(0, limit) : changes,
    changeCount: changes.length,
    truncated: changes.length > limit,
    added: added,
    missing: missing
  };
}

/**
 * バックアップから復元する。順序に意味がある。
 *  1. ロックを取る
 *  2. 先にバックアップ行を読む（この後の世代整理が復元元を消しても大丈夫なように）
 *  3. 今の状態を「復元前」として控える（prune:false）→ 復元そのものを取り消せる
 *  4. 商品管理を1回だけ読み、対象列だけ差し替えて1回で書き戻す
 *  5. バックアップに無い商品は触らない（added）／バックアップにあって今無い商品は復活させない（missing）
 *  6. 台帳に記録し管理者へ通知。履歴シートには書かない
 *     （79商品の復元で履歴上限1000行の8%を消費してしまうため。監査記録は台帳が担う）
 */
function restoreBackup_(backupId, scope, actor) {
  var scopeKey = normalizeRestoreScope_(scope);
  var sc = FI_RESTORE_SCOPES_[scopeKey];
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var backupRows = readBackupRows_(backupId);
    var byCode = {};
    backupRows.forEach(function(r) { byCode[String(r[0] || '').trim()] = r; });

    var pre = takeBackup_('復元前', actor || '', '復元元: ' + backupId, { prune: false });

    var sheet = getProductsSheet_();
    var lastRow = sheet.getLastRow();
    var width = FI_PRODUCT_COLS_ + 1;   // L（更新日時）まで書き戻す
    var grid = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, width).getValues() : [];
    var stamp = nowJa_();
    var restored = [], added = [], seen = {};

    for (var i = 0; i < grid.length; i++) {
      var row = grid[i];
      var code = String(row[0] === undefined || row[0] === null ? '' : row[0]).trim();
      if (!code) continue;
      var b = byCode[code];
      if (!b) { added.push({ code: code, name: String(row[1] || '') }); continue; }
      seen[code] = true;
      var changed = false;
      for (var k = 0; k < sc.cols.length; k++) {
        var idx = sc.cols[k] - 1;
        if (!sameCellValue_(row[idx], b[idx])) { row[idx] = b[idx]; changed = true; }
      }
      if (changed) {
        row[FI_PRODUCT_COLS_] = stamp;
        restored.push({ code: code, name: String(row[1] || '') });
      }
    }
    if (grid.length) sheet.getRange(2, 1, grid.length, width).setValues(grid);

    var missing = [];
    Object.keys(byCode).forEach(function(code) {
      if (!seen[code]) missing.push({ code: code, name: String(byCode[code][1] || '') });
    });

    var sheets = ensureBackupSheets_();
    sheets.ledger.appendRow([
      nextBackupId_(sheets.ledger, FI_RESTORE_ID_PREFIX_),
      nowJa_(), '復元', String(actor || ''), restored.length,
      '復元元: ' + backupId + ' / 範囲: ' + sc.label + ' / 取り消し用: ' + pre.backupId +
      (added.length ? ' / 据え置き ' + added.length + '件' : '') +
      (missing.length ? ' / 復活させず ' + missing.length + '件' : '')
    ]);

    sendAdminMail_('【お守り在庫】バックアップから復元しました（' + backupId + '）',
      '商品管理シートを ' + backupId + ' の内容で復元しました。\n' +
      '範囲: ' + sc.label + '\n' +
      '値が変わった商品: ' + restored.length + '件\n' +
      'バックアップに無いため据え置いた商品: ' + added.length + '件\n' +
      'バックアップにあるが現在の商品管理に無い商品（復活させていません）: ' + missing.length + '件\n\n' +
      'この復元を取り消すには、バックアップ ' + pre.backupId + '（きっかけ「復元前」）を同じ範囲で復元してください。');

    return {
      success: true,
      backupId: String(backupId),
      scope: scopeKey,
      scopeLabel: sc.label,
      restored: restored,
      restoredCount: restored.length,
      added: added,
      missing: missing,
      undoBackupId: pre.backupId
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 毎日のバックアップ。トリガーは常に設置してあり、実行するかどうかは
 * 発火時に設定シートを読んで決める（設定を切り替えるだけで有効化できる）。
 */
function dailyBackupJob() {
  if (!getConfigFlag_('dailyBackup', 'FALSE')) {
    Logger.log('dailyBackupJob: 設定 dailyBackup が FALSE のため何もしません');
    return { success: true, skipped: true };
  }
  var r = takeBackupLocked_('毎日', 'システム', '自動バックアップ');
  Logger.log('dailyBackupJob: ' + JSON.stringify(r));
  return { success: true, backupId: r.backupId, count: r.count };
}

// ========================================
// 7. メール
// ========================================

function mailOptions_(extra) {
  var opts = { name: String(getConfigValue_('mailSenderName', 'お守り在庫管理')) };
  Object.keys(extra || {}).forEach(function(k) { opts[k] = extra[k]; });
  return opts;
}

function sendAdminMail_(subject, body) {
  var to = getConfigValue_('adminEmail', '');
  if (!to) {
    Logger.log('adminEmail 未設定のため通知できません: ' + subject + '\n' + body);
    return;
  }
  try {
    MailApp.sendEmail(to, subject, body, mailOptions_());
  } catch (e) {
    Logger.log('管理者メール送信失敗: ' + e);
  }
}

/**
 * 入荷ラベルPDF を入力者へ送る
 */
function sendLabelMail_(to, staffName, pdf, labelItems, summaryText, fallbackToAdmin) {
  if (!to) throw new Error('送信先メールアドレスがありません（入力者シートのメール、または設定の adminEmail を確認）');
  var totalLabels = pdf.count;
  var subject = '【お守り在庫】入荷ラベル ' + totalLabels + '枚（' + labelItems.map(function(it) { return it.productName; }).join('・').slice(0, 40) + '）';
  var lines = [];
  lines.push(staffName + ' さん');
  lines.push('');
  lines.push('入荷登録を受け付け、在庫に反映しました。箱に貼るラベルの PDF を添付します。');
  if (fallbackToAdmin) lines.push('※ 入力者のメールアドレスが未登録のため、管理者宛に送っています。');
  lines.push('');
  lines.push('■ 在庫反映内容');
  lines.push(summaryText);
  lines.push('');
  lines.push('■ ラベル番号');
  labelItems.forEach(function(it) {
    lines.push('・' + it.productName + '（' + it.productCode + '）: ' + formatQrText_(it.productCode, it.year, it.numbers[0]) + ' 〜 ' + pad4_(it.numbers[it.numbers.length - 1]) + '（' + it.numbers.length + '枚）');
  });
  lines.push('');
  lines.push('■ 印刷のヒント');
  lines.push('・用紙: ' + LABEL_SHEET_.name + '（A4・8面）、' + pdf.pages + 'ページ');
  lines.push('・プリンター設定は「実際のサイズ（100%）」、「ページに合わせる」はオフ');
  lines.push('・ズレる場合はスプレッドシートの「設定」シート offsetX_mm / offsetY_mm で調整');
  lines.push('');
  lines.push('PDF: ' + pdf.pdfFile.getUrl());
  var quota = null;
  try { quota = MailApp.getRemainingDailyQuota(); } catch (e) { quota = null; }
  MailApp.sendEmail(to, subject, lines.join('\n'), mailOptions_({ attachments: [pdf.pdfBlob] }));
  if (quota !== null && quota < 20) {
    sendAdminMail_('【お守り在庫】メール送信の残り回数が少なくなっています', '本日の残り送信可能数: ' + quota + '\n上限に達するとラベルPDFのメール送付ができません（PDFはDriveに保存されます）。');
  }
}

/**
 * 出荷で安心在庫を下回った商品を通知
 */
function sendLowStockMail_(to, items, staffName) {
  var admin = getConfigValue_('adminEmail', '');
  var recipients = [];
  if (to) recipients.push(to);
  if (admin && recipients.indexOf(admin) < 0) recipients.push(admin);
  if (!recipients.length) return;
  var subject = '【お守り在庫】安心在庫を下回りました（' + items.map(function(i) { return i.name; }).join('・').slice(0, 40) + '）';
  var lines = ['出荷登録（入力者: ' + staffName + '）の結果、以下の商品が安心在庫を下回りました。', ''];
  items.forEach(function(i) {
    lines.push('・' + i.name + '（' + i.code + '）: 残り ' + i.stock + '個（安心在庫 ' + i.safeStock + '個）');
  });
  lines.push('');
  lines.push('発注の検討をお願いします。管理画面「在庫管理」→「発注準備」から見積依頼メールの下書きを作成できます。');
  try {
    MailApp.sendEmail(recipients.join(','), subject, lines.join('\n'), mailOptions_());
  } catch (e) {
    Logger.log('安心在庫メール送信失敗: ' + e);
  }
}

// ========================================
// 8. Web アクション（Code.gs の doGet default から委譲）
// ========================================

/**
 * @param {string} action
 * @param {Object} data  doGet が JSON パース済みの data パラメータ
 * @param {Object} e     元のイベント
 * @return {Object|null} 未知のアクションなら null（doGet 側で Unknown action を返す）
 */
function routeExtended_(action, data, e) {
  data = data || {};
  switch (action) {
    case 'getFormConfig':
      return getFormConfig_();

    case 'getStaff':
      return { success: true, data: getStaffList_().map(function(s) { return { name: s.name, hasEmail: !!s.email }; }) };

    case 'syncFormChoices':
      return syncFormChoices();

    case 'processPendingResponses':
      return processPendingResponses();

    case 'getNextBoxNumber': {
      if (!data.productCode) return { success: false, error: 'productCode が必要です' };
      var yy = data.year ? String(data.year) : yearSuffix_(new Date());
      return { success: true, data: { productCode: String(data.productCode).toUpperCase(), year: yy, next: getNextBoxNumber_(data.productCode, yy) } };
    }

    case 'registerBoxes': {
      if (!data.productCode || !data.year || !data.start || !data.count) return { success: false, error: 'productCode, year, start, count が必要です' };
      var r = ledgerRegister_(data.productCode, data.year, Number(data.start), Number(data.count), FI_LEDGER_STATUS_.ISSUED, data.source || 'qrgen', data.ref || '');
      return { success: r.conflicts.length === 0, registered: r.registered, conflicts: r.conflicts,
        error: r.conflicts.length ? '既に台帳にある番号があります: ' + r.conflicts.slice(0, 5).join(', ') + (r.conflicts.length > 5 ? ' ほか' : '') : undefined };
    }

    case 'checkBoxes': {
      var codes = Array.isArray(data.qrCodes) ? data.qrCodes : [];
      return { success: true, data: ledgerCheck_(codes) };
    }

    case 'markBoxes': {
      var list = Array.isArray(data.qrCodes) ? data.qrCodes : [];
      var status = data.status === 'out' || data.status === FI_LEDGER_STATUS_.OUT ? FI_LEDGER_STATUS_.OUT : FI_LEDGER_STATUS_.IN;
      var m = ledgerMark_(list, status, data.source || 'app', data.ref || '');
      return { success: true, updated: m.updated, added: m.added };
    }

    case 'createLabelPdf':
      return createLabelPdfAction_(data);

    case 'resendLabelPdf':
      return resendLabelPdfAction_(data);

    default:
      return null;
  }
}

function getFormConfig_() {
  var cfg = getConfigMap_();
  var handlers = {};
  try {
    ScriptApp.getProjectTriggers().forEach(function(t) { handlers[t.getHandlerFunction()] = true; });
  } catch (e) {
    // Web アプリ実行時に取得できない場合がある
  }
  var products = 0;
  try { products = Object.keys(getProductsData().data).length; } catch (e) { products = 0; }
  var folderUrl = '';
  try { if (cfg.driveFolderId) folderUrl = DriveApp.getFolderById(cfg.driveFolderId).getUrl(); } catch (e) { folderUrl = ''; }
  return {
    success: true,
    data: {
      inFormUrl: cfg.inFormUrl || '',
      inFormEditUrl: cfg.inFormEditUrl || '',
      outFormUrl: cfg.outFormUrl || '',
      outFormEditUrl: cfg.outFormEditUrl || '',
      spreadsheetUrl: getSpreadsheet().getUrl(),
      folderUrl: folderUrl,
      adminEmail: cfg.adminEmail || '',
      staffCount: getStaffList_().length,
      productCount: products,
      templateReady: !!cfg.labelTemplateId,
      triggers: {
        onFormSubmit: !!handlers['onFormSubmit'],
        syncFormChoices: !!handlers['syncFormChoices'],
        processPendingResponses: !!handlers['processPendingResponses']
      },
      setupDone: !!(cfg.inFormId && cfg.outFormId)
    }
  };
}

/**
 * QR生成画面から: 指定範囲のラベルPDFを作成し、メール送付（任意）と台帳登録（任意）を行う
 * data: { productCode, year, start, count, to?, register? }
 */
function createLabelPdfAction_(data) {
  try {
    var code = String(data.productCode || '').toUpperCase();
    var year = String(data.year || yearSuffix_(new Date()));
    var start = Number(data.start);
    var count = Number(data.count);
    if (!code || !isFinite(start) || !isFinite(count) || start < 1 || count < 1) {
      return { success: false, error: 'productCode, year, start, count を指定してください' };
    }
    var products = getProductsData().data;
    var p = products[code];
    if (!p) return { success: false, error: '商品コードが商品マスタにありません: ' + code };

    var numbers = [];
    for (var i = 0; i < count; i++) numbers.push(start + i);
    var items = [{ productCode: code, productName: p.name, unitQuantity: Number(p.quantity) || 0, year: year, numbers: numbers }];
    var labels = labelsFromBoxItems_(items);
    var pdf = buildLabelPdf_(labels, { fileName: 'ラベル_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm') + '_' + code + '_' + pad4_(start) });

    var registerResult = null;
    if (data.register) {
      registerResult = ledgerRegister_(code, year, start, count, FI_LEDGER_STATUS_.ISSUED, 'qrgen', 'createLabelPdf');
    }

    var sentTo = '';
    if (data.to) {
      var to = String(data.to).trim();
      if (to === '__admin__') {
        to = getConfigValue_('adminEmail', '');
      } else if (to.indexOf('@') < 0) {
        var staff = resolveStaff_(to);
        to = staff && staff.email ? staff.email : '';
      }
      if (!to) return { success: false, error: '送信先が解決できません: ' + data.to, pdfUrl: pdf.pdfFile.getUrl() };
      var summary = p.name + '（' + code + '）: ' + count + '枚（' + formatQrText_(code, year, start) + ' 〜 ' + pad4_(start + count - 1) + '）';
      sendLabelMail_(to, String(data.to), pdf, items, summary, false);
      sentTo = to;
    }
    return { success: true, pdfUrl: pdf.pdfFile.getUrl(), pages: pdf.pages, count: pdf.count, sentTo: sentTo,
      registered: registerResult ? registerResult.registered : 0, conflicts: registerResult ? registerResult.conflicts : [] };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

/**
 * 回答行の「ラベル番号範囲」から PDF を作り直して再送する
 * data: { kind: 'in', row: 12 } または { sheet: 'フォーム回答_入荷', row: 12 }
 */
function resendLabelPdfAction_(data) {
  try {
    var ss = getSpreadsheet();
    var sheetName = data.sheet || getConfigValue_('inResponseSheet', FI_SHEETS_.IN_RESP);
    var sheet = ss.getSheetByName(sheetName);
    var row = Number(data.row);
    if (!sheet || !isFinite(row) || row < 2) return { success: false, error: 'sheet と row（2以上）を指定してください' };
    var rowData = readRowMap_(sheet, row);
    var rangeText = String(rowData.map['ラベル番号範囲'] || '');
    var items = parseLabelRangeText_(rangeText);
    if (!items.length) return { success: false, error: 'この行にはラベル番号範囲がありません（在庫反映前かエラー行）' };
    var products = getProductsData().data;
    items.forEach(function(it) {
      var p = products[it.productCode];
      it.productName = p ? p.name : it.productCode;
      it.unitQuantity = p ? (Number(p.quantity) || 0) : 0;
    });
    var labels = labelsFromBoxItems_(items);
    var pdf = buildLabelPdf_(labels, { fileName: 'ラベル_再送_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm') + '_R' + row });
    var staffName = String(rowData.map[FI_Q_.STAFF] || '').trim();
    var staff = resolveStaff_(staffName);
    var to = data.to ? String(data.to) : (staff && staff.email ? staff.email : getConfigValue_('adminEmail', ''));
    if (to.indexOf('@') < 0) {
      var s2 = resolveStaff_(to);
      to = s2 && s2.email ? s2.email : '';
    }
    if (to) {
      sendLabelMail_(to, staffName || '担当者', pdf, items, String(rowData.map['在庫反映内容'] || ''), !(staff && staff.email));
    }
    writeResultCells_(sheet, row, { '処理結果': FI_STATUS_.DONE, 'PDF URL': pdf.pdfFile.getUrl(), 'エラー': '' });
    return { success: true, pdfUrl: pdf.pdfFile.getUrl(), sentTo: to, count: pdf.count };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

/**
 * 'HEALTH-26-0001〜0003, MONEY-26-0010〜0012' → [{productCode, year, numbers:[...]}]
 */
function parseLabelRangeText_(text) {
  var items = [];
  var re = /([A-Z0-9_-]+)-(\d{2})-(\d{4})〜(\d{4})/gi;
  var m;
  while ((m = re.exec(String(text || '')))) {
    var start = Number(m[3]);
    var end = Number(m[4]);
    if (end < start) continue;
    var numbers = [];
    for (var n = start; n <= end; n++) numbers.push(n);
    items.push({ productCode: m[1].toUpperCase(), year: m[2], numbers: numbers });
  }
  return items;
}
