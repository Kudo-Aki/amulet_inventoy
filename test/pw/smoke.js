// 管理画面をブラウザで動かすスモークテスト（GAS はモックする）。
//   node test/pw/smoke.js
// Playwright と Chromium が必要。無ければスキップして終了する。
'use strict';
const assert = require('assert');
const path = require('path');
const { start } = require('./serve');

let chromium;
try {
  chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium;
} catch (e) {
  try { chromium = require('playwright').chromium; } catch (e2) {
    console.log('Playwright が見つからないためスキップします（npm i -D playwright で導入できます）');
    process.exit(0);
  }
}

const GAS_URL = 'https://script.google.com/macros/s/TEST123/exec';

const FORMS = [
  { kind: 'in', label: '入荷', url: 'https://docs.google.com/forms/d/e/IN/viewform', editUrl: 'https://docs.google.com/forms/d/IN/edit', responseSheet: 'フォーム回答_入荷' },
  { kind: 'out', label: '出荷', url: 'https://docs.google.com/forms/d/e/OUT/viewform', editUrl: 'https://docs.google.com/forms/d/OUT/edit', responseSheet: 'フォーム回答_出荷' },
  { kind: 'inv', label: '棚卸', url: 'https://docs.google.com/forms/d/e/INV/viewform', editUrl: 'https://docs.google.com/forms/d/INV/edit', responseSheet: 'フォーム回答_棚卸' },
  { kind: 'product', label: '商品登録', url: 'https://docs.google.com/forms/d/e/PRD/viewform', editUrl: 'https://docs.google.com/forms/d/PRD/edit', responseSheet: 'フォーム回答_商品登録' },
];

const BACKUPS = [
  { backupId: 'BK_20260909_030500', at: '2026/9/9 3:05:00', reason: '棚卸(フォーム)', actor: '山田', count: 3, note: '' },
  { backupId: 'BK_20260908_030000', at: '2026/9/8 3:00:00', reason: '毎日', actor: 'システム', count: 3, note: '自動バックアップ' },
];

const PREVIEW = {
  stock: {
    backupId: 'BK_20260909_030500', scope: 'stock', scopeLabel: '在庫のみ（現在庫・安心在庫）',
    changes: [{ code: 'HEALTH', name: '健康守り', fields: [{ label: '現在庫', from: '95', to: '100' }] }],
    changeCount: 1, truncated: false,
    added: [{ code: 'NEW', name: '新商品' }], missing: [{ code: 'LOVE', name: '縁結び守り' }],
  },
  all: {
    backupId: 'BK_20260909_030500', scope: 'all', scopeLabel: 'すべて（商品名〜発注数/納期）',
    changes: [{ code: 'HEALTH', name: '健康守り', fields: [{ label: '商品名', from: '健康守り(改)', to: '健康守り' }, { label: '現在庫', from: '95', to: '100' }] }],
    changeCount: 1, truncated: false, added: [], missing: [],
  },
};

function makeState(over) {
  return Object.assign({
    master: {
      HEALTH: { name: '健康守り', quantity: 50, unitPrice: 300, supplier: '', contact: '', email: '' },
      MONEY: { name: '金運守り', quantity: 100, unitPrice: 500, supplier: '', contact: '', email: '' },
      LOVE: { name: '縁結び守り', quantity: 80, unitPrice: 400, supplier: '', contact: '', email: '' },
    },
    stock: {
      HEALTH: { stock: 100, safeStock: 30 },
      MONEY: { stock: 20, safeStock: 50 },
      LOVE: { stock: 5, safeStock: 10 },
    },
    orders: {}, history: [],
    backupStatus: {
      ready: true, count: 2, latest: BACKUPS[0], maxBackups: 30,
      beforeFormInventory: true, beforeAppInventory: true, beforeStockSave: false, daily: false, dailyHour: 3,
      scopes: [{ key: 'stock', label: '在庫のみ（現在庫・安心在庫）' }, { key: 'all', label: 'すべて（商品名〜発注数/納期）' }],
    },
    backupSeq: 0, failBackup: false,
    // true にすると GAS がログイン画面の HTML を返す状況を再現する
    returnHtml: false,
  }, over || {});
}

function gasResponse(state, action, data) {
  switch (action) {
    case 'ping': return { success: true, message: 'pong' };
    case 'test': return { success: true, spreadsheetName: 'テスト用シート' };
    case 'getMaster': return { success: true, data: state.master };
    case 'getStock': return { success: true, data: state.stock };
    case 'getOrders': return { success: true, data: state.orders };
    case 'getHistory': return { success: true, data: state.history };
    case 'getAll': return { success: true, data: { master: state.master, stock: state.stock, orders: state.orders, history: state.history } };
    case 'saveStock':
      // GAS の saveStockToProducts と同じく、送られてきた商品だけ更新する
      Object.keys(data.stock || {}).forEach(code => { state.stock[code] = data.stock[code]; });
      return { success: true };
    case 'addHistory': state.history.unshift(data.record || data); return { success: true };
    case 'addHistoryBatch':
      (data.records || []).slice().reverse().forEach(r => state.history.unshift(r));
      return { success: true, added: (data.records || []).length };
    case 'getBackupStatus': return { success: true, data: state.backupStatus };
    case 'listBackups': return { success: true, data: BACKUPS };
    case 'createBackup':
      if (state.failBackup) return { success: false, error: 'テスト用の失敗' };
      state.backupSeq++;
      return { success: true, backupId: 'BK_TEST_' + state.backupSeq, count: 3 };
    case 'previewRestore': return { success: true, data: PREVIEW[data.scope || 'stock'] };
    case 'restoreBackup': return {
      success: true, backupId: data.backupId, scope: data.scope,
      scopeLabel: PREVIEW[data.scope || 'stock'].scopeLabel, restoredCount: 1,
      restored: [{ code: 'HEALTH', name: '健康守り' }], added: [], missing: [],
      undoBackupId: 'BK_20260909_041000',
    };
    case 'getFormConfig': return { success: true, data: {
      inFormUrl: FORMS[0].url, inFormEditUrl: FORMS[0].editUrl,
      outFormUrl: FORMS[1].url, outFormEditUrl: FORMS[1].editUrl,
      forms: FORMS, spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/SS', folderUrl: '',
      adminEmail: 'admin@example.com', staffCount: 2, productCount: 3, templateReady: true,
      triggers: { onFormSubmit: true, syncFormChoices: true, processPendingResponses: true, dailyBackupJob: true },
      backup: state.backupStatus, setupDone: true } };
    case 'syncFormChoices': return { success: true, products: 3, staff: 2, updatedItems: 26 };
    case 'processPendingResponses': return { success: true, processed: { in: 1, out: 0, inv: 2, product: 1, errors: 0 } };
    case 'saveMaster': case 'saveOrders': case 'updateStock': case 'updateOrder': case 'saveProduct':
      return { success: true };
    default: return { success: false, error: 'Unknown action: ' + action };
  }
}

async function newPage(browser, base, state, opts) {
  opts = opts || {};
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.addInitScript(({ apiEnabled, GAS_URL }) => {
    if (apiEnabled) localStorage.setItem('omamori_api_config', JSON.stringify({ url: GAS_URL, enabled: true }));
    else localStorage.removeItem('omamori_api_config');
    localStorage.removeItem('omamori_stock');
    sessionStorage.setItem('omamori_admin_auth', 'true');
  }, { apiEnabled: opts.apiEnabled !== false, GAS_URL });

  // 外部ホストへは一切出さない。先に登録した総括ルートを、
  // あとに登録する個別ルートが上書きする（Playwright は後に登録したものが優先）。
  // こうしておけば、将来 CDN を1つ足されてもテストが外部通信で落ちない。
  await page.route(u => u.hostname !== '127.0.0.1' && u.hostname !== 'localhost',
    r => r.fulfill({ status: 204, body: '' }));

  // CDN はこの環境では引けないのでスタブする
  await page.route(/cdn\.jsdelivr\.net.*chart/, r => r.fulfill({
    contentType: 'application/javascript',
    body: 'window.Chart=function(){this.destroy=function(){};this.update=function(){};};window.Chart.register=function(){};',
  }));
  await page.route(/cdn\.jsdelivr\.net.*qrcode/, r => r.fulfill({
    contentType: 'application/javascript',
    body: 'window.QRCode=function(el,o){var c=document.createElement("canvas");c.setAttribute("data-text",o.text);el.appendChild(c);};window.QRCode.CorrectLevel={L:1,M:0,Q:3,H:2};',
  }));
  await page.route(/unpkg\.com.*html5-qrcode/, r => r.fulfill({
    contentType: 'application/javascript',
    body: 'window.Html5Qrcode=class{constructor(){this.isScanning=false}start(){return Promise.resolve()}stop(){return Promise.resolve()}};window.Html5QrcodeScanner=window.Html5Qrcode;',
  }));

  await page.route('https://script.google.com/**', route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    let data = {};
    try { data = JSON.parse(url.searchParams.get('data') || '{}'); } catch (e) { data = {}; }
    requests.push({ action, data });
    if (state.returnHtml) {
      // 「アクセスできるユーザー」が「全員」でないとき Google が返す画面を模擬
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!DOCTYPE html><html><head><title>ログイン - Google アカウント</title></head><body>Sign in</body></html>' });
      return;
    }
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(gasResponse(state, action, data)) });
  });

  return { page, context, errors, requests };
}

const results = [];
async function test(label, fn) {
  try { await fn(); results.push({ label, ok: true }); console.log('  ✓ ' + label); }
  catch (e) { results.push({ label, ok: false }); console.log('  ✗ ' + label); console.log('      ' + String(e.message || e).split('\n').slice(0, 6).join('\n      ')); }
}

(async () => {
  const server = await start(0);
  const browser = await chromium.launch();
  const B = server.base;
  try {
    await test('api-settings: API未設定なら案内を出して何も壊れない', async () => {
      const { page, context, errors } = await newPage(browser, B, makeState(), { apiEnabled: false });
      await page.goto(B + '/admin/api-settings.html');
      await page.waitForTimeout(500);
      assert.ok(await page.locator('#fi-not-configured').isVisible(), 'フォーム連携の案内');
      assert.ok(await page.locator('#bk-not-configured').isVisible(), 'バックアップの案内');
      assert.strictEqual(await page.locator('#fi-content').isVisible(), false);
      assert.strictEqual(await page.locator('#bk-content').isVisible(), false);
      assert.deepStrictEqual(errors, [], errors.join(' | '));
      await context.close();
    });

    await test('api-settings: フォームカードが4枚出て、棚卸のQRも出せる', async () => {
      const { page, context, errors } = await newPage(browser, B, makeState());
      await page.goto(B + '/admin/api-settings.html#form-integration');
      await page.waitForSelector('#fi-content:not(.hidden)', { timeout: 10000 });
      const titles = await page.locator('#fi-form-cards .fi-form-card h3').allTextContents();
      assert.deepStrictEqual(titles.map(t => t.replace(/^\S+\s*/, '')),
        ['入荷フォーム', '出荷フォーム', '棚卸フォーム', '商品登録フォーム'], titles.join(' / '));
      for (const f of FORMS) {
        assert.strictEqual(await page.locator(`#fi-${f.kind}-url`).getAttribute('href'), f.url, f.kind);
        assert.strictEqual(await page.locator(`#fi-${f.kind}-edit`).getAttribute('href'), f.editUrl, f.kind);
      }
      await page.click('#fi-form-cards .fi-form-card >> nth=2 >> button:has-text("QRコード")');
      await page.waitForSelector('#fi-inv-qr canvas');
      assert.strictEqual(await page.locator('#fi-inv-qr canvas').getAttribute('data-text'), FORMS[2].url);
      const status = await page.locator('#fi-status').textContent();
      assert.ok(status.includes('バックアップ') && status.includes('2 世代'), status);
      assert.deepStrictEqual(errors, [], errors.join(' | '));
      await context.close();
    });

    await test('api-settings: 再処理の結果を返ってきた種別ぶん表示する', async () => {
      const { page, context } = await newPage(browser, B, makeState());
      await page.goto(B + '/admin/api-settings.html#form-integration');
      await page.waitForSelector('#fi-content:not(.hidden)', { timeout: 10000 });
      page.once('dialog', d => d.accept());
      await page.click('#form-integration button:has-text("未処理の回答を再処理")');
      await page.waitForFunction(() => document.getElementById('fi-action-result').textContent.includes('棚卸'));
      const res = await page.locator('#fi-action-result').textContent();
      assert.ok(res.includes('入荷 1 件') && res.includes('棚卸 2 件') && res.includes('商品登録 1 件'), res);
      await context.close();
    });

    await test('バックアップ: 一覧 → 変更点を確認 → 復元', async () => {
      const { page, context, errors, requests } = await newPage(browser, B, makeState());
      await page.goto(B + '/admin/api-settings.html#backup-restore');
      await page.waitForSelector('#bk-content:not(.hidden)', { timeout: 10000 });
      const status = await page.locator('#bk-status').textContent();
      assert.ok(status.includes('2 / 30') && status.includes('棚卸(フォーム)'), status);
      assert.strictEqual(await page.locator('#bk-restore-btn').isDisabled(), true, '確認前は復元できない');

      await page.click('#backup-restore button:has-text("変更点を確認")');
      await page.waitForSelector('#bk-preview:not(.hidden)');
      const prev = await page.locator('#bk-preview').textContent();
      assert.ok(prev.includes('健康守り') && prev.includes('現在庫') && prev.includes('95') && prev.includes('100'), prev);
      assert.ok(prev.includes('新商品'), '据え置きの案内: ' + prev);
      assert.ok(prev.includes('縁結び守り'), '復活しない商品の案内: ' + prev);
      assert.strictEqual(await page.locator('#bk-restore-btn').isDisabled(), false);

      page.once('dialog', d => { assert.ok(d.message().includes('値が変わる商品: 1 件'), d.message()); d.accept(); });
      await page.click('#bk-restore-btn');
      await page.waitForSelector('#bk-result:not(.hidden)');
      const result = await page.locator('#bk-result').textContent();
      assert.ok(result.includes('BK_20260909_030500') && result.includes('BK_20260909_041000') && result.includes('取り消す'), result);
      const rr = requests.find(r => r.action === 'restoreBackup');
      assert.deepStrictEqual([rr.data.backupId, rr.data.scope], ['BK_20260909_030500', 'stock']);
      assert.strictEqual(await page.locator('#bk-restore-btn').isDisabled(), true, '復元後はまた確認が必要');
      assert.deepStrictEqual(errors, [], errors.join(' | '));
      await context.close();
    });

    await test('バックアップ: 範囲を変えたら確認をやり直させる', async () => {
      const { page, context } = await newPage(browser, B, makeState());
      await page.goto(B + '/admin/api-settings.html#backup-restore');
      await page.waitForSelector('#bk-content:not(.hidden)', { timeout: 10000 });
      await page.click('#backup-restore button:has-text("変更点を確認")');
      await page.waitForSelector('#bk-preview:not(.hidden)');
      await page.selectOption('#bk-scope', 'all');
      assert.strictEqual(await page.locator('#bk-restore-btn').isDisabled(), true);
      assert.strictEqual(await page.locator('#bk-preview').isVisible(), false);
      await page.click('#backup-restore button:has-text("変更点を確認")');
      await page.waitForSelector('#bk-preview:not(.hidden)');
      assert.ok((await page.locator('#bk-preview').textContent()).includes('健康守り(改)'));
      await context.close();
    });

    // ---- 在庫管理: 上書き事故の防止 -------------------------------------
    async function openStockManager(state) {
      const h = await newPage(browser, B, state);
      await h.page.goto(B + '/admin/stock-manager.html');
      await h.page.waitForSelector('#stock-HEALTH', { timeout: 10000 });
      return h;
    }

    await test('在庫保存: 変更した商品だけ送るのでフォームの入荷を巻き戻さない', async () => {
      const state = makeState();
      const { page, context, errors, requests } = await openStockManager(state);
      // 画面を開いたあと、フォーム経由で HEALTH が 100 → 250 になる
      state.stock.HEALTH = { stock: 250, safeStock: 30 };
      await page.fill('#stock-MONEY', '77');
      await page.evaluate(() => saveStock());
      await page.waitForFunction(() => document.getElementById('toast').textContent.includes('保存しました'));

      assert.strictEqual(state.stock.HEALTH.stock, 250, 'フォーム経由の入荷が生き残る');
      assert.strictEqual(state.stock.MONEY.stock, 77);
      assert.strictEqual(state.stock.LOVE.stock, 5);
      const sent = requests.filter(r => r.action === 'saveStock');
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(Object.keys(sent[0].data.stock), ['MONEY'], JSON.stringify(sent[0].data.stock));
      assert.strictEqual(await page.inputValue('#stock-HEALTH'), '250', 'サーバーの値が画面に反映される');
      assert.deepStrictEqual(errors, [], errors.join(' | '));
      await context.close();
    });

    await test('在庫保存: 同じ商品が両方で変わっていたら商品名つきで警告する', async () => {
      const state = makeState();
      const { page, context } = await openStockManager(state);
      state.stock.HEALTH = { stock: 250, safeStock: 30 };
      await page.fill('#stock-HEALTH', '120');
      let msg = '';
      page.once('dialog', d => { msg = d.message(); d.dismiss(); });
      await page.evaluate(() => saveStock());
      await page.waitForFunction(() => document.getElementById('toast').textContent.includes('中止'));
      assert.ok(msg.includes('健康守り') && msg.includes('画面 100') && msg.includes('サーバー 250') && msg.includes('120'), msg);
      assert.strictEqual(state.stock.HEALTH.stock, 250, '中止したら書き込まない');
      await context.close();
    });

    await test('在庫保存: 空欄を 0 として書き込まない', async () => {
      const state = makeState();
      const { page, context, requests } = await openStockManager(state);
      await page.fill('#stock-HEALTH', '');
      await page.evaluate(() => saveStock());
      await page.waitForFunction(() => document.getElementById('toast').textContent.includes('空欄'));
      assert.ok((await page.locator('#toast').textContent()).includes('健康守り（現在庫）'));
      assert.strictEqual(state.stock.HEALTH.stock, 100);
      assert.strictEqual(requests.filter(r => r.action === 'saveStock').length, 0);
      await context.close();
    });

    await test('在庫保存: 変更がなければ何も送らない', async () => {
      const { page, context, requests } = await openStockManager(makeState());
      await page.evaluate(() => saveStock());
      await page.waitForFunction(() => document.getElementById('toast').textContent.includes('変更はありません'));
      assert.strictEqual(requests.filter(r => r.action === 'saveStock').length, 0);
      await context.close();
    });

    await test('棚卸: 反映前にバックアップし、変更分だけ送り、履歴もシートへ送る', async () => {
      const state = makeState();
      const { page, context, errors, requests } = await openStockManager(state);
      await page.click('.tab:has-text("棚卸し")');
      await page.waitForSelector('.inventory-input');
      await page.fill('.inventory-input[data-code="HEALTH"]', '95');
      await page.fill('.inventory-input[data-code="LOVE"]', '0');
      page.once('dialog', d => { assert.ok(d.message().includes('健康守り: 100 → 95'), d.message()); d.accept(); });
      await page.evaluate(() => applyInventory());
      await page.waitForFunction(() => document.getElementById('toast').textContent.includes('反映しました'));

      assert.ok((await page.locator('#toast').textContent()).includes('BK_TEST_1'), 'バックアップIDを表示');
      assert.strictEqual(state.stock.HEALTH.stock, 95);
      assert.strictEqual(state.stock.LOVE.stock, 0, '0 は在庫ゼロとして反映');
      assert.strictEqual(state.stock.MONEY.stock, 20, '差異のない商品は触らない');
      const sent = requests.filter(r => r.action === 'saveStock');
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(Object.keys(sent[0].data.stock).sort(), ['HEALTH', 'LOVE']);
      const order = requests.map(r => r.action);
      assert.ok(order.indexOf('createBackup') < order.indexOf('saveStock'), 'バックアップが先: ' + order.join(','));
      assert.strictEqual(state.history.length, 2, JSON.stringify(state.history));
      const h = state.history.find(x => x.productCode === 'HEALTH');
      assert.deepStrictEqual([h.type, h.quantity], ['out', 5]);
      assert.ok(h.note.includes('棚卸し調整: 100→95 (-5)'), h.note);
      assert.deepStrictEqual(errors, [], errors.join(' | '));
      await context.close();
    });

    await test('棚卸: 未入力があれば反映しない', async () => {
      const state = makeState();
      const { page, context, requests } = await openStockManager(state);
      await page.click('.tab:has-text("棚卸し")');
      await page.waitForSelector('.inventory-input');
      await page.fill('.inventory-input[data-code="MONEY"]', '');
      await page.waitForFunction(() => document.getElementById('inventory-diff-summary').textContent.includes('未入力'));
      await page.evaluate(() => applyInventory());
      await page.waitForFunction(() => document.getElementById('toast').textContent.includes('未入力の商品があります'));
      assert.ok((await page.locator('#toast').textContent()).includes('金運守り'));
      assert.strictEqual(requests.filter(r => r.action === 'saveStock').length, 0);
      await context.close();
    });

    await test('棚卸: バックアップに失敗したら確認し、断れば反映しない', async () => {
      const state = makeState({ failBackup: true });
      const { page, context, requests } = await openStockManager(state);
      await page.click('.tab:has-text("棚卸し")');
      await page.waitForSelector('.inventory-input');
      await page.fill('.inventory-input[data-code="HEALTH"]', '95');
      const messages = [];
      let n = 0;
      page.on('dialog', d => { messages.push(d.message()); n++; if (n === 1) d.accept(); else d.dismiss(); });
      await page.evaluate(() => applyInventory());
      await page.waitForFunction(() => document.getElementById('toast').textContent.includes('中止'));
      assert.ok(messages.some(m => m.includes('バックアップに失敗') && m.includes('元の在庫へ戻せなくなります')), messages.join(' || '));
      assert.strictEqual(requests.filter(r => r.action === 'saveStock').length, 0, 'バックアップなしでは反映しない');
      assert.strictEqual(state.stock.HEALTH.stock, 100);
      await context.close();
    });

    // ---- 非JSON応答（デプロイのアクセス範囲が「全員」でない状況） ----------
    //
    // 修正前の apiPost は JSON パース失敗時に { success: true } を返していたため、
    // 画面には「保存しました」と出るのにスプレッドシートには何も入らなかった。
    // アカウント移行やデプロイ作り直しの直後に最も起こりやすい事故。
    await test('GASがログイン画面のHTMLを返したら、保存成功と表示しない', async () => {
      const state = makeState({ returnHtml: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(({ GAS_URL }) => {
        localStorage.setItem('omamori_api_config', JSON.stringify({ url: GAS_URL, enabled: true }));
      }, { GAS_URL });
      await page.route('https://script.google.com/**', route => route.fulfill({
        status: 200, contentType: 'text/html',
        body: '<!DOCTYPE html><html><head><title>ログイン - Google アカウント</title></head><body>Sign in</body></html>',
      }));
      await page.goto(B + '/index.html');
      await page.waitForTimeout(300);

      const r = await page.evaluate(async () => {
        try {
          const res = await apiPost('saveStock', { stock: { HEALTH: { stock: 1, safeStock: 1 } } });
          return { threw: false, res };
        } catch (e) {
          return { threw: true, message: e.message };
        }
      });
      assert.strictEqual(r.threw, true, '非JSONなら例外になるべき（返り値: ' + JSON.stringify(r.res) + '）');
      assert.ok(r.message.includes('解釈できませんでした'), r.message);
      assert.ok(r.message.includes('全員'), '原因のヒントを含む: ' + r.message);
      await context.close();
    });

    await test('アプリ本体が API 有効・無効の両方で起動する', async () => {
      for (const apiEnabled of [true, false]) {
        const { page, context, errors } = await newPage(browser, B, makeState(), { apiEnabled });
        await page.goto(B + '/index.html');
        await page.waitForTimeout(900);
        assert.deepStrictEqual(errors, [], 'apiEnabled=' + apiEnabled + ': ' + errors.join(' | '));
        await context.close();
      }
    });

    await test('管理メニューに Googleフォーム連携のカードがある', async () => {
      const { page, context } = await newPage(browser, B, makeState(), { apiEnabled: false });
      await page.goto(B + '/admin/index.html');
      await page.waitForTimeout(300);
      const cards = await page.locator('a.menu-card').allTextContents();
      assert.ok(cards.some(t => t.includes('Googleフォーム連携')), cards.join(' / '));
      await context.close();
    });

    await test('既存の test/test.html が全件通る', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(B + '/test/test.html');
      await page.waitForTimeout(800);
      const lines = await page.locator('.test-result').allTextContents();
      const fail = lines.filter(l => l.startsWith('✗'));
      assert.strictEqual(fail.length, 0, fail.join(' | '));
      assert.ok(lines.length >= 13, '件数: ' + lines.length);
      await context.close();
    });
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\npw/smoke: ${results.length - failed.length}/${results.length} 合格`);
  if (failed.length) process.exit(1);
})().catch(e => { console.error('SMOKE FAILED:', e); process.exit(1); });
