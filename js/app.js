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
 * - 在庫不足アラート
 */

// ========================================
// グローバル変数・定数
// ========================================

// 商品マスタ（デフォルト値）
const DEFAULT_MASTER = {
    'HEALTH': { name: '健康守り', quantity: 50 },
    'MONEY': { name: '金運守り', quantity: 100 },
    'LOVE': { name: '縁結び守り', quantity: 80 },
    'TRAFFIC': { name: '交通安全守り', quantity: 60 },
    'STUDY': { name: '学業成就守り', quantity: 70 },
    'FAMILY': { name: '家内安全守り', quantity: 50 },
    'BUSINESS': { name: '商売繁盛守り', quantity: 60 },
    'CHILD': { name: '子授け守り', quantity: 40 },
    'RECOVERY': { name: '病気平癒守り', quantity: 50 },
    'LUCK': { name: '開運守り', quantity: 80 }
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

document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    loadMasterFromStorage();
    createScanConfirmDialog();
    createEmailDialog();
    checkStockAlerts();
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
    elements.btnNewSession.addEventListener('click', startNewSession);
}

// ========================================
// 在庫アラートチェック
// ========================================

function checkStockAlerts() {
    const lowItems = getLowStockItems();
    
    if (lowItems.length > 0) {
        elements.stockAlertBanner.classList.add('show');
        elements.alertText.textContent = `在庫不足: ${lowItems.length}種類のお守り`;
    } else {
        elements.stockAlertBanner.classList.remove('show');
    }
}

function getLowStockItems() {
    const stockData = JSON.parse(localStorage.getItem('omamori_stock') || '{}');
    const lowItems = [];
    
    Object.keys(productMaster).forEach(code => {
        const stock = stockData[code] || { stock: 0, alertThreshold: 10 };
        if (stock.stock <= stock.alertThreshold) {
            lowItems.push({
                code: code,
                name: productMaster[code].name,
                stock: stock.stock,
                threshold: stock.alertThreshold
            });
        }
    });
    
    return lowItems;
}

// ========================================
// 読み取り確認ダイアログの作成
// ========================================

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
                <button id="btn-scan-cancel" class="btn btn-secondary" style="flex: 1; padding: 14px; font-size: 1rem;">キャンセル</button>
                <button id="btn-scan-register" class="btn btn-primary" style="flex: 1; padding: 14px; font-size: 1rem; background: #4CAF50;">登録する</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
    
    // イベントリスナー
    document.getElementById('btn-scan-cancel').addEventListener('click', cancelScanConfirm);
    document.getElementById('btn-scan-register').addEventListener('click', confirmScanRegister);
}

// 確認ダイアログ用の一時データ
let pendingScanData = null;

function showScanConfirmDialog(scanData) {
    pendingScanData = scanData;
    scanPaused = true;
    
    const product = productMaster[scanData.productCode];
    const quantity = product ? product.quantity : '不明';
    
    // モードに応じてダイアログの色とアイコンを変更
    const header = document.getElementById('scan-confirm-header');
    const icon = document.getElementById('scan-confirm-icon');
    const registerBtn = document.getElementById('btn-scan-register');
    
    if (session.mode === 'delivery') {
        header.style.background = 'linear-gradient(135deg, #4CAF50 0%, #388E3C 100%)';
        icon.textContent = '📦';
        registerBtn.style.background = '#4CAF50';
        registerBtn.textContent = '登録する（在庫+）';
    } else if (session.mode === 'shipment') {
        header.style.background = 'linear-gradient(135deg, #FF5722 0%, #E64A19 100%)';
        icon.textContent = '🚚';
        registerBtn.style.background = '#FF5722';
        registerBtn.textContent = '登録する（在庫-）';
    } else {
        header.style.background = 'linear-gradient(135deg, #2196F3 0%, #1976D2 100%)';
        icon.textContent = '📋';
        registerBtn.style.background = '#2196F3';
        registerBtn.textContent = '登録する';
    }
    
    document.getElementById('scan-confirm-product').textContent = scanData.productName;
    document.getElementById('scan-confirm-qr').textContent = scanData.qrCode;
    document.getElementById('scan-confirm-quantity').textContent = `入数: ${quantity}個/箱`;
    
    // 在庫表示（納品・出庫モードのみ）
    const stockDisplay = document.getElementById('scan-confirm-stock');
    if (session.mode === 'delivery' || session.mode === 'shipment') {
        const currentStock = getStock(scanData.productCode);
        const stockValue = document.getElementById('scan-confirm-stock-value');
        stockValue.textContent = `${currentStock}個`;
        
        const stockData = JSON.parse(localStorage.getItem('omamori_stock') || '{}');
        const threshold = stockData[scanData.productCode] ? stockData[scanData.productCode].alertThreshold : 10;
        stockValue.className = currentStock <= threshold ? 'stock-value low' : 'stock-value normal';
        
        stockDisplay.style.display = 'flex';
    } else {
        stockDisplay.style.display = 'none';
    }
    
    document.getElementById('scan-confirm-dialog').classList.remove('hidden');
    
    // 振動フィードバック
    if (navigator.vibrate) {
        navigator.vibrate(50);
    }
}

function cancelScanConfirm() {
    document.getElementById('scan-confirm-dialog').classList.add('hidden');
    pendingScanData = null;
    scanPaused = false;
}

function confirmScanRegister() {
    if (pendingScanData) {
        // セッションに追加
        session.scannedBoxes.push(pendingScanData);
        
        // 在庫更新（納品・出庫モードのみ）
        const product = productMaster[pendingScanData.productCode];
        const quantity = product ? product.quantity : 0;
        
        if (session.mode === 'delivery') {
            updateStock(pendingScanData.productCode, quantity, 'add', `QR: ${pendingScanData.qrCode}`);
        } else if (session.mode === 'shipment') {
            updateStock(pendingScanData.productCode, quantity, 'remove', `QR: ${pendingScanData.qrCode}`);
        }
        
        // UI更新
        updateScanUI(pendingScanData);
        showSuccessToast(`${pendingScanData.productName} を登録しました`);
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

function updateStock(productCode, quantity, operation, note) {
    const stockData = JSON.parse(localStorage.getItem('omamori_stock') || '{}');
    
    if (!stockData[productCode]) {
        stockData[productCode] = { stock: 0, alertThreshold: 10 };
    }
    
    if (operation === 'add') {
        stockData[productCode].stock += quantity;
    } else if (operation === 'remove') {
        stockData[productCode].stock = Math.max(0, stockData[productCode].stock - quantity);
    }
    
    localStorage.setItem('omamori_stock', JSON.stringify(stockData));
    
    // 履歴に追加
    addStockHistory(operation === 'add' ? 'in' : 'out', productCode, quantity, note);
}

function addStockHistory(type, productCode, quantity, note) {
    const history = JSON.parse(localStorage.getItem('omamori_stock_history') || '[]');
    const productName = productMaster[productCode] ? productMaster[productCode].name : productCode;
    
    history.unshift({
        date: new Date().toLocaleString('ja-JP'),
        type: type,
        productCode: productCode,
        productName: productName,
        quantity: quantity,
        note: note || ''
    });

    // 最大500件まで保存
    if (history.length > 500) {
        history.pop();
    }

    localStorage.setItem('omamori_stock_history', JSON.stringify(history));
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
                <span style="font-size: 1.5rem;">📤</span>
                <div style="font-size: 1.1rem; font-weight: bold; margin-top: 4px;">CSV出力・共有</div>
            </div>
            <div class="dialog-body" style="padding: 20px;">
                <div style="margin-bottom: 16px;">
                    <button id="btn-download-csv" class="btn btn-primary" style="width: 100%; padding: 14px; font-size: 1rem;">
                        📥 ダウンロード
                    </button>
                    <p style="font-size: 0.85rem; color: #666; text-align: center; margin-top: 8px;">CSVファイルを端末に保存します</p>
                </div>
                <hr style="border: none; border-top: 1px solid #eee; margin: 16px 0;">
                <div id="share-section">
                    <button id="btn-share-csv" class="btn btn-secondary" style="width: 100%; padding: 14px; font-size: 1rem; background: #4CAF50; color: white; border: none;">
                        📤 共有する（LINE・メール・AirDropなど）
                    </button>
                    <p style="font-size: 0.85rem; color: #666; text-align: center; margin-top: 8px;">CSVファイルと集計結果を共有できます</p>
                </div>
                <div id="share-not-supported" style="display: none; text-align: center; color: #999; padding: 12px;">
                    <p style="font-size: 0.85rem;">※ このブラウザでは共有機能を利用できません</p>
                </div>
            </div>
            <div class="dialog-footer" style="padding: 16px; border-top: 1px solid #eee;">
                <button id="btn-close-email-dialog" class="btn btn-secondary" style="width: 100%; padding: 12px;">閉じる</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
    
    // イベントリスナー
    document.getElementById('btn-download-csv').addEventListener('click', () => {
        exportCsvDownload();
        document.getElementById('email-dialog').classList.add('hidden');
    });
    document.getElementById('btn-share-csv').addEventListener('click', shareCsvFile);
    document.getElementById('btn-close-email-dialog').addEventListener('click', () => {
        document.getElementById('email-dialog').classList.add('hidden');
    });
    
    // Web Share API対応チェック
    if (!navigator.share || !navigator.canShare) {
        document.getElementById('share-section').style.display = 'none';
        document.getElementById('share-not-supported').style.display = 'block';
    }
}

function showExportOptions() {
    document.getElementById('email-dialog').classList.remove('hidden');
}

// ========================================
// 画面遷移
// ========================================

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    document.getElementById(screenId).classList.add('active');
}

// ========================================
// モード選択・確認ダイアログ
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
    if (scanPaused) {
        return;
    }
    
    // 同じQRコードの連続読み取り防止（1.5秒以内）
    const now = Date.now();
    if (decodedText === lastScannedQr && (now - lastScanTime) < 1500) {
        return;
    }
    lastScannedQr = decodedText;
    lastScanTime = now;
    
    // QRコードのパース
    const parsed = parseQrCode(decodedText);
    
    if (!parsed) {
        showScanError('不明なQRコード形式です', decodedText);
        return;
    }
    
    // 重複チェック
    if (checkDuplicate(decodedText)) {
        showDuplicateWarning(decodedText, parsed);
        return;
    }
    
    // 商品情報取得
    const product = productMaster[parsed.productCode];
    const productName = product ? product.name : `不明(${parsed.productCode})`;
    
    // スキャンデータ作成
    const scanData = {
        qrCode: decodedText,
        productCode: parsed.productCode,
        year: parsed.year,
        boxNumber: parsed.boxNumber,
        productName: productName,
        timestamp: new Date().toISOString()
    };
    
    // 確認画面を表示
    showScanConfirmDialog(scanData);
}

function onScanFailure(error) {
    // 読み取り失敗は無視（連続スキャン中は頻繁に発生）
}

// ========================================
// QRコードパース
// ========================================

function parseQrCode(qrCode) {
    // フォーマット: [商品コード]-[年度(2桁)]-[箱連番(3〜4桁)]
    // 例: HEALTH-25-001 または HEALTH-25-0001
    const regex = /^([A-Z]+)-(\d{2})-(\d{3,4})$/;
    const match = qrCode.match(regex);
    
    if (!match) {
        return null;
    }
    
    return {
        productCode: match[1],
        year: match[2],
        boxNumber: match[3]
    };
}

// ========================================
// 重複検知
// ========================================

function checkDuplicate(qrCode) {
    return session.scannedBoxes.some(box => box.qrCode === qrCode);
}

function showDuplicateWarning(qrCode, parsed) {
    const product = productMaster[parsed.productCode];
    const productName = product ? product.name : parsed.productCode;
    
    elements.duplicateMessage.innerHTML = `
        <strong>${productName}</strong><br>
        <span style="font-family:monospace">${qrCode}</span>
    `;
    
    // 重複試行をログに記録
    session.duplicateAttempts.push({
        qrCode: qrCode,
        timestamp: new Date().toISOString()
    });
    
    elements.duplicateDialog.classList.remove('hidden');
    
    // 振動フィードバック（対応端末のみ）
    if (navigator.vibrate) {
        navigator.vibrate([100, 50, 100]);
    }
}

function hideDuplicateDialog() {
    elements.duplicateDialog.classList.add('hidden');
}

// ========================================
// エラー表示
// ========================================

function showScanError(message, qrCode) {
    elements.lastScan.innerHTML = `
        <span style="color:#F44336">${message}</span>
        <span class="qr-code" style="font-size:0.8rem">${qrCode}</span>
    `;
    elements.lastScan.className = 'last-scan error';
    
    if (navigator.vibrate) {
        navigator.vibrate([200, 100, 200]);
    }
}

// ========================================
// UI更新
// ========================================

function updateScanUI(scanData) {
    // 最後の読み取り結果
    elements.lastScan.innerHTML = `
        <span class="product-name">${scanData.productName}</span>
        <span class="qr-code">${scanData.qrCode}</span>
    `;
    elements.lastScan.className = 'last-scan success';
    
    // カウント更新
    elements.scanCount.textContent = session.scannedBoxes.length;
    
    // リストに追加
    const listItem = document.createElement('div');
    listItem.className = 'scan-list-item';
    listItem.innerHTML = `
        <span class="product-name">${scanData.productName}</span>
        <span class="qr-code">${scanData.qrCode}</span>
    `;
    elements.scanList.insertBefore(listItem, elements.scanList.firstChild);
}

function toggleScanList() {
    const isHidden = elements.scanList.classList.toggle('hidden');
    elements.btnToggleList.textContent = isHidden ? '一覧表示' : '一覧を隠す';
}

function showSuccessToast(message) {
    elements.toastMessage.textContent = message;
    elements.successToast.classList.add('show');
    
    setTimeout(() => {
        elements.successToast.classList.remove('show');
    }, 2000);
}

// ========================================
// 読み取り終了・集計
// ========================================

function finishScan() {
    if (session.scannedBoxes.length === 0) {
        alert('まだ何もスキャンされていません');
        return;
    }
    
    stopQrScanner();
    showSummary();
}

function showSummary() {
    const summary = calculateSummary();
    
    // UI更新
    let modeText;
    if (session.mode === 'delivery') {
        modeText = '📦 納品';
    } else if (session.mode === 'shipment') {
        modeText = '🚚 出庫';
    } else {
        modeText = '📋 棚卸';
    }
    
    elements.summaryModeIndicator.textContent = modeText;
    elements.summaryModeIndicator.className = `mode-indicator ${session.mode}`;
    
    elements.summaryDatetime.textContent = formatDateTime(session.startTime);
    elements.summaryTotalBoxes.textContent = summary.totalBoxes;
    elements.summaryTotalQuantity.textContent = summary.totalQuantity;
    
    // 在庫更新メッセージ
    const stockUpdateInfo = document.getElementById('stock-update-info');
    const stockUpdateMessage = document.getElementById('stock-update-message');
    
    if (session.mode === 'delivery') {
        stockUpdateInfo.style.display = 'block';
        stockUpdateInfo.style.background = '#e8f5e9';
        stockUpdateInfo.style.borderColor = '#4CAF50';
        stockUpdateMessage.style.color = '#2e7d32';
        stockUpdateMessage.textContent = `✅ 在庫が ${summary.totalQuantity}個 増加しました`;
    } else if (session.mode === 'shipment') {
        stockUpdateInfo.style.display = 'block';
        stockUpdateInfo.style.background = '#fff3e0';
        stockUpdateInfo.style.borderColor = '#FF9800';
        stockUpdateMessage.style.color = '#e65100';
        stockUpdateMessage.textContent = `📤 在庫が ${summary.totalQuantity}個 減少しました`;
    } else {
        stockUpdateInfo.style.display = 'none';
    }
    
    // テーブル生成
    elements.summaryTbody.innerHTML = '';
    summary.products.forEach(product => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${product.name}</td>
            <td>${product.boxes}</td>
            <td>${product.unitQuantity}</td>
            <td><strong>${product.totalQuantity}</strong></td>
        `;
        elements.summaryTbody.appendChild(row);
    });
    
    showScreen('summary-screen');
}

function calculateSummary() {
    const productCounts = {};
    
    session.scannedBoxes.forEach(box => {
        if (!productCounts[box.productCode]) {
            productCounts[box.productCode] = {
                code: box.productCode,
                name: box.productName,
                boxes: 0
            };
        }
        productCounts[box.productCode].boxes++;
    });
    
    const products = Object.values(productCounts).map(product => {
        const master = productMaster[product.code];
        const unitQuantity = master ? master.quantity : 0;
        return {
            code: product.code,
            name: product.name,
            boxes: product.boxes,
            unitQuantity: unitQuantity,
            totalQuantity: product.boxes * unitQuantity
        };
    }).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    
    const totalBoxes = products.reduce((sum, p) => sum + p.boxes, 0);
    const totalQuantity = products.reduce((sum, p) => sum + p.totalQuantity, 0);
    
    return { products, totalBoxes, totalQuantity };
}

// ========================================
// CSV出力
// ========================================

function generateCsvContent() {
    const summary = calculateSummary();
    
    // CSVヘッダー
    let csv = '\uFEFF'; // BOM for Excel
    csv += '商品コード,商品名,箱数,入数,合計数量\n';
    
    // データ行
    summary.products.forEach(product => {
        csv += `${product.code},${product.name},${product.boxes},${product.unitQuantity},${product.totalQuantity}\n`;
    });
    
    // 合計行
    csv += `合計,,${summary.totalBoxes},,${summary.totalQuantity}\n`;
    
    return csv;
}

function generateCsvFilename() {
    const dateStr = formatDateTimeForFilename(session.startTime);
    return `omamori_${session.mode}_${dateStr}.csv`;
}

function exportCsvDownload() {
    const csv = generateCsvContent();
    const filename = generateCsvFilename();
    
    // ダウンロード
    downloadFile(csv, filename, 'text/csv;charset=utf-8');
    
    showSuccessToast('CSVをダウンロードしました');
}

async function shareCsvFile() {
    const summary = calculateSummary();
    let modeText;
    if (session.mode === 'delivery') {
        modeText = '納品';
    } else if (session.mode === 'shipment') {
        modeText = '出庫';
    } else {
        modeText = '棚卸';
    }
    const dateStr = formatDateTime(session.startTime);
    const filename = generateCsvFilename();
    
    // CSVファイルを作成
    const csvContent = generateCsvContent();
    const csvBlob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    const csvFile = new File([csvBlob], filename, { type: 'text/csv' });
    
    // 共有テキストを作成
    let shareText = `お守り在庫管理 ${modeText}結果\n`;
    shareText += `日時: ${dateStr}\n\n`;
    shareText += `【集計結果】\n`;
    shareText += `総箱数: ${summary.totalBoxes}箱\n`;
    shareText += `総数量: ${summary.totalQuantity}個\n\n`;
    shareText += `【商品別内訳】\n`;
    
    summary.products.forEach(product => {
        shareText += `${product.name}: ${product.boxes}箱 × ${product.unitQuantity}個 = ${product.totalQuantity}個\n`;
    });
    
    // Web Share APIで共有
    try {
        const shareData = {
            title: `お守り在庫管理 ${modeText}結果`,
            text: shareText,
            files: [csvFile]
        };
        
        // ファイル共有がサポートされているか確認
        if (navigator.canShare && navigator.canShare(shareData)) {
            await navigator.share(shareData);
            document.getElementById('email-dialog').classList.add('hidden');
            showSuccessToast('共有しました');
        } else {
            // ファイル共有がサポートされていない場合はテキストのみ共有
            const textOnlyData = {
                title: `お守り在庫管理 ${modeText}結果`,
                text: shareText
            };
            await navigator.share(textOnlyData);
            document.getElementById('email-dialog').classList.add('hidden');
            showSuccessToast('共有しました（テキストのみ）');
            // CSVもダウンロード
            exportCsvDownload();
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            // ユーザーがキャンセルした場合
            console.log('共有がキャンセルされました');
        } else {
            console.error('共有エラー:', err);
            alert('共有に失敗しました。ダウンロードをお試しください。');
        }
    }
}

// 従来のexportCsv関数（互換性のため残す）
function exportCsv() {
    showExportOptions();
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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

function formatDateTimeForFilename(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hour = String(d.getHours()).padStart(2, '0');
    const minute = String(d.getMinutes()).padStart(2, '0');
    return `${year}${month}${day}_${hour}${minute}`;
}

// ========================================
// マスタ管理
// ========================================

function loadMasterFromStorage() {
    const stored = localStorage.getItem('omamori_master');
    if (stored) {
        try {
            productMaster = JSON.parse(stored);
        } catch (e) {
            console.error('マスタ読み込みエラー:', e);
            productMaster = { ...DEFAULT_MASTER };
        }
    }
}

function saveMasterToStorage() {
    localStorage.setItem('omamori_master', JSON.stringify(productMaster));
}

// デバッグ用：コンソールからマスタを確認・更新可能
window.omamoriApp = {
    getSession: () => session,
    getMaster: () => productMaster,
    setMaster: (master) => {
        productMaster = master;
        saveMasterToStorage();
    },
    resetMaster: () => {
        productMaster = { ...DEFAULT_MASTER };
        saveMasterToStorage();
    },
    getStock: getStock,
    updateStock: updateStock,
    checkStockAlerts: checkStockAlerts
};
