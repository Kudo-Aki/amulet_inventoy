// 棚卸フォーム: 「空欄」と「0」の区別、部分棚卸、解析先行のバックアップ、冪等性。
'use strict';
const assert = require('assert');
const F = require('./fixtures');
const { boot, sheetOf, addRow, productRow, productRowCount, histRows, ledgerRows, eqJ } = F;

const s = F.suite('inventory');

const WITH_NOUNIT = F.DEFAULT_PRODUCTS.concat([
  ['NOUNIT', '入数未設定守り', 0, 0, '', '', '', 7, 5, '未発注', '', '2026/9/1 10:00:00'],
]);

// ここが壊れると在庫が実態と合わなくなる。hasAnswer_ を if (!v) 等に
// 書き換えると「実在庫0個」が「数えていない」に化ける。
s.test('hasAnswer_ は数値の0を「回答あり」、空欄を「回答なし」と判定する', () => {
  const ctx = boot();
  assert.strictEqual(ctx.hasAnswer_(0), true, '数値の0');
  assert.strictEqual(ctx.hasAnswer_('0'), true, '文字列の0');
  assert.strictEqual(ctx.hasAnswer_(false), true, 'false も値');
  assert.strictEqual(ctx.hasAnswer_(''), false);
  assert.strictEqual(ctx.hasAnswer_('   '), false);
  assert.strictEqual(ctx.hasAnswer_(null), false);
  assert.strictEqual(ctx.hasAnswer_(undefined), false);
});

s.test('部分棚卸: 送った商品だけ上書きし、差異ゼロは履歴を書かない', () => {
  const ctx = boot({ products: WITH_NOUNIT, sheets: ['inv'] });
  const sheet = sheetOf(ctx, 'inv');
  const row = addRow(sheet, {
    'タイムスタンプ': new Date(2026, 8, 9, 3, 0, 0), '入力者': '山田',
    '商品1': '健康守り（HEALTH）', '実在庫数1': '95',
    '商品2': '金運守り（MONEY）', '実在庫数2': 20,     // 差異ゼロ
    '備考': '本殿倉庫',
  });
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, '完了');

  assert.strictEqual(productRow(ctx, 'HEALTH')[7], 95, '絶対値で上書き');
  assert.strictEqual(productRow(ctx, 'MONEY')[7], 20);
  assert.strictEqual(productRow(ctx, 'LOVE')[7], 5, '入力していない商品は触らない');
  assert.strictEqual(productRow(ctx, 'NOUNIT')[7], 7);

  const hist = histRows(ctx);
  assert.strictEqual(hist.length, 1, '差異ゼロは履歴を書かない: ' + JSON.stringify(hist));
  eqJ(hist[0].slice(1, 5), ['out', 'HEALTH', '健康守り', 5]);
  assert.ok(hist[0][5].includes('棚卸(フォーム): 100→95 (-5)') && hist[0][5].includes('本殿倉庫'), hist[0][5]);

  const map = ctx.readRowMap_(sheet, row).map;
  assert.ok(map['在庫反映内容'].includes('健康守り（HEALTH）: 100 → 95個（-5）'), map['在庫反映内容']);
  assert.ok(map['在庫反映内容'].includes('金運守り（MONEY）: 20 → 20個（差異なし）'), map['在庫反映内容']);
  assert.ok(map['在庫反映内容'].includes('計上 2件 / 差異あり 1件 / 未計上 2件'), map['在庫反映内容']);
  assert.strictEqual(map['バックアップ'], ledgerRows(ctx)[0][0], 'バックアップIDが回答行に残る');
  eqJ(ledgerRows(ctx)[0].slice(2, 5), ['棚卸(フォーム)', '山田', 4]);
});

s.test('実在庫 0 は「在庫ゼロ」として反映される', () => {
  [0, '0'].forEach(v => {
    const ctx = boot({ sheets: ['inv'] });
    const sheet = sheetOf(ctx, 'inv');
    const row = addRow(sheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '健康守り（HEALTH）', '実在庫数1': v });
    assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, '完了', JSON.stringify(v));
    assert.strictEqual(productRow(ctx, 'HEALTH')[7], 0, '入力値 ' + JSON.stringify(v));
    eqJ(histRows(ctx)[0].slice(1, 5), ['out', 'HEALTH', '健康守り', 100]);
  });
});

s.test('入数0の商品も棚卸できる（棚卸は絶対個数なので入数を検証しない）', () => {
  const ctx = boot({ products: WITH_NOUNIT, sheets: ['inv'] });
  const sheet = sheetOf(ctx, 'inv');
  const row = addRow(sheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '入数未設定守り（NOUNIT）', '実在庫数1': '12' });
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, '完了');
  assert.strictEqual(productRow(ctx, 'NOUNIT')[7], 12);
});

// 解析先行の証明。先にバックアップを取ると、入力ミスの回答が世代を1つ消費して
// 本当に必要な世代を押し出してしまう。
s.test('入力エラー8種: 在庫も商品行も動かず、バックアップ世代も消費しない', () => {
  const cases = [
    ['数量の入れ忘れ', { '商品1': '健康守り（HEALTH）' }, /実在庫数1 が入力されていません/],
    ['商品の入れ忘れ', { '実在庫数1': '5' }, /商品1 が選択されていません/],
    ['未知のコード', { '商品1': '謎の守り（XXX）', '実在庫数1': '5' }, /商品マスタにありません/],
    ['負の数', { '商品1': '健康守り（HEALTH）', '実在庫数1': '-1' }, /0 以上の整数/],
    ['小数', { '商品1': '健康守り（HEALTH）', '実在庫数1': '1.5' }, /0 以上の整数/],
    ['桁の入力ミス', { '商品1': '健康守り（HEALTH）', '実在庫数1': '999999999' }, /上限/],
    ['同じ商品の重複', { '商品1': '健康守り（HEALTH）', '実在庫数1': '5', '商品2': '健康守り（HEALTH）', '実在庫数2': '6' }, /複数の枠/],
    ['全部空', {}, /商品が1つも入力されていません/],
  ];
  cases.forEach(([label, fields, re]) => {
    const ctx = boot({ sheets: ['inv'] });
    const sheet = sheetOf(ctx, 'inv');
    const row = addRow(sheet, Object.assign({ 'タイムスタンプ': new Date(), '入力者': '山田' }, fields));
    assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, 'エラー', label);
    const msg = ctx.readRowMap_(sheet, row).map['エラー'];
    assert.ok(re.test(msg), label + ': ' + msg);
    assert.strictEqual(ledgerRows(ctx).length, 0, label + ': 解析エラーでバックアップを残してはいけない');
    assert.strictEqual(productRow(ctx, 'HEALTH')[7], 100, label + ': 在庫が動いてはいけない');
    assert.strictEqual(productRowCount(ctx), 4, label + ': 商品行が増えてはいけない');
    assert.ok(ctx.__mails.some(m => m.to === 'admin@example.com'), label + ': 管理者へ通知');
  });
});

s.test('冪等: 再処理で在庫もバックアップも履歴も増えない', () => {
  const ctx = boot({ sheets: ['inv'] });
  const sheet = sheetOf(ctx, 'inv');
  const row = addRow(sheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '健康守り（HEALTH）', '実在庫数1': '95' });
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, '完了');
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, 'already');
  assert.strictEqual(productRow(ctx, 'HEALTH')[7], 95);
  assert.strictEqual(ledgerRows(ctx).length, 1);
  assert.strictEqual(histRows(ctx).length, 1);
});

s.test('backupBeforeFormInventory を FALSE にするとバックアップを取らない（在庫は反映する）', () => {
  const ctx = boot({ sheets: ['inv'] });
  ctx.setConfigValue_('backupBeforeFormInventory', 'FALSE');
  const sheet = sheetOf(ctx, 'inv');
  const row = addRow(sheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '健康守り（HEALTH）', '実在庫数1': '95' });
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, '完了');
  assert.strictEqual(productRow(ctx, 'HEALTH')[7], 95);
  assert.strictEqual(ledgerRows(ctx).length, 0);
  assert.strictEqual(ctx.readRowMap_(sheet, row).map['バックアップ'], '');
});

s.test('棚卸 → バックアップから復元 で在庫が戻る', () => {
  const ctx = boot({ sheets: ['inv'] });
  const sheet = sheetOf(ctx, 'inv');
  const row = addRow(sheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '健康守り（HEALTH）', '実在庫数1': '95' });
  ctx.processResponseRow_(sheet, row, {});
  const backupId = ctx.readRowMap_(sheet, row).map['バックアップ'];

  const pv = ctx.previewRestore_(backupId, 'stock');
  eqJ(pv.changes, [{ code: 'HEALTH', name: '健康守り', fields: [{ label: '現在庫', from: '95', to: '100' }] }], JSON.stringify(pv.changes));
  assert.strictEqual(productRow(ctx, 'HEALTH')[7], 95, 'プレビューは書き込まない');

  ctx.__advance(1000);
  const r = ctx.restoreBackup_(backupId, 'stock', '山田');
  assert.strictEqual(productRow(ctx, 'HEALTH')[7], 100, '棚卸前に戻る');
  assert.strictEqual(r.restoredCount, 1);
});

s.test('棚卸フォームの質問は 入力者, 棚卸日, 商品n, 実在庫数n, 備考 の順で必須は枠1だけ', () => {
  const ctx = boot();
  const plan = ctx.formQuestionPlan_(ctx.getFormSpec_('inv'));
  eqJ(plan.slice(0, 6).map(e => e.title), ['入力者', '棚卸日', '商品1', '実在庫数1', '商品2', '実在庫数2']);
  assert.strictEqual(plan[plan.length - 1].title, '備考');
  assert.strictEqual(plan.length, 2 + 10 * 2 + 1, JSON.stringify(plan.map(e => e.title)));
  eqJ(plan.filter(e => e.required).map(e => e.title), ['入力者', '商品1', '実在庫数1']);
  const actual = plan.find(e => e.title === '実在庫数1');
  assert.strictEqual(actual.q.validation.kind, 'wholeNumber');
  assert.ok(actual.q.help.includes('0 は「在庫ゼロ」'), actual.q.help);
});

module.exports = s.done();
