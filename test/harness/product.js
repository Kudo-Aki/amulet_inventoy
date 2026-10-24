// 商品登録フォーム: コード検証、大文字小文字を無視した重複拒否、既定値、選択肢同期。
'use strict';
const assert = require('assert');
const F = require('./fixtures');
const { boot, sheetOf, addRow, productRow, productRowCount, histRows, eqJ } = F;

const s = F.suite('product');

// 過去に手入力で作られた小文字混じりのコードがある状況も再現する
const WITH_LOWER = F.DEFAULT_PRODUCTS.concat([
  ['kotsu', '交通安全守り(小文字コード)', 60, 700, '', '', '', 12, 10, '未発注', '', '2026/9/1 10:00:00'],
]);

s.test('validateProductCode_ は英大文字1〜12文字だけ通し、黙って直さない', () => {
  const ctx = boot();
  assert.strictEqual(ctx.validateProductCode_('KOTSU'), 'KOTSU');
  assert.strictEqual(ctx.validateProductCode_('  KOTSU  '), 'KOTSU', '前後の空白だけは落とす');
  assert.strictEqual(ctx.validateProductCode_('A'), 'A');
  assert.strictEqual(ctx.validateProductCode_('ABCDEFGHIJKL'), 'ABCDEFGHIJKL', '12文字');
  [['', /商品コードを入力してください/], ['   ', /商品コードを入力してください/],
   ['NEW1', /英大文字のみ/], ['new', /英大文字のみ/], ['New', /英大文字のみ/],
   ['ABCDEFGHIJKLM', /英大文字のみ/], ['KO-TSU', /英大文字のみ/], ['KO TSU', /英大文字のみ/],
   ['ＫＯＴＳＵ', /英大文字のみ/], ['お守り', /英大文字のみ/]].forEach(([v, re]) => {
    assert.throws(() => ctx.validateProductCode_(v), re, '拒否されるはず: ' + JSON.stringify(v));
  });
  // 入力値をメッセージに出して「何が悪かったか」を伝える
  assert.throws(() => ctx.validateProductCode_('new1'), /入力値: new1/);
});

s.test('正常登録: 初期在庫を計上し、他のフォームの選択肢にも出る', () => {
  const ctx = boot();
  ctx.setupFormIntegration();
  const sheet = sheetOf(ctx, 'product');
  const row = addRow(sheet, {
    'タイムスタンプ': new Date(2026, 8, 9, 3, 0, 0), '入力者': '山田',
    '商品名': '交通安全御守', '商品コード': 'KOTSU', '入数': '50', '単価（税込）': '800',
    '安心在庫': '20', '初期在庫': '35', '発注先': '株式会社B', '担当者': '鈴木',
    'メールアドレス': 'b@example.com', '備考': '棚卸中に発見',
  });
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, '完了');

  const p = productRow(ctx, 'KOTSU');
  eqJ(p.slice(0, 11), ['KOTSU', '交通安全御守', 50, 800, '株式会社B', '鈴木', 'b@example.com', 35, 20, '未発注', '']);
  assert.ok(String(p[11]).length > 0, '更新日時が入る');

  const h = histRows(ctx);
  eqJ(h[0].slice(1, 5), ['in', 'KOTSU', '交通安全御守', 35]);
  assert.ok(h[0][5].includes('フォーム商品登録: 初期在庫') && h[0][5].includes('棚卸中に発見'), h[0][5]);

  const map = ctx.readRowMap_(sheet, row).map;
  assert.ok(map['在庫反映内容'].includes('交通安全御守（KOTSU）: 入数 50個 / 単価 800円 / 安心在庫 20個'), map['在庫反映内容']);
  assert.ok(map['在庫反映内容'].includes('初期在庫 35個を計上しました'), map['在庫反映内容']);

  // ロック外で選択肢が同期される
  const inForm = ctx.__forms[ctx.getConfigValue_('inFormId', '')];
  const choices = inForm.dumpItems().find(i => i.title === '商品1').choices;
  assert.ok(choices.includes('交通安全御守（KOTSU）'), JSON.stringify(choices));
});

s.test('任意欄の既定値: 単価0 / 初期在庫0（履歴なし）/ 安心在庫10', () => {
  const ctx = boot({ sheets: ['product'] });
  const sheet = sheetOf(ctx, 'product');
  const row = addRow(sheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品名': '安産御守', '商品コード': 'ANZAN', '入数': '30' });
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, '完了');
  const p = productRow(ctx, 'ANZAN');
  eqJ([p[2], p[3], p[7], p[8]], [30, 0, 0, 10]);
  assert.strictEqual(histRows(ctx).length, 0, '初期在庫0なら履歴を書かない');
  assert.ok(ctx.readRowMap_(sheet, row).map['在庫反映内容'].includes('初期在庫は 0個'));
});

s.test('不正な入力10種をそれぞれ固有のメッセージで拒否し、商品行を増やさない', () => {
  const cases = [
    ['数字入り', { '商品名': 'X', '商品コード': 'NEW1', '入数': '10' }, /英大文字のみ[\s\S]*入力値: NEW1/],
    ['小文字', { '商品名': 'X', '商品コード': 'new', '入数': '10' }, /英大文字のみ[\s\S]*入力値: new/],
    ['コード空', { '商品名': 'X', '商品コード': '', '入数': '10' }, /商品コードを入力してください/],
    ['13文字', { '商品名': 'X', '商品コード': 'ABCDEFGHIJKLM', '入数': '10' }, /英大文字のみ/],
    ['既存コード', { '商品名': 'X', '商品コード': 'HEALTH', '入数': '10' }, /既に使われています: HEALTH（健康守り）/],
    // 検証が入る前に手入力で作られた小文字コードが残っていても、
    // 大文字版の新規登録は止めなければならない（QR がどちらにも当たらなくなる）
    ['大小違いの既存', { '商品名': 'X', '商品コード': 'KOTSU', '入数': '10' }, /既に使われています: kotsu/],
    ['入数0', { '商品名': 'X', '商品コード': 'ZZZ', '入数': '0' }, /入数 は 1 以上/],
    ['商品名なし', { '商品コード': 'ZZZ', '入数': '10' }, /商品名を入力してください/],
    ['入数なし', { '商品名': 'X', '商品コード': 'ZZZ' }, /入数 を入力してください/],
    ['入数が小数', { '商品名': 'X', '商品コード': 'ZZZ', '入数': '1.5' }, /入数 は整数で/],
  ];
  cases.forEach(([label, fields, re]) => {
    const ctx = boot({ products: WITH_LOWER, sheets: ['product'] });
    const before = productRowCount(ctx);
    const sheet = sheetOf(ctx, 'product');
    const row = addRow(sheet, Object.assign({ 'タイムスタンプ': new Date(), '入力者': '山田' }, fields));
    assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, 'エラー', label);
    const msg = ctx.readRowMap_(sheet, row).map['エラー'];
    assert.ok(re.test(msg), label + ' のメッセージ: ' + msg);
    assert.strictEqual(productRowCount(ctx), before, label + ': 商品行が増えてはいけない');
    assert.strictEqual(histRows(ctx).length, 0, label + ': 履歴も増えない');
  });
});

s.test('冪等: 再処理しても二重登録しない', () => {
  const ctx = boot({ sheets: ['product'] });
  const sheet = sheetOf(ctx, 'product');
  const row = addRow(sheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品名': '厄除御守', '商品コード': 'YAKU', '入数': '40', '初期在庫': '10' });
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, '完了');
  assert.strictEqual(ctx.processResponseRow_(sheet, row, {}).status, 'already');
  assert.strictEqual(productRowCount(ctx), 5, 'ヘッダー + 元3件 + 1件');
  assert.strictEqual(histRows(ctx).length, 1);
});

s.test('商品登録フォームの質問構成とコードの入力検証', () => {
  const ctx = boot();
  const plan = ctx.formQuestionPlan_(ctx.getFormSpec_('product'));
  eqJ(plan.map(e => e.title),
    ['入力者', '商品名', '商品コード', '入数', '単価（税込）', '安心在庫', '初期在庫', '発注先', '担当者', 'メールアドレス', '備考']);
  eqJ(plan.filter(e => e.required).map(e => e.title), ['入力者', '商品名', '商品コード', '入数']);
  const code = plan.find(e => e.title === '商品コード');
  assert.strictEqual(code.q.validation.kind, 'pattern');
  assert.strictEqual(code.q.validation.pattern, '^[A-Z]{1,12}$');
});

s.test('選択肢の同期に失敗したら「登録済/選択肢同期失敗」と記録して復旧手順を案内する', () => {
  const ctx = boot({ sheets: ['product'] });
  // ロック外の後処理（syncFormChoices）だけを失敗させる
  ctx.syncFormChoices = () => { throw new Error('テスト用の失敗'); };
  const sheet = sheetOf(ctx, 'product');
  const row = addRow(sheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品名': '合格御守', '商品コード': 'GOKAKU', '入数': '20' });
  const res = ctx.processResponseRow_(sheet, row, {});
  assert.strictEqual(res.status, '登録済/選択肢同期失敗', JSON.stringify(res));
  assert.ok(productRow(ctx, 'GOKAKU'), '商品の登録自体は完了している');
  const mail = ctx.__mails[ctx.__mails.length - 1];
  assert.ok(mail.subject.includes('フォームの選択肢の同期に失敗'), mail.subject);
  assert.ok(mail.body.includes('選択肢を同期'), mail.body);
});

module.exports = s.done();
