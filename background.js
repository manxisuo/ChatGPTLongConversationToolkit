// Background Service Worker

const CHATGPT_HOSTS = ['chat.openai.com', 'chatgpt.com'];
const SNAPSHOT_DB_NAME = 'ChatGPTHistoryCleanerSnapshots';
const SNAPSHOT_DB_VERSION = 2;
const SNAPSHOT_STORE_NAME = 'collapsedGroups';
const SNAPSHOT_TURN_STORE_NAME = 'collapsedTurns';
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
  // 通知 popup（若已打开）同步更新轮数显示
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
        const store = db.createObjectStore(SNAPSHOT_STORE_NAME, { keyPath: 'groupId' });
        store.createIndex('conversationId', 'conversationId', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(SNAPSHOT_TURN_STORE_NAME)) {
        const turnStore = db.createObjectStore(SNAPSHOT_TURN_STORE_NAME, { keyPath: 'id' });
        turnStore.createIndex('groupId', 'groupId', { unique: false });
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

async function getSnapshot(groupId) {
  return withSnapshotStore('readonly', (store) => new Promise((resolve, reject) => {
    const request = store.get(groupId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  }));
}

async function deleteSnapshot(groupId) {
  await withSnapshotStore('readwrite', (store) => {
    store.delete(groupId);
  });
}

async function putSnapshotTurn(turnSnapshot) {
  await withSnapshotStoreByName(SNAPSHOT_TURN_STORE_NAME, 'readwrite', (store) => {
    store.put(turnSnapshot);
  });
}

async function getSnapshotTurns(groupId) {
  return withSnapshotStoreByName(SNAPSHOT_TURN_STORE_NAME, 'readonly', (store) => new Promise((resolve, reject) => {
    const request = store.index('groupId').getAll(groupId);
    request.onsuccess = () => {
      resolve((request.result || []).sort((a, b) => a.index - b.index));
    };
    request.onerror = () => reject(request.error);
  }));
}

async function deleteSnapshotTurns(groupId) {
  const turns = await getSnapshotTurns(groupId);
  await withSnapshotStoreByName(SNAPSHOT_TURN_STORE_NAME, 'readwrite', (store) => {
    turns.forEach((turn) => store.delete(turn.id));
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
  await Promise.all(snapshots.map(snapshot => deleteSnapshotTurns(snapshot.groupId)));
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
    deleteSnapshot(snapshot.groupId),
    deleteSnapshotTurns(snapshot.groupId)
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
    groupCount: snapshots.length,
    turnCount,
    roundCount: Math.floor(turnCount / 2)
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

// 扩展安装时的初始化
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // 设置默认配置
    chrome.storage.local.set({
      enabled: true,
      autoRemove: false,
      cleanupMode: 'safe',
      collapseOldMessages: true
    });
  }
});

// 切换到非 ChatGPT 标签时清除 badge
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!isChatGPTUrl(tab.url)) {
      chrome.action.setBadgeText({ text: '', tabId: activeInfo.tabId });
    }
  } catch (e) {
    // 标签可能已关闭
  }
});

// 处理来自 content script 或 popup 的消息
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
    // 通知 popup（若已打开）
    chrome.runtime.sendMessage({ action: 'domWarning', tabId }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'saveCollapsedSnapshot') {
    chrome.storage.local.get({ snapshotTtlDays: DEFAULT_SNAPSHOT_TTL_DAYS }, (settings) => {
      cleanupExpiredSnapshots(settings.snapshotTtlDays).catch(() => {});
    });
    putSnapshot({
      groupId: request.groupId,
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
    cleanupExpiredSnapshots(request.ttlDays).then((deletedGroups) => {
      sendResponse({ success: true, deletedGroups });
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

  if (request.action === 'saveCollapsedTurn') {
    putSnapshotTurn({
      id: `${request.groupId}:${request.index}`,
      groupId: request.groupId,
      index: request.index,
      html: request.html,
      createdAt: Date.now(),
      schemaVersion: 2
    }).then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      sendResponse({ success: false, message: error.message });
    });
    return true;
  }

  if (request.action === 'getCollapsedSnapshot') {
    Promise.all([
      getSnapshot(request.groupId),
      getSnapshotTurns(request.groupId)
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
      deleteSnapshot(request.groupId),
      deleteSnapshotTurns(request.groupId)
    ]).then(() => {
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

