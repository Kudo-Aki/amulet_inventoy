// バックアップと復元: 採番、保持世代の整理、プレビューの分類、範囲別の復元、
// 復元の取り消し、そして「ロック内から呼んでも止まらない」ことの回帰。
'use strict';
const assert = require('assert');
const F = require('./fixtures');
const { boot, productRow, histRows, rowsOf, ledgerRows, eqJ } = F;

const s = F.suite('backup');

const detailIds = (ctx) => [...new Set(rowsOf(ctx, 'バックアップ明細').map(r => r[0]))];

s.test('backupId は秒まで含み、同じ秒なら _2 が付く', () => {
  const ctx = boot();
  const b1 = ctx.takeBackup_('手動', '山田', 'テスト', {});
  assert.strictEqual(b1.backupId, 'BK_20260909_030000', b1.backupId);
  assert.strictEqual(b1.count, 3);
  // Utilities.formatDate が秒を置換できないと、同一分内の世代が全て衝突する
  assert.strictEqual(ctx.takeBackup_('手動', '山田', '', {}).backupId, 'BK_20260909_030000_2');
  ctx.__advance(1000);
  assert.strictEqual(ctx.takeBackup_('手動', '山田', '', {}).backupId, 'BK_20260909_030001');
});

s.test('明細は商品管理の A〜K の11列（L更新日時は保存しない）', () => {
  const ctx = boot();
  ctx.takeBackup_('手動', '山田', 'テスト', {});
  const det = ctx.__ss.getSheetByName('バックアップ明細').dump();
  eqJ(det[0], ['backupId', '商品コード', '商品名', '入数', '単価（税込）', '発注先', '担当者', 'メールアドレス', '現在庫', '安心在庫', '発注状況', '発注数/納期']);
  const row = det.find(r => r[1] === 'HEALTH');
  eqJ(row.slice(1), ['HEALTH', '健康守り', 50, 300, '株式会社A', '佐藤', 'a@example.com', 100, 30, '発注済み',
    '合計2600個: 1000個(1/31), 1000個(2/15), 600個(3/1)']);
  eqJ(ledgerRows(ctx)[0].slice(2, 6), ['手動', '山田', 3, 'テスト']);
});

s.test('保持世代数を超えたら古い順に消え、明細も一緒に消える', () => {
  const ctx = boot();
  ctx.setConfigValue_('maxBackups', 3);
  const ids = [];
  for (let i = 0; i < 5; i++) { ids.push(ctx.takeBackup_('手動', 'テスト', '', {}).backupId); ctx.__advance(1000); }
  eqJ(ledgerRows(ctx).map(r => r[0]), ids.slice(2), '新しい3件だけ残る');
  eqJ(detailIds(ctx).sort(), ids.slice(2).sort(), '明細も同じ3件');
  assert.throws(() => ctx.readBackupRows_(ids[0]), /保持世代数を超えて削除/, '消えた世代は理由の分かるエラー');
});

s.test('prune:false は世代整理をしない（復元前の控え用）', () => {
  const ctx = boot();
  ctx.setConfigValue_('maxBackups', 1);
  ctx.takeBackup_('手動', 'テスト', '', {});
  ctx.__advance(1000);
  const before = ledgerRows(ctx).length;
  ctx.takeBackup_('復元前', 'テスト', '', { prune: false });
  assert.strictEqual(ledgerRows(ctx).length, before + 1);
});

s.test('プレビューが 変更／据え置き／復活させない を正しく分類する', () => {
  const ctx = boot();
  const bk = ctx.takeBackup_('棚卸前', '山田', '', {}).backupId;
  const ps = ctx.__ss.getSheetByName('商品管理');
  ps.getRange(2, 8).setValue(250);            // HEALTH 現在庫 100 → 250
  ps.getRange(2, 2).setValue('健康守り(改)'); // 商品名も変える
  ps.getRange(4, 1, 1, 12).setValues([['', '', '', '', '', '', '', '', '', '', '', '']]); // LOVE を消す
  ps.getRange(5, 1, 1, 12).setValues([['NEW', '新商品', 10, 100, '', '', '', 7, 3, '未発注', '', '']]);

  const pv = ctx.previewRestore_(bk, 'stock');
  assert.strictEqual(pv.changeCount, 1, JSON.stringify(pv.changes));
  eqJ(pv.changes[0].fields, [{ label: '現在庫', from: '250', to: '100' }], '在庫のみ範囲では商品名の差は出ない');
  eqJ(pv.added.map(a => a.code), ['NEW'], 'バックアップに無い商品は据え置き');
  eqJ(pv.missing.map(a => a.code), ['LOVE'], '今存在しない商品は復活させない');

  const pvAll = ctx.previewRestore_(bk, 'all');
  eqJ(pvAll.changes.find(c => c.code === 'HEALTH').fields.map(f => f.label).sort(), ['商品名', '現在庫']);
});

s.test('stock 復元は現在庫と安心在庫だけを戻し、履歴には書かない', () => {
  const ctx = boot();
  const bk = ctx.takeBackup_('棚卸前', '山田', '', {}).backupId;
  const ps = ctx.__ss.getSheetByName('商品管理');
  ps.getRange(2, 2).setValue('健康守り(改)');
  ps.getRange(2, 3).setValue(60);
  ps.getRange(2, 8).setValue(250);
  ps.getRange(2, 9).setValue(99);
  ctx.__advance(1000);

  const r = ctx.restoreBackup_(bk, 'stock', '山田');
  assert.strictEqual(r.success, true);
  eqJ(r.restored.map(x => x.code), ['HEALTH']);
  const h = productRow(ctx, 'HEALTH');
  assert.strictEqual(h[7], 100, '現在庫は戻る');
  assert.strictEqual(h[8], 30, '安心在庫は戻る');
  assert.strictEqual(h[1], '健康守り(改)', '商品名は戻さない');
  assert.strictEqual(h[2], 60, '入数は戻さない');
  assert.ok(String(h[11]).length > 0, '更新日時が刻まれる');

  // 79商品の復元で履歴上限1000行の8%を消費するため、監査記録は台帳が担う
  assert.strictEqual(histRows(ctx).length, 0, '履歴は増やさない');
  const led = ledgerRows(ctx);
  assert.ok(led.some(x => x[0].startsWith('RS_') && x[2] === '復元'), JSON.stringify(led));
  assert.ok(led.some(x => x[0] === r.undoBackupId && x[2] === '復元前'), r.undoBackupId);
  assert.ok(ctx.__mails.some(m => String(m.subject).includes('バックアップから復元')), '管理者へ通知');
});

s.test('all 復元は B〜K を戻し A列は変えない。復元 → 取り消し で元に戻る', () => {
  const ctx = boot();
  const bk = ctx.takeBackup_('手動', '山田', '', {}).backupId;
  const ps = ctx.__ss.getSheetByName('商品管理');
  ps.getRange(2, 2).setValue('健康守り(改)');
  ps.getRange(2, 3).setValue(60);
  ps.getRange(2, 8).setValue(250);
  ps.getRange(2, 10).setValue('未発注');
  ctx.__advance(1000);

  const r = ctx.restoreBackup_(bk, 'all', '山田');
  const h = productRow(ctx, 'HEALTH');
  eqJ([h[0], h[1], h[2], h[7], h[9]], ['HEALTH', '健康守り', 50, 100, '発注済み']);

  ctx.__advance(1000);
  ctx.restoreBackup_(r.undoBackupId, 'all', '山田');
  const h2 = productRow(ctx, 'HEALTH');
  eqJ([h2[1], h2[2], h2[7], h2[9]], ['健康守り(改)', 60, 250, '未発注'], '取り消しで復元前の値に戻る');
});

// 本番の ScriptLock は再入できない。takeBackup_ は棚卸フォームの処理の
// ロック内から呼ばれるので、ここでロックを取ると必ず 30 秒後に例外になる。
s.test('ロック内から takeBackup_ を呼んでも止まらない（再入禁止の回帰）', () => {
  const ctx = boot();
  const lock = ctx.LockService.getScriptLock();
  lock.waitLock(30000);
  let r;
  try {
    r = ctx.takeBackup_('棚卸(フォーム)', '山田', '', {});
  } finally {
    lock.releaseLock();
  }
  assert.strictEqual(r.count, 3);
});

s.test('takeBackupLocked_ はロック内から呼ぶと失敗する（用途の取り違えを検出）', () => {
  const ctx = boot();
  const lock = ctx.LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    assert.throws(() => ctx.takeBackupLocked_('手動', '山田', ''), /再入できません/);
  } finally {
    lock.releaseLock();
  }
});

s.test('一覧は新しい順で、復元の記録は含めない', () => {
  const ctx = boot();
  const a = ctx.takeBackup_('手動', '山田', '1件目', {}).backupId; ctx.__advance(1000);
  ctx.takeBackup_('棚卸(フォーム)', '佐藤', '', {}); ctx.__advance(1000);
  ctx.restoreBackup_(a, 'stock', '山田');
  const list = ctx.listBackups_(0);
  assert.ok(!list.some(x => x.backupId.startsWith('RS_')), '復元記録は一覧に出さない');
  assert.strictEqual(list[0].reason, '復元前', JSON.stringify(list.map(x => x.reason)));
  assert.strictEqual(list[list.length - 1].backupId, a, '最後が一番古い');
  eqJ(ctx.listBackups_(2).map(x => x.reason), ['復元前', '棚卸(フォーム)']);
});

s.test('毎日バックアップは発火時に設定フラグを読む（設定変更に再デプロイ不要）', () => {
  const ctx = boot();
  assert.strictEqual(ctx.dailyBackupJob().skipped, true, '既定は OFF');
  assert.strictEqual(ctx.__ss.getSheetByName('バックアップ台帳'), null, 'スキップ時はシートも作らない');
  ctx.setConfigValue_('dailyBackup', 'TRUE');
  assert.strictEqual(ctx.dailyBackupJob().skipped, undefined);
  assert.strictEqual(ledgerRows(ctx).length, 1);
  assert.strictEqual(ledgerRows(ctx)[0][2], '毎日');
});

s.test('getBackupStatus_ は台帳シートが無ければ作らずに ready:false を返す', () => {
  const ctx = boot();
  const st = ctx.getBackupStatus_();
  assert.strictEqual(st.ready, false);
  assert.strictEqual(ctx.__ss.getSheetByName('バックアップ台帳'), null, '状態を見ただけでシートを作らない');
  eqJ([st.maxBackups, st.beforeFormInventory, st.beforeAppInventory, st.beforeStockSave, st.daily],
    [30, true, true, false, false]);
  eqJ(st.scopes.map(x => x.key), ['stock', 'all']);
});

module.exports = s.done();
