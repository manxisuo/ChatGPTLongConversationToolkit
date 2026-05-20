const CLEANUP_MODES = {
  SAFE: 'safe',
  PERFORMANCE: 'performance',
  REMOVE: 'remove'
};

function getMessage(key, substitutions = []) {
  return chrome.i18n.getMessage(key, substitutions);
}

function initI18n() {
  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach(element => {
    const key = element.getAttribute('data-i18n');
    const message = getMessage(key);
    if (message) {
      element.textContent = message;
    }
  });
  document.title = getMessage('title');
}

initI18n();

function showStatus(message, type = 'info', persistent = false) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message;
  statusEl.className = `status show ${type}`;
  if (!persistent) {
    setTimeout(() => {
      statusEl.classList.remove('show');
    }, 5000);
  }
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function getSelectedMode() {
  return document.querySelector('input[name="cleanupMode"]:checked')?.value || CLEANUP_MODES.SAFE;
}

function setSelectedMode(cleanupMode) {
  const mode = Object.values(CLEANUP_MODES).includes(cleanupMode)
    ? cleanupMode
    : CLEANUP_MODES.SAFE;
  const input = document.querySelector(`input[name="cleanupMode"][value="${mode}"]`);
  if (input) {
    input.checked = true;
  }
}

function readSettingsFromForm() {
  return {
    keepRounds: parseInt(document.getElementById('keepRounds').value, 10),
    autoMaintain: document.getElementById('autoMaintain').checked,
    cleanupMode: getSelectedMode()
  };
}

function resolveCleanupMode(result) {
  if (result.cleanupMode) {
    return result.cleanupMode;
  }
  return result.collapseOldMessages === false ? CLEANUP_MODES.REMOVE : CLEANUP_MODES.SAFE;
}

async function loadSettings() {
  const result = await chrome.storage.local.get({
    keepRounds: 10,
    autoMaintain: false,
    cleanupMode: CLEANUP_MODES.SAFE,
    collapseOldMessages: true
  });
  document.getElementById('keepRounds').value = result.keepRounds;
  document.getElementById('autoMaintain').checked = result.autoMaintain;
  setSelectedMode(resolveCleanupMode(result));
}

async function saveSettings() {
  const settings = readSettingsFromForm();
  if (settings.keepRounds < 1 || settings.keepRounds > 100 || Number.isNaN(settings.keepRounds)) {
    showStatus(getMessage('errorKeepRoundsRange'), 'error');
    return null;
  }

  await chrome.storage.local.set({
    keepRounds: settings.keepRounds,
    autoMaintain: settings.autoMaintain,
    cleanupMode: settings.cleanupMode,
    collapseOldMessages: settings.cleanupMode !== CLEANUP_MODES.REMOVE
  });
  return settings;
}

async function notifyAutoMaintainChange(settings = readSettingsFromForm()) {
  const tabs = await chrome.tabs.query({
    url: ['https://chat.openai.com/*', 'https://chatgpt.com/*']
  });
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  for (const tab of tabs) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'setAutoMaintain',
        autoMaintain: settings.autoMaintain,
        keepRounds: settings.keepRounds,
        cleanupMode: settings.cleanupMode
      });
      if (tab.id === activeTab?.id && response?.stats) {
        setCurrentRoundsDisplay(response.stats);
      }
    } catch (e) {
      // The tab may not have loaded the content script yet.
    }
  }
}

loadSettings();

async function loadCurrentRounds() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    if (tab.url?.includes('chat.openai.com') || tab.url?.includes('chatgpt.com')) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'getRoundStats' });
        if (response?.success && response.stats) {
          setCurrentRoundsDisplay(response.stats);
          return;
        }
      } catch (e) {
        // Fall back to badge text below.
      }
    }

    const text = await chrome.action.getBadgeText({ tabId: tab.id });
    if (text === '!') {
      showStatus(getMessage('domWarningMessage'), 'error', true);
    } else {
      setCurrentRoundsDisplay(text ? { visibleRounds: Number(text), totalRounds: Number(text) } : null);
    }
  } catch (e) {
    // Ignore non-ChatGPT pages or empty badges.
  }
}

function setCurrentRoundsDisplay(stats) {
  const el = document.getElementById('currentRounds');
  if (!el) return;
  if (stats?.visibleRounds > 0 || stats?.totalRounds > 0) {
    el.textContent = getMessage('roundStatsBadge', [
      String(stats.visibleRounds || 0),
      String(stats.totalRounds || stats.visibleRounds || 0)
    ]);
  } else {
    el.textContent = '';
  }
  updatePerformanceMetrics(stats);
}

function updatePerformanceMetrics(stats) {
  const optimizedEl = document.getElementById('optimizedRounds');
  const reductionEl = document.getElementById('domReduction');
  if (!optimizedEl || !reductionEl) return;

  const visible = stats?.visibleRounds || 0;
  const total = stats?.totalRounds || visible;
  const optimized = Math.max(0, total - visible);
  const reduction = total > 0 ? Math.round((optimized / total) * 100) : 0;

  optimizedEl.textContent = getMessage('optimizedRoundsValue', [String(optimized)]);
  reductionEl.textContent = `${reduction}%`;
}

loadCurrentRounds();

async function saveAndNotifyIfNeeded(showModeStatus = false) {
  const settings = await saveSettings();
  if (!settings) return null;

  await notifyAutoMaintainChange(settings);

  if (showModeStatus) {
    const statusKey = settings.cleanupMode === CLEANUP_MODES.PERFORMANCE
      ? 'performanceModeSelected'
      : settings.cleanupMode === CLEANUP_MODES.REMOVE
        ? 'removeModeSelected'
        : 'safeModeSelected';
    showStatus(getMessage(statusKey), 'info');
  }

  return settings;
}

document.getElementById('keepRounds').addEventListener('change', async () => {
  const settings = await saveSettings();
  if (settings?.autoMaintain) {
    await notifyAutoMaintainChange(settings);
    await loadCurrentRounds();
  }
});

document.querySelectorAll('input[name="cleanupMode"]').forEach((input) => {
  input.addEventListener('change', () => {
    saveAndNotifyIfNeeded(true);
  });
});

document.getElementById('autoMaintain').addEventListener('change', async () => {
  const settings = await saveAndNotifyIfNeeded();
  if (settings) {
    if (settings.autoMaintain) {
      showStatus(getMessage('autoMaintainEnabled', [settings.keepRounds.toString()]), 'success');
    } else {
      showStatus(getMessage('autoMaintainDisabled'), 'info');
    }
  }
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

async function checkContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return true;
  } catch (error) {
    return false;
  }
}

document.getElementById('removeOldRounds').addEventListener('click', async () => {
  try {
    const tab = await getCurrentTab();

    if (!tab.url.includes('chat.openai.com') && !tab.url.includes('chatgpt.com')) {
      showStatus(getMessage('errorNotChatGPT'), 'error');
      return;
    }

    const scriptReady = await checkContentScript(tab.id);
    if (!scriptReady) {
      showStatus(getMessage('errorScriptLoad') + ' Please refresh the ChatGPT page and try again.', 'error');
      return;
    }

    const settings = await saveSettings();
    if (!settings) {
      return;
    }

    chrome.tabs.sendMessage(tab.id, {
      action: 'removeOldRounds',
      keepRounds: settings.keepRounds,
      cleanupMode: settings.cleanupMode
    }, (response) => {
      if (chrome.runtime.lastError) {
        showStatus(getMessage('errorOperationFailed'), 'error');
        console.error('Failed to send message:', chrome.runtime.lastError);
        return;
      }

      if (response) {
        if (response.success) {
          showStatus(
            response.message || getMessage('successCleaned', [settings.keepRounds.toString()]),
            'success'
          );
        } else {
          showStatus(response.message || getMessage('errorOperationFailedRetry'), 'error');
        }
      } else {
        showStatus(getMessage('errorOperationFailedRetry'), 'error');
      }
    });
  } catch (error) {
    showStatus(getMessage('errorOccurred') + error.message, 'error');
    console.error('Failed to limit old conversation rounds:', error);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'badgeUpdated') {
    getCurrentTab().then(tab => {
      if (tab?.id === message.tabId) {
        setCurrentRoundsDisplay(message.stats || {
          visibleRounds: message.rounds || 0,
          totalRounds: message.totalRounds || message.rounds || 0
        });
      }
    }).catch(() => {});
  }

  if (message.action === 'domWarning') {
    getCurrentTab().then(tab => {
      if (tab?.id === message.tabId) {
        showStatus(getMessage('domWarningMessage'), 'error', true);
      }
    }).catch(() => {});
  }
});
