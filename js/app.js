/**
 * お守り在庫管理アプリ - メインスクリプト
 * 
 * 機能:
 * - モード選択（納品/出庫/棚卸）
 * - QRコード連続読み取り
 * - 読み取り確認画面
 * - 重複検知・警告
 * - 商品別集計
 * - CSV出力（ダウンロード＆メール送信）
 * - 在庫連動（納品で増加、出庫で減少）
 * - 安心在庫アラート
 * - 出庫時の安心在庫警告
 */

// ========================================
// グローバル変数・定数
// ========================================

// 商品マスタ（デフォルト値）
const DEFAULT_MASTER = {
    'HEALTH': { name: '健康守り', quantity: 50, unitPrice: 0 },
    'MONEY': { name: '金運守り', quantity: 100, unitPrice: 0 },
    'LOVE': { name: '縁結び守り', quantity: 80, unitPrice: 0 },
    'TRAFFIC': { name: '交通安全守り', quantity: 60, unitPrice: 0 },
    'STUDY': { name: '学業成就守り', quantity: 70, unitPrice: 0 },
    'FAMILY': { name: '家内安全守り', quantity: 50, unitPrice: 0 },
    'BUSINESS': { name: '商売繁盛守り', quantity: 60, unitPrice: 0 },
    'CHILD': { name: '子授け守り', quantity: 40, unitPrice: 0 },
    'RECOVERY': { name: '病気平癒守り', quantity: 50, unitPrice: 0 },
    'LUCK': { name: '開運守り', quantity: 80, unitPrice: 0 }
};

// セッションデータ
let session = {
    mode: null,           // 'delivery', 'shipment', or 'inventory'
    startTime: null,
    scannedBoxes: [],     // { qrCode, productCode, year, boxNumber, productName, timestamp }
    duplicateAttempts: [] // 重複読み取り試行ログ
};

// QRスキャナーインスタンス
let html5QrcodeScanner = null;

// 商品マスタ
let productMaster = { ...DEFAULT_MASTER };

// スキャン一時停止フラグ（確認画面表示中）
let scanPaused = false;

// 最後にスキャンしたQRコード（連続読み取り防止）
let lastScannedQr = null;
let lastScanTime = 0;

// ========================================
// DOM要素の取得
// ========================================

const elements = {
    // 画面
    modeSelectScreen: document.getElementById('mode-select-screen'),
    scanScreen: document.getElementById('scan-screen'),
    summaryScreen: document.getElementById('summary-screen'),
    
    // モード選択
    btnDelivery: document.getElementById('btn-delivery'),
    btnShipment: document.getElementById('btn-shipment'),
    btnInventory: document.getElementById('btn-inventory'),
    
    // 確認ダイアログ
    confirmDialog: document.getElementById('confirm-dialog'),
    dialogModeIndicator: document.getElementById('dialog-mode-indicator'),
    dialogMessage: document.getElementById('dialog-message'),
    btnConfirmCancel: document.getElementById('btn-confirm-cancel'),
    btnConfirmOk: document.getElementById('btn-confirm-ok'),
    
    // QR読み取り画面
    currentModeIndicator: document.getElementById('current-mode-indicator'),
    btnBackToMode: document.getElementById('btn-back-to-mode'),
    qrReader: document.getElementById('qr-reader'),
    lastScan: document.getElementById('last-scan'),
    scanCount: document.getElementById('scan-count'),
    btnToggleList: document.getElementById('btn-toggle-list'),
    scanList: document.getElementById('scan-list'),
    btnFinishScan: document.getElementById('btn-finish-scan'),
    
    // 重複警告ダイアログ
    duplicateDialog: document.getElementById('duplicate-dialog'),
    duplicateMessage: document.getElementById('duplicate-message'),
    btnDuplicateOk: document.getElementById('btn-duplicate-ok'),
    
    // 集計画面
    summaryModeIndicator: document.getElementById('summary-mode-indicator'),
    summaryDatetime: document.getElementById('summary-datetime'),
    summaryTotalBoxes: document.getElementById('summary-total-boxes'),
    summaryTotalQuantity: document.getElementById('summary-total-quantity'),
    summaryTbody: document.getElementById('summary-tbody'),
    btnExportCsv: document.getElementById('btn-export-csv'),
    btnContinueScan: document.getElementById('btn-continue-scan'),
    btnNewSession: document.getElementById('btn-new-session'),
    
    // トースト
    successToast: document.getElementById('success-toast'),
    toastMessage: document.getElementById('toast-message'),
    
    // 在庫アラート
    stockAlertBanner: document.getElementById('stock-alert-banner'),
    alertText: document.getElementById('alert-text')
};

// ========================================
// 初期化
// ========================================

document.addEventListener('DOMContentLoaded', async () => {
    initEventListeners();
    await loadMasterFromStorage();
    createScanConfirmDialog();
    createEmailDialog();
    createSafeStockWarningDialog();
    await checkStockAlerts();
});

function initEventListeners() {
    // モード選択ボタン
    elements.btnDelivery.addEventListener('click', () => showConfirmDialog('delivery'));
    elements.btnShipment.addEventListener('click', () => showConfirmDialog('shipment'));
    elements.btnInventory.addEventListener('click', () => showConfirmDialog('inventory'));
    
    // 確認ダイアログ
    elements.btnConfirmCancel.addEventListener('click', hideConfirmDialog);
    elements.btnConfirmOk.addEventListener('click', startSession);
    
    // QR読み取り画面
    elements.btnBackToMode.addEventListener('click', confirmBackToMode);
    elements.btnToggleList.addEventListener('click', toggleScanList);
    elements.btnFinishScan.addEventListener('click', finishScan);
    
    // 重複警告ダイアログ
    elements.btnDuplicateOk.addEventListener('click', hideDuplicateDialog);
    
    // 集計画面
    elements.btnExportCsv.addEventListener('click', showExportOptions);
    elements.btnContinueScan.addEventListener('click', continueScan);
    elements.btnNewSession.addEventListener('click', startNewSession);
}

// ========================================
// 安心在庫アラートチェック
// ========================================

async function checkStockAlerts() {
    const lowItems = await getLowStockItems();
    
    if (lowItems.length > 0) {
        elements.stockAlertBanner.classList.add('show');
        elements.alertText.textContent = `安心在庫不足: ${lowItems.length}種類のお守り`;
    } else {
        elements.stockAlertBanner.classList.remove('show');
    }
}

async function getLowStockItems() {
    // APIから在庫データを取得
    let stockData = {};
    if (typeof isApiEnabled === 'function' && isApiEnabled()) {
        try {
            stockData = await fetchStockData();
        } catch (e) {
            console.error('APIからの在庫取得失敗:', e);
            stockData = JSON.parse(localStorage.getItem('omamori_stock') || '{}');
        }
    } else {
        stockData = JSON.parse(localStorage.getItem('omamori_stock') || '{}');
    }
    
    const lowItems = [];
    
    Object.keys(productMaster).forEach(code => {
        const stock = stockData[code] || { stock: 0, safeStock: 10 };
        // 旧形式（alertThreshold）から新形式（safeStock）への対応
        const safeStock = stock.safeStock !== undefined ? stock.safeStock : (stock.alertThreshold || 10);
        
        if (stock.stock < safeStock) {
            lowItems.push({
                code: code,
                name: productMaster[code].name,
                stock: stock.stock,
                safeStock: safeStock
            });
        }
    });
    
    return lowItems;
}

// ========================================
// 安心在庫警告ダイアログの作成
// ========================================

function createSafeStockWarningDialog() {
    const dialog = document.createElement('div');
    dialog.id = 'safe-stock-warning-dialog';
    dialog.className = 'dialog-overlay hidden';
    dialog.innerHTML = `
        <div class="dialog" style="max-width: 380px;">
            <div class="dialog-header" style="background: #f44336; color: white; padding: 20px; text-align: center;">
                <span style="font-size: 3rem;">⚠️</span>
                <div style="font-size: 1.3rem; font-weight: bold; margin-top: 12px;">安心在庫を下回りました</div>
            </div>
            <div class="dialog-body" style="padding: 24px; text-align: center;">
                <div id="safe-stock-warning-product" style="font-size: 1.4rem; font-weight: bold; color: #c62828; margin-bottom: 16px;"></div>
                <div style="background: #ffebee; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
                    <div style="font-size: 0.9rem; color: #666; margin-bottom: 8px;">現在庫 / 安心在庫</div>
                    <div id="safe-stock-warning-numbers" style="font-size: 1.5rem; font-weight: bold; color: #c62828;"></div>
                </div>
                <div style="background: #fff3e0; border: 2px solid #ff9800; border-radius: 8px; padding: 16px; font-size: 1.1rem; font-weight: bold; color: #e65100;">
                    📞 工藤へ報告してください
                </div>
            </div>
            <div class="dialog-footer" style="padding: 16px; text-align: center; border-top: 1px solid #eee;">
                <button id="btn-safe-stock-warning-ok" class="btn-primary" style="padding: 14px 40px; font-size: 1.1rem;">
                    確認しました
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
    
    document.getElementById('btn-safe-stock-warning-ok').addEventListener('click', () => {
        dialog.classList.add('hidden');
    });
}

function showSafeStockWarning(productName, currentStock, safeStock) {
    const dialog = document.getElementById('safe-stock-warning-dialog');
    document.getElementById('safe-stock-warning-product').textContent = productName;
    document.getElementById('safe-stock-warning-numbers').textContent = `${currentStock}個 / ${safeStock}個`;
    dialog.classList.remove('hidden');
}

// ========================================
// 読み取り確認ダイアログの作成
// ========================================

let pendingScanData = null;

function createScanConfirmDialog() {
    const dialog = document.createElement('div');
    dialog.id = 'scan-confirm-dialog';
    dialog.className = 'dialog-overlay hidden';
    dialog.innerHTML = `
        <div class="dialog" style="max-width: 350px;">
            <div class="dialog-header" id="scan-confirm-header" style="background: #4CAF50; color: white; padding: 16px; text-align: center;">
                <span style="font-size: 2rem;" id="scan-confirm-icon">📦</span>
                <div style="font-size: 1.2rem; font-weight: bold; margin-top: 8px;">読み取り確認</div>
            </div>
            <div class="dialog-body" style="padding: 20px; text-align: center;">
                <div id="scan-confirm-product" style="font-size: 1.5rem; font-weight: bold; color: #8B0000; margin-bottom: 12px;"></div>
                <div id="scan-confirm-qr" style="font-family: monospace; font-size: 1rem; color: #666; margin-bottom: 8px;"></div>
                <div id="scan-confirm-quantity" style="font-size: 0.9rem; color: #999; margin-bottom: 12px;"></div>
                <div id="scan-confirm-stock" class="stock-display" style="display: none;">
                    <span class="stock-label">現在庫:</span>
                    <span class="stock-value" id="scan-confirm-stock-value">0</span>
                </div>
            </div>
            <div class="dialog-footer" style="display: flex; gap: 12px; padding: 16px;">
                <button id="btn-scan-cancel" class="btn-secondary" style="flex: 1; padding: 12px;">キャンセル</button>
                <button id="btn-scan-confirm" class="btn-primary" style="flex: 1; padding: 12px;">登録する</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
    
    document.getElementById('btn-scan-cancel').addEventListener('click', cancelScanConfirm);
    document.getElementById('btn-scan-confirm').addEventListener('click', confirmScanRegister);
}

function showScanConfirmDialog(scanData) {
    pendingScanData = scanData;
    
    const header = document.getElementById('scan-confirm-header');
    const icon = document.getElementById('scan-confirm-icon');
    
    if (session.mode === 'delivery') {
        header.style.background = '#4CAF50';
        icon.textContent = '📦';
    } else if (session.mode === 'shipment') {
        header.style.background = '#FF9800';
        icon.textContent = '🚚';
    } else {
        header.style.background = '#2196F3';
        icon.textContent = '📋';
    }
    
    document.getElementById('scan-confirm-product').textContent = scanData.productName;
    document.getElementById('scan-confirm-qr').textContent = scanData.qrCode;
    
    const product = productMaster[scanData.productCode];
    const quantity = product ? product.quantity : 0;
    document.getElementById('scan-confirm-quantity').textContent = `入数: ${quantity}個`;
    
    // 在庫表示（納品・出庫モードのみ）
    const stockDisplay = document.getElementById('scan-confirm-stock');
    if (session.mode === 'delivery' || session.mode === 'shipment') {
        const currentStock = getStock(scanData.productCode);
        const stockValue = document.getElementById('scan-confirm-stock-value');
        stockValue.textContent = `${currentStock}個`;
        
        const safeStock = getSafeStock(scanData.productCode);
        if (currentStock < safeStock) {
            stockValue.className = 'stock-value low';
        } else {
            stockValue.className = 'stock-value normal';
        }
        stockDisplay.style.display = 'flex';
    } else {
        stockDisplay.style.display = 'none';
    }
    
    document.getElementById('scan-confirm-dialog').classList.remove('hidden');
}

function cancelScanConfirm() {
    document.getElementById('scan-confirm-dialog').classList.add('hidden');
    pendingScanData = null;
    scanPaused = false;
}

async function confirmScanRegister() {
    if (pendingScanData) {
        // セッションに追加
        session.scannedBoxes.push(pendingScanData);
        
        // 在庫更新（納品・出庫モードのみ）
        const product = productMaster[pendingScanData.productCode];
        const quantity = product ? product.quantity : 0;
        
        if (session.mode === 'delivery') {
            await updateStock(pendingScanData.productCode, quantity, 'add', `QR: ${pendingScanData.qrCode}`);
            showSuccessToast(`${pendingScanData.productName} を登録しました`);
        } else if (session.mode === 'shipment') {
            const result = await updateStockWithCheck(pendingScanData.productCode, quantity, `QR: ${pendingScanData.qrCode}`);
            showSuccessToast(`${pendingScanData.productName} を登録しました`);
            
            // 安心在庫を下回った場合は警告を表示
            if (result.belowSafeStock && result.justBecameLow) {
                setTimeout(() => {
                    showSafeStockWarning(result.productName, result.currentStock, result.safeStock);
                }, 500);
            }
        } else {
            showSuccessToast(`${pendingScanData.productName} を登録しました`);
        }
        
        // UI更新
        updateScanUI(pendingScanData);
    }
    
    document.getElementById('scan-confirm-dialog').classList.add('hidden');
    pendingScanData = null;
    scanPaused = false;
}

// ========================================
// 在庫管理関数
// ========================================

function getStock(productCode) {
    const stockData = JSON.parse(localStorage.getItem('omamori_stock') || '{}');
    return stockData[productCode] ? stockData[productCode].stock : 0;
}

function getSafeStock(productCode) {
    const stockData = JSON.parse(localStorage.getItem('omamori_stock') || '{}');
    if (stockData[productCode]) {
        // 旧形式（alertThreshold）から新形式（safeStock）への対応
        return stockData[productCode].safeStock !== undefined ? 
               stockData[productCode].safeStock : 
               (stockData[productCode].alertThreshold || 10);
    }
    return 10;
}

async function updateStock(productCode, quantity, operation, note) {
    const stockData = JSON.parse(localStorage.getItem('omamori_stock') || '{}');
    
    if (!stockData[productCode]) {
        stockData[productCode] = { stock: 0, safeStock: 10 };
    }
    
    if (operation === 'add') {
        stockData[productCode].stock += quantity;
        
        // 納品時は発注数量を自動減少
        await updateOrderQuantityOnDelivery(productCode, quantity);
    } else if (operation === 'remove') {
        stockData[productCode].stock = Math.max(0, stockData[productCode].stock - quantity);
    }
    
    localStorage.setItem('omamori_stock', JSON.stringify(stockData));
    
    // APIにも保存
    if (typeof isApiEnabled === 'function' && isApiEnabled()) {
        try {
            await updateSingleStockToApi(productCode, stockData[productCode].stock, stockData[productCode].safeStock);
        } catch (e) {
            console.error('APIへの在庫更新失敗:', e);
        }
    }
    
    // 履歴に追加
    await addStockHistory(operation === 'add' ? 'in' : 'out', productCode, quantity, note);
}

// 納品時に発注数量を自動減少させる
async function updateOrderQuantityOnDelivery(productCode, deliveredQuantity) {
    const orderData = JSON.parse(localStorage.getItem('omamori_orders') || '{}');
    
    // その商品の発注データがあるか確認
    if (!orderData[productCode]) {
        return; // 発注データがない場合は何もしない
    }
    
    // 発注済みの場合のみ処理
    if (orderData[productCode].ordered && orderData[productCode].quantity > 0) {
        // 発注数量を減少
        orderData[productCode].quantity = Math.max(0, orderData[productCode].quantity - deliveredQuantity);
        
        // 発注数量が0になったら未発注に変更
        if (orderData[productCode].quantity === 0) {
            orderData[productCode].ordered = false;
            orderData[productCode].deliveryDate = '';
        }
        
        localStorage.setItem('omamori_orders', JSON.stringify(orderData));
        
        // APIにも保存
        if (typeof isApiEnabled === 'function' && isApiEnabled()) {
            try {
                await updateSingleOrderToApi(
                    productCode,
                    orderData[productCode].ordered,
                    orderData[productCode].quantity,
                    orderData[productCode].deliveryDate
                );
            } catch (e) {
                console.error('APIへの発注更新失敗:', e);
            }
        }
    }
}

// 出庫時の在庫更新（安心在庫チェック付き）
async function updateStockWithCheck(productCode, quantity, note) {
    const stockData = JSON.parse(localStorage.getItem('omamori_stock') || '{}');
    
    if (!stockData[productCode]) {
        stockData[productCode] = { stock: 0, safeStock: 10 };
    }
    
    const beforeStock = stockData[productCode].stock;
    const safeStock = stockData[productCode].safeStock !== undefined ? 
                      stockData[productCode].safeStock : 
                      (stockData[productCode].alertThreshold || 10);
    
    stockData[productCode].stock = Math.max(0, stockData[productCode].stock - quantity);
    const afterStock = stockData[productCode].stock;
    
    localStorage.setItem('omamori_stock', JSON.stringify(stockData));
    
    // APIにも保存
    if (typeof isApiEnabled === 'function' && isApiEnabled()) {
        try {
            await updateSingleStockToApi(productCode, afterStock, safeStock);
        } catch (e) {
            console.error('APIへの在庫更新失敗:', e);
        }
    }
    
    // 履歴に追加
    await addStockHistory('out', productCode, quantity, note);
    
    // 安心在庫を下回ったかチェック
    const productName = productMaster[productCode] ? productMaster[productCode].name : productCode;
    
    if (afterStock < safeStock && beforeStock >= safeStock) {
        // 今回の出庫で安心在庫を下回った
        return {
            belowSafeStock: true,
            justBecameLow: true,
            productName: productName,
            currentStock: afterStock,
            safeStock: safeStock
        };
    } else if (afterStock < safeStock) {
        // 既に安心在庫を下回っていた
        return {
            belowSafeStock: true,
            justBecameLow: false,
            productName: productName,
            currentStock: afterStock,
            safeStock: safeStock
        };
    }
    
    return {
        belowSafeStock: false,
        productName: productName,
        currentStock: afterStock,
        safeStock: safeStock
    };
}

async function addStockHistory(type, productCode, quantity, note) {
    const productName = productMaster[productCode] ? productMaster[productCode].name : productCode;
    
    const record = {
        date: new Date().toLocaleString('ja-JP'),
        type: type,
        productCode: productCode,
        productName: productName,
        quantity: quantity,
        note: note || ''
    };
    
    // localStorageに保存
    const history = JSON.parse(localStorage.getItem('omamori_stock_history') || '[]');
    history.unshift(record);

    // 最大500件まで保存
    if (history.length > 500) {
        history.pop();
    }

    localStorage.setItem('omamori_stock_history', JSON.stringify(history));
    
    // APIにも保存
    if (typeof isApiEnabled === 'function' && isApiEnabled()) {
        try {
            await addHistoryRecordToApi(record);
        } catch (e) {
            console.error('APIへの履歴追加失敗:', e);
        }
    }
}

// ========================================
// CSV出力・共有ダイアログの作成
// ========================================

function createEmailDialog() {
    const dialog = document.createElement('div');
    dialog.id = 'email-dialog';
    dialog.className = 'dialog-overlay hidden';
    dialog.innerHTML = `
        <div class="dialog" style="max-width: 400px;">
            <div class="dialog-header" style="background: #8B0000; color: white; padding: 16px; text-align: center;">
                <div style="font-size: 1.2rem; font-weight: bold;">📤 CSV出力方法を選択</div>
            </div>
            <div class="dialog-body" style="padding: 20px;">
                <button id="btn-download-csv" class="btn-primary" style="width: 100%; padding: 16px; margin-bottom: 12px; font-size: 1rem;">
                    📥 ファイルをダウンロード
                </button>
                <button id="btn-share-csv" class="btn-secondary" style="width: 100%; padding: 16px; margin-bottom: 12px; font-size: 1rem;">
                    📤 共有（LINE・メール等）
                </button>
                <button id="btn-email-csv" class="btn-secondary" style="width: 100%; padding: 16px; font-size: 1rem;">
                    ✉️ メールで送信
                </button>
            </div>
            <div class="dialog-footer" style="padding: 16px; text-align: center; border-top: 1px solid #eee;">
                <button id="btn-email-cancel" class="btn-secondary" style="padding: 12px 32px;">キャンセル</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
    
    document.getElementById('btn-download-csv').addEventListener('click', downloadCsv);
    document.getElementById('btn-share-csv').addEventListener('click', shareCsv);
    document.getElementById('btn-email-csv').addEventListener('click', emailCsv);
    document.getElementById('btn-email-cancel').addEventListener('click', () => {
        document.getElementById('email-dialog').classList.add('hidden');
    });
}

function showExportOptions() {
    document.getElementById('email-dialog').classList.remove('hidden');
}

function downloadCsv() {
    const csv = generateCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = generateFilename();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    document.getElementById('email-dialog').classList.add('hidden');
    showSuccessToast('CSVをダウンロードしました');
}

async function shareCsv() {
    const csv = generateCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const file = new File([blob], generateFilename(), { type: 'text/csv' });
    
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({
                files: [file],
                title: 'お守り在庫管理データ',
                text: `${getModeText()}データ`
            });
            document.getElementById('email-dialog').classList.add('hidden');
        } catch (err) {
            if (err.name !== 'AbortError') {
                showSuccessToast('共有がキャンセルされました');
            }
        }
    } else {
        // 共有APIが使えない場合はダウンロード
        downloadCsv();
    }
}

function emailCsv() {
    const csv = generateCsv();
    const subject = encodeURIComponent(`お守り在庫管理 - ${getModeText()}データ`);
    const body = encodeURIComponent(`${getModeText()}データを添付します。\n\n---\n${csv}`);
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
    document.getElementById('email-dialog').classList.add('hidden');
}

function generateCsv() {
    let csv = '\uFEFF'; // BOM for Excel
    csv += `お守り在庫管理 - ${getModeText()}\n`;
    csv += `日時,${formatDateTime(session.startTime)}\n`;
    csv += `総箱数,${session.scannedBoxes.length}\n`;
    csv += `総数量,${calculateTotalQuantity()}\n\n`;
    
    csv += '商品コード,商品名,箱数,入数,合計\n';
    
    const summary = calculateSummary();
    Object.keys(summary).sort().forEach(code => {
        const item = summary[code];
        csv += `${code},${item.name},${item.boxCount},${item.quantity},${item.total}\n`;
    });
    
    csv += '\n詳細データ\n';
    csv += 'QRコード,商品コード,商品名,年度,箱番号,読み取り時刻\n';
    
    session.scannedBoxes.forEach(box => {
        csv += `${box.qrCode},${box.productCode},${box.productName},${box.year},${box.boxNumber},${formatDateTime(new Date(box.timestamp))}\n`;
    });
    
    return csv;
}

function generateFilename() {
    const date = formatDateForFilename(session.startTime);
    const mode = session.mode === 'delivery' ? 'nouhin' : (session.mode === 'shipment' ? 'shukko' : 'tanaoroshi');
    return `omamori_${mode}_${date}.csv`;
}

function getModeText() {
    if (session.mode === 'delivery') return '納品';
    if (session.mode === 'shipment') return '出庫';
    return '棚卸';
}

// ========================================
// モード確認ダイアログ
// ========================================

function showConfirmDialog(mode) {
    session.mode = mode;
    
    let modeText, modeDesc;
    
    if (mode === 'delivery') {
        modeText = '納品モード';
        modeDesc = '新しく届いたお守りの箱をスキャンして登録します。在庫数が自動で増加します。';
    } else if (mode === 'shipment') {
        modeText = '出庫モード';
        modeDesc = '出庫するお守りの箱をスキャンして登録します。在庫数が自動で減少します。';
    } else {
        modeText = '棚卸モード';
        modeDesc = '現在の在庫にあるお守りの箱をスキャンして確認します。在庫数は変わりません。';
    }
    
    elements.dialogModeIndicator.textContent = modeText;
    elements.dialogModeIndicator.className = `dialog-header ${mode}`;
    elements.dialogMessage.textContent = modeDesc;
    
    elements.confirmDialog.classList.remove('hidden');
}

function hideConfirmDialog() {
    elements.confirmDialog.classList.add('hidden');
}

// ========================================
// セッション管理
// ========================================

function startSession() {
    hideConfirmDialog();
    
    // セッション初期化
    session.startTime = new Date();
    session.scannedBoxes = [];
    session.duplicateAttempts = [];
    lastScannedQr = null;
    lastScanTime = 0;
    scanPaused = false;
    
    // UI更新
    let modeText, modeIcon;
    if (session.mode === 'delivery') {
        modeText = '📦 納品モード';
    } else if (session.mode === 'shipment') {
        modeText = '🚚 出庫モード';
    } else {
        modeText = '📋 棚卸モード';
    }
    
    elements.currentModeIndicator.textContent = modeText;
    elements.currentModeIndicator.className = `mode-indicator ${session.mode}`;
    
    elements.lastScan.innerHTML = '<span style="color:#999">QRコードをスキャンしてください</span>';
    elements.scanCount.textContent = '0';
    elements.scanList.innerHTML = '';
    elements.scanList.classList.add('hidden');
    elements.btnToggleList.textContent = '一覧表示';
    
    // 画面遷移
    showScreen('scan-screen');
    
    // QRスキャナー起動
    startQrScanner();
}

function confirmBackToMode() {
    if (session.scannedBoxes.length > 0) {
        if (!confirm('読み取りデータが失われます。戻りますか？')) {
            return;
        }
    }
    stopQrScanner();
    checkStockAlerts();
    showScreen('mode-select-screen');
}

function startNewSession() {
    checkStockAlerts();
    showScreen('mode-select-screen');
}

// 追加でQRを読み取る（同じセッションを継続）
function continueScan() {
    // スキャン画面に戻る
    showScreen('scan-screen');
    
    // QRスキャナーを再起動
    startQrScanner();
    
    showSuccessToast('スキャンを継続します');
}

// ========================================
// QRスキャナー
// ========================================

function startQrScanner() {
    const config = {
        fps: 10,
        qrbox: { width: 250, height: 250 },
        aspectRatio: 1.0
    };
    
    html5QrcodeScanner = new Html5Qrcode("qr-reader");
    
    html5QrcodeScanner.start(
        { facingMode: "environment" },
        config,
        onScanSuccess,
        onScanFailure
    ).catch(err => {
        console.error("カメラ起動エラー:", err);
        elements.lastScan.innerHTML = '<span style="color:#F44336">カメラを起動できませんでした。<br>カメラの権限を許可してください。</span>';
    });
}

function stopQrScanner() {
    if (html5QrcodeScanner) {
        html5QrcodeScanner.stop().then(() => {
            html5QrcodeScanner.clear();
        }).catch(err => {
            console.error("スキャナー停止エラー:", err);
        });
    }
}

function onScanSuccess(decodedText, decodedResult) {
    // 確認画面表示中はスキャンを無視
    if (scanPaused) return;
    
    // 連続読み取り防止（同じQRを1秒以内に再読み取りしない）
    const now = Date.now();
    if (decodedText === lastScannedQr && now - lastScanTime < 1000) {
        return;
    }
    lastScannedQr = decodedText;
    lastScanTime = now;
    
    // QRコードをパース
    const parsed = parseQrCode(decodedText);
    if (!parsed) {
        showErrorToast('無効なQRコードです');
        return;
    }
    
    // 重複チェック
    const isDuplicate = session.scannedBoxes.some(box => box.qrCode === decodedText);
    if (isDuplicate) {
        session.duplicateAttempts.push({
            qrCode: decodedText,
            timestamp: new Date()
        });
        showDuplicateDialog(parsed.productName);
        return;
    }
    
    // 確認ダイアログを表示
    scanPaused = true;
    showScanConfirmDialog({
        qrCode: decodedText,
        productCode: parsed.productCode,
        year: parsed.year,
        boxNumber: parsed.boxNumber,
        productName: parsed.productName,
        timestamp: new Date()
    });
}

function onScanFailure(error) {
    // スキャン失敗は無視（連続スキャン中は頻繁に発生する）
}

// ========================================
// QRコードパース
// ========================================

function parseQrCode(qrText) {
    // 形式: PRODUCTCODE-YY-NNNN
    const pattern = /^([A-Z]+)-(\d{2})-(\d{4})$/;
    const match = qrText.match(pattern);
    
    if (!match) return null;
    
    const productCode = match[1];
    const year = match[2];
    const boxNumber = match[3];
    
    // 商品マスタで確認
    const product = productMaster[productCode];
    if (!product) return null;
    
    return {
        productCode,
        year,
        boxNumber,
        productName: product.name
    };
}

// ========================================
// UI更新
// ========================================

function updateScanUI(scanData) {
    // 最後のスキャン表示
    elements.lastScan.innerHTML = `
        <strong>${scanData.productName}</strong><br>
        <span style="font-family: monospace; color: #666;">${scanData.qrCode}</span>
    `;
    
    // カウント更新
    elements.scanCount.textContent = session.scannedBoxes.length;
    
    // リスト更新
    const listItem = document.createElement('div');
    listItem.className = 'scan-list-item';
    listItem.innerHTML = `
        <span class="scan-list-name">${scanData.productName}</span>
        <span class="scan-list-qr">${scanData.qrCode}</span>
    `;
    elements.scanList.insertBefore(listItem, elements.scanList.firstChild);
}

function toggleScanList() {
    if (elements.scanList.classList.contains('hidden')) {
        elements.scanList.classList.remove('hidden');
        elements.btnToggleList.textContent = '一覧を閉じる';
    } else {
        elements.scanList.classList.add('hidden');
        elements.btnToggleList.textContent = '一覧表示';
    }
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    document.getElementById(screenId).classList.add('active');
}

// ========================================
// 重複警告ダイアログ
// ========================================

function showDuplicateDialog(productName) {
    elements.duplicateMessage.innerHTML = `
        <strong>${productName}</strong><br>
        この箱はすでに登録されています。<br>
        数量は増えません。
    `;
    elements.duplicateDialog.classList.remove('hidden');
}

function hideDuplicateDialog() {
    elements.duplicateDialog.classList.add('hidden');
}

// ========================================
// 読み取り終了・集計
// ========================================

function finishScan() {
    if (session.scannedBoxes.length === 0) {
        if (!confirm('読み取りデータがありません。終了しますか？')) {
            return;
        }
        stopQrScanner();
        checkStockAlerts();
        showScreen('mode-select-screen');
        return;
    }
    
    stopQrScanner();
    showSummary();
}

function showSummary() {
    // モード表示
    let modeText;
    if (session.mode === 'delivery') {
        modeText = '📦 納品';
        elements.summaryModeIndicator.className = 'summary-mode delivery';
    } else if (session.mode === 'shipment') {
        modeText = '🚚 出庫';
        elements.summaryModeIndicator.className = 'summary-mode shipment';
    } else {
        modeText = '📋 棚卸';
        elements.summaryModeIndicator.className = 'summary-mode inventory';
    }
    elements.summaryModeIndicator.textContent = modeText;
    
    // 日時
    elements.summaryDatetime.textContent = formatDateTime(session.startTime);
    
    // 総数
    elements.summaryTotalBoxes.textContent = session.scannedBoxes.length;
    elements.summaryTotalQuantity.textContent = calculateTotalQuantity();
    
    // 商品別集計
    const summary = calculateSummary();
    elements.summaryTbody.innerHTML = '';
    
    Object.keys(summary).sort((a, b) => {
        return summary[a].name.localeCompare(summary[b].name, 'ja');
    }).forEach(code => {
        const item = summary[code];
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${item.name}</td>
            <td>${item.boxCount}箱</td>
            <td>${item.quantity}個</td>
            <td><strong>${item.total}個</strong></td>
        `;
        elements.summaryTbody.appendChild(row);
    });
    
    // 在庫更新メッセージ
    const stockUpdateMessage = document.getElementById('stock-update-message');
    if (stockUpdateMessage) {
        if (session.mode === 'delivery') {
            stockUpdateMessage.textContent = '✅ 在庫が自動で増加しました';
            stockUpdateMessage.style.color = '#2e7d32';
        } else if (session.mode === 'shipment') {
            stockUpdateMessage.textContent = '✅ 在庫が自動で減少しました';
            stockUpdateMessage.style.color = '#e65100';
        } else {
            stockUpdateMessage.textContent = '';
        }
    }
    
    showScreen('summary-screen');
}

function calculateSummary() {
    const summary = {};
    
    session.scannedBoxes.forEach(box => {
        if (!summary[box.productCode]) {
            const product = productMaster[box.productCode];
            summary[box.productCode] = {
                name: box.productName,
                boxCount: 0,
                quantity: product ? product.quantity : 0,
                total: 0
            };
        }
        summary[box.productCode].boxCount++;
        summary[box.productCode].total = summary[box.productCode].boxCount * summary[box.productCode].quantity;
    });
    
    return summary;
}

function calculateTotalQuantity() {
    let total = 0;
    session.scannedBoxes.forEach(box => {
        const product = productMaster[box.productCode];
        if (product) {
            total += product.quantity;
        }
    });
    return total;
}

// ========================================
// トースト通知
// ========================================

function showSuccessToast(message) {
    elements.toastMessage.textContent = message;
    elements.successToast.classList.remove('hidden');
    elements.successToast.classList.add('show');
    
    setTimeout(() => {
        elements.successToast.classList.remove('show');
        elements.successToast.classList.add('hidden');
    }, 2000);
}

function showErrorToast(message) {
    elements.toastMessage.textContent = message;
    elements.successToast.style.background = '#F44336';
    elements.successToast.classList.remove('hidden');
    elements.successToast.classList.add('show');
    
    setTimeout(() => {
        elements.successToast.classList.remove('show');
        elements.successToast.classList.add('hidden');
        elements.successToast.style.background = '';
    }, 2000);
}

// ========================================
// ユーティリティ
// ========================================

function formatDateTime(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hour = String(d.getHours()).padStart(2, '0');
    const minute = String(d.getMinutes()).padStart(2, '0');
    return `${year}/${month}/${day} ${hour}:${minute}`;
}

function formatDateForFilename(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hour = String(d.getHours()).padStart(2, '0');
    const minute = String(d.getMinutes()).padStart(2, '0');
    return `${year}${month}${day}_${hour}${minute}`;
}

async function loadMasterFromStorage() {
    // APIが有効な場合はAPIから取得
    if (typeof isApiEnabled === 'function' && isApiEnabled()) {
        try {
            const master = await fetchMasterData();
            if (master) {
                productMaster = master;
                // 単価がない場合は追加
                Object.keys(productMaster).forEach(code => {
                    if (productMaster[code].unitPrice === undefined) {
                        productMaster[code].unitPrice = 0;
                    }
                });
                return;
            }
        } catch (e) {
            console.error('APIからのマスタ取得失敗:', e);
        }
    }
    
    // localStorageから取得（フォールバック）
    const stored = localStorage.getItem('omamori_master');
    if (stored) {
        try {
            productMaster = JSON.parse(stored);
            // 単価がない場合は追加
            Object.keys(productMaster).forEach(code => {
                if (productMaster[code].unitPrice === undefined) {
                    productMaster[code].unitPrice = 0;
                }
            });
        } catch (e) {
            productMaster = { ...DEFAULT_MASTER };
        }
    }
}
