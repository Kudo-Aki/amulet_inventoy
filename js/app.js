/**
 * お守り在庫管理アプリ - メインスクリプト
 * 
 * 機能:
 * - モード選択（納品/棚卸）
 * - QRコード連続読み取り
 * - 重複検知・警告
 * - 商品別集計
 * - CSV出力
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
    mode: null,           // 'delivery' or 'inventory'
    startTime: null,
    scannedBoxes: [],     // { qrCode, productCode, year, boxNumber, productName, timestamp }
    duplicateAttempts: [] // 重複読み取り試行ログ
};

// QRスキャナーインスタンス
let html5QrcodeScanner = null;

// 商品マスタ
let productMaster = { ...DEFAULT_MASTER };

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
    toastMessage: document.getElementById('toast-message')
};

// ========================================
// 初期化
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    loadMasterFromStorage();
});

function initEventListeners() {
    // モード選択ボタン
    elements.btnDelivery.addEventListener('click', () => showConfirmDialog('delivery'));
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
    elements.btnExportCsv.addEventListener('click', exportCsv);
    elements.btnNewSession.addEventListener('click', startNewSession);
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
    
    const modeText = mode === 'delivery' ? '納品モード' : '棚卸モード';
    const modeDesc = mode === 'delivery' 
        ? '新しく届いたお守りの箱をスキャンして登録します。'
        : '現在の在庫にあるお守りの箱をスキャンして確認します。';
    
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
    
    // UI更新
    const modeText = session.mode === 'delivery' ? '📦 納品モード' : '📋 棚卸モード';
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
    showScreen('mode-select-screen');
}

function startNewSession() {
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
    
    // セッションに追加
    const scanData = {
        qrCode: decodedText,
        productCode: parsed.productCode,
        year: parsed.year,
        boxNumber: parsed.boxNumber,
        productName: productName,
        timestamp: new Date().toISOString()
    };
    session.scannedBoxes.push(scanData);
    
    // UI更新
    updateScanUI(scanData);
    showSuccessToast(`${productName} を登録しました`);
}

function onScanFailure(error) {
    // 読み取り失敗は無視（連続スキャン中は頻繁に発生）
}

// ========================================
// QRコードパース
// ========================================

function parseQrCode(qrCode) {
    // フォーマット: [商品コード]-[年度(2桁)]-[箱連番(3桁)]
    // 例: HEALTH-25-001
    const regex = /^([A-Z]+)-(\d{2})-(\d{3})$/;
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
        <span class="product">${scanData.productName}</span>
        <span class="qr">${scanData.qrCode}</span>
    `;
    elements.scanList.insertBefore(listItem, elements.scanList.firstChild);
}

function showScanError(message, qrCode) {
    elements.lastScan.innerHTML = `
        <span style="color:#F44336">${message}</span>
        <span class="qr-code">${qrCode}</span>
    `;
    elements.lastScan.className = 'last-scan error';
}

function toggleScanList() {
    const isHidden = elements.scanList.classList.contains('hidden');
    if (isHidden) {
        elements.scanList.classList.remove('hidden');
        elements.btnToggleList.textContent = '一覧を閉じる';
    } else {
        elements.scanList.classList.add('hidden');
        elements.btnToggleList.textContent = '一覧表示';
    }
}

function showSuccessToast(message) {
    elements.toastMessage.textContent = message;
    elements.successToast.className = 'toast success';
    
    setTimeout(() => {
        elements.successToast.classList.add('hidden');
    }, 2000);
}

// ========================================
// 集計・終了処理
// ========================================

function finishScan() {
    if (session.scannedBoxes.length === 0) {
        alert('読み取りデータがありません');
        return;
    }
    
    stopQrScanner();
    
    // 集計
    const summary = calculateSummary();
    
    // UI更新
    const modeText = session.mode === 'delivery' ? '📦 納品' : '📋 棚卸';
    elements.summaryModeIndicator.textContent = modeText;
    elements.summaryModeIndicator.className = `mode-indicator ${session.mode}`;
    
    elements.summaryDatetime.textContent = formatDateTime(session.startTime);
    elements.summaryTotalBoxes.textContent = summary.totalBoxes;
    elements.summaryTotalQuantity.textContent = summary.totalQuantity;
    
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

function exportCsv() {
    const summary = calculateSummary();
    const modeText = session.mode === 'delivery' ? '納品' : '棚卸';
    
    // CSVヘッダー
    let csv = '\uFEFF'; // BOM for Excel
    csv += '商品コード,商品名,箱数,入数,合計数量\n';
    
    // データ行
    summary.products.forEach(product => {
        csv += `${product.code},${product.name},${product.boxes},${product.unitQuantity},${product.totalQuantity}\n`;
    });
    
    // 合計行
    csv += `合計,,${summary.totalBoxes},,${summary.totalQuantity}\n`;
    
    // ファイル名生成
    const dateStr = formatDateTimeForFilename(session.startTime);
    const filename = `omamori_${session.mode}_${dateStr}.csv`;
    
    // ダウンロード
    downloadFile(csv, filename, 'text/csv;charset=utf-8');
    
    showSuccessToast('CSVを出力しました');
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
    }
};
