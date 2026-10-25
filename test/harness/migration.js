// アカウント移行ヘルパー（gas/Migration.gs）。
// 旧環境の記録・凍結、新環境での引き取り、移行後の突き合わせ。
'use strict';
const assert = require('assert');
const F = require('./fixtures');
const { boot, sheetOf, addRow, productRow, rowsOf, eqJ } = F;

const s = F.suite('migration');

/** いまスクリプトプロパティが指しているスプレッドシート（コピー後は新しいほう） */
const cur = (ctx) => ctx.__spreadsheets[ctx.__props.OMAMORI_SPREADSHEET_ID];

const memoOf = (ctx, ss) => {
  const sheet = (ss || ctx.__ss).getSheetByName('移行メモ');
  if (!sheet || sheet.getLastRow() < 2) return null;
  const map = {};
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(r => {
    if (String(r[0] || '').trim()) map[String(r[0])] = r[1];
  });
  return map;
};

const KINDS = ['in', 'out', 'inv', 'product'];

/** いま設定シートが指している4本のフォーム（スタブの Form オブジェクト） */
const formsOf = (ctx) => KINDS
  .map(k => ctx.__forms[String(ctx.getConfigValue_(ctx.getFormSpec_(k).formIdKey, ''))])
  .filter(Boolean);

/** 4本のフォームすべてに失敗注入を仕掛ける */
const failAllForms = (ctx, failOn) => formsOf(ctx).forEach(f => { f.__failOn = failOn; });

/** 旧環境を一通り作る: フォーム4本・トリガー・箱台帳・入荷1件 */
function bootOldEnv() {
  const ctx = boot();
  ctx.setupFormIntegration();
  const inSheet = sheetOf(ctx, 'in');
  const row = addRow(inSheet, {
    'タイムスタンプ': new Date(2026, 8, 9, 3, 0, 0), '入力者': '山田',
    '商品1': '健康守り（HEALTH）', '箱数1': '3',
    '商品2': '金運守り（MONEY）', '箱数2': '2',
  });
  assert.strictEqual(ctx.processResponseRow_(inSheet, row, {}).status, '完了');
  return ctx;
}

// --- 1. 記録 ---------------------------------------------------------------

s.test('migration_1_snapshot が現状を「移行メモ」シートに記録する', () => {
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  const memo = memoOf(ctx);
  assert.ok(memo, '移行メモシートができる');

  assert.strictEqual(String(memo['商品数']), '3');
  assert.strictEqual(String(memo['箱台帳の行数']), '5', 'HEALTH 3箱 + MONEY 2箱');
  assert.strictEqual(String(memo['箱番号最大: HEALTH-26']), '3');
  assert.strictEqual(String(memo['箱番号最大: MONEY-26']), '2');
  assert.strictEqual(String(memo['履歴の行数']), '2');
  assert.strictEqual(String(memo['有効な入力者']), '1');
  assert.strictEqual(String(memo['回答シート行数: 入荷']), '1');
  assert.ok(String(memo['トリガー']).includes('onFormSubmit'), memo['トリガー']);
  assert.ok(String(memo['旧フォームID: 棚卸']).length > 0, 'フォームIDを記録');
  assert.strictEqual(memo['旧フォーム状態: 入荷'], '受付中');
});

s.test('migration_1_snapshot は何度実行しても行が重複しない', () => {
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  const n1 = rowsOf(ctx, '移行メモ').length;
  ctx.migration_1_snapshot();
  assert.strictEqual(rowsOf(ctx, '移行メモ').length, n1, '上書きされる');
});

s.test('migration_1_snapshot は署名などの手入力設定を記録し、自動設定キーは記録しない', () => {
  const ctx = bootOldEnv();
  ctx.setConfigValue_('orgName', 'テスト神社');
  ctx.setConfigValue_('senderName', '山田太郎');
  ctx.migration_1_snapshot();
  const memo = memoOf(ctx);
  assert.strictEqual(memo['設定: orgName'], 'テスト神社');
  assert.strictEqual(memo['設定: senderName'], '山田太郎');
  // 移行時に空にするキーは記録しない（引き継がないので意味がない）
  assert.strictEqual(memo['設定: inFormId'], undefined);
  assert.strictEqual(memo['設定: driveFolderId'], undefined);
  assert.strictEqual(memo['設定: adminEmail'], undefined);
});

// --- 2. 凍結 ---------------------------------------------------------------

s.test('migration_2_freeze は記録前だと実行を拒む', () => {
  const ctx = bootOldEnv();
  assert.throws(() => ctx.migration_2_freeze(), /migration_1_snapshot/);
  assert.strictEqual(ctx.__triggers.length, 4, 'トリガーは消えていない');
});

s.test('migration_2_freeze がフォームの受付を止めてトリガーを全削除する', () => {
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  assert.strictEqual(ctx.__triggers.length, 4);

  ctx.migration_2_freeze();

  assert.strictEqual(ctx.__triggers.length, 0, 'トリガーが全部消える');
  const forms = Object.keys(ctx.__forms).map(id => ctx.__forms[id]);
  assert.strictEqual(forms.length, 4);
  forms.forEach(f => {
    assert.strictEqual(f.isAcceptingResponses(), false, f.getTitle() + ' の受付が止まる');
    assert.ok(f.getCustomClosedFormMessage().includes('移行'), f.getTitle() + ' の閉鎖メッセージ');
  });
});

// 未処理のまま凍結すると、その回答は _旧 シートに取り残されて永久に処理されない
s.test('migration_2_freeze は捌けない未処理の回答が残っていたら中断する', () => {
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  // 商品マスタに無いコード = 何度処理してもエラーになる行…ではなく、
  // 「処理結果が空のまま残る」状況を作るためロックを握った状態で1行追加する
  const inSheet = sheetOf(ctx, 'in');
  addRow(inSheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '健康守り（HEALTH）', '箱数1': '1' });
  const lock = ctx.LockService.getScriptLock();
  lock.waitLock(1000);                 // processPendingResponses がロックを取れない状態にする
  try {
    assert.throws(() => ctx.migration_2_freeze(), /未処理の回答が 1 行残っています/);
  } finally {
    lock.releaseLock();
  }
  assert.strictEqual(ctx.__triggers.length, 4, '中断したのでトリガーは消えていない');
});

s.test('migration_2_freeze は未処理の回答を先に捌いてから止める', () => {
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  const inSheet = sheetOf(ctx, 'in');
  const row = addRow(inSheet, { 'タイムスタンプ': new Date(), '入力者': '山田', '商品1': '縁結び守り（LOVE）', '箱数1': '1' });
  ctx.migration_2_freeze();
  assert.strictEqual(ctx.readRowMap_(inSheet, row).map['処理結果'], '完了', '凍結前に処理される');
  assert.strictEqual(productRow(ctx, 'LOVE')[7], 85, '5 + 1箱×80');
  assert.strictEqual(ctx.__triggers.length, 0);
});

// Google がフォームの公開モデルを変えたため、本番で setAcceptingResponses(false) が
// 「フォームを更新するデータが無効です」で4本すべて失敗した。片方の API が通らなくても
// もう片方で閉じられること、どちらも通らなければ**トリガーを消さずに止まること**を守る。

s.test('setAcceptingResponses が失敗しても setPublished で閉じられる', () => {
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  failAllForms(ctx, { setAcceptingResponses: 'Exception: フォームを更新するデータが無効です。' });

  const out = ctx.migration_2_freeze();

  assert.strictEqual(ctx.__triggers.length, 0, 'フォームは閉じられたのでトリガーも消える');
  formsOf(ctx).forEach(f => assert.strictEqual(f.isPublished(), false, f.getTitle() + ' が未公開になる'));
  assert.ok(out.includes('setAcceptingResponses(false): ★失敗'), '失敗した API がログに残る');
  assert.ok(out.includes('次: migration_3_share()'), out);
});

s.test('setPublished が無い/失敗する環境でも setAcceptingResponses で閉じられる', () => {
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  const forms = formsOf(ctx);
  forms[0].setPublished = undefined;                       // 古いランタイム（メソッドが無い）
  forms.slice(1).forEach(f => { f.__failOn = { setPublished: true }; });

  ctx.migration_2_freeze();

  assert.strictEqual(ctx.__triggers.length, 0);
  forms.forEach(f => assert.strictEqual(f.isAcceptingResponses(), false, f.getTitle() + ' の受付が止まる'));
});

// ★今回の再発防止。フォームが閉じられないのにトリガーだけ消すのが最悪の状態
s.test('両方の API が失敗したら migration_2_freeze は中断し、トリガーを消さない', () => {
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  failAllForms(ctx, {
    setPublished: 'Exception: フォームを更新するデータが無効です。',
    setAcceptingResponses: 'Exception: フォームを更新するデータが無効です。',
  });

  assert.throws(() => ctx.migration_2_freeze(), (e) => {
    const m = String(e.message);
    assert.ok(m.includes('トリガーはまだ削除していません'), m);
    assert.ok(m.includes('migration_diagnoseForms()'), '原因の調べ方を案内する');
    assert.ok(m.includes('migration_2_freeze_skipForms()'), '回避策を案内する');
    return true;
  });

  assert.strictEqual(ctx.__triggers.length, 4, '★トリガーが残る（回答は処理され続ける）');
  formsOf(ctx).forEach(f => assert.strictEqual(f.isAcceptingResponses(), true, '受付中のまま'));
});

s.test('手でフォームを閉じたあとは migration_closeOldForms() だけ再実行できる', () => {
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  failAllForms(ctx, { setPublished: true, setAcceptingResponses: true });
  assert.strictEqual(ctx.migration_closeOldForms().failed.length, 4);

  // 画面から手動で受付を止めた状況
  formsOf(ctx).forEach(f => { f.__failOn = null; f.setAcceptingResponses(false); f.__failOn = { setPublished: true, setAcceptingResponses: true }; });

  const r = ctx.migration_closeOldForms();
  eqJ(r.failed, [], '閉じていれば API が失敗しても成功と判定する');
  assert.strictEqual(r.closed.length, 4);
  ctx.migration_2_freeze();
  assert.strictEqual(ctx.__triggers.length, 0, '止まっていれば先へ進める');
});

s.test('閉鎖メッセージだけ失敗しても受付停止は成功扱いになる', () => {
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  failAllForms(ctx, { setCustomClosedFormMessage: 'Exception: 無効です。' });

  const out = ctx.migration_2_freeze();

  assert.strictEqual(ctx.__triggers.length, 0);
  assert.ok(out.includes('受付停止の成否には影響しません'), out);
});

s.test('migration_2_freeze_skipForms はフォームを閉じられなくても先へ進む', () => {
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  failAllForms(ctx, { setPublished: true, setAcceptingResponses: true });

  const out = ctx.migration_2_freeze_skipForms();

  assert.strictEqual(ctx.__triggers.length, 0, '関門を飛ばすのでトリガーは消える');
  assert.ok(out.includes('フォームを閉じられないまま先へ進みました'), out);
  assert.ok(out.includes('画面から必ず受付を止めてください'), '危険を伝える');
});

s.test('migration_diagnoseForms はフォームの状態を変えない', () => {
  const ctx = bootOldEnv();
  const before = formsOf(ctx).map(f => [f.isPublished(), f.isAcceptingResponses(), f.getCustomClosedFormMessage()]);
  formsOf(ctx)[1].__failOn = { setAcceptingResponses: 'Exception: フォームを更新するデータが無効です。' };

  const out = ctx.migration_diagnoseForms();

  eqJ(formsOf(ctx).map(f => [f.isPublished(), f.isAcceptingResponses(), f.getCustomClosedFormMessage()]),
    before, '公開状態・受付状態・閉鎖メッセージが変わらない');
  assert.strictEqual(ctx.__triggers.length, 4, 'トリガーも触らない');
  assert.ok(out.includes('setAcceptingResponses(いまと同じ値): ★失敗'), '失敗する API を特定できる');
  assert.ok(out.includes('setPublished(いまと同じ値): 成功'), '通る API も分かる');
});

s.test('migration_diagnoseForms は状態が読めない API を無理に試さない', () => {
  const ctx = bootOldEnv();
  failAllForms(ctx, { isAcceptingResponses: 'Exception: 読めません。' });

  const out = ctx.migration_diagnoseForms();

  assert.ok(out.includes('isAcceptingResponses(): ★読めません'), out);
  assert.ok(out.includes('setAcceptingResponses(): いまの値が読めないので試しません'), out);
});

// --- 3. 引き渡し -----------------------------------------------------------

s.test('migration_3_share はメールアドレス未記入だと実行を拒む', () => {
  const ctx = bootOldEnv();
  assert.throws(() => ctx.migration_3_share(), /MIGRATION_NEW_ACCOUNT_EMAIL/);
});

s.test('migration_3_share が共有して退避コピーを作り、旧IDをログに出す', () => {
  const ctx = bootOldEnv();
  ctx.MIGRATION_NEW_ACCOUNT_EMAIL = 'new@example.co.jp';
  const out = ctx.migration_3_share();

  assert.ok(ctx.__shared.some(x => x.id === 'SSID' && x.email === 'new@example.co.jp'), JSON.stringify(ctx.__shared));
  assert.ok(ctx.__shared.some(x => x.email === 'new@example.co.jp' && x.id !== 'SSID'), 'ラベルフォルダも共有');
  // 退避コピーが旧アカウント側に残る
  const copies = Object.keys(ctx.__spreadsheets).filter(id => id !== 'SSID');
  assert.strictEqual(copies.length, 1, JSON.stringify(copies));
  assert.ok(ctx.__spreadsheets[copies[0]].getName().includes('移行前退避'), ctx.__spreadsheets[copies[0]].getName());
  // 新環境で使う旧IDを案内している
  assert.ok(out.includes("MIGRATION_OLD_SPREADSHEET_ID = 'SSID'"), out);
});

// --- 4. 引き取り -----------------------------------------------------------

s.test('migration_4_adopt は旧ID未記入だと実行を拒む', () => {
  const ctx = boot({ skipInit: true });
  delete ctx.__props.OMAMORI_SPREADSHEET_ID;
  assert.throws(() => ctx.migration_4_adopt(), /MIGRATION_OLD_SPREADSHEET_ID/);
});

s.test('migration_4_adopt は既にブックを掴んでいたら二重コピーを拒む', () => {
  const ctx = bootOldEnv();
  ctx.MIGRATION_OLD_SPREADSHEET_ID = 'SSID';
  assert.throws(() => ctx.migration_4_adopt(), /既にスプレッドシートを掴んでいます/);
  assert.strictEqual(Object.keys(ctx.__spreadsheets).length, 1, 'コピーは作られない');
});

s.test('migration_4_adopt がコピー・プロパティ設定・設定シートのID消去をまとめてやる', () => {
  // 旧環境を作り、記録してから、同じコンテキストで「新環境」を演じる
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  const oldConfig = ctx.getConfigMap_();
  assert.ok(oldConfig.inFormId, '旧環境にはフォームIDが入っている');
  assert.ok(oldConfig.labelTemplateId, '旧環境にはテンプレートIDが入っている');

  // 新しい空のプロジェクトに相当する状態にする
  delete ctx.__props.OMAMORI_SPREADSHEET_ID;
  ctx.FI_CONFIG_CACHE_ = null;
  ctx.MIGRATION_OLD_SPREADSHEET_ID = 'SSID';

  const out = ctx.migration_4_adopt();

  const newId = ctx.__props.OMAMORI_SPREADSHEET_ID;
  assert.ok(newId && newId !== 'SSID', '新しいIDになる: ' + newId);
  const newSs = ctx.__spreadsheets[newId];
  assert.strictEqual(newSs.getName(), 'お守り在庫管理データ');

  // データは引き継がれている
  assert.ok(newSs.getSheetByName('商品管理'), '商品管理');
  assert.ok(newSs.getSheetByName('箱台帳'), '箱台帳');
  assert.ok(newSs.getSheetByName('移行メモ'), '移行メモも一緒に来る');
  assert.strictEqual(Object.keys(ctx.getProductsData().data).length, 3);

  // 自動設定キーが空になっている（ここが移行の最大の事故ポイント）
  const cfg = ctx.getConfigMap_();
  ['driveFolderId', 'labelTemplateId', 'inFormId', 'inFormUrl', 'inFormEditUrl',
   'outFormId', 'outFormUrl', 'outFormEditUrl', 'invFormId', 'invFormUrl', 'invFormEditUrl',
   'productFormId', 'productFormUrl', 'productFormEditUrl', 'adminEmail'].forEach(k => {
    assert.strictEqual(String(cfg[k] || ''), '', k + ' が空になっていない');
  });
  // 人が記入した設定は残る
  assert.strictEqual(String(cfg.maxBoxesPerLine), '50', '手入力の設定は消さない');
  assert.ok(out.includes('移行メモを引き継ぎました'), out);
});

s.test('migration_4_adopt の後に setupFormIntegration すると新しいフォームが作られる', () => {
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  const oldFormIds = ctx.FI_KIND_ORDER_.map(k => ctx.getConfigValue_(ctx.getFormSpec_(k).formIdKey, ''));

  delete ctx.__props.OMAMORI_SPREADSHEET_ID;
  ctx.FI_CONFIG_CACHE_ = null;
  ctx.MIGRATION_OLD_SPREADSHEET_ID = 'SSID';
  ctx.migration_4_adopt();
  ctx.setupFormIntegration();

  const newFormIds = ctx.FI_KIND_ORDER_.map(k => ctx.getConfigValue_(ctx.getFormSpec_(k).formIdKey, ''));
  newFormIds.forEach((id, i) => {
    assert.ok(id, '新しいフォームIDが入る');
    assert.notStrictEqual(id, oldFormIds[i], '旧フォームを掴み直していない');
  });
  // 旧回答シートは _旧 に退避され、新しい空のシートが作られる
  const names = cur(ctx).getSheets().map(s2 => s2.getName());
  assert.ok(names.some(n => n.indexOf('フォーム回答_入荷_旧') === 0), names.join(' / '));
  assert.ok(names.indexOf('フォーム回答_入荷') >= 0, '新しい回答シートもある');
  // 箱台帳は引き継がれているので採番が続く
  assert.strictEqual(ctx.getNextBoxNumber_('HEALTH', '26'), 4, '0001 に戻らない');
});

// --- 5. 突き合わせ ---------------------------------------------------------

function migrateAll(opts) {
  const ctx = bootOldEnv();
  ctx.migration_1_snapshot();
  // 本番の手順は snapshot → freeze → share → adopt。freeze を飛ばすと旧フォームが
  // 受付中のまま残る（それを検出することも migration_5_verify の役目）
  if (!(opts && opts.skipFreeze)) ctx.migration_2_freeze();
  delete ctx.__props.OMAMORI_SPREADSHEET_ID;
  ctx.FI_CONFIG_CACHE_ = null;
  ctx.MIGRATION_OLD_SPREADSHEET_ID = 'SSID';
  ctx.migration_4_adopt();
  ctx.setupFormIntegration();
  return ctx;
}

s.test('migration_5_verify が正常な移行を OK と判定する', () => {
  const ctx = migrateAll();
  const out = ctx.migration_5_verify();
  assert.ok(out.includes('自動で確認できる範囲はすべて OK'), out);
  assert.ok(!out.includes('★NG'), out);
  assert.ok(out.includes('箱番号の最大値（2件）'), out);
  assert.ok(out.includes('人が確認してください'), '人がやる項目を案内する');
});

// 箱台帳を引き継ぎ損ねると、既に印刷したラベルと番号が衝突する。
// 手で数えるのは現実的でない（79商品×年）ので、ここを自動で止める価値が高い。
s.test('migration_5_verify が箱番号のずれを検出する', () => {
  const ctx = migrateAll();
  // 箱台帳を取りこぼした状況を作る
  const ledger = cur(ctx).getSheetByName('箱台帳');
  ledger.deleteRows(2, ledger.getLastRow() - 1);
  const out = ctx.migration_5_verify();
  assert.ok(out.includes('★NG') && out.includes('箱番号の最大値'), out);
  assert.ok(out.includes('HEALTH-26（移行前 3 → 現在 0）'), out);
  assert.ok(out.includes('既に印刷したラベルと番号が衝突します'), '結果の意味を伝える');
});

s.test('migration_5_verify が商品数・履歴の欠落を検出する', () => {
  const ctx = migrateAll();
  const ps = cur(ctx).getSheetByName('商品管理');
  ps.deleteRows(2, 1);   // 商品を1件失う
  const out = ctx.migration_5_verify();
  assert.ok(out.includes('★NG') && out.includes('商品数'), out);
  assert.ok(out.includes('移行前 3 → 現在 2'), out);
});

s.test('migration_5_verify が未公開・受付停止のフォームを検出する', () => {
  const ctx = migrateAll();
  const invId = ctx.getConfigValue_('invFormId', '');
  ctx.__forms[invId].setPublished(false);
  const out = ctx.migration_5_verify();
  assert.ok(out.includes('★NG') && out.includes('棚卸フォーム') && out.includes('未公開'), out);
  assert.ok(out.includes('このままでは回答を受け付けません'), out);
});

// 旧フォームが受付中のまま残ると、回答できるのに誰も処理しない（在庫に反映されず通知もない）
s.test('migration_5_verify が受付中の旧フォームを検出する', () => {
  const ctx = migrateAll({ skipFreeze: true });
  const out = ctx.migration_5_verify();
  assert.ok(out.includes('【旧フォーム】'), out);
  assert.ok(out.includes('★NG') && out.includes('フォーム（旧）'), out);
  assert.ok(out.includes('回答されても誰も処理しません'), '結果の意味を伝える');
});

s.test('migration_5_verify は閉じた旧フォームを OK と判定する', () => {
  const ctx = migrateAll();                       // freeze 済み = 旧フォームは閉じている
  const out = ctx.migration_5_verify();
  assert.ok(out.includes('【旧フォーム】'), out);
  assert.ok(out.includes('フォーム（旧）') && out.includes('受付停止'), out);
  assert.ok(!out.includes('★NG'), out);
});

s.test('migration_5_verify がトリガー未設置を検出する', () => {
  const ctx = migrateAll();
  ctx.__triggers.length = 0;
  const out = ctx.migration_5_verify();
  assert.ok(out.includes('★NG') && out.includes('トリガー onFormSubmit'), out);
  assert.ok(out.includes('setupFormIntegration() を実行してください'), out);
});

s.test('migration_5_verify が通知先の個人アドレス残りを知らせる', () => {
  const ctx = migrateAll();
  ctx.setConfigValue_('adminEmail', 'someone@gmail.com');
  const out = ctx.migration_5_verify();
  assert.ok(out.includes('通知先が個人アドレスのままです'), out);
});

s.test('migration_5_verify は移行メモが無くても新環境のチェックだけは行う', () => {
  const ctx = migrateAll();
  const ss = cur(ctx);
  ss.deleteSheet(ss.getSheetByName('移行メモ'));
  const out = ctx.migration_5_verify();
  assert.ok(out.includes('移行メモが無いため'), out);
  assert.ok(out.includes('トリガー onFormSubmit'), '新環境のチェックは動く');
  assert.ok(!out.includes('★NG'), '新環境は正常なので NG は出ない: ' + out);
});

module.exports = s.done();
