// Background Service Worker

const CHATGPT_HOSTS = ['chat.openai.com', 'chatgpt.com'];

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

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      enabled: true,
      autoRemove: false,
      cleanupMode: 'safe',
      collapseOldMessages: true
    });
  } else if (details.reason === 'update') {
    chrome.storage.local.get({ cleanupMode: null }, (settings) => {
      if (!settings.cleanupMode) {
        chrome.storage.local.set({
          cleanupMode: 'safe',
          collapseOldMessages: true
        });
      }
    });
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!isChatGPTUrl(tab.url)) {
      chrome.action.setBadgeText({ text: '', tabId: activeInfo.tabId });
    }
  } catch (e) {
    // The activated tab may have closed.
  }
});

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
    chrome.runtime.sendMessage({ action: 'domWarning', tabId }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'getStorage') {
    chrome.storage.local.get(request.keys, (result) => {
      sendResponse(result);
    });
    return true;
  }

  if (request.action === 'setStorage') {
    chrome.storage.local.set(request.data, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});
