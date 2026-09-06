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
  OUT_RESP: 'フォーム回答_出荷'
};

var FI_FORM_TITLES_ = {
  IN: 'お守り入荷登録',
  OUT: 'お守り出荷登録'
};

// フォームの質問タイトル（回答シートのヘッダー名にもなる。変更する場合はフォームも作り直す）
var FI_Q_ = {
  STAFF: '入力者',
  IN_DATE: '入荷日',
  OUT_DATE: '出荷日',
  PRODUCT: '商品',    // 商品1, 商品2, ...
  BOXES: '箱数',      // 箱数1, 箱数2, ...
  PIECES: '端数',     // 端数1, ...（出荷のみ。箱に満たない個数）
  DEST: '出荷先',
  NOTE: '備考'
};

var FI_IN_SLOTS_ = 10;   // 入荷フォームの商品枠数
var FI_OUT_SLOTS_ = 3;   // 出荷フォームの商品枠数

// 回答シートに GAS が追記する列
var FI_RESULT_COLS_ = ['処理結果', '処理日時', '在庫反映内容', 'ラベル番号範囲', 'PDF URL', 'エラー'];

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
  ['senderMobile', '', '署名の携帯番号']
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
  log.push('入荷フォーム: ' + forms.inForm.getPublishedUrl());
  log.push('出荷フォーム: ' + forms.outForm.getPublishedUrl());

  ensureTriggers_(ss);
  log.push('トリガー: OK（onFormSubmit / syncFormChoices 毎日6時 / processPendingResponses 10分毎）');

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
  var inForm = openFormIfExists_(getConfigValue_('inFormId', ''));
  if (!inForm) {
    inForm = createIntakeForm_(ss, folder, 'in');
  }
  var outForm = openFormIfExists_(getConfigValue_('outFormId', ''));
  if (!outForm) {
    outForm = createIntakeForm_(ss, folder, 'out');
  }
  // 回答シートの追記列を確認
  ensureResponseSheetColumns_(getResponseSheet_('in'));
  ensureResponseSheetColumns_(getResponseSheet_('out'));
  return { inForm: inForm, outForm: outForm };
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
  var isIn = kind === 'in';
  var form = FormApp.create(isIn ? FI_FORM_TITLES_.IN : FI_FORM_TITLES_.OUT);
  form.setDescription(isIn
    ? '届いた箱の数を登録します。送信すると在庫に反映され、箱に貼るラベル（QR付き）のPDFが入力者宛にメールで届きます。'
    : '倉庫から持ち出した数を登録します。送信すると在庫から減算されます。');
  form.setCollectEmail(false);
  form.setLimitOneResponsePerUser(false);
  form.setAllowResponseEdits(false);
  form.setShowLinkToRespondAgain(true);
  form.setConfirmationMessage(isIn
    ? '登録しました。在庫に反映し、ラベルPDFを入力者宛にメールします（届くまで1〜2分かかることがあります）。'
    : '登録しました。在庫に反映します。');

  // 入力者
  form.addListItem().setTitle(FI_Q_.STAFF).setRequired(true)
    .setHelpText('ご自身の名前を選んでください（入力者シートに登録された人）')
    .setChoiceValues(['（入力者シートを設定後に syncFormChoices を実行）']);

  // 日付
  form.addDateItem().setTitle(isIn ? FI_Q_.IN_DATE : FI_Q_.OUT_DATE).setRequired(false)
    .setHelpText('空欄の場合は送信日になります' + (isIn ? '（QRの年はこの日付の西暦下2桁）' : ''));

  var slots = isIn ? FI_IN_SLOTS_ : FI_OUT_SLOTS_;
  for (var i = 1; i <= slots; i++) {
    form.addListItem().setTitle(FI_Q_.PRODUCT + i).setRequired(i === 1)
      .setChoiceValues(['（商品マスタを設定後に syncFormChoices を実行）']);
    var boxes = form.addTextItem().setTitle(FI_Q_.BOXES + i).setRequired(i === 1)
      .setHelpText(isIn ? '届いた箱の数（1以上の整数）' : '持ち出した箱の数（整数。箱単位でなければ 0 にして端数に個数を入力）');
    boxes.setValidation(FormApp.createTextValidation().setHelpText('整数を入力してください').requireWholeNumber().build());
    if (!isIn) {
      var pieces = form.addTextItem().setTitle(FI_Q_.PIECES + i).setRequired(false)
        .setHelpText('箱に満たない個数（任意）');
      pieces.setValidation(FormApp.createTextValidation().setHelpText('整数を入力してください').requireWholeNumber().build());
    }
  }

  if (!isIn) {
    form.addTextItem().setTitle(FI_Q_.DEST).setRequired(false).setHelpText('授与所名など（任意）');
  }
  form.addParagraphTextItem().setTitle(FI_Q_.NOTE).setRequired(false);

  // 回答先をスプレッドシートに設定 → 新しくできた回答シートを見つけてリネーム
  var beforeNames = ss.getSheets().map(function(s) { return s.getName(); });
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  SpreadsheetApp.flush();
  var respSheet = findNewResponseSheet_(ss.getId(), form.getId(), beforeNames);
  var targetName = isIn ? getConfigValue_('inResponseSheet', FI_SHEETS_.IN_RESP) : getConfigValue_('outResponseSheet', FI_SHEETS_.OUT_RESP);
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

  setConfigValue_(isIn ? 'inFormId' : 'outFormId', form.getId());
  setConfigValue_(isIn ? 'inFormUrl' : 'outFormUrl', form.getPublishedUrl());
  setConfigValue_(isIn ? 'inFormEditUrl' : 'outFormEditUrl', form.getEditUrl());
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
  var ss = getSpreadsheet();
  var name = kind === 'in' ? getConfigValue_('inResponseSheet', FI_SHEETS_.IN_RESP) : getConfigValue_('outResponseSheet', FI_SHEETS_.OUT_RESP);
  return ss.getSheetByName(name);
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
  ['inFormId', 'outFormId'].forEach(function(key) {
    var form = openFormIfExists_(getConfigValue_(key, ''));
    if (!form) return;
    form.getItems(FormApp.ItemType.LIST).forEach(function(item) {
      var title = item.getTitle();
      var list = item.asListItem();
      if (title === FI_Q_.STAFF) {
        list.setChoiceValues(staffChoices);
        updated++;
      } else if (title.indexOf(FI_Q_.PRODUCT) === 0) {
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
  var results = { in: 0, out: 0, errors: 0 };
  ['in', 'out'].forEach(function(kind) {
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
  var kind = null;
  if (sheetName === getConfigValue_('inResponseSheet', FI_SHEETS_.IN_RESP)) kind = 'in';
  else if (sheetName === getConfigValue_('outResponseSheet', FI_SHEETS_.OUT_RESP)) kind = 'out';
  if (!kind) return { status: 'skipped', message: '対象外のシート: ' + sheetName };

  ensureResponseSheetColumns_(sheet);
  var ref = sheetName + '!R' + row;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    writeResultCells_(sheet, row, { 'エラー': 'ロック取得に失敗（混雑）。10分毎の再処理で自動的に再試行されます: ' + e });
    return { status: 'locked' };
  }

  var rowData, lines, staff, summaryText, labelItems = [], lowStock = [];
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

    var products = getProductsData().data;
    lines = parseLines_(kind, rowData.map, products);
    staff = resolveStaff_(rowData.map[FI_Q_.STAFF]);
    var staffName = String(rowData.map[FI_Q_.STAFF] || '').trim() || '不明';
    var dateValue = rowData.map[kind === 'in' ? FI_Q_.IN_DATE : FI_Q_.OUT_DATE];
    var baseDate = toDate_(dateValue) || toDate_(rowData.values[0]) || new Date();
    var yy = yearSuffix_(baseDate);
    var dest = kind === 'out' ? String(rowData.map[FI_Q_.DEST] || '').trim() : '';

    // --- 在庫・履歴・発注の更新（ここは業務上重要なので先に確定させる） ---
    var summaryLines = [];
    lines.forEach(function(line) {
      var p = products[line.code];
      var before = Number(p.stock) || 0;
      var after = kind === 'in' ? before + line.quantity : Math.max(0, before - line.quantity);
      var partial = { stock: after };
      if (kind === 'in') {
        var consumed = consumeDeliveries_(p, line.quantity);
        if (consumed) {
          partial.ordered = consumed.ordered;
          partial.deliveries = consumed.deliveries;
        }
      }
      updateSingleProduct(line.code, partial);

      var note = kind === 'in'
        ? 'フォーム入荷: ' + line.boxes + '箱 入力者:' + staffName
        : 'フォーム出荷: ' + line.boxes + '箱' + (line.pieces ? '(+' + line.pieces + '個)' : '') + ' 入力者:' + staffName + (dest ? ' 出荷先:' + dest : '');
      addHistoryRecord({
        date: nowJa_(),
        type: kind,
        productCode: line.code,
        productName: p.name,
        quantity: line.quantity,
        note: note
      });

      summaryLines.push(p.name + '（' + line.code + '）: ' + (kind === 'in' ? '+' : '-') + line.quantity + '個 → 在庫 ' + after + '個');

      if (kind === 'out') {
        var safe = Number(p.safeStock) || 0;
        if (after < safe) lowStock.push({ code: line.code, name: p.name, stock: after, safeStock: safe });
      }
      line.after = after;
      line.name = p.name;
      line.unitQuantity = Number(p.quantity) || 0;
    });

    // --- 箱台帳: 採番と登録（入荷のみ） ---
    var rangeText = '';
    if (kind === 'in') {
      var rangeParts = [];
      lines.forEach(function(line) {
        var numbers = reserveBoxNumbers_(line.code, yy, line.boxes, 'form', ref);
        labelItems.push({ productCode: line.code, productName: line.name, unitQuantity: line.unitQuantity, year: yy, numbers: numbers });
        rangeParts.push(formatQrText_(line.code, yy, numbers[0]) + '〜' + pad4_(numbers[numbers.length - 1]));
      });
      rangeText = rangeParts.join(', ');
    }

    summaryText = summaryLines.join('\n');
    writeResultCells_(sheet, row, {
      '処理結果': FI_STATUS_.STOCK_DONE,
      '処理日時': nowJa_(),
      '在庫反映内容': summaryText,
      'ラベル番号範囲': rangeText
    });
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
  var staffLabel = String(rowData.map[FI_Q_.STAFF] || '').trim() || '不明';
  try {
    if (kind === 'in') {
      var labels = labelsFromBoxItems_(labelItems);
      var fileName = 'ラベル_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm') + '_' +
        labelItems.map(function(it) { return it.productCode; }).join('+').slice(0, 60);
      var pdf = buildLabelPdf_(labels, { fileName: fileName });
      sendLabelMail_(recipient, staffLabel, pdf, labelItems, summaryText, !(staff && staff.email));
      writeResultCells_(sheet, row, { '処理結果': FI_STATUS_.DONE, '処理日時': nowJa_(), 'PDF URL': pdf.pdfFile.getUrl() });
    } else {
      if (lowStock.length && String(getConfigValue_('lowStockMail', 'TRUE')).toUpperCase() === 'TRUE') {
        sendLowStockMail_(recipient, lowStock, staffLabel);
      }
      writeResultCells_(sheet, row, { '処理結果': FI_STATUS_.DONE, '処理日時': nowJa_() });
    }
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
 * 回答行の 商品n / 箱数n / 端数n を検証して配列にする
 * @return {Array<{slot:number, code:string, boxes:number, pieces:number, quantity:number}>}
 */
function parseLines_(kind, map, products) {
  var slots = kind === 'in' ? FI_IN_SLOTS_ : FI_OUT_SLOTS_;
  var maxPerLine = Number(getConfigValue_('maxBoxesPerLine', 50)) || 50;
  var maxTotal = Number(getConfigValue_('maxBoxesPerSubmission', 80)) || 80;
  var lines = [];
  var seen = {};
  var totalBoxes = 0;

  for (var i = 1; i <= slots; i++) {
    var choice = map[FI_Q_.PRODUCT + i];
    var boxesRaw = map[FI_Q_.BOXES + i];
    var piecesRaw = map[FI_Q_.PIECES + i];
    var hasChoice = choice !== undefined && choice !== null && String(choice).trim() !== '';
    var hasBoxes = boxesRaw !== undefined && boxesRaw !== null && String(boxesRaw).trim() !== '';
    var hasPieces = piecesRaw !== undefined && piecesRaw !== null && String(piecesRaw).trim() !== '';
    if (!hasChoice && !hasBoxes && !hasPieces) continue;
    if (!hasChoice) throw new Error('商品' + i + ' が選択されていません');

    var code = extractProductCode_(choice);
    var p = products[code];
    if (!p) throw new Error('商品' + i + ' のコードが商品マスタにありません: ' + choice);
    if (seen[code]) throw new Error('同じ商品が複数の枠に入力されています: ' + code + '（1つの枠にまとめてください）');
    seen[code] = true;

    var boxes = hasBoxes ? Number(String(boxesRaw).trim()) : 0;
    var pieces = (kind === 'out' && hasPieces) ? Number(String(piecesRaw).trim()) : 0;
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
      if (to.indexOf('@') < 0) {
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
