// セットアップ系: setupFormIntegration の通し、フォームの公開状態、
// initializeSpreadsheet の上書き事故防止。
'use strict';
const assert = require('assert');
const F = require('./fixtures');
const { boot, eqJ } = F;

const s = F.suite('setup');

// --- setupFormIntegration -------------------------------------------------

s.test('setupFormIntegration が4種別のフォーム・シート・トリガーを作る', () => {
  const ctx = boot();
  const log = String(ctx.setupFormIntegration());

  eqJ(ctx.FI_KIND_ORDER_, ['in', 'out', 'inv', 'product'], '種別の順序');
  ctx.FI_KIND_ORDER_.forEach(kind => {
    const spec = ctx.getFormSpec_(kind);
    assert.ok(ctx.__ss.getSheetByName(spec.sheetDefault), spec.label + 'の回答シートが作られる');
    assert.ok(/^https:\/\/docs\.google\.com\/forms\//.test(ctx.getConfigValue_(spec.formUrlKey, '')), spec.label + 'のURLが設定される');
    assert.ok(log.includes(spec.label + 'フォーム: https://'), spec.label + 'がログに出る: ' + log);
  });

  assert.ok(ctx.__ss.getSheetByName('バックアップ台帳'), 'バックアップ台帳');
  assert.ok(ctx.__ss.getSheetByName('バックアップ明細'), 'バックアップ明細');

  const handlers = ctx.__triggers.map(t => t.getHandlerFunction()).sort();
  eqJ(handlers, ['dailyBackupJob', 'onFormSubmit', 'processPendingResponses', 'syncFormChoices'], handlers.join(','));
});

s.test('再実行してもフォームもトリガーも増えない', () => {
  const ctx = boot();
  ctx.setupFormIntegration();
  const forms = Object.keys(ctx.__forms).length;
  const trigs = ctx.__triggers.length;
  ctx.setupFormIntegration();
  assert.strictEqual(Object.keys(ctx.__forms).length, forms, 'フォーム数');
  assert.strictEqual(ctx.__triggers.length, trigs, 'トリガー数');
});

// フォームは未公開だと URL が発行されても回答を受け付けない。
// スタブの FormApp.create() は「未公開で作る」側に寄せてあるので、
// コードが明示的に公開していなければここで落ちる。
s.test('作られたフォームはすべて公開状態になっている', () => {
  const ctx = boot();
  ctx.setupFormIntegration();
  const notPublished = Object.keys(ctx.__forms)
    .map(id => ctx.__forms[id])
    .filter(f => !f.isPublished())
    .map(f => f.getTitle());
  eqJ(notPublished, [], '未公開のフォーム: ' + notPublished.join(', '));
});

s.test('未公開のフォームがあればログで警告する', () => {
  const ctx = boot();
  ctx.setupFormIntegration();
  // 公開状態を人が後から外した状況を作り、再実行時に警告が出ることを確認
  Object.keys(ctx.__forms).forEach(id => ctx.__forms[id].setPublished(false));
  const log = String(ctx.setupFormIntegration());
  assert.ok(log.includes('★未公開です'), '警告が出る: ' + log);
});

s.test('syncFormChoices は商品スロットと入力者だけを埋める', () => {
  const ctx = boot();
  ctx.setupFormIntegration();
  const r = ctx.syncFormChoices();
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.products, 3);
  assert.strictEqual(r.staff, 1, '無効な入力者は数えない');

  const inForm = ctx.__forms[ctx.getConfigValue_('inFormId', '')];
  const items = inForm.dumpItems();
  eqJ(items.find(i => i.title === '商品1').choices,
    ['健康守り（HEALTH）', '縁結び守り（LOVE）', '金運守り（MONEY）'], '商品の選択肢（コード順）');
  eqJ(items.find(i => i.title === '入力者').choices, ['山田']);

  // 「商品名」「商品コード」を商品スロットと誤認してはいけない
  const prodForm = ctx.__forms[ctx.getConfigValue_('productFormId', '')];
  const pItems = prodForm.dumpItems();
  assert.strictEqual(pItems.find(i => i.title === '商品名').choices, null, '商品名に選択肢を入れない');
  assert.strictEqual(pItems.find(i => i.title === '商品コード').choices, null, '商品コードに選択肢を入れない');
  eqJ(pItems.find(i => i.title === '入力者').choices, ['山田']);
});

// --- initializeSpreadsheet の上書き事故防止 --------------------------------
//
// スタンドアロンのスクリプトでは SpreadsheetApp.getUi() が必ず例外になる。
// 修正前は openById と getUi を同じ try に入れていたため、IDが有効でも
// 確認ダイアログが出ないまま新規作成に落ち、既存データへのリンクが黙って失われた。

function uiStub(answer) {
  const Button = { YES: 'YES', NO: 'NO' };
  return {
    alert: () => answer,
    Button: Button,
    ButtonSet: { YES_NO: 'YES_NO' },
  };
}

s.test('有効なIDがあり UI が無いときは、作成せず理由を示して失敗する', () => {
  const ctx = boot({ skipInit: true });
  const before = Object.keys(ctx.__spreadsheets).length;
  assert.throws(() => ctx.initializeSpreadsheet(), /既にスプレッドシートが設定されています/);
  assert.strictEqual(Object.keys(ctx.__spreadsheets).length, before, 'スプレッドシートを作ってはいけない');
  assert.strictEqual(ctx.__props.OMAMORI_SPREADSHEET_ID, 'SSID', 'プロパティを書き換えてはいけない');
  // 復旧方法を案内していること
  try {
    ctx.initializeSpreadsheet();
  } catch (e) {
    assert.ok(String(e.message).includes('スクリプト プロパティ'), '案内文: ' + e.message);
    assert.ok(String(e.message).includes('OMAMORI_SPREADSHEET_ID'), '案内文にキー名: ' + e.message);
  }
});

s.test('UI があって「いいえ」なら何も作らない', () => {
  const ctx = boot({ skipInit: true });
  ctx.__setUi(uiStub('NO'));
  const before = Object.keys(ctx.__spreadsheets).length;
  ctx.initializeSpreadsheet();
  assert.strictEqual(Object.keys(ctx.__spreadsheets).length, before);
  assert.strictEqual(ctx.__props.OMAMORI_SPREADSHEET_ID, 'SSID');
});

s.test('UI があって「はい」なら新規作成する', () => {
  const ctx = boot({ skipInit: true });
  ctx.__setUi(uiStub('YES'));
  ctx.initializeSpreadsheet();
  assert.notStrictEqual(ctx.__props.OMAMORI_SPREADSHEET_ID, 'SSID', '新しいIDになる');
  const fresh = ctx.__spreadsheets[ctx.__props.OMAMORI_SPREADSHEET_ID];
  assert.ok(fresh.getSheetByName('商品管理'), '商品管理シートが作られる');
  assert.ok(fresh.getSheetByName('履歴'), '履歴シートが作られる');
});

s.test('IDが無効なら（UI が無くても）新規作成する', () => {
  const ctx = boot({ skipInit: true });
  ctx.__props.OMAMORI_SPREADSHEET_ID = 'NOT_A_REAL_ID';
  ctx.initializeSpreadsheet();
  const id = ctx.__props.OMAMORI_SPREADSHEET_ID;
  assert.notStrictEqual(id, 'NOT_A_REAL_ID', '新しいIDに差し替わる');
  assert.ok(ctx.__spreadsheets[id].getSheetByName('商品管理'));
  assert.ok(ctx.__logs.some(l => l.includes('開けませんでした')), 'ログに理由が残る');
});

s.test('プロパティが未設定なら素直に新規作成する', () => {
  const ctx = boot({ skipInit: true });
  delete ctx.__props.OMAMORI_SPREADSHEET_ID;
  ctx.initializeSpreadsheet();
  assert.ok(ctx.__props.OMAMORI_SPREADSHEET_ID, 'IDが設定される');
  assert.ok(ctx.__spreadsheets[ctx.__props.OMAMORI_SPREADSHEET_ID].getSheetByName('商品管理'));
});

s.test('getSpreadsheetUrl でどのブックを掴んでいるか確認できる（移行時の検証手段）', () => {
  const ctx = boot();
  assert.strictEqual(ctx.getSpreadsheetUrl(), 'https://docs.google.com/spreadsheets/d/SSID');
});

module.exports = s.done();
