/**
 * お守り在庫管理システム - Google Apps Script
 *
 * このスクリプトは以下の機能を提供します：
 * 1. スプレッドシートの自動作成・初期化
 * 2. 商品データのCRUD操作（1シートで統合管理）
 * 3. 履歴データの記録・取得
 *
 * 使い方：
 * 1. Google ドライブで新しい Google Apps Script プロジェクトを作成
 * 2. このコードを貼り付けて保存
 * 3. initializeSpreadsheet() を実行してスプレッドシートを作成
 * 4. デプロイ → ウェブアプリとしてデプロイ
 * 5. 生成されたURLをアプリに設定
 *
 * ※ Googleフォーム連携・ラベルPDF送付は FormIntegration.gs / LabelPdf.gs 側に実装。
 *    このファイルからは doGet の default 分岐で routeExtended_ に委譲するのみ。
 * ※ 見積メール・起案書の署名（神社名・氏名・連絡先）は「設定」シートから読み込む
 *    （getSenderProfile_ を参照）。コード内には個人情報を持たない。
 */

// ========================================
// 設定
// ========================================

const SPREADSHEET_NAME = 'お守り在庫管理データ';
const SHEET_NAMES = {
  PRODUCTS: '商品管理',
  HISTORY: '履歴'
};

// スプレッドシートIDを保存するプロパティキー
const SPREADSHEET_ID_KEY = 'OMAMORI_SPREADSHEET_ID';

// ========================================
// 初期化関数
// ========================================

/**
 * スプレッドシートを新規作成し、必要なシートと初期データを設定する
 * 最初に1回だけ実行してください
 */
function initializeSpreadsheet() {
  // 既存のスプレッドシートIDを確認
  const existingId = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_KEY);

  if (existingId) {
    try {
      const existingSs = SpreadsheetApp.openById(existingId);
      const ui = SpreadsheetApp.getUi();
      const response = ui.alert(
        '確認',
        '既にスプレッドシートが存在します。新しく作成しますか？\n' +
        '（既存のデータは保持されます）\n\n' +
        '既存のスプレッドシート: ' + existingSs.getName(),
        ui.ButtonSet.YES_NO
      );

      if (response !== ui.Button.YES) {
        ui.alert('キャンセルしました。');
        return;
      }
    } catch (e) {
      // 既存のスプレッドシートにアクセスできない場合は新規作成
    }
  }

  // 新しいスプレッドシートを作成
  const ss = SpreadsheetApp.create(SPREADSHEET_NAME);
  const spreadsheetId = ss.getId();

  // スプレッドシートIDを保存
  PropertiesService.getScriptProperties().setProperty(SPREADSHEET_ID_KEY, spreadsheetId);

  // シートを作成
  createProductsSheet(ss);
  createHistorySheet(ss);

  // デフォルトのSheet1を削除
  try {
    const defaultSheet = ss.getSheetByName('シート1');
    if (defaultSheet) {
      ss.deleteSheet(defaultSheet);
    }
  } catch (e) {
    // 削除できなくても続行
  }

  // 完了メッセージ（ログに出力）
  Logger.log('=== 初期化完了 ===');
  Logger.log('スプレッドシート名: ' + SPREADSHEET_NAME);
  Logger.log('スプレッドシートID: ' + spreadsheetId);
  Logger.log('スプレッドシートURL: ' + ss.getUrl());
  Logger.log('');
  Logger.log('次のステップ:');
  Logger.log('1. 「デプロイ」→「新しいデプロイ」を選択');
  Logger.log('2. 「ウェブアプリ」を選択');
  Logger.log('3. アクセスできるユーザーを「全員」に設定');
  Logger.log('4. デプロイしてURLをコピー');

  Logger.log('スプレッドシートを作成しました: ' + ss.getUrl());
}

/**
 * 商品管理シートを作成（統合シート）
 */
function createProductsSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.PRODUCTS);
  }

  // ヘッダーを設定（分納対応・発注先情報付き）
  const headers = [
    '商品コード', '商品名', '入数', '単価（税込）',
    '発注先', '担当者', 'メールアドレス',
    '現在庫', '安心在庫',
    '発注状況', '発注数/納期',
    '更新日時'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  // ヘッダー行のスタイル
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#8B0000')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold');

  // 列幅を調整（発注先情報付き）
  sheet.setColumnWidth(1, 120);  // 商品コード
  sheet.setColumnWidth(2, 180);  // 商品名
  sheet.setColumnWidth(3, 60);   // 入数
  sheet.setColumnWidth(4, 100);  // 単価
  sheet.setColumnWidth(5, 150);  // 発注先
  sheet.setColumnWidth(6, 100);  // 担当者
  sheet.setColumnWidth(7, 200);  // メールアドレス
  sheet.setColumnWidth(8, 80);   // 現在庫
  sheet.setColumnWidth(9, 80);   // 安心在庫
  sheet.setColumnWidth(10, 80);  // 発注状況
  sheet.setColumnWidth(11, 350); // 発注数/納期
  sheet.setColumnWidth(12, 140); // 更新日時

  // 1行目を固定
  sheet.setFrozenRows(1);

  // データ入力規則（発注状況）
  const orderStatusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['未発注', '発注済み'], true)
    .build();
  sheet.getRange('J2:J1000').setDataValidation(orderStatusRule);

  return sheet;
}

/**
 * 履歴シートを作成
 */
function createHistorySheet(ss) {
  let sheet = ss.getSheetByName(SHEET_NAMES.HISTORY);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.HISTORY);
  }

  // ヘッダーを設定
  const headers = ['日時', '種別', '商品コード', '商品名', '数量', '備考'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  // ヘッダー行のスタイル
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#4a4a4a')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold');

  // 列幅を調整
  sheet.setColumnWidth(1, 150);
  sheet.setColumnWidth(2, 80);
  sheet.setColumnWidth(3, 120);
  sheet.setColumnWidth(4, 180);
  sheet.setColumnWidth(5, 80);
  sheet.setColumnWidth(6, 200);

  // 1行目を固定
  sheet.setFrozenRows(1);

  return sheet;
}

// ========================================
// Web API エンドポイント
// ========================================

/**
 * data パラメータ（JSON文字列）を解釈する
 *
 * GAS は e.parameter の値を URL デコード済みで渡すため、まずそのまま JSON として解釈する。
 * 失敗した場合のみ（二重にエンコードされた旧形式に備えて）decodeURIComponent を試す。
 * ※ 以前は常に decodeURIComponent してから解釈していたため、備考などに「%」を含む
 *    データを送るとデコードに失敗し、データ全体が空 {} として扱われていた。
 */
function parseDataParam_(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e1) {
    try {
      return JSON.parse(decodeURIComponent(raw));
    } catch (e2) {
      // パース失敗時は空オブジェクト
      return {};
    }
  }
}

/**
 * GETリクエストを処理
 * CORS問題を回避するため、POST相当の処理もGETで受け付ける
 */
function doGet(e) {
  try {
    const action = e.parameter.action;
    let result;

    // dataパラメータがあればJSONとしてパース
    const data = parseDataParam_(e.parameter.data);

    switch (action) {
      // === 読み取り系（従来のGET） ===
      case 'getProducts':
        result = getProductsData();
        break;
      case 'getMaster':
        // 後方互換性のため
        result = getMasterDataFromProducts();
        break;
      case 'getStock':
        // 後方互換性のため
        result = getStockDataFromProducts();
        break;
      case 'getOrders':
        // 後方互換性のため
        result = getOrdersDataFromProducts();
        break;
      case 'getHistory':
        const limit = parseInt(e.parameter.limit) || 100;
        result = getHistoryData(limit);
        break;
      case 'getAll':
        result = getAllData();
        break;
      case 'ping':
        result = { success: true, message: 'pong', timestamp: new Date().toISOString() };
        break;
      case 'test':
        // 接続テスト用
        const ss = getSpreadsheet();
        result = {
          success: true,
          message: '接続成功',
          spreadsheetId: ss.getId(),
          spreadsheetName: ss.getName(),
          timestamp: new Date().toISOString()
        };
        break;

      // === 書き込み系（CORS回避のためGETでも受付） ===
      case 'saveStock':
        result = saveStockToProducts(data.stock || data);
        break;
      case 'saveOrders':
        result = saveOrdersToProducts(data.orders || data);
        break;
      case 'addHistory':
        result = addHistoryRecord(data.record || data);
        break;
      case 'updateStock':
        result = updateStockInProducts(data.productCode, data.stock, data.safeStock);
        break;
      case 'updateOrder':
        result = updateOrderInProducts(data.productCode, data.ordered, data.quantity, data.deliveryDate);
        break;
      case 'saveProducts':
        result = saveProductsData(data.products || data);
        break;
      case 'saveMaster':
        result = saveMasterToProducts(data.master || data);
        break;
      case 'addProduct':
        result = addProduct(data.product || data);
        break;
      case 'saveProduct':
        result = saveFullProduct(data.data || data);
        break;
      case 'deleteProduct':
        result = deleteProduct(data.productCode);
        break;
      case 'clearHistory':
        result = clearHistoryData();
        break;
      case 'createQuotationEmail':
        result = createQuotationEmailDrafts(data);
        break;
      case 'createKianDocument':
        result = createKianDocuments(data);
        break;

      default:
        // 拡張アクション（FormIntegration.gs の routeExtended_）に委譲。
        // 拡張が未導入・未知のアクションなら従来通りエラーを返す
        result = (typeof routeExtended_ === 'function') ? routeExtended_(action, data, e) : null;
        if (!result) result = { success: false, error: 'Unknown action: ' + action };
    }

    return createJsonResponse(result);
  } catch (error) {
    return createJsonResponse({ success: false, error: error.toString() });
  }
}

/**
 * POSTリクエストを処理
 */
function doPost(e) {
  try {
    // FormDataまたは通常のJSON両方に対応
    let data;
    if (e.parameter && e.parameter.payload) {
      // FormDataの場合（payloadパラメータにJSONが入っている）
      data = JSON.parse(e.parameter.payload);
    } else {
      // 通常のJSON POSTの場合
      data = JSON.parse(e.postData.contents);
    }
    const action = data.action;
    let result;

    switch (action) {
      case 'saveProducts':
        result = saveProductsData(data.products);
        break;
      case 'saveMaster':
        // 後方互換性のため
        result = saveMasterToProducts(data.master);
        break;
      case 'saveStock':
        // 後方互換性のため
        result = saveStockToProducts(data.stock);
        break;
      case 'saveOrders':
        // 後方互換性のため
        result = saveOrdersToProducts(data.orders);
        break;
      case 'addHistory':
        result = addHistoryRecord(data.record);
        break;
      case 'updateProduct':
        result = updateSingleProduct(data.productCode, data.productData);
        break;
      case 'updateStock':
        // 後方互換性のため
        result = updateStockInProducts(data.productCode, data.stock, data.safeStock);
        break;
      case 'updateOrder':
        // 後方互換性のため
        result = updateOrderInProducts(data.productCode, data.ordered, data.quantity, data.deliveryDate);
        break;
      case 'addProduct':
        result = addProduct(data.product);
        break;
      case 'saveProduct':
        // 商品追加時に全データを一括保存
        result = saveFullProduct(data.data);
        break;
      case 'addMasterItem':
        // 後方互換性のため
        result = addProduct({
          code: data.item.code,
          name: data.item.name,
          quantity: data.item.quantity,
          unitPrice: data.item.unitPrice || 0
        });
        break;
      case 'deleteProduct':
        result = deleteProduct(data.productCode);
        break;
      case 'deleteMasterItem':
        // 後方互換性のため
        result = deleteProduct(data.productCode);
        break;
      case 'clearHistory':
        result = clearHistoryData();
        break;
      case 'migrate':
        // データ移行用
        result = migrateAllData(data.master, data.stock, data.orders, data.history);
        break;
      default:
        result = { success: false, error: 'Unknown action: ' + action };
    }

    return createJsonResponse(result);
  } catch (error) {
    return createJsonResponse({ success: false, error: error.toString() });
  }
}

/**
 * JSONレスポンスを作成
 */
function createJsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ========================================
// データ取得関数
// ========================================

/**
 * スプレッドシートを取得
 */
function getSpreadsheet() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_KEY);
  if (!spreadsheetId) {
    throw new Error('スプレッドシートが初期化されていません。initializeSpreadsheet()を実行してください。');
  }
  return SpreadsheetApp.openById(spreadsheetId);
}

/**
 * 商品管理データを取得（統合シートから）
 */
function getProductsData() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS);
  const data = sheet.getDataRange().getValues();

  const products = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0]) {  // 商品コードがある行のみ
      // 分納データのパース（見やすい形式または旧形式）
      // 新列構成: A=コード, B=名前, C=入数, D=単価, E=発注先, F=担当者, G=メール, H=現在庫, I=安心在庫, J=発注状況, K=発注数/納期, L=更新日時
      let deliveries = [];
      const deliveryData = row[10];
      if (deliveryData) {
        if (typeof deliveryData === 'string' && deliveryData.startsWith('合計')) {
          deliveries = parseDisplayTextToDeliveries(deliveryData);
        } else if (typeof deliveryData === 'string' && deliveryData.startsWith('[')) {
          try {
            deliveries = JSON.parse(deliveryData);
          } catch (e) {
            deliveries = [];
          }
        } else if (typeof deliveryData === 'number' || !isNaN(parseInt(deliveryData))) {
          const qty = parseInt(deliveryData) || 0;
          const date = row[11] || '';
          if (qty > 0 || date) {
            deliveries = [{ quantity: qty, date: date }];
          }
        }
      }

      products[row[0]] = {
        code: row[0],
        name: row[1],
        quantity: row[2] || 0,
        unitPrice: row[3] || 0,
        supplier: row[4] || '',
        contact: row[5] || '',
        email: row[6] || '',
        stock: row[7] || 0,
        safeStock: row[8] || 0,
        ordered: row[9] === '発注済み',
        deliveries: deliveries,
        updatedAt: row[11]
      };
    }
  }

  return { success: true, data: products };
}

/**
 * 見やすい表示形式を分納配列にパース
 * 例: "合計2600個: 1000個(1/31), 1000個(2/15), 600個(3/1)" -> [{quantity: 1000, date: '1/31'}, ...]
 */
function parseDisplayTextToDeliveries(displayText) {
  if (!displayText || !displayText.startsWith('合計')) {
    return [];
  }

  try {
    // "合計XXXX個: " の後ろを取得
    const colonIndex = displayText.indexOf(':');
    if (colonIndex === -1) return [];

    const partsStr = displayText.substring(colonIndex + 1).trim();
    const parts = partsStr.split(',').map(p => p.trim());

    const deliveries = [];
    for (const part of parts) {
      // "1000個(1/31)" 形式をパース
      const match = part.match(/(\d+)個\(([^)]+)\)/);
      if (match) {
        deliveries.push({
          quantity: parseInt(match[1]),
          date: match[2]
        });
      }
    }

    return deliveries;
  } catch (e) {
    return [];
  }
}

/**
 * 後方互換性: マスタデータ形式で取得
 */
function getMasterDataFromProducts() {
  const productsResult = getProductsData();
  if (!productsResult.success) return productsResult;

  const master = {};
  for (const code in productsResult.data) {
    const p = productsResult.data[code];
    master[code] = {
      name: p.name,
      quantity: p.quantity,
      unitPrice: p.unitPrice,
      supplier: p.supplier || '',
      contact: p.contact || '',
      email: p.email || ''
    };
  }

  return { success: true, data: master };
}

/**
 * 後方互換性: 在庫データ形式で取得
 */
function getStockDataFromProducts() {
  const productsResult = getProductsData();
  if (!productsResult.success) return productsResult;

  const stock = {};
  for (const code in productsResult.data) {
    const p = productsResult.data[code];
    stock[code] = {
      stock: p.stock,
      safeStock: p.safeStock
    };
  }

  return { success: true, data: stock };
}

/**
 * 後方互換性: 発注データ形式で取得（分納対応）
 */
function getOrdersDataFromProducts() {
  const productsResult = getProductsData();
  if (!productsResult.success) return productsResult;

  const orders = {};
  for (const code in productsResult.data) {
    const p = productsResult.data[code];
    orders[code] = {
      ordered: p.ordered,
      deliveries: p.deliveries || []
    };
  }

  return { success: true, data: orders };
}

/**
 * 履歴データを取得
 */
function getHistoryData(limit) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.HISTORY);
  const data = sheet.getDataRange().getValues();

  const history = [];
  const maxRows = Math.min(data.length, limit + 1);

  for (let i = 1; i < maxRows; i++) {
    const row = data[i];
    if (row[0]) {
      history.push({
        date: row[0],
        type: row[1],
        productCode: row[2],
        productName: row[3],
        quantity: row[4],
        note: row[5]
      });
    }
  }

  return { success: true, data: history };
}

/**
 * 全データを取得
 */
function getAllData() {
  const products = getProductsData();
  const master = getMasterDataFromProducts();
  const stock = getStockDataFromProducts();
  const orders = getOrdersDataFromProducts();
  const history = getHistoryData(100);

  return {
    success: true,
    data: {
      products: products.data,
      master: master.data,
      stock: stock.data,
      orders: orders.data,
      history: history.data
    }
  };
}

// ========================================
// データ保存関数
// ========================================

/**
 * 商品管理データを保存（分納対応・見やすい形式）
 */
function saveProductsData(products) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS);
  const now = new Date().toLocaleString('ja-JP');

  // 既存データをクリア（ヘッダー以外）
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 12).clearContent();
  }

  // 新しいデータを書き込み
  const rows = [];
  for (const code in products) {
    const p = products[code];
    const displayText = formatDeliveriesForDisplay(p.deliveries || []);
    rows.push([
      code,
      p.name || '',
      p.quantity || 0,
      p.unitPrice || 0,
      p.supplier || '',
      p.contact || '',
      p.email || '',
      p.stock || 0,
      p.safeStock || 0,
      p.ordered ? '発注済み' : '未発注',
      displayText,
      now
    ]);
  }

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 12).setValues(rows);
  }

  return { success: true, message: '商品データを保存しました' };
}

/**
 * 後方互換性: マスタデータを商品管理シートに保存（分納対応・見やすい形式）
 */
function saveMasterToProducts(master) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS);
  const now = new Date().toLocaleString('ja-JP');

  // 既存データを取得
  const existingData = sheet.getDataRange().getValues();
  const existingProducts = {};

  for (let i = 1; i < existingData.length; i++) {
    const row = existingData[i];
    if (row[0]) {
      // 分納データのパース（見やすい形式またはJSON）
      // 新列構成: E=発注先, F=担当者, G=メール, H=現在庫, I=安心在庫, J=発注状況, K=発注数/納期
      let deliveries = [];
      const deliveryData = row[10];
      if (deliveryData) {
        if (typeof deliveryData === 'string' && deliveryData.startsWith('合計')) {
          deliveries = parseDisplayTextToDeliveries(deliveryData);
        } else if (typeof deliveryData === 'string' && deliveryData.startsWith('[')) {
          try {
            deliveries = JSON.parse(deliveryData);
          } catch (e) {
            deliveries = [];
          }
        }
      }

      existingProducts[row[0]] = {
        supplier: row[4] || '',
        contact: row[5] || '',
        email: row[6] || '',
        stock: row[7] || 0,
        safeStock: row[8] || 0,
        ordered: row[9] === '発注済み',
        deliveries: deliveries
      };
    }
  }

  // 既存データをクリア（ヘッダー以外）
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 12).clearContent();
  }

  // マスタデータと既存の在庫・発注データをマージして書き込み
  const rows = [];
  for (const code in master) {
    const m = master[code];
    const existing = existingProducts[code] || {};
    const displayText = formatDeliveriesForDisplay(existing.deliveries || []);
    rows.push([
      code,
      m.name || '',
      m.quantity || 0,
      m.unitPrice || 0,
      m.supplier || existing.supplier || '',
      m.contact || existing.contact || '',
      m.email || existing.email || '',
      existing.stock || 0,
      existing.safeStock || 0,
      existing.ordered ? '発注済み' : '未発注',
      displayText,
      now
    ]);
  }

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 12).setValues(rows);
  }

  return { success: true, message: '商品マスタを保存しました' };
}

/**
 * 後方互換性: 在庫データを商品管理シートに保存
 */
function saveStockToProducts(stock) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS);
  const now = new Date().toLocaleString('ja-JP');

  // 既存データを取得
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const code = data[i][0];
    if (code && stock[code]) {
      // 在庫と安心在庫を更新（列8=現在庫, 9=安心在庫）
      sheet.getRange(i + 1, 8, 1, 2).setValues([[
        stock[code].stock || 0,
        stock[code].safeStock || 0
      ]]);
      // 更新日時を更新（列12）
      sheet.getRange(i + 1, 12).setValue(now);
    }
  }

  return { success: true, message: '在庫データを保存しました' };
}

/**
 * 発注データを商品管理シートに保存（分納対応・見やすい形式）
 */
function saveOrdersToProducts(orders) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS);
  const now = new Date().toLocaleString('ja-JP');

  // 既存データを取得
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const code = data[i][0];
    if (code && orders[code]) {
      // 分納データを見やすい形式に変換
      const deliveries = orders[code].deliveries || [];
      const displayText = formatDeliveriesForDisplay(deliveries);

      // 発注状況、分納データを更新（列10=発注状況, 11=発注数/納期）
      sheet.getRange(i + 1, 10, 1, 2).setValues([[
        orders[code].ordered ? '発注済み' : '未発注',
        displayText
      ]]);
      // 更新日時を更新（列12）
      sheet.getRange(i + 1, 12).setValue(now);
    }
  }

  return { success: true, message: '発注データを保存しました' };
}

/**
 * 分納データを見やすい表示形式に変換
 * 例: "合計2600個: 1000個(1/31), 1000個(2/15), 600個(3/1)"
 */
function formatDeliveriesForDisplay(deliveries) {
  if (!deliveries || deliveries.length === 0) {
    return '';
  }

  // 合計数量を計算
  const total = deliveries.reduce((sum, d) => sum + (d.quantity || 0), 0);

  // 各分納をフォーマット
  const parts = deliveries.map(d => {
    const qty = d.quantity || 0;
    const date = formatDateShort(d.date);
    return `${qty}個(${date})`;
  });

  return `合計${total}個: ${parts.join(', ')}`;
}

/**
 * 日付を短い形式に変換 (M/D)
 */
function formatDateShort(dateStr) {
  if (!dateStr) return '未定';

  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;

    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}/${day}`;
  } catch (e) {
    return dateStr;
  }
}

/**
 * 履歴レコードを追加
 */
function addHistoryRecord(record) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.HISTORY);

  // 新しい行を先頭（2行目）に挿入
  sheet.insertRowAfter(1);

  const row = [
    record.date || new Date().toLocaleString('ja-JP'),
    record.type,
    record.productCode,
    record.productName,
    record.quantity,
    record.note || ''
  ];

  sheet.getRange(2, 1, 1, 6).setValues([row]);

  // 履歴が1000件を超えたら古いものを削除
  const lastRow = sheet.getLastRow();
  if (lastRow > 1001) {
    sheet.deleteRows(1002, lastRow - 1001);
  }

  return { success: true, message: '履歴を追加しました' };
}

/**
 * 単一の商品データを更新
 */
function updateSingleProduct(productCode, productData) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS);
  const now = new Date().toLocaleString('ja-JP');

  // 既存の行を検索
  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === productCode) {
      rowIndex = i + 1;
      break;
    }
  }

  if (rowIndex > 0) {
    // 既存の行を更新
    // 分納データの処理
    let deliveryDisplay = data[rowIndex - 1][10]; // 既存の発注数/納期を保持
    if (productData.deliveries !== undefined) {
      deliveryDisplay = formatDeliveriesForDisplay(productData.deliveries);
    } else if (productData.orderQuantity !== undefined || productData.deliveryDate !== undefined) {
      const qty = productData.orderQuantity || 0;
      const date = productData.deliveryDate || '';
      if (qty > 0 || date) {
        deliveryDisplay = formatDeliveriesForDisplay([{quantity: qty, date: date}]);
      } else {
        deliveryDisplay = '';
      }
    }

    const rowData = [
      productCode,
      productData.name || data[rowIndex - 1][1],
      productData.quantity !== undefined ? productData.quantity : data[rowIndex - 1][2],
      productData.unitPrice !== undefined ? productData.unitPrice : data[rowIndex - 1][3],
      productData.supplier !== undefined ? productData.supplier : (data[rowIndex - 1][4] || ''),
      productData.contact !== undefined ? productData.contact : (data[rowIndex - 1][5] || ''),
      productData.email !== undefined ? productData.email : (data[rowIndex - 1][6] || ''),
      productData.stock !== undefined ? productData.stock : data[rowIndex - 1][7],
      productData.safeStock !== undefined ? productData.safeStock : data[rowIndex - 1][8],
      productData.ordered !== undefined ? (productData.ordered ? '発注済み' : '未発注') : data[rowIndex - 1][9],
      deliveryDisplay,
      now
    ];
    sheet.getRange(rowIndex, 1, 1, 12).setValues([rowData]);
  } else {
    // 新しい行を追加
    const lastRow = sheet.getLastRow();
    let deliveryDisplay = '';
    if (productData.deliveries) {
      deliveryDisplay = formatDeliveriesForDisplay(productData.deliveries);
    } else if (productData.orderQuantity || productData.deliveryDate) {
      deliveryDisplay = formatDeliveriesForDisplay([{quantity: productData.orderQuantity || 0, date: productData.deliveryDate || ''}]);
    }

    const rowData = [
      productCode,
      productData.name || '',
      productData.quantity || 0,
      productData.unitPrice || 0,
      productData.supplier || '',
      productData.contact || '',
      productData.email || '',
      productData.stock || 0,
      productData.safeStock || 0,
      productData.ordered ? '発注済み' : '未発注',
      deliveryDisplay,
      now
    ];
    sheet.getRange(lastRow + 1, 1, 1, 12).setValues([rowData]);
  }

  return { success: true, message: '商品データを更新しました' };
}

/**
 * 後方互換性: 在庫データを更新
 */
function updateStockInProducts(productCode, stock, safeStock) {
  return updateSingleProduct(productCode, { stock: stock, safeStock: safeStock });
}

/**
 * 後方互換性: 発注データを更新
 */
function updateOrderInProducts(productCode, ordered, quantity, deliveryDate) {
  return updateSingleProduct(productCode, {
    ordered: ordered,
    orderQuantity: quantity,
    deliveryDate: deliveryDate
  });
}

/**
 * 商品を追加
 */
function addProduct(product) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS);
  const now = new Date().toLocaleString('ja-JP');

  // 既存の商品コードをチェック
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === product.code) {
      return { success: false, error: '商品コードが既に存在します: ' + product.code };
    }
  }

  // 新しい行を追加
  const lastRow = sheet.getLastRow();
  let deliveryDisplay = '';
  if (product.deliveries) {
    deliveryDisplay = formatDeliveriesForDisplay(product.deliveries);
  } else if (product.orderQuantity || product.deliveryDate) {
    deliveryDisplay = formatDeliveriesForDisplay([{quantity: product.orderQuantity || 0, date: product.deliveryDate || ''}]);
  }

  const rowData = [
    product.code,
    product.name || '',
    product.quantity || 0,
    product.unitPrice || 0,
    product.supplier || '',
    product.contact || '',
    product.email || '',
    product.stock || 0,
    product.safeStock || 0,
    product.ordered ? '発注済み' : '未発注',
    deliveryDisplay,
    now
  ];
  sheet.getRange(lastRow + 1, 1, 1, 12).setValues([rowData]);

  return { success: true, message: '商品を追加しました' };
}

/**
 * 商品を削除
 */
function deleteProduct(productCode) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS);

  // 該当行を検索して削除
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === productCode) {
      sheet.deleteRow(i + 1);
      return { success: true, message: '商品を削除しました' };
    }
  }

  return { success: false, error: '商品が見つかりません: ' + productCode };
}

/**
 * 履歴データをクリア
 */
function clearHistoryData() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.HISTORY);

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 6).clearContent();
  }

  return { success: true, message: '履歴をクリアしました' };
}

/**
 * 全データを一括移行
 */
function migrateAllData(master, stock, orders, history) {
  try {
    const ss = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS);
    const now = new Date().toLocaleString('ja-JP');

    // 既存データをクリア（ヘッダー以外）
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, 12).clearContent();
    }

    // マスタ、在庫、発注データをマージして商品管理シートに書き込み
    const allCodes = new Set([
      ...Object.keys(master || {}),
      ...Object.keys(stock || {}),
      ...Object.keys(orders || {})
    ]);

    const rows = [];
    for (const code of allCodes) {
      const m = (master && master[code]) || {};
      const s = (stock && stock[code]) || {};
      const o = (orders && orders[code]) || {};

      // 発注データを見やすい形式に変換
      let deliveryDisplay = '';
      if (o.deliveries) {
        deliveryDisplay = formatDeliveriesForDisplay(o.deliveries);
      } else if (o.quantity || o.deliveryDate) {
        deliveryDisplay = formatDeliveriesForDisplay([{quantity: o.quantity || 0, date: o.deliveryDate || ''}]);
      }

      rows.push([
        code,
        m.name || '',
        m.quantity || 0,
        m.unitPrice || 0,
        m.supplier || '',
        m.contact || '',
        m.email || '',
        s.stock || 0,
        s.safeStock || 0,
        o.ordered ? '発注済み' : '未発注',
        deliveryDisplay,
        now
      ]);
    }

    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, 12).setValues(rows);
    }

    // 履歴データを保存
    if (history && history.length > 0) {
      const historySheet = ss.getSheetByName(SHEET_NAMES.HISTORY);

      // 既存データをクリア（ヘッダー以外）
      const historyLastRow = historySheet.getLastRow();
      if (historyLastRow > 1) {
        historySheet.getRange(2, 1, historyLastRow - 1, 6).clearContent();
      }

      // 履歴データを書き込み
      const historyRows = history.map(record => [
        record.date || '',
        record.type || '',
        record.productCode || '',
        record.productName || '',
        record.quantity || 0,
        record.note || ''
      ]);

      if (historyRows.length > 0) {
        historySheet.getRange(2, 1, historyRows.length, 6).setValues(historyRows);
      }
    }

    return {
      success: true,
      message: 'データ移行が完了しました',
      counts: {
        products: rows.length,
        history: history ? history.length : 0
      }
    };
  } catch (error) {
    return { success: false, error: 'データ移行に失敗しました: ' + error.toString() };
  }
}

// ========================================
// ユーティリティ関数
// ========================================

/**
 * スプレッドシートのURLを取得（デバッグ用）
 */
function getSpreadsheetUrl() {
  const ss = getSpreadsheet();
  Logger.log('Spreadsheet URL: ' + ss.getUrl());
  return ss.getUrl();
}

/**
 * 接続テスト
 */
function testConnection() {
  try {
    const ss = getSpreadsheet();
    Logger.log('接続成功: ' + ss.getName());
    return { success: true, name: ss.getName() };
  } catch (e) {
    Logger.log('接続失敗: ' + e.toString());
    return { success: false, error: e.toString() };
  }
}

/**
 * 既存データを新形式に移行（手動実行用）
 */
function migrateToNewFormat() {
  const ss = getSpreadsheet();

  // 旧シートが存在するか確認
  const oldMasterSheet = ss.getSheetByName('商品マスタ');
  const oldStockSheet = ss.getSheetByName('在庫データ');
  const oldOrdersSheet = ss.getSheetByName('発注データ');

  if (!oldMasterSheet && !oldStockSheet && !oldOrdersSheet) {
    Logger.log('旧形式のシートが見つかりません。移行は不要です。');
    return;
  }

  // 旧データを読み込み
  const master = {};
  const stock = {};
  const orders = {};

  if (oldMasterSheet) {
    const data = oldMasterSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) {
        master[data[i][0]] = {
          name: data[i][1],
          quantity: data[i][2],
          unitPrice: data[i][3] || 0
        };
      }
    }
  }

  if (oldStockSheet) {
    const data = oldStockSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) {
        stock[data[i][0]] = {
          stock: data[i][1] || 0,
          safeStock: data[i][2] || 0
        };
      }
    }
  }

  if (oldOrdersSheet) {
    const data = oldOrdersSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) {
        orders[data[i][0]] = {
          ordered: data[i][1] === '発注済み',
          quantity: data[i][2] || 0,
          deliveryDate: data[i][3] || ''
        };
      }
    }
  }

  // 新形式のシートを作成
  createProductsSheet(ss);

  // データを移行
  migrateAllData(master, stock, orders, []);

  Logger.log('データ移行が完了しました。旧シートは手動で削除してください。');
}


/**
 * 商品を全データ付きで保存（追加または更新）
 */
function saveFullProduct(productData) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS);
  const now = new Date().toLocaleString('ja-JP');

  // 既存の商品コードをチェック
  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === productData.code) {
      rowIndex = i + 1;
      break;
    }
  }

  // 分納データを見やすい形式に変換
  let deliveryDisplay = '';
  if (productData.deliveries) {
    deliveryDisplay = formatDeliveriesForDisplay(productData.deliveries);
  } else if (productData.orderQuantity || productData.deliveryDate) {
    deliveryDisplay = formatDeliveriesForDisplay([{quantity: productData.orderQuantity || 0, date: productData.deliveryDate || ''}]);
  }

  const rowData = [
    productData.code,
    productData.name || '',
    productData.quantity || 0,
    productData.unitPrice || 0,
    productData.supplier || '',
    productData.contact || '',
    productData.email || '',
    productData.stock || 0,
    productData.safeStock || 0,
    productData.ordered ? '発注済み' : '未発注',
    deliveryDisplay,
    now
  ];

  if (rowIndex > 0) {
    // 既存の行を更新
    sheet.getRange(rowIndex, 1, 1, 12).setValues([rowData]);
    return { success: true, message: '商品データを更新しました' };
  } else {
    // 新しい行を追加
    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, 1, 12).setValues([rowData]);
    return { success: true, message: '商品を追加しました' };
  }
}


// ========================================
// 差出人プロフィール（署名）
// ========================================

/**
 * 見積メール・起案書で使う差出人情報を「設定」シートから取得
 *
 * 「設定」シートは FormIntegration.gs の setupFormIntegration() が作成する。
 * 未作成・未記入の場合は空文字で返し、署名行は省略される。
 *
 * キー:
 *   orgName         神社名（例: ○○神社）
 *   senderName      署名用の氏名（例: 山田太郎）
 *   senderShortName 本文の名乗り（例: 山田）※未設定なら senderName
 *   senderEmail     メールアドレス
 *   senderAddress   住所（〒から1行で）
 *   senderTel       電話番号
 *   senderFax       FAX番号
 *   senderMobile    携帯番号
 */
function getSenderProfile_() {
  const cfg = (typeof getConfigMap_ === 'function') ? getConfigMap_() : {};
  const pick = key => (cfg[key] === undefined || cfg[key] === null) ? '' : String(cfg[key]).trim();
  const profile = {
    orgName: pick('orgName'),
    senderName: pick('senderName'),
    senderShortName: pick('senderShortName'),
    senderEmail: pick('senderEmail'),
    senderAddress: pick('senderAddress'),
    senderTel: pick('senderTel'),
    senderFax: pick('senderFax'),
    senderMobile: pick('senderMobile')
  };
  if (!profile.senderShortName) profile.senderShortName = profile.senderName;
  return profile;
}

/**
 * HTML エスケープ（起案書の埋め込み用）
 */
function escapeHtml_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ========================================
// 発注準備機能（メール下書き・起案書作成）
// ========================================

/**
 * 見積依頼メールの下書きを発注先ごとに作成
 */
function createQuotationEmailDrafts(data) {
  try {
    const suppliers = data.suppliers;
    if (!suppliers) {
      return { success: false, error: '発注データがありません' };
    }

    const sig = getSenderProfile_();
    const createdDrafts = [];

    for (const supplierName in suppliers) {
      const group = suppliers[supplierName];
      const items = group.items;
      const contactName = group.contact || '';
      const email = group.email || '';

      // メール件名
      const subject = '【お見積り依頼】授与品について' + (sig.orgName ? '（' + sig.orgName + '）' : '');

      // メール本文を作成
      let body = '';
      if (contactName) {
        body += supplierName + '\n' + contactName + ' 様\n\n';
      } else {
        body += supplierName + ' 御中\n\n';
      }

      body += (sig.orgName ? sig.orgName + 'の' : '') + (sig.senderShortName || '担当者') + 'です。\n';
      body += '下記授与品の発注を検討しておりますので、お見積りをお願いいたします。\n\n';
      body += '【見積依頼内容】\n';
      body += '─────────────────────\n';

      items.forEach(function(item) {
        body += '・' + item.name + '　' + item.quantity + '個\n';
      });

      body += '─────────────────────────\n';
      body += '\nご多忙のところ恐れ入りますが、\nご回答のほどよろしくお願いいたします。\n';

      // 署名（設定シートの値。未設定の項目は省略）
      const sigLines = [];
      if (sig.senderName || sig.senderEmail) {
        sigLines.push([sig.senderName, sig.senderEmail].filter(Boolean).join(' '));
      }
      if (sig.senderAddress) sigLines.push(sig.senderAddress);
      const telParts = [];
      if (sig.senderTel) telParts.push('TEL:' + sig.senderTel);
      if (sig.senderFax) telParts.push('FAX:' + sig.senderFax);
      if (telParts.length) sigLines.push(telParts.join(' '));
      if (sig.senderMobile) sigLines.push('携帯:' + sig.senderMobile);
      if (sigLines.length) {
        body += '\n**************************************************************************************************\n';
        body += sigLines.join('\n') + '\n';
      }

      // Gmail下書きを作成
      if (email) {
        GmailApp.createDraft(email, subject, body);
        createdDrafts.push(supplierName + '（' + email + '）');
      } else {
        // メールアドレスなしの場合は宛先空で下書き作成
        GmailApp.createDraft('', subject, body);
        createdDrafts.push(supplierName + '（宛先未設定）');
      }
    }

    return {
      success: true,
      message: createdDrafts.length + '件の下書きを作成しました：\n' + createdDrafts.join('\n')
    };

  } catch (error) {
    return { success: false, error: 'メール下書き作成エラー: ' + error.toString() };
  }
}

/**
 * 起案書をGoogleドキュメントで作成し、PDFも生成
 */
function createKianDocuments(data) {
  try {
    var suppliers = data.suppliers;
    if (!suppliers) {
      return { success: false, error: '発注データがありません' };
    }

    var sig = getSenderProfile_();

    // 起案書保存用フォルダを取得または作成
    var folderName = 'お守り在庫管理_起案書';
    var folder;
    var folders = DriveApp.getFoldersByName(folderName);
    if (folders.hasNext()) {
      folder = folders.next();
    } else {
      folder = DriveApp.createFolder(folderName);
    }

    var now = new Date();
    var dateStr = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd');

    // 令和の年を計算
    var year = now.getFullYear();
    var reiwaYear = year - 2018;
    var month = now.getMonth() + 1;
    var day = now.getDate();
    var reiwaDateStr = '令和' + reiwaYear + '年' + month + '月' + day + '日';

    var documents = [];

    for (var supplierName in suppliers) {
      var group = suppliers[supplierName];
      var items = group.items;

      // HTMLで起案書を作成し、PDFに変換
      var fileName = dateStr + '_' + supplierName + '起案書';

      // 明細行のHTMLを生成
      var totalAmount = 0;
      var itemRows = '';
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var amount = item.quantity * item.unitPrice;
        totalAmount += amount;
        itemRows += '<tr>';
        itemRows += '<td style="border:1px solid #000;padding:8px 12px;font-size:14pt;">' + (item.name || '不明') + '</td>';
        itemRows += '<td style="border:1px solid #000;padding:8px 12px;font-size:14pt;text-align:right;">&yen;' + Number(item.unitPrice).toLocaleString() + '</td>';
        itemRows += '<td style="border:1px solid #000;padding:8px 12px;font-size:14pt;text-align:center;">' + item.quantity + '</td>';
        itemRows += '<td style="border:1px solid #000;padding:8px 12px;font-size:14pt;text-align:right;">&yen;' + Number(amount).toLocaleString() + '</td>';
        itemRows += '<td style="border:1px solid #000;padding:8px 12px;font-size:14pt;">' + supplierName + '</td>';
        itemRows += '<td style="border:1px solid #000;padding:8px 12px;font-size:14pt;text-align:center;">別途調整</td>';
        itemRows += '</tr>';
      }

      var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        '<style>' +
        '@page { size: A4; margin: 20mm 18mm 15mm 18mm; }' +
        'body { font-family: "Noto Serif CJK JP", "Yu Mincho", "游明朝", "MS Mincho", "ＭＳ 明朝", serif; font-size: 14pt; color: #000; }' +
        'table { border-collapse: collapse; }' +
        '</style></head><body>' +

        '<div style="margin-bottom:20px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
        '<div style="font-size:14pt;">' +
        '<div>起案日</div>' +
        '<div style="border-bottom:1px solid #000;display:inline-block;padding-bottom:2px;">' + reiwaDateStr + '</div>' +
        '</div>' +
        '<div style="border:3px solid #000;padding:8px 30px;font-size:22pt;font-weight:bold;text-align:center;">起　案　書</div>' +
        '<div style="width:120px;"></div>' +
        '</div>' +
        '</div>' +

        '<div style="font-size:14pt;margin-bottom:16px;">' +
        '<span style="border-bottom:1px solid #000;padding-bottom:2px;">起案者：' + escapeHtml_(sig.senderName) + '</span>' +
        '</div>' +

        '<div style="border:1px solid #000;display:inline-block;padding:6px 16px;font-size:14pt;font-weight:bold;margin-bottom:16px;">' +
        '件名：授与品発注の件' +
        '</div>' +

        '<div style="font-size:14pt;margin-bottom:6px;margin-left:16px;">上記の件について、下記の通り購入してもよろしいでしょうか。</div>' +
        '<div style="font-size:14pt;margin-bottom:24px;margin-left:16px;">お伺い申し上げます。</div>' +

        '<table style="width:100%;margin-bottom:20px;">' +
        '<tr style="background:#f5f5f5;">' +
        '<th style="border:1px solid #000;padding:8px 12px;font-size:14pt;font-weight:bold;">品名</th>' +
        '<th style="border:1px solid #000;padding:8px 12px;font-size:14pt;font-weight:bold;">単価</th>' +
        '<th style="border:1px solid #000;padding:8px 12px;font-size:14pt;font-weight:bold;">数量</th>' +
        '<th style="border:1px solid #000;padding:8px 12px;font-size:14pt;font-weight:bold;">合計金額</th>' +
        '<th style="border:1px solid #000;padding:8px 12px;font-size:14pt;font-weight:bold;">発注先</th>' +
        '<th style="border:1px solid #000;padding:8px 12px;font-size:14pt;font-weight:bold;">納期</th>' +
        '</tr>' +
        itemRows +
        '</table>' +

        '<div style="text-align:right;margin-bottom:24px;">' +
        '<table style="display:inline-table;">' +
        '<tr><td style="border:1px solid #000;padding:8px 16px;font-size:14pt;font-weight:bold;">合計金額</td>' +
        '<td style="border:1px solid #000;padding:8px 24px;font-size:16pt;font-weight:bold;text-align:right;">&yen;' + Number(totalAmount).toLocaleString() + ' -</td></tr>' +
        '</table>' +
        '</div>' +

        '<div style="border:1px solid #000;padding:12px 16px;min-height:60px;margin-bottom:30px;font-size:14pt;">' +
        '備考：' +
        '</div>' +

        '<div style="text-align:right;">' +
        '<table style="display:inline-table;">' +
        '<tr>' +
        '<th style="border:1px solid #000;padding:6px 16px;font-size:14pt;font-weight:bold;">宮司印</th>' +
        '<th style="border:1px solid #000;padding:6px 16px;font-size:14pt;font-weight:bold;">権禰宜印</th>' +
        '<th style="border:1px solid #000;padding:6px 16px;font-size:14pt;font-weight:bold;">起案者印</th>' +
        '</tr>' +
        '<tr>' +
        '<td style="border:1px solid #000;padding:4px 16px;height:60px;"></td>' +
        '<td style="border:1px solid #000;padding:4px 16px;height:60px;"></td>' +
        '<td style="border:1px solid #000;padding:4px 16px;height:60px;"></td>' +
        '</tr>' +
        '</table>' +
        '</div>' +

        '</body></html>';

      // HTMLからPDFを生成
      var pdfName = dateStr + '_' + supplierName + '起案書.pdf';
      var pdfBlob = Utilities.newBlob(html, 'text/html', fileName + '.html').getAs('application/pdf').setName(pdfName);
      var pdfFile = folder.createFile(pdfBlob);

      // HTMLをGoogleドキュメントとしても保存
      var htmlBlob = Utilities.newBlob(html, 'text/html', fileName + '.html');
      var docResource = Drive.Files.insert(
        { title: fileName, mimeType: 'application/vnd.google-apps.document', parents: [{ id: folder.getId() }] },
        htmlBlob,
        { convert: true }
      );
      var docUrl = 'https://docs.google.com/document/d/' + docResource.id + '/edit';

      documents.push({
        name: fileName,
        docUrl: docUrl,
        pdfName: pdfName,
        pdfUrl: pdfFile.getUrl()
      });
    }

    return {
      success: true,
      message: documents.length + '件の起案書を作成しました',
      documents: documents,
      folderUrl: folder.getUrl()
    };

  } catch (error) {
    return { success: false, error: '起案書作成エラー: ' + error.toString() };
  }
}
