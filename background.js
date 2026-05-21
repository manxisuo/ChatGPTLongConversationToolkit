// Background Service Worker

const CHATGPT_HOSTS = ['chat.openai.com', 'chatgpt.com'];
const SNAPSHOT_DB_NAME = 'ChatGPTHistoryCleanerSnapshots';
const SNAPSHOT_DB_VERSION = 3;
const SNAPSHOT_STORE_NAME = 'conversationSnapshots';
const SNAPSHOT_TURN_STORE_NAME = 'conversationSnapshotTurns';
const DEFAULT_SNAPSHOT_TTL_DAYS = 30;

function isChatGPTUrl(url) {
  if (!url) return false;
  return CHATGPT_HOSTS.some(host => url.includes(host));
}

function normalizeRoundStats(input) {
  if (typeof input === 'number') {
    return { visibleRounds: input, totalRounds: input };
  }
  const visibleRounds = input?.visibleRounds ?? input?.rounds ?? 0;
  const totalRounds = input?.totalRounds ?? visibleRounds;
  return { visibleRounds, totalRounds };
}

function setBadge(tabId, statsInput) {
  const stats = normalizeRoundStats(statsInput);
  const text = stats.visibleRounds > 0 ? (stats.visibleRounds > 999 ? '999+' : String(stats.visibleRounds)) : '';
  chrome.action.setBadgeText({ text, tabId });
  if (text) {
    chrome.action.setBadgeBackgroundColor({ color: '#667eea', tabId });
    chrome.action.setTitle({
      title: chrome.i18n.getMessage('badgeTitle', [
        String(stats.visibleRounds),
        String(stats.totalRounds)
      ]),
      tabId
    });
  } else {
    chrome.action.setTitle({
      title: chrome.i18n.getMessage('extensionName'),
      tabId
    });
  }
  chrome.runtime.sendMessage({
    action: 'badgeUpdated',
    rounds: stats.visibleRounds,
    totalRounds: stats.totalRounds,
    stats,
    tabId
  }).catch(() => {});
}

function openSnapshotDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SNAPSHOT_DB_NAME, SNAPSHOT_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE_NAME)) {
        const store = db.createObjectStore(SNAPSHOT_STORE_NAME, { keyPath: 'conversationId' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(SNAPSHOT_TURN_STORE_NAME)) {
        const turnStore = db.createObjectStore(SNAPSHOT_TURN_STORE_NAME, { keyPath: 'id' });
        turnStore.createIndex('conversationId', 'conversationId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withSnapshotStore(mode, callback) {
  const db = await openSnapshotDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(SNAPSHOT_STORE_NAME, mode);
      const store = transaction.objectStore(SNAPSHOT_STORE_NAME);
      const result = callback(store);

      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

async function putSnapshot(snapshot) {
  await withSnapshotStore('readwrite', (store) => {
    store.put(snapshot);
  });
}

async function getSnapshot(conversationId) {
  return withSnapshotStore('readonly', (store) => new Promise((resolve, reject) => {
    const request = store.get(conversationId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  }));
}

async function deleteSnapshot(conversationId) {
  await withSnapshotStore('readwrite', (store) => {
    store.delete(conversationId);
  });
}

async function putSnapshotTurn(turnSnapshot) {
  await withSnapshotStoreByName(SNAPSHOT_TURN_STORE_NAME, 'readwrite', (store) => {
    store.put(turnSnapshot);
  });
}

async function getSnapshotTurns(conversationId) {
  return withSnapshotStoreByName(SNAPSHOT_TURN_STORE_NAME, 'readonly', (store) => new Promise((resolve, reject) => {
    const request = store.index('conversationId').getAll(conversationId);
    request.onsuccess = () => {
      resolve((request.result || []).sort((a, b) => a.index - b.index));
    };
    request.onerror = () => reject(request.error);
  }));
}

async function deleteSnapshotTurns(conversationId) {
  const turns = await getSnapshotTurns(conversationId);
  await withSnapshotStoreByName(SNAPSHOT_TURN_STORE_NAME, 'readwrite', (store) => {
    turns.forEach((turn) => store.delete(turn.id));
  });
}

async function deleteSnapshotTurnsFromIndex(conversationId, startIndex) {
  const turns = await getSnapshotTurns(conversationId);
  const removableTurns = turns.filter((turn) => turn.index >= startIndex);
  await withSnapshotStoreByName(SNAPSHOT_TURN_STORE_NAME, 'readwrite', (store) => {
    removableTurns.forEach((turn) => store.delete(turn.id));
  });
}

async function getAllSnapshots() {
  return withSnapshotStore('readonly', (store) => new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  }));
}

async function clearAllSnapshots() {
  const snapshots = await getAllSnapshots();
  await Promise.all(snapshots.map(snapshot => deleteSnapshotTurns(snapshot.conversationId)));
  await withSnapshotStore('readwrite', (store) => {
    store.clear();
  });
}

async function cleanupExpiredSnapshots(ttlDays) {
  const days = Number(ttlDays) > 0 ? Number(ttlDays) : DEFAULT_SNAPSHOT_TTL_DAYS;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const snapshots = await getAllSnapshots();
  const expired = snapshots.filter(snapshot => (snapshot.updatedAt || snapshot.createdAt || 0) < cutoff);
  await Promise.all(expired.map(snapshot => Promise.all([
    deleteSnapshot(snapshot.conversationId),
    deleteSnapshotTurns(snapshot.conversationId)
  ])));
  return expired.length;
}

async function getSnapshotStats() {
  const snapshots = await getAllSnapshots();
  let turnCount = 0;
  for (const snapshot of snapshots) {
    turnCount += snapshot.turnCount || 0;
  }
  return {
    conversationCount: snapshots.length,
    turnCount,
    roundCount: Math.floor(turnCount / 2)
  };
}

async function listConversationSnapshots() {
  const snapshots = await getAllSnapshots();
  return snapshots
    .map(snapshot => ({
      conversationId: snapshot.conversationId,
      turnCount: snapshot.turnCount || 0,
      roundCount: snapshot.roundCount || Math.floor((snapshot.turnCount || 0) / 2),
      createdAt: snapshot.createdAt || null,
      updatedAt: snapshot.updatedAt || null
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function getConversationSnapshotDetail(conversationId) {
  const [snapshot, turns] = await Promise.all([
    getSnapshot(conversationId),
    getSnapshotTurns(conversationId)
  ]);
  if (!snapshot) return null;
  return {
    ...snapshot,
    html: turns.map(turn => turn.html),
    turns
  };
}

async function withSnapshotStoreByName(storeName, mode, callback) {
  const db = await openSnapshotDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const result = callback(store);

      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

// 鎵╁睍瀹夎鏃剁殑鍒濆鍖?
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // 璁剧疆榛樿閰嶇疆
    chrome.storage.local.set({
      enabled: true,
      autoRemove: false,
      cleanupMode: 'performance',
      collapseOldMessages: true
    });
  } else if (details.reason === 'update') {
    chrome.storage.local.get({ cleanupMode: null }, (settings) => {
      if (!settings.cleanupMode) {
        chrome.storage.local.set({
          cleanupMode: 'performance',
          collapseOldMessages: true
        });
      }
    });
  }
});

// 鍒囨崲鍒伴潪 ChatGPT 鏍囩鏃舵竻闄?badge
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!isChatGPTUrl(tab.url)) {
      chrome.action.setBadgeText({ text: '', tabId: activeInfo.tabId });
    }
  } catch (e) {
    // 鏍囩鍙兘宸插叧闂?
  }
});

// 澶勭悊鏉ヨ嚜 content script 鎴?popup 鐨勬秷鎭?
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'updateBadge') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      setBadge(tabId, request.stats ?? request.rounds ?? 0);
    }
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'domWarning') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      chrome.action.setBadgeText({ text: '!', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId });
      chrome.action.setTitle({
        title: chrome.i18n.getMessage('domWarningTitle'),
        tabId
      });
    }
    // 閫氱煡 popup锛堣嫢宸叉墦寮€锛?
    chrome.runtime.sendMessage({ action: 'domWarning', tabId }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'saveCollapsedSnapshot') {
    chrome.storage.local.get({ snapshotTtlDays: DEFAULT_SNAPSHOT_TTL_DAYS }, (settings) => {
      cleanupExpiredSnapshots(settings.snapshotTtlDays).catch(() => {});
    });
    putSnapshot({
      conversationId: request.conversationId,
      turnCount: request.turnCount,
      roundCount: request.roundCount,
      html: request.html,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      schemaVersion: 1
    }).then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      sendResponse({ success: false, message: error.message });
    });
    return true;
  }

  if (request.action === 'cleanupExpiredSnapshots') {
    cleanupExpiredSnapshots(request.ttlDays).then((deletedSnapshots) => {
      sendResponse({ success: true, deletedSnapshots });
    }).catch((error) => {
      sendResponse({ success: false, message: error.message });
    });
    return true;
  }

  if (request.action === 'clearAllSnapshots') {
    clearAllSnapshots().then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      sendResponse({ success: false, message: error.message });
    });
    return true;
  }

  if (request.action === 'getSnapshotStats') {
    getSnapshotStats().then((stats) => {
      sendResponse({ success: true, stats });
    }).catch((error) => {
      sendResponse({ success: false, message: error.message });
    });
    return true;
  }

  if (request.action === 'listConversationSnapshots') {
    listConversationSnapshots().then((snapshots) => {
      sendResponse({ success: true, snapshots });
    }).catch((error) => {
      sendResponse({ success: false, message: error.message });
    });
    return true;
  }

  if (request.action === 'getConversationSnapshotDetail') {
    getConversationSnapshotDetail(request.conversationId).then((snapshot) => {
      sendResponse({ success: true, snapshot });
    }).catch((error) => {
      sendResponse({ success: false, message: error.message });
    });
    return true;
  }

  if (request.action === 'saveCollapsedTurn') {
    putSnapshotTurn({
      id: `${request.conversationId}:${request.index}`,
      conversationId: request.conversationId,
      index: request.index,
      html: request.html,
      createdAt: Date.now(),
      schemaVersion: 1
    }).then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      sendResponse({ success: false, message: error.message });
    });
    return true;
  }

  if (request.action === 'getCollapsedSnapshot') {
    Promise.all([
      getSnapshot(request.conversationId),
      getSnapshotTurns(request.conversationId)
    ]).then(([snapshot, turns]) => {
      if (snapshot && turns.length > 0) {
        snapshot.html = turns.map((turn) => turn.html);
        snapshot.turnCount = turns.length;
        snapshot.roundCount = Math.floor(turns.length / 2);
      }
      sendResponse({ success: true, snapshot });
    }).catch((error) => {
      sendResponse({ success: false, message: error.message });
    });
    return true;
  }

  if (request.action === 'deleteCollapsedSnapshot') {
    Promise.all([
      deleteSnapshot(request.conversationId),
      deleteSnapshotTurns(request.conversationId)
    ]).then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      sendResponse({ success: false, message: error.message });
    });
    return true;
  }

  if (request.action === 'deleteCollapsedTurnsFromIndex') {
    deleteSnapshotTurnsFromIndex(request.conversationId, request.startIndex).then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      sendResponse({ success: false, message: error.message });
    });
    return true;
  }

  if (request.action === 'getStorage') {
    chrome.storage.local.get(request.keys, (result) => {
      sendResponse(result);
    });
    return true;
  } else if (request.action === 'setStorage') {
    chrome.storage.local.set(request.data, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

