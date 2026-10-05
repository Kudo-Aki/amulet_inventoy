// 入荷・出荷の中核フロー: 在庫反映、履歴、分納の消し込み、箱台帳の採番、
// ラベルPDF、安心在庫割れ通知、冪等性、入力検証。
'use strict';
const assert = require('assert');
const F = require('./fixtures');
const { boot, sheetOf, addRow, productRow, histRows, boxLedger, eqJ } = F;

const s = F.suite('core');

s.test('入荷: 2商品が「箱数×入数」で反映され、分納が納期の早い順に消える', () => {
  const ctx = boot({ sheets: ['in'] });
  const sheet = sheetOf(ctx, 'in');
  const row = addRow(sheet, {
    'タイムスタンプ': new Date(2026, 8, 6, 9, 30), '入力者': '山田', '入荷日': new Date(2026, 8, 6),
    '商品1': '健康守り（HEALTH）', '箱数1': '3',
    '商品2': '金運守り（MONEY）', '箱数2': 2,
    '備考': '9月納品分',
  });
  const res = ctx.processResponseRow_(sheet, row, {});
  assert.strictEqual(res.status, '完了', JSON.stringify(res));

  const h = productRow(ctx, 'HEALTH'), m = productRow(ctx, 'MONEY');
  assert.strictEqual(h[7], 250, 'HEALTH 100 + 3箱×50');
  assert.strictEqual(h[9], '発注済み');
  assert.strictEqual(h[10], '合計2450個: 850個(1/31), 1000個(2/15), 600個(3/1)', '納期の早い分納から消化: ' + h[10]);
  assert.strictEqual(m[7], 220, 'MONEY 20 + 2箱×100');
  assert.strictEqual(m[9], '未発注', '分納なしなら発注状況はそのまま');

  const hist = histRows(ctx);
  assert.strictEqual(hist.length, 2);
  eqJ(hist[0].slice(1, 5), ['in', 'MONEY', '金運守り', 200], '最後に処理した商品が上');
  eqJ(hist[1].slice(1, 5), ['in', 'HEALTH', '健康守り', 150]);
  assert.ok(hist[1][5].includes('フォーム入荷: 3箱') && hist[1][5].includes('入力者:山田'), hist[1][5]);

  eqJ(boxLedger(ctx).map(r => [r[0], r[4], r[6]]), [
    ['HEALTH-26-0001', '入庫済', 'form'], ['HEALTH-26-0002', '入庫済', 'form'], ['HEALTH-26-0003', '入庫済', 'form'],
    ['MONEY-26-0001', '入庫済', 'form'], ['MONEY-26-0002', '入庫済', 'form'],
  ], '箱台帳の採番');

  const map = ctx.readRowMap_(sheet, row).map;
  assert.strictEqual(map['処理結果'], '完了');
  assert.strictEqual(map['ラベル番号範囲'], 'HEALTH-26-0001〜0003, MONEY-26-0001〜0002');
  assert.ok(String(map['PDF URL']).startsWith('https://pdf/'), map['PDF URL']);
  assert.ok(map['在庫反映内容'].includes('健康守り（HEALTH）: +150個 → 在庫 250個'), map['在庫反映内容']);

  assert.strictEqual(ctx.__pdfCalls.length, 1);
  assert.strictEqual(ctx.__pdfCalls[0].labels.length, 5);
  eqJ(ctx.__pdfCalls[0].labels[0], { qrText: 'HEALTH-26-0001', productName: '健康守り', unitQuantity: 50 });
  assert.strictEqual(ctx.__mails.length, 1);
  assert.strictEqual(ctx.__mails[0].to, 'yamada@example.com');
  assert.ok(ctx.__mails[0].subject.includes('入荷ラベル 5枚'), ctx.__mails[0].subject);
  assert.strictEqual(ctx.__mails[0].opts.attachments.length, 1);
});

s.test('冪等: 同じ行を再処理しても在庫も履歴もメールも増えない', () => {
  const ctx = boot({ sheets: ['in'] });
  const sheet = sheetOf(ctx, 'in');
  const row = addRow(sheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '健康守り（HEALTH）', '箱数1': '3' });
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, '完了');
  const mails = ctx.__mails.length;
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, 'already');
  assert.strictEqual(productRow(ctx, 'HEALTH')[7], 250);
  assert.strictEqual(histRows(ctx).length, 1);
  assert.strictEqual(ctx.__mails.length, mails);
});

s.test('箱番号は前回の続きから振られる', () => {
  const ctx = boot({ sheets: ['in'] });
  const sheet = sheetOf(ctx, 'in');
  const r1 = addRow(sheet, { 'タイムスタンプ': new Date(2026, 8, 6), '入力者': '山田', '商品1': '健康守り（HEALTH）', '箱数1': '3' });
  ctx.processResponseRow_(sheet, r1, {});
  const r2 = addRow(sheet, { 'タイムスタンプ': new Date(2026, 8, 7), '入力者': '山田', '商品1': '健康守り（HEALTH）', '箱数1': '2' });
  assert.strictEqual(ctx.processResponseRow_(sheet, r2, {}).status, '完了');
  assert.strictEqual(ctx.readRowMap_(sheet, r2).map['ラベル番号範囲'], 'HEALTH-26-0004〜0005');
  assert.strictEqual(productRow(ctx, 'HEALTH')[7], 350);
});

s.test('箱台帳が空だと 0001 から振り直す（移行時に台帳を引き継ぐ理由）', () => {
  const ctx = boot({ sheets: ['in'] });
  assert.strictEqual(ctx.getNextBoxNumber_('HEALTH', '26'), 1, '台帳が空なら1から');
  const sheet = sheetOf(ctx, 'in');
  const row = addRow(sheet, { 'タイムスタンプ': new Date(2026, 8, 6), '入力者': '山田', '商品1': '健康守り（HEALTH）', '箱数1': '2' });
  ctx.processResponseRow_(sheet, row, {});
  assert.strictEqual(ctx.getNextBoxNumber_('HEALTH', '26'), 3, '台帳があれば続き番号');
});

s.test('エラー行: 未知の商品なら在庫を動かさず管理者に通知する', () => {
  const ctx = boot({ sheets: ['in'] });
  const sheet = sheetOf(ctx, 'in');
  const row = addRow(sheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '謎の守り（XXX）', '箱数1': '1' });
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, 'エラー');
  const map = ctx.readRowMap_(sheet, row).map;
  assert.strictEqual(map['処理結果'], 'エラー');
  assert.ok(map['エラー'].includes('商品マスタにありません'), map['エラー']);
  assert.strictEqual(productRow(ctx, 'HEALTH')[7], 100, '在庫は動かない');
  assert.strictEqual(ctx.__mails[ctx.__mails.length - 1].to, 'admin@example.com');
});

s.test('入力者が未登録ならラベルPDFは管理者宛に送る', () => {
  const ctx = boot({ sheets: ['in'] });
  const sheet = sheetOf(ctx, 'in');
  const row = addRow(sheet, { 'タイムスタンプ': new Date(), '入力者': '名無し', '商品1': '金運守り（MONEY）', '箱数1': '1' });
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, '完了');
  const last = ctx.__mails[ctx.__mails.length - 1];
  assert.strictEqual(last.to, 'admin@example.com');
  assert.ok(last.body.includes('管理者宛に送っています'), last.body);
});

s.test('出荷: 端数を足して減算し、安心在庫を下回れば通知、0未満にはしない', () => {
  const ctx = boot({ sheets: ['out'] });
  const sheet = sheetOf(ctx, 'out');
  const o1 = addRow(sheet, {
    'タイムスタンプ': new Date(), '入力者': '山田',
    '商品1': '縁結び守り（LOVE）', '箱数1': '0', '端数1': '3', '出荷先': '本殿授与所',
  });
  assert.strictEqual(ctx.processResponseRow_(sheet, o1, {}).status, '完了');
  assert.strictEqual(productRow(ctx, 'LOVE')[7], 2, '5 - 3');
  const hist = histRows(ctx);
  eqJ(hist[0].slice(1, 5), ['out', 'LOVE', '縁結び守り', 3]);
  assert.ok(hist[0][5].includes('出荷先:本殿授与所'), hist[0][5]);
  const low = ctx.__mails[ctx.__mails.length - 1];
  assert.ok(low.subject.includes('安心在庫を下回りました'), low.subject);
  assert.ok(low.to.includes('yamada@example.com') && low.to.includes('admin@example.com'), low.to);
  assert.strictEqual(ctx.__pdfCalls.length, 0, '出荷でラベルPDFは作らない');

  const o2 = addRow(sheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '縁結び守り（LOVE）', '箱数1': '5' });
  ctx.processResponseRow_(sheet, o2, {});
  assert.strictEqual(productRow(ctx, 'LOVE')[7], 0, '在庫は0未満にならない');
});

s.test('入力検証: 箱数の範囲・整数・重複・上限・合計', () => {
  const ctx = boot({ sheets: ['in'] });
  const p = () => ctx.getProductsData().data;
  const cases = [
    [{ '商品1': '健康守り（HEALTH）', '箱数1': '0' }, /1 以上/, '入荷で0箱'],
    [{ '商品1': '健康守り（HEALTH）', '箱数1': '1.5' }, /整数/, '小数'],
    [{ '商品1': '健康守り（HEALTH）', '箱数1': '99' }, /上限/, '1商品の上限'],
    [{ '商品1': '健康守り（HEALTH）', '箱数1': '1', '商品2': '健康守り（HEALTH）', '箱数2': '1' }, /複数の枠/, '同じ商品の重複'],
    [{}, /1つも/, '全部空'],
    [{ '商品1': '健康守り（HEALTH）', '箱数1': '41', '商品2': '金運守り（MONEY）', '箱数2': '40' }, /合計/, '合計の上限'],
    [{ '箱数1': '3' }, /選択されていません/, '商品の入れ忘れ'],
  ];
  cases.forEach(([map, re, label]) => {
    assert.throws(() => ctx.parseLines_('in', map, p()), re, label);
  });
});

s.test('processPendingResponses は未処理行だけを4種別ぶん処理する', () => {
  const ctx = boot({ sheets: ['in', 'out', 'inv', 'product'] });
  const inSheet = sheetOf(ctx, 'in');
  const done = addRow(inSheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '健康守り（HEALTH）', '箱数1': '1' });
  ctx.processResponseRow_(inSheet, done, {});
  addRow(inSheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '金運守り（MONEY）', '箱数1': '1' });
  addRow(sheetOf(ctx, 'inv'), { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '縁結び守り（LOVE）', '実在庫数1': '7' });

  const r = ctx.processPendingResponses();
  eqJ(r.processed, { in: 1, out: 0, inv: 1, product: 0, errors: 0 }, JSON.stringify(r));
  assert.strictEqual(productRow(ctx, 'MONEY')[7], 120);
  assert.strictEqual(productRow(ctx, 'LOVE')[7], 7);
});

s.test('対象外のシートは skipped で何もしない', () => {
  const ctx = boot({ sheets: ['in'] });
  const other = ctx.__ss.insertSheet('関係ないシート');
  other.getRange(1, 1, 2, 1).setValues([['x'], ['y']]);
  eqJ(ctx.processResponseRow_(other, 2, {}), { status: 'skipped', message: '対象外のシート: 関係ないシート' });
});

s.test('ロックが取れないときは処理結果を空のまま残す（10分毎の再処理で拾わせる）', () => {
  const ctx = boot({ sheets: ['in'] });
  const sheet = sheetOf(ctx, 'in');
  const row = addRow(sheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '健康守り（HEALTH）', '箱数1': '1' });
  const outer = ctx.LockService.getScriptLock();
  outer.waitLock(1000);
  const res = ctx.processResponseRow_(sheet, row, {});
  outer.releaseLock();
  assert.strictEqual(res.status, 'locked');
  const map = ctx.readRowMap_(sheet, row).map;
  assert.strictEqual(map['処理結果'], '', '処理結果は空のまま');
  assert.ok(String(map['エラー']).includes('ロック取得に失敗'), map['エラー']);
  // 再処理で拾える
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, '完了');
  assert.strictEqual(productRow(ctx, 'HEALTH')[7], 150);
});

s.test('分納の納期比較は M/D を数値で比べる', () => {
  const ctx = boot();
  const cmp = ctx.compareDeliveryDates_;
  assert.ok(cmp({ date: '1/31' }, { date: '2/15' }) < 0);
  assert.ok(cmp({ date: '10/1' }, { date: '2/15' }) > 0, '文字列比較では 10/1 < 2/15 になってしまう');
  assert.ok(cmp({ date: '' }, { date: '2/15' }) > 0, '納期未定は最後');
  assert.ok(cmp({ date: '2026-01-10' }, { date: '2026/1/9' }) > 0);
});

s.test('ラベルの幾何とQR文字列の書式', () => {
  const ctx = boot();
  const o = ctx.labelCellOrigin_(0, 0, 0);
  assert.ok(Math.abs(o.x - 22.68) < 0.01 && Math.abs(o.y - 29.76) < 0.01, JSON.stringify(o));
  const o7 = ctx.labelCellOrigin_(7, 0, 0);
  assert.ok(Math.abs(o7.x - 297.64) < 0.01 && Math.abs(o7.y - 616.54) < 0.01, JSON.stringify(o7));
  assert.strictEqual(ctx.formatQrText_('health', '2026', 12), 'HEALTH-26-0012');
  assert.strictEqual(ctx.formatQrText_('HEALTH', 6, 1), 'HEALTH-06-0001');
  eqJ(ctx.parseLabelRangeText_('HEALTH-26-0001〜0003, MONEY-26-0010〜0012').map(i => i.numbers.length), [3, 3]);
});

s.test('Tests.gs の確認用関数が通る', () => {
  const ctx = boot();
  ctx.test_consumeDeliveries();
  ctx.test_parseDataParam();
  ctx.test_parseLabelRange();
  ctx.test_hasAnswer();
  ctx.test_productCode();
  ctx.test_formSpecs();
  ['test_consumeDeliveries', 'test_parseDataParam', 'test_parseLabelRange', 'test_hasAnswer', 'test_productCode', 'test_formSpecs']
    .forEach(n => assert.ok(ctx.__logs.some(l => l.includes(n + ': すべて OK')), n));
});

s.test('test_backupRoundTrip が一巡して在庫を元に戻す', () => {
  const ctx = boot();
  const before = productRow(ctx, 'HEALTH')[7];
  ctx.test_backupRoundTrip();
  assert.ok(ctx.__logs.some(l => l.includes('test_backupRoundTrip: すべて OK')));
  assert.strictEqual(productRow(ctx, 'HEALTH')[7], before, '最後に元の在庫へ戻す');
});

module.exports = s.done();
