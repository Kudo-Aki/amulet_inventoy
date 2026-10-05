// 各テストが共通で使う土台。gas/*.gs を vm コンテキストに読み込んで、
// 商品管理・履歴・設定・入力者・回答シートを用意する。
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const { makeContext } = require('./gas-stub');

const GAS_DIR = path.join(__dirname, '..', '..', 'gas');
// Code.gs を先に読む（SHEET_NAMES などの const を FormIntegration.gs が参照する）
const FILES = ['Code.gs', 'QRCode.gs', 'LabelTemplate.gs', 'LabelPdf.gs', 'FormIntegration.gs', 'Tests.gs'];

// JSON.stringify で比べる。vm コンテキストで作られたオブジェクトは realm が違うため
// assert.deepStrictEqual が「構造は同じだが参照が同一でない」で落ちる。
const eqJ = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);

const DEFAULT_PRODUCTS = [
  //コード      商品名            入数 単価  発注先      担当者 メール            在庫 安心 発注状況   発注数/納期                                        更新日時
  ['HEALTH', '健康守り', 50, 300, '株式会社A', '佐藤', 'a@example.com', 100, 30, '発注済み', '合計2600個: 1000個(1/31), 1000個(2/15), 600個(3/1)', '2026/9/1 10:00:00'],
  ['MONEY', '金運守り', 100, 500, '', '', '', 20, 50, '未発注', '', '2026/9/1 10:00:00'],
  ['LOVE', '縁結び守り', 80, 400, '', '', '', 5, 10, '未発注', '', '2026/9/1 10:00:00'],
];

/**
 * @param {Object} opts
 *   products: 商品管理に入れる行（省略時 DEFAULT_PRODUCTS）
 *   staff: 入力者シートの行（省略時 山田のみ）
 *   sheets: 用意する回答シートの種別（['in','out','inv','product'] のうち）
 *   now: 固定する時刻
 *   skipInit: 商品管理・履歴シートを作らない（initializeSpreadsheet のテスト用）
 */
function boot(opts) {
  opts = opts || {};
  const ctx = makeContext();
  vm.createContext(ctx);
  for (const f of FILES) {
    vm.runInContext(fs.readFileSync(path.join(GAS_DIR, f), 'utf8'), ctx, { filename: f });
  }
  const ss = ctx.__ss;

  if (!opts.skipInit) {
    ctx.createProductsSheet(ss);
    ctx.createHistorySheet(ss);
    const rows = opts.products === undefined ? DEFAULT_PRODUCTS : opts.products;
    if (rows.length) ss.getSheetByName('商品管理').getRange(2, 1, rows.length, 12).setValues(rows);

    ctx.ensureConfigSheet_();
    ctx.ensureSheetWithHeaders_(ss, '入力者', ['名前', 'メール', '有効', '備考'], '#8B0000');
    const staff = opts.staff === undefined
      ? [['山田', 'yamada@example.com', true, ''], ['退職者', 'old@example.com', false, '']]
      : opts.staff;
    if (staff.length) ss.getSheetByName('入力者').getRange(2, 1, staff.length, 4).setValues(staff);
    ctx.ensureSheetWithHeaders_(ss, '箱台帳', ctx.FI_LEDGER_HEADERS_, '#4a4a4a');
  }

  (opts.sheets || []).forEach(kind => makeResponseSheet(ctx, kind));

  // ラベル組版は SlidesApp を必要とするのでテストでは差し替える
  ctx.__pdfCalls = [];
  ctx.buildLabelPdf_ = (labels, o) => {
    ctx.__pdfCalls.push({ labels, opts: o });
    return {
      pdfFile: { getUrl: () => 'https://pdf/' + (o && o.fileName) },
      pdfBlob: { name: 'x.pdf' },
      pages: Math.ceil(labels.length / 8),
      count: labels.length,
    };
  };
  ctx.ensureLabelTemplate_ = () => 'TPL';

  ctx.__setNow(opts.now || new Date(2026, 8, 9, 3, 0, 0));
  return ctx;
}

/** フォームが作る回答シートのヘッダーを模擬して作る */
function makeResponseSheet(ctx, kind) {
  const spec = ctx.getFormSpec_(kind);
  if (!spec) throw new Error('未知の種別: ' + kind);
  const headers = ['タイムスタンプ'].concat(
    ctx.formQuestionPlan_(spec).map(e => e.title)
  );
  const sheet = ctx.__ss.insertSheet(spec.sheetDefault);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  ctx.ensureResponseSheetColumns_(sheet);
  return sheet;
}

function sheetOf(ctx, kind) {
  return ctx.__ss.getSheetByName(ctx.getFormSpec_(kind).sheetDefault);
}

/** 回答シートに1行追加して行番号を返す */
function addRow(sheet, obj) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, headers.length).setValues([headers.map(h => (obj[h] === undefined ? '' : obj[h]))]);
  return row;
}

const productRow = (ctx, code) => ctx.__ss.getSheetByName('商品管理').dump().find(r => r[0] === code);
const productRowCount = (ctx) => ctx.__ss.getSheetByName('商品管理').dump().length;
const histRows = (ctx) => ctx.__ss.getSheetByName('履歴').dump().slice(1);
const rowsOf = (ctx, name) => { const s = ctx.__ss.getSheetByName(name); return s ? s.dump().slice(1).filter(r => r[0]) : []; };
const ledgerRows = (ctx) => rowsOf(ctx, 'バックアップ台帳');
const boxLedger = (ctx) => rowsOf(ctx, '箱台帳');

/** doGet 経由で叩く */
function call(ctx, action, data) {
  const parameter = Object.assign({ action }, data === undefined ? {} : { data: JSON.stringify(data) });
  return JSON.parse(ctx.doGet({ parameter }).getContent());
}

// ---- 簡易テストランナー -----------------------------------------------
function suite(name) {
  const results = [];
  return {
    test(label, fn) {
      try {
        fn();
        results.push({ label, ok: true });
        console.log('  ✓ ' + label);
      } catch (e) {
        results.push({ label, ok: false, err: e });
        console.log('  ✗ ' + label);
        console.log('      ' + String(e.message || e).split('\n').join('\n      '));
      }
    },
    done() {
      const failed = results.filter(r => !r.ok);
      console.log(`${name}: ${results.length - failed.length}/${results.length} 合格`);
      if (failed.length) {
        process.exitCode = 1;
        return false;
      }
      return true;
    },
  };
}

module.exports = {
  boot, makeResponseSheet, sheetOf, addRow, call, suite, eqJ,
  productRow, productRowCount, histRows, rowsOf, ledgerRows, boxLedger,
  DEFAULT_PRODUCTS,
};
