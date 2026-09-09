/**
 * Tests.gs - Apps Script エディタから実行する動作確認用の関数
 *
 * いずれも Logger（実行ログ）に結果を出します。
 *   test_consumeDeliveries   分納の消し込みロジック（シートを変更しない）
 *   test_parseDataParam      doGet の data パラメータ解釈（シートを変更しない）
 *   test_parseLabelRange     ラベル番号範囲の解釈（シートを変更しない）
 *   test_qrPng               QR画像の生成（Drive に PNG を1枚保存）
 *   test_sampleLabelPdf      8面のサンプルPDF（LabelPdf.gs。Drive に保存）
 *   test_processLastInRow    入荷回答シートの最終行を処理（未処理の場合のみ在庫が動く）
 *   test_dryRunLastInRow     入荷回答シートの最終行を解釈だけする（在庫は動かない）
 */

function assertEq_(actual, expected, label) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error('NG ' + label + '\n  expected: ' + e + '\n  actual:   ' + a);
  }
  Logger.log('OK ' + label);
}

function test_consumeDeliveries() {
  // 納期が早い分納から順に消化する（js/app.js updateOrderQuantityOnDelivery と同じ）
  var p1 = { ordered: true, deliveries: [{ quantity: 1000, date: '2/15' }, { quantity: 1000, date: '1/31' }, { quantity: 600, date: '3/1' }] };
  assertEq_(consumeDeliveries_(p1, 1200), { ordered: true, deliveries: [{ quantity: 800, date: '2/15' }, { quantity: 600, date: '3/1' }] }, '一部消化');
  assertEq_(consumeDeliveries_(p1, 2600), { ordered: false, deliveries: [] }, '全部消化で未発注に戻る');
  assertEq_(consumeDeliveries_(p1, 3000), { ordered: false, deliveries: [] }, '超過分は無視');
  assertEq_(consumeDeliveries_({ ordered: false, deliveries: [{ quantity: 10, date: '' }] }, 5), null, '未発注は変更なし');
  assertEq_(consumeDeliveries_({ ordered: true, deliveries: [] }, 5), null, '分納なしは変更なし');
  var p2 = { ordered: true, deliveries: [{ quantity: 100, date: '' }, { quantity: 50, date: '2026-01-10' }] };
  assertEq_(consumeDeliveries_(p2, 50), { ordered: true, deliveries: [{ quantity: 100, date: '' }] }, '納期未定は最後に消化');
  Logger.log('test_consumeDeliveries: すべて OK');
}

function test_parseDataParam() {
  assertEq_(parseDataParam_('{"a":1}'), { a: 1 }, 'そのままの JSON');
  assertEq_(parseDataParam_('{"note":"20%引き"}'), { note: '20%引き' }, '% を含む JSON');
  assertEq_(parseDataParam_(encodeURIComponent('{"b":"x y"}')), { b: 'x y' }, '二重エンコードされた旧形式');
  assertEq_(parseDataParam_(''), {}, '空');
  assertEq_(parseDataParam_('not json'), {}, '不正な文字列');
  Logger.log('test_parseDataParam: すべて OK');
}

function test_parseLabelRange() {
  assertEq_(parseLabelRangeText_('HEALTH-26-0001〜0003, MONEY-26-0010〜0012'),
    [{ productCode: 'HEALTH', year: '26', numbers: [1, 2, 3] }, { productCode: 'MONEY', year: '26', numbers: [10, 11, 12] }], '2商品');
  assertEq_(formatQrText_('health', 26, 7), 'HEALTH-26-0007', 'QR文字列の書式');
  assertEq_(extractProductCode_('健康守り（HEALTH）'), 'HEALTH', '選択肢からコード抽出');
  Logger.log('test_parseLabelRange: すべて OK');
}

function test_qrPng() {
  Logger.log(qrSelfTest_());
}

/**
 * 入荷回答シートの最終行を解釈だけして内容をログに出す（在庫・台帳は変更しない）
 */
function test_dryRunLastInRow() {
  var sheet = getResponseSheet_('in');
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('入荷の回答がありません');
    return;
  }
  var row = sheet.getLastRow();
  var rowData = readRowMap_(sheet, row);
  var products = getProductsData().data;
  var lines = parseLines_('in', rowData.map, products);
  Logger.log('行 ' + row + ' 入力者: ' + rowData.map[FI_Q_.STAFF] + ' / 処理結果: ' + (rowData.map['処理結果'] || '(未処理)'));
  lines.forEach(function(l) {
    Logger.log('  ' + l.code + ' ' + l.boxes + '箱 → ' + l.quantity + '個');
  });
}

/**
 * 入荷回答シートの最終行を処理する（未処理の行だけ在庫が動く。処理済みなら何もしない）
 */
function test_processLastInRow() {
  var sheet = getResponseSheet_('in');
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('入荷の回答がありません');
    return;
  }
  var row = sheet.getLastRow();
  var r = processResponseRow_(sheet, row, {});
  Logger.log('行 ' + row + ': ' + JSON.stringify(r));
}
