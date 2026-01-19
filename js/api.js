/**
 * お守り在庫管理アプリ - API連携モジュール
 * 
 * Google Apps Script (GAS) と連携してデータを永続化します。
 * GASが設定されていない場合は、従来通りlocalStorageを使用します。
 */

// ========================================
// 設定
// ========================================

const API_CONFIG_KEY = 'omamori_api_config';

// API設定を取得
function getApiConfig() {
    const config = localStorage.getItem(API_CONFIG_KEY);
    if (config) {
        try {
            return JSON.parse(config);
        } catch (e) {
            return { url: '', enabled: false };
        }
    }
    return { url: '', enabled: false };
}

// API設定を保存
function saveApiConfig(url, enabled) {
    localStorage.setItem(API_CONFIG_KEY, JSON.stringify({ url, enabled }));
}

// APIが有効かどうか
function isApiEnabled() {
    const config = getApiConfig();
    return config.enabled && config.url && config.url.length > 0;
}

// ========================================
// API通信関数
// ========================================

/**
 * GETリクエストを送信
 */
async function apiGet(action, params = {}) {
    const config = getApiConfig();
    if (!config.enabled || !config.url) {
        throw new Error('API未設定');
    }
    
    const url = new URL(config.url);
    url.searchParams.append('action', action);
    for (const key in params) {
        url.searchParams.append(key, params[key]);
    }
    
    const response = await fetch(url.toString(), {
        method: 'GET',
        mode: 'cors'
    });
    
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    return await response.json();
}

/**
 * データ更新リクエストを送信
 * GASのCORS制限を回避するため、GETリクエストを使用
 * 
 * GETリクエストはプリフライトが発生しないため、CORSエラーを回避できる
 * データはURLパラメータとして送信
 */
async function apiPost(action, data = {}) {
    const config = getApiConfig();
    if (!config.enabled || !config.url) {
        throw new Error('API未設定');
    }
    
    try {
        // データをURLパラメータとしてエンコード
        const encodedData = encodeURIComponent(JSON.stringify(data));
        const url = `${config.url}?action=${action}&data=${encodedData}`;
        
        const response = await fetch(url, {
            method: 'GET',
            redirect: 'follow'
        });
        
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch (e) {
            // JSONパースに失敗してもリクエストは成功とみなす
            console.log('Response text:', text);
            return { success: true };
        }
    } catch (e) {
        console.error('APIエラー:', e);
        throw e;
    }
}

// ========================================
// データ操作関数（API/localStorage両対応）
// ========================================

/**
 * 商品マスタを取得
 */
async function fetchMasterData() {
    if (isApiEnabled()) {
        try {
            const result = await apiGet('getMaster');
            if (result.success) {
                // ローカルにもキャッシュ
                localStorage.setItem('omamori_master', JSON.stringify(result.data));
                return result.data;
            }
        } catch (e) {
            console.error('API取得エラー（マスタ）:', e);
            // フォールバック: ローカルデータを使用
        }
    }
    
    // localStorageから取得
    const stored = localStorage.getItem('omamori_master');
    if (stored) {
        try {
            return JSON.parse(stored);
        } catch (e) {
            return null;
        }
    }
    return null;
}

/**
 * 商品マスタを保存
 */
async function saveMasterDataToApi(master) {
    // 常にローカルにも保存
    localStorage.setItem('omamori_master', JSON.stringify(master));
    
    if (isApiEnabled()) {
        try {
            const result = await apiPost('saveMaster', { master });
            return result.success;
        } catch (e) {
            console.error('API保存エラー（マスタ）:', e);
            return false;
        }
    }
    return true;
}

/**
 * 在庫データを取得
 */
async function fetchStockData() {
    if (isApiEnabled()) {
        try {
            const result = await apiGet('getStock');
            if (result.success) {
                localStorage.setItem('omamori_stock', JSON.stringify(result.data));
                return result.data;
            }
        } catch (e) {
            console.error('API取得エラー（在庫）:', e);
        }
    }
    
    const stored = localStorage.getItem('omamori_stock');
    if (stored) {
        try {
            return JSON.parse(stored);
        } catch (e) {
            return {};
        }
    }
    return {};
}

/**
 * 在庫データを保存
 */
async function saveStockDataToApi(stock) {
    localStorage.setItem('omamori_stock', JSON.stringify(stock));
    
    if (isApiEnabled()) {
        try {
            const result = await apiPost('saveStock', { stock });
            return result.success;
        } catch (e) {
            console.error('API保存エラー（在庫）:', e);
            return false;
        }
    }
    return true;
}

/**
 * 単一の在庫を更新
 */
async function updateSingleStockToApi(productCode, stock, safeStock) {
    // ローカルも更新
    const stockData = JSON.parse(localStorage.getItem('omamori_stock') || '{}');
    stockData[productCode] = { stock, safeStock };
    localStorage.setItem('omamori_stock', JSON.stringify(stockData));
    
    if (isApiEnabled()) {
        try {
            const result = await apiPost('updateStock', { productCode, stock, safeStock });
            return result.success;
        } catch (e) {
            console.error('API更新エラー（在庫）:', e);
            return false;
        }
    }
    return true;
}

/**
 * 発注データを取得
 */
async function fetchOrdersData() {
    if (isApiEnabled()) {
        try {
            const result = await apiGet('getOrders');
            if (result.success) {
                localStorage.setItem('omamori_orders', JSON.stringify(result.data));
                return result.data;
            }
        } catch (e) {
            console.error('API取得エラー（発注）:', e);
        }
    }
    
    const stored = localStorage.getItem('omamori_orders');
    if (stored) {
        try {
            return JSON.parse(stored);
        } catch (e) {
            return {};
        }
    }
    return {};
}

/**
 * 発注データを保存
 */
async function saveOrdersDataToApi(orders) {
    localStorage.setItem('omamori_orders', JSON.stringify(orders));
    
    if (isApiEnabled()) {
        try {
            const result = await apiPost('saveOrders', { orders });
            return result.success;
        } catch (e) {
            console.error('API保存エラー（発注）:', e);
            return false;
        }
    }
    return true;
}

/**
 * 単一の発注を更新
 */
async function updateSingleOrderToApi(productCode, ordered, quantity, deliveryDate) {
    // ローカルも更新
    const orderData = JSON.parse(localStorage.getItem('omamori_orders') || '{}');
    orderData[productCode] = { ordered, quantity, deliveryDate };
    localStorage.setItem('omamori_orders', JSON.stringify(orderData));
    
    if (isApiEnabled()) {
        try {
            const result = await apiPost('updateOrder', { productCode, ordered, quantity, deliveryDate });
            return result.success;
        } catch (e) {
            console.error('API更新エラー（発注）:', e);
            return false;
        }
    }
    return true;
}

/**
 * 履歴データを取得
 */
async function fetchHistoryData(limit = 100) {
    if (isApiEnabled()) {
        try {
            const result = await apiGet('getHistory', { limit });
            if (result.success) {
                localStorage.setItem('omamori_stock_history', JSON.stringify(result.data));
                return result.data;
            }
        } catch (e) {
            console.error('API取得エラー（履歴）:', e);
        }
    }
    
    const stored = localStorage.getItem('omamori_stock_history');
    if (stored) {
        try {
            return JSON.parse(stored);
        } catch (e) {
            return [];
        }
    }
    return [];
}

/**
 * 履歴レコードを追加
 */
async function addHistoryRecordToApi(record) {
    // ローカルにも追加
    const history = JSON.parse(localStorage.getItem('omamori_stock_history') || '[]');
    history.unshift(record);
    // ローカルは100件まで
    if (history.length > 100) {
        history.length = 100;
    }
    localStorage.setItem('omamori_stock_history', JSON.stringify(history));
    
    if (isApiEnabled()) {
        try {
            const result = await apiPost('addHistory', { record });
            return result.success;
        } catch (e) {
            console.error('API追加エラー（履歴）:', e);
            return false;
        }
    }
    return true;
}

/**
 * 履歴をクリア
 */
async function clearHistoryDataToApi() {
    localStorage.setItem('omamori_stock_history', '[]');
    
    if (isApiEnabled()) {
        try {
            const result = await apiPost('clearHistory', {});
            return result.success;
        } catch (e) {
            console.error('API削除エラー（履歴）:', e);
            return false;
        }
    }
    return true;
}

/**
 * 全データを一括取得
 */
async function fetchAllData() {
    if (isApiEnabled()) {
        try {
            const result = await apiGet('getAll');
            if (result.success) {
                // ローカルにもキャッシュ
                if (result.data.master) {
                    localStorage.setItem('omamori_master', JSON.stringify(result.data.master));
                }
                if (result.data.stock) {
                    localStorage.setItem('omamori_stock', JSON.stringify(result.data.stock));
                }
                if (result.data.orders) {
                    localStorage.setItem('omamori_orders', JSON.stringify(result.data.orders));
                }
                if (result.data.history) {
                    localStorage.setItem('omamori_stock_history', JSON.stringify(result.data.history));
                }
                return result.data;
            }
        } catch (e) {
            console.error('API取得エラー（全データ）:', e);
        }
    }
    
    // localStorageから取得
    return {
        master: JSON.parse(localStorage.getItem('omamori_master') || 'null'),
        stock: JSON.parse(localStorage.getItem('omamori_stock') || '{}'),
        orders: JSON.parse(localStorage.getItem('omamori_orders') || '{}'),
        history: JSON.parse(localStorage.getItem('omamori_stock_history') || '[]')
    };
}

/**
 * API接続テスト
 */
async function testApiConnection(url) {
    try {
        const testUrl = new URL(url);
        testUrl.searchParams.append('action', 'ping');
        
        const response = await fetch(testUrl.toString(), {
            method: 'GET',
            mode: 'cors'
        });
        
        if (!response.ok) {
            return { success: false, error: `HTTP error: ${response.status}` };
        }
        
        const result = await response.json();
        return result;
    } catch (e) {
        return { success: false, error: e.toString() };
    }
}

/**
 * ローカルデータをAPIに同期
 */
async function syncLocalDataToApi() {
    if (!isApiEnabled()) {
        return { success: false, error: 'API未設定' };
    }
    
    try {
        // マスタデータ
        const master = JSON.parse(localStorage.getItem('omamori_master') || 'null');
        if (master) {
            await apiPost('saveMaster', { master });
        }
        
        // 在庫データ
        const stock = JSON.parse(localStorage.getItem('omamori_stock') || '{}');
        if (Object.keys(stock).length > 0) {
            await apiPost('saveStock', { stock });
        }
        
        // 発注データ
        const orders = JSON.parse(localStorage.getItem('omamori_orders') || '{}');
        if (Object.keys(orders).length > 0) {
            await apiPost('saveOrders', { orders });
        }
        
        // 履歴データ
        const history = JSON.parse(localStorage.getItem('omamori_stock_history') || '[]');
        for (const record of history) {
            await apiPost('addHistory', { record });
        }
        
        return { success: true, message: '同期完了' };
    } catch (e) {
        return { success: false, error: e.toString() };
    }
}
