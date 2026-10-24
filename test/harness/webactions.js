// doGet 経由の Web アクション: 既存アクションの互換、箱台帳操作、
// バックアップ系、履歴の一括追加、getFormConfig。
'use strict';
const assert = require('assert');
const F = require('./fixtures');
const { boot, call, productRow, histRows, eqJ } = F;

const s = F.suite('webactions');

s.test('既存アクションの互換と data の二重デコード対策', () => {
  const ctx = boot();
  assert.strictEqual(call(ctx, 'ping').message, 'pong');
  eqJ(call(ctx, 'getStock').data.MONEY, { stock: 20, safeStock: 50 });

  // 備考に % が含まれていても壊れない（旧実装は二重デコードで空になった）
  const before = histRows(ctx).length;
  const r = call(ctx, 'addHistory', { record: { date: 'x', type: 'out', productCode: 'HEALTH', productName: '健康守り', quantity: 1, note: '20%引き' } });
  assert.strictEqual(r.success, true);
  assert.strictEqual(histRows(ctx).length, before + 1);
  assert.strictEqual(histRows(ctx)[0][5], '20%引き');

  // 旧クライアントが送ってくる二重エンコードも受け付ける
  const out = JSON.parse(ctx.doGet({
    parameter: { action: 'updateStock', data: encodeURIComponent(JSON.stringify({ productCode: 'MONEY', stock: 7, safeStock: 50 })) },
  }).getContent());
  assert.strictEqual(out.success, true);
  assert.strictEqual(productRow(ctx, 'MONEY')[7], 7);

  eqJ(call(ctx, 'nope'), { success: false, error: 'Unknown action: nope' });
});

s.test('箱台帳: 次番号の取得・登録・重複検出・状態更新', () => {
  const ctx = boot();
  eqJ(call(ctx, 'getNextBoxNumber', { productCode: 'health', year: '26' }),
    { success: true, data: { productCode: 'HEALTH', year: '26', next: 1 } }, '小文字でも大文字に正規化');

  let out = call(ctx, 'registerBoxes', { productCode: 'HEALTH', year: '26', start: 1, count: 3 });
  assert.strictEqual(out.success, true);
  assert.strictEqual(out.registered, 3);

  out = call(ctx, 'registerBoxes', { productCode: 'HEALTH', year: '26', start: 3, count: 2 });
  assert.strictEqual(out.success, false, '重複があれば success:false');
  eqJ(out.conflicts, ['HEALTH-26-0003']);
  assert.strictEqual(out.registered, 1);

  out = call(ctx, 'checkBoxes', { qrCodes: ['HEALTH-26-0001', 'OLD-25-0001'] });
  assert.strictEqual(out.data['HEALTH-26-0001'].status, '発行済');
  assert.strictEqual(out.data['OLD-25-0001'].status, 'unknown');

  out = call(ctx, 'markBoxes', { qrCodes: ['HEALTH-26-0001', 'OLD-25-0001'], status: 'in', source: 'app' });
  eqJ([out.updated, out.added], [1, 1], '台帳に無いコードは追加する');
  assert.strictEqual(call(ctx, 'checkBoxes', { qrCodes: ['OLD-25-0001'] }).data['OLD-25-0001'].status, '入庫済');
});

s.test('バックアップ: 作成 → 一覧 → プレビュー → 復元 → 取り消し', () => {
  const ctx = boot();
  let out = call(ctx, 'createBackup', { reason: '手動', actor: '山田', note: 'テスト' });
  assert.strictEqual(out.success, true);
  const backupId = out.backupId;
  assert.strictEqual(out.count, 3);

  out = call(ctx, 'listBackups', { limit: 5 });
  eqJ([out.data.length, out.data[0].backupId, out.data[0].reason, out.data[0].count], [1, backupId, '手動', 3]);

  ctx.__ss.getSheetByName('商品管理').getRange(2, 8).setValue(999);
  out = call(ctx, 'previewRestore', { backupId, scope: 'stock' });
  eqJ(out.data.changes, [{ code: 'HEALTH', name: '健康守り', fields: [{ label: '現在庫', from: '999', to: '100' }] }]);
  assert.strictEqual(productRow(ctx, 'HEALTH')[7], 999, 'プレビューは書き込まない');

  ctx.__advance(1000);
  out = call(ctx, 'restoreBackup', { backupId, scope: 'stock', actor: '山田' });
  assert.strictEqual(out.success, true);
  assert.strictEqual(productRow(ctx, 'HEALTH')[7], 100);

  ctx.__advance(1000);
  call(ctx, 'restoreBackup', { backupId: out.undoBackupId, scope: 'stock', actor: '山田' });
  assert.strictEqual(productRow(ctx, 'HEALTH')[7], 999, '復元を取り消せる');
});

s.test('バックアップ: 引数不足と存在しないIDはエラーを返す', () => {
  const ctx = boot();
  eqJ(call(ctx, 'previewRestore', {}), { success: false, error: 'backupId が必要です' });
  eqJ(call(ctx, 'restoreBackup', {}), { success: false, error: 'backupId が必要です' });
  const out = call(ctx, 'previewRestore', { backupId: 'BK_19990101_000000' });
  assert.strictEqual(out.success, false);
  assert.ok(out.error.includes('バックアップが見つかりません'), out.error);
});

s.test('addHistoryBatch は addHistory の逐次呼び出しと同じ並びになる', () => {
  const records = [];
  for (let i = 1; i <= 30; i++) {
    records.push({ date: 'D' + i, type: 'in', productCode: 'HEALTH', productName: '健康守り', quantity: i, note: 'n' + i });
  }
  const a = boot();
  eqJ(call(a, 'addHistoryBatch', { records }), { success: true, added: 30 });
  const rowsA = histRows(a);
  assert.strictEqual(rowsA.length, 30);
  assert.strictEqual(rowsA[0][0], 'D30', '配列の最後が一番上');
  assert.strictEqual(rowsA[29][0], 'D1');

  const b = boot();
  records.forEach(r => call(b, 'addHistory', { record: r }));
  eqJ(rowsA, histRows(b), '一括と逐次で結果が一致する');
});

s.test('addHistoryBatch は空配列と上限を扱う', () => {
  const ctx = boot();
  eqJ(call(ctx, 'addHistoryBatch', { records: [] }), { success: true, added: 0 });
  const many = [];
  for (let i = 0; i < 201; i++) many.push({ type: 'in', productCode: 'X', productName: 'X', quantity: 1 });
  const out = call(ctx, 'addHistoryBatch', { records: many });
  assert.strictEqual(out.success, false);
  assert.ok(out.error.includes('200 件までです'), out.error);
  assert.strictEqual(histRows(ctx).length, 0, '上限超過なら1件も書かない');
});

s.test('履歴1000件の上限処理が一括追加でも効く', () => {
  const ctx = boot();
  const sheet = ctx.__ss.getSheetByName('履歴');
  const bulk = [];
  for (let i = 0; i < 995; i++) bulk.push(['D' + i, 'in', 'HEALTH', '健康守り', 1, '']);
  sheet.getRange(2, 1, bulk.length, 6).setValues(bulk);
  assert.strictEqual(sheet.getLastRow(), 996);
  const records = [];
  for (let i = 1; i <= 20; i++) records.push({ date: 'NEW' + i, type: 'in', productCode: 'HEALTH', productName: '健康守り', quantity: 1 });
  call(ctx, 'addHistoryBatch', { records });
  assert.strictEqual(sheet.getLastRow(), 1001, '1000件＋ヘッダーに丸める: ' + sheet.getLastRow());
  assert.strictEqual(sheet.dump()[1][0], 'NEW20', '新しいものが上に残る');
});

s.test('getFormConfig が4フォームぶんの情報とバックアップ状態を返す', () => {
  const ctx = boot();
  assert.strictEqual(call(ctx, 'getFormConfig').data.setupDone, false, 'フォーム未作成なら false');

  ctx.setupFormIntegration();
  const d = call(ctx, 'getFormConfig').data;
  assert.strictEqual(d.setupDone, true);
  eqJ(d.forms.map(f => f.kind), ['in', 'out', 'inv', 'product']);
  eqJ(d.forms.map(f => f.label), ['入荷', '出荷', '棚卸', '商品登録']);
  eqJ(d.forms.map(f => f.responseSheet),
    ['フォーム回答_入荷', 'フォーム回答_出荷', 'フォーム回答_棚卸', 'フォーム回答_商品登録']);
  d.forms.forEach(f => {
    assert.ok(f.url.indexOf('https://docs.google.com/forms/') === 0, f.kind + ': ' + f.url);
    assert.ok(f.editUrl.indexOf('https://docs.google.com/forms/') === 0, f.kind + ': ' + f.editUrl);
  });
  // 古い管理画面との互換キーも残す
  assert.strictEqual(d.inFormUrl, d.forms[0].url);
  assert.strictEqual(d.outFormEditUrl, d.forms[1].editUrl);
  eqJ(d.triggers, { onFormSubmit: true, syncFormChoices: true, processPendingResponses: true, dailyBackupJob: true });
  assert.strictEqual(d.backup.ready, true);
  eqJ([d.staffCount, d.productCount], [1, 3]);
});

s.test('getStaff は有効な入力者だけを返す', () => {
  const ctx = boot();
  eqJ(call(ctx, 'getStaff').data, [{ name: '山田', hasEmail: true }]);
});

s.test('見積メールの署名は設定シートから読む（コードに個人情報を持たない）', () => {
  const ctx = boot();
  const order = { suppliers: { '株式会社A': { items: [{ name: '健康守り', quantity: 100 }], contact: '佐藤', email: 'a@example.com' } } };

  ctx.createQuotationEmailDrafts(order);
  let draft = ctx.__mails[ctx.__mails.length - 1];
  assert.ok(draft.draft, '下書きとして作る');
  assert.strictEqual(draft.subject, '【お見積り依頼】授与品について', '未設定なら神社名なし');
  assert.ok(!draft.body.includes('****'), '未設定のプレースホルダが残らない: ' + draft.body);

  ['orgName', 'senderName', 'senderShortName', 'senderEmail', 'senderAddress', 'senderTel', 'senderFax', 'senderMobile']
    .forEach((k, i) => ctx.setConfigValue_(k,
      ['テスト神社', '山田太郎', '山田', 'yamada@example.com', '〒000-0000 どこか', '000-000-0000', '000-000-0001', '090-0000-0000'][i]));

  ctx.createQuotationEmailDrafts(order);
  draft = ctx.__mails[ctx.__mails.length - 1];
  assert.strictEqual(draft.subject, '【お見積り依頼】授与品について（テスト神社）');
  assert.ok(draft.body.includes('テスト神社の山田です。'), draft.body);
  assert.ok(draft.body.endsWith('山田太郎 yamada@example.com\n〒000-0000 どこか\nTEL:000-000-0000 FAX:000-000-0001\n携帯:090-0000-0000\n'),
    JSON.stringify(draft.body.slice(-120)));
});

module.exports = s.done();
