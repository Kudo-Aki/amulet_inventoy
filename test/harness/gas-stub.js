// Google Apps Script の各サービスを Node 上で模擬するスタブ。
// gas/*.gs を実際に読み込んで動かすために使う（モックした関数のテストではない）。
//
// 本物と食い違う挙動があるとテストが通って本番で落ちるため、
// 意図的に「本物と同じ厳しさ」にしてある箇所にはコメントで理由を書いている。
'use strict';

const RealDate = Date;

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------
class Range {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet; this.row = row; this.col = col; this.numRows = numRows; this.numCols = numCols;
  }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet._get(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.numRows || values.some(v => v.length !== this.numCols)) {
      throw new Error(`setValues size mismatch: expected ${this.numRows}x${this.numCols}, got ${values.length}x${values[0] && values[0].length}`);
    }
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.sheet._set(this.row + r, this.col + c, values[r][c]);
    return this;
  }
  getValue() { return this.sheet._get(this.row, this.col); }
  setValue(v) { this.sheet._set(this.row, this.col, v); return this; }
  clearContent() { for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.sheet._set(this.row + r, this.col + c, ''); return this; }
  // 書式設定は値に影響しないので no-op
  setBackground() { return this; } setFontColor() { return this; } setFontWeight() { return this; }
  setDataValidation() { return this; } setNumberFormat() { return this; } setNumberFormats() { return this; }
  setFontSize() { return this; } setFontFamily() { return this; } setFontStyle() { return this; }
  setHorizontalAlignment() { return this; } setVerticalAlignment() { return this; }
  setWrap() { return this; } setBorder() { return this; } setNote() { return this; }
}

// getRange('A1:B2') は書式設定にしか使われていない（gas/Code.gs の発注状況の入力規則のみ）。
// 値の読み書きを許すと、A1記法で別のセルを触るコードがテストでは通って本番で壊れるため例外にする。
class PoisonRange {
  constructor(a1) { this.a1 = a1; }
  _boom(op) {
    throw new Error(`getRange('${this.a1}').${op}() はハーネスでは未対応です。` +
      'A1記法ではなく getRange(row, col, numRows, numCols) を使ってください。');
  }
  getValues() { this._boom('getValues'); } setValues() { this._boom('setValues'); }
  getValue() { this._boom('getValue'); } setValue() { this._boom('setValue'); }
  clearContent() { this._boom('clearContent'); }
  setDataValidation() { return this; } setBackground() { return this; } setFontColor() { return this; }
  setFontWeight() { return this; } setNumberFormat() { return this; }
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------
class Sheet {
  constructor(ss, name) {
    this.ss = ss; this.name = name; this.cells = new Map();
    this.maxRow = 0; this.maxCol = 0; this.formUrl = null; this.hidden = false;
    this.gridRows = 1000; this.gridCols = 26;
  }
  _key(r, c) { return r + ':' + c; }
  _get(r, c) { const v = this.cells.get(this._key(r, c)); return v === undefined ? '' : v; }
  _set(r, c, v) {
    this.cells.set(this._key(r, c), v);
    if (v !== '' && v !== null && v !== undefined) { if (r > this.maxRow) this.maxRow = r; if (c > this.maxCol) this.maxCol = c; }
  }
  getName() { return this.name; }
  setName(n) { this.ss._rename(this, n); this.name = n; return this; }
  getFormUrl() { return this.formUrl; }
  getLastRow() { this._recalc(); return this.maxRow; }
  getLastColumn() { this._recalc(); return this.maxCol; }
  getMaxRows() { return Math.max(this.gridRows, this.getLastRow()); }
  getMaxColumns() { return Math.max(this.gridCols, this.getLastColumn()); }
  _recalc() {
    let mr = 0, mc = 0;
    for (const [k, v] of this.cells) {
      if (v === '' || v === null || v === undefined) continue;
      const [r, c] = k.split(':').map(Number);
      if (r > mr) mr = r; if (c > mc) mc = c;
    }
    this.maxRow = mr; this.maxCol = mc;
  }
  getRange(a, b, c, d) {
    if (typeof a === 'string') return new PoisonRange(a);
    if (!(a >= 1) || !(b >= 1)) throw new Error(`getRange: 行・列は1以上が必要です (row=${a}, col=${b})`);
    return new Range(this, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
  }
  getDataRange() { this._recalc(); return new Range(this, 1, 1, Math.max(this.maxRow, 1), Math.max(this.maxCol, 1)); }
  appendRow(values) { const r = this.getLastRow() + 1; values.forEach((v, i) => this._set(r, i + 1, v)); return this; }
  insertRows(row, n) {
    n = n === undefined ? 1 : n;
    this._recalc();
    for (let r = this.maxRow; r >= row; r--) for (let c = 1; c <= this.maxCol; c++) this._set(r + n, c, this._get(r, c));
    for (let i = 0; i < n; i++) for (let c = 1; c <= this.maxCol; c++) this._set(row + i, c, '');
    return this;
  }
  insertRowBefore(row) { return this.insertRows(row, 1); }
  insertRowAfter(row) { return this.insertRows(row + 1, 1); }
  deleteRows(start, n) {
    this._recalc();
    for (let r = start; r <= this.maxRow; r++) for (let c = 1; c <= this.maxCol; c++) this._set(r, c, r + n <= this.maxRow ? this._get(r + n, c) : '');
    return this;
  }
  deleteRow(r) { return this.deleteRows(r, 1); }
  clearContents() { this.cells.clear(); this.maxRow = 0; this.maxCol = 0; return this; }
  hideSheet() { this.hidden = true; return this; }
  showSheet() { this.hidden = false; return this; }
  isSheetHidden() { return this.hidden; }
  setFrozenRows() { return this; } setColumnWidth() { return this; } setTabColor() { return this; }
  autoResizeColumn() { return this; } activate() { return this; }
  getSheetId() { return 1; }
  // テスト用
  dump() {
    this._recalc();
    const rows = [];
    for (let r = 1; r <= this.maxRow; r++) {
      const line = [];
      for (let c = 1; c <= this.maxCol; c++) line.push(this._get(r, c));
      rows.push(line);
    }
    return rows;
  }
}

class Spreadsheet {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = []; }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) {
    if (this.getSheetByName(n)) throw new Error('シート名が重複しています: ' + n);
    const s = new Sheet(this, n); this.sheets.push(s); return s;
  }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
  setActiveSheet(s) { return s; }
  moveActiveSheet() {}
  _rename(sheet, n) {
    const other = this.getSheetByName(n);
    if (other && other !== sheet) throw new Error('シート名が重複しています: ' + n);
  }
}

// ---------------------------------------------------------------------------
// FormApp
// ---------------------------------------------------------------------------
const FI_ITEM_TYPE = { LIST: 'LIST', TEXT: 'TEXT', PARAGRAPH_TEXT: 'PARAGRAPH_TEXT', DATE: 'DATE', CHECKBOX: 'CHECKBOX' };

class FormItem {
  constructor(form, type) {
    this.form = form; this.type = type; this.title = ''; this.required = false;
    this.helpText = ''; this.choices = null; this.validation = null;
  }
  getType() { return this.type; }
  getTitle() { return this.title; }
  setTitle(t) { this.title = String(t); return this; }
  setRequired(b) { this.required = !!b; return this; }
  isRequired() { return this.required; }
  setHelpText(t) { this.helpText = String(t); return this; }
  getHelpText() { return this.helpText; }
  setChoiceValues(v) {
    if (this.type !== FI_ITEM_TYPE.LIST) throw new Error('setChoiceValues はリスト項目にしか使えません: ' + this.title);
    this.choices = v.slice(); return this;
  }
  getChoices() { return (this.choices || []).map(v => ({ getValue: () => v })); }
  setValidation(v) { this.validation = v; return this; }
  asListItem() { if (this.type !== FI_ITEM_TYPE.LIST) throw new Error('asListItem: 型が違います ' + this.type); return this; }
  asTextItem() { if (this.type !== FI_ITEM_TYPE.TEXT) throw new Error('asTextItem: 型が違います ' + this.type); return this; }
  asDateItem() { return this; }
  asParagraphTextItem() { return this; }
}

class Form {
  constructor(app, id, title, published) {
    this.app = app; this.id = id; this.title = title; this.description = '';
    this.items = []; this.settings = {}; this.destinationId = null;
    // Google は API 経由で作られたフォームを未公開状態で作るようになった
    // （「API changes to Google Forms」）。FormApp.create() に同じ規則が及ぶかは
    // 公式に明言されていないため、スタブでは「未公開で作られる」という厳しい側を既定にする。
    // こうしておくと、コード側が明示的に公開していなければテストが落ちて気づける。
    this.published = published === undefined ? false : !!published;
    this.acceptingResponses = true;
  }
  getId() { return this.id; }
  getTitle() { return this.title; }
  setTitle(t) { this.title = t; return this; }
  getDescription() { return this.description; }
  setDescription(d) { this.description = d; return this; }
  getPublishedUrl() { return 'https://docs.google.com/forms/d/e/' + this.id + '/viewform'; }
  getEditUrl() { return 'https://docs.google.com/forms/d/' + this.id + '/edit'; }
  setPublished(v) { this.published = !!v; return this; }
  isPublished() { return this.published; }
  setAcceptingResponses(v) { this.acceptingResponses = !!v; return this; }
  isAcceptingResponses() { return this.acceptingResponses; }
  setCollectEmail(v) { this.settings.collectEmail = v; return this; }
  setLimitOneResponsePerUser(v) { this.settings.limitOne = v; return this; }
  setAllowResponseEdits(v) { this.settings.allowEdits = v; return this; }
  setShowLinkToRespondAgain(v) { this.settings.respondAgain = v; return this; }
  setConfirmationMessage(v) { this.settings.confirmation = v; return this; }
  setProgressBar(v) { this.settings.progressBar = v; return this; }
  _add(type) { const it = new FormItem(this, type); this.items.push(it); return it; }
  addListItem() { return this._add(FI_ITEM_TYPE.LIST); }
  addTextItem() { return this._add(FI_ITEM_TYPE.TEXT); }
  addParagraphTextItem() { return this._add(FI_ITEM_TYPE.PARAGRAPH_TEXT); }
  addDateItem() { return this._add(FI_ITEM_TYPE.DATE); }
  addSectionHeaderItem() { return this._add('SECTION_HEADER'); }
  getItems(type) { return type === undefined ? this.items.slice() : this.items.filter(i => i.type === type); }
  // Google Forms が実際に作るのと同じ「タイムスタンプ + 各質問タイトル」の回答シートを作る
  setDestination(type, spreadsheetId) {
    const ss = this.app._spreadsheets[spreadsheetId];
    if (!ss) throw new Error('setDestination: unknown spreadsheet ' + spreadsheetId);
    this.destinationId = spreadsheetId;
    let base = 'フォームの回答', n = 1, name = base + ' ' + n;
    while (ss.getSheetByName(name)) { n++; name = base + ' ' + n; }
    const sheet = ss.insertSheet(name);
    sheet.formUrl = this.getEditUrl();
    const headers = ['タイムスタンプ'].concat(this.items.map(i => i.title));
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return this;
  }
  // テスト用
  dumpForm() { return { id: this.id, title: this.title, published: this.published, destinationId: this.destinationId, settings: this.settings }; }
  dumpItems() {
    return this.items.map(i => ({ type: i.type, title: i.title, required: i.required, help: i.helpText, choices: i.choices, validation: i.validation }));
  }
}

function makeFormApp(spreadsheets) {
  let seq = 0;
  const forms = {};
  const app = {
    _spreadsheets: spreadsheets,
    _forms: forms,
    ItemType: FI_ITEM_TYPE,
    DestinationType: { SPREADSHEET: 'SPREADSHEET' },
    create(title, isPublished) { const id = 'FORM' + (++seq); const f = new Form(app, id, title, isPublished); forms[id] = f; return f; },
    openById(id) { if (!forms[id]) throw new Error('No item with the given ID could be found: ' + id); return forms[id]; },
    createTextValidation() {
      const v = { type: null, helpText: '', pattern: null };
      const b = {
        setHelpText(t) { v.helpText = t; return b; },
        requireWholeNumber() { v.type = 'wholeNumber'; return b; },
        requireNumberGreaterThanOrEqualTo(n) { v.type = 'numberGte'; v.min = n; return b; },
        requireTextMatchesPattern(p) { v.type = 'pattern'; v.pattern = p; return b; },
        build() { return v; },
      };
      return b;
    },
  };
  return app;
}

// ---------------------------------------------------------------------------
// Utilities.formatDate
// トークンを1回の走査で置換する。.replace('mm', …) を鎖にすると 'ss'（秒）が
// 置換されず、backupId（BK_yyyyMMdd_HHmmss）が同一分内で全て衝突する。
// ---------------------------------------------------------------------------
function formatDateStub(d, tz, fmt) {
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const map = {
    yyyy: () => String(d.getFullYear()),
    yy: () => String(d.getFullYear()).slice(-2),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    dd: () => pad(d.getDate()),
    d: () => String(d.getDate()),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    mm: () => pad(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
    SSS: () => pad(d.getMilliseconds(), 3),
  };
  return String(fmt).replace(/yyyy|yy|MM|dd|HH|mm|ss|SSS|M|d|H/g, t => map[t]());
}

// ---------------------------------------------------------------------------
function makeContext(extra) {
  const ss = new Spreadsheet('SSID', 'お守り在庫管理データ');
  const spreadsheets = { SSID: ss };
  let ssSeq = 0;
  const mails = [];
  const props = { OMAMORI_SPREADSHEET_ID: 'SSID' };
  const FormAppStub = makeFormApp(spreadsheets);

  // --- 固定できる時計 ---------------------------------------------------
  let nowOverride = null;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0 && nowOverride !== null) super(nowOverride);
      else super(...args);
    }
    static now() { return nowOverride !== null ? nowOverride : RealDate.now(); }
  }
  // 外側の realm で作られた本物の Date も `v instanceof Date` を通す
  // （gas/FormIntegration.gs の toDate_ がこれに依存している）
  Object.defineProperty(FakeDate, Symbol.hasInstance, { value: (x) => x instanceof RealDate });

  // --- 再入不可の ScriptLock -------------------------------------------
  // 本番の LockService は再入できない。takeBackup_ を processResponseRow_ の
  // ロック内から呼ぶと 30 秒待って例外になる。同じ挙動にして検出する。
  let lockHeld = 0;
  const scriptLock = {
    waitLock(ms) {
      if (lockHeld > 0) {
        throw new Error('Could not acquire lock after ' + (ms === undefined ? 0 : ms) +
          'ms（ScriptLock は再入できません。ロック内から waitLock を呼んでいます）');
      }
      lockHeld = 1;
      ctx.__lockAcquires++;
    },
    tryLock(ms) { if (lockHeld > 0) return false; lockHeld = 1; ctx.__lockAcquires++; return true; },
    hasLock() { return lockHeld > 0; },
    releaseLock() { lockHeld = 0; ctx.__lockReleases++; },
  };

  const triggers = [];
  function makeTriggerBuilder(handler) {
    const spec = { handler, kind: null };
    const b = {
      forSpreadsheet(id) { spec.ssId = id; return b; },
      onFormSubmit() { spec.kind = 'onFormSubmit'; return b; },
      onEdit() { spec.kind = 'onEdit'; return b; },
      timeBased() { spec.kind = 'timeBased'; return b; },
      atHour(h) { spec.hour = h; return b; },
      nearMinute(m) { spec.minute = m; return b; },
      everyDays(n) { spec.everyDays = n; return b; },
      everyHours(n) { spec.everyHours = n; return b; },
      everyMinutes(n) { spec.everyMinutes = n; return b; },
      create() {
        const t = {
          spec,
          getHandlerFunction: () => spec.handler,
          getUniqueId: () => 'TRG' + triggers.length,
          getEventType: () => spec.kind,
        };
        triggers.push(t);
        return t;
      },
    };
    return b;
  }

  // スタンドアロンのスクリプトでは SpreadsheetApp.getUi() が必ず例外になる。
  // テストで UI のある環境（スプレッドシートのメニューから実行）を再現したいときは
  // ctx.__setUi({...}) で差し込む。
  let uiStub = null;

  const ctx = {
    console,
    Math, Array, String, Number, Object, JSON, RegExp, Error, isFinite, isNaN, parseInt, parseFloat, Set, Map,
    unescape, encodeURIComponent, decodeURIComponent,
    Date: FakeDate,
    Logger: { log: (m) => { ctx.__logs.push(String(m)); } },
    __logs: [],
    __mails: mails,
    __ss: ss,
    __spreadsheets: spreadsheets,
    __forms: FormAppStub._forms,
    __triggers: triggers,
    __props: props,
    __lockAcquires: 0,
    __lockReleases: 0,
    __setNow: (v) => { nowOverride = v === null ? null : (v instanceof RealDate ? v.getTime() : Number(v)); },
    __advance: (ms) => { if (nowOverride === null) nowOverride = RealDate.now(); nowOverride += ms; },
    __isLocked: () => lockHeld > 0,
    __setUi: (u) => { uiStub = u; },
    SpreadsheetApp: {
      openById: (id) => { const s = spreadsheets[id]; if (!s) throw new Error('no such spreadsheet ' + id); return s; },
      // 本物と同じく「新しい別のスプレッドシート」を作る。
      // ここで既存の ss を返すと initializeSpreadsheet の上書き事故を再現できない。
      create: (n) => { const id = 'SS' + (++ssSeq); const s = new Spreadsheet(id, n); spreadsheets[id] = s; return s; },
      flush: () => {},
      newDataValidation: () => ({ requireValueInList: () => ({ build: () => ({}) }) }),
      getUi: () => {
        if (uiStub) return uiStub;
        throw new Error('Cannot call SpreadsheetApp.getUi() from this context.');
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props[k] === undefined ? null : props[k]),
        setProperty: (k, v) => { props[k] = v; },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    ContentService: {
      createTextOutput: (s) => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } }),
      MimeType: { JSON: 'json' },
    },
    Utilities: {
      formatDate: formatDateStub,
      newBlob: (bytes, mime, name) => ({ bytes, mime, name, getAs() { return this; }, setName(n) { this.name = n; return this; } }),
      base64Decode: (s) => [...Buffer.from(s, 'base64')],
      sleep: () => {},
      getUuid: () => 'uuid-stub',
    },
    LockService: { getScriptLock: () => scriptLock, getDocumentLock: () => scriptLock, getUserLock: () => scriptLock },
    MailApp: { sendEmail: (to, subject, body, opts) => { mails.push({ to, subject, body, opts }); }, getRemainingDailyQuota: () => 99 },
    GmailApp: { createDraft: (to, subject, body) => { mails.push({ draft: true, to, subject, body }); } },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => 'admin@example.com' }),
      getActiveUser: () => ({ getEmail: () => 'admin@example.com' }),
      getScriptTimeZone: () => 'Asia/Tokyo',
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      newTrigger: (handler) => makeTriggerBuilder(handler),
      deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    },
    DriveApp: {
      getFoldersByName: () => ({ hasNext: () => false }),
      createFolder: (n) => ({ getId: () => 'FOLDER', getUrl: () => 'https://drive/folder', createFile: (b) => ({ getUrl: () => 'https://drive/file/' + b.name }) }),
      getFolderById: (id) => ({ getId: () => id, getUrl: () => 'https://drive/folder/' + id, createFile: (b) => ({ getUrl: () => 'https://drive/file/' + b.name }) }),
      getFileById: () => ({ moveTo() {}, makeCopy: () => ({ getId: () => 'COPY', getUrl: () => 'https://slides/COPY', setTrashed() {} }), getAs: () => ({ setName(n) { this.name = n; return this; } }) }),
      createFile: (b) => ({ getUrl: () => 'https://drive/file/' + b.name }),
      Access: { ANYONE_WITH_LINK: 1 }, Permission: { VIEW: 1 },
    },
    Drive: { Files: { insert: () => ({ id: 'CONVERTED' }) } },
    SlidesApp: null,   // ラベル組版はテスト側で buildLabelPdf_ を差し替える
    FormApp: FormAppStub,
  };
  Object.assign(ctx, extra || {});
  ctx.globalThis = ctx;
  return ctx;
}

module.exports = { makeContext, Spreadsheet, Sheet, Range, Form, FormItem };
