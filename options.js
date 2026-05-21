const DEFAULT_SNAPSHOT_TTL_DAYS = 30;

function getMessage(key, substitutions = []) {
  return chrome.i18n.getMessage(key, substitutions);
}

function initI18n() {
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    const key = element.getAttribute('data-i18n');
    const message = getMessage(key);
    if (message) {
      element.textContent = message;
    }
  });
  document.title = getMessage('optionsTitle');
}

function showStatus(message, type = 'info') {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status show ${type}`;
}

function readTtlDays() {
  return parseInt(document.getElementById('snapshotTtlDays').value, 10);
}

async function loadOptions() {
  const result = await chrome.storage.local.get({ snapshotTtlDays: DEFAULT_SNAPSHOT_TTL_DAYS });
  document.getElementById('snapshotTtlDays').value = result.snapshotTtlDays;
  await refreshStats();
  await refreshSnapshotList();
}

async function refreshStats() {
  const response = await chrome.runtime.sendMessage({ action: 'getSnapshotStats' });
  const stats = response?.stats || { conversationCount: 0, roundCount: 0, turnCount: 0 };
  document.getElementById('snapshotStats').textContent = getMessage('snapshotStatsText', [
    String(stats.conversationCount),
    String(stats.roundCount),
    String(stats.turnCount)
  ]);
}

async function saveOptions() {
  const ttlDays = readTtlDays();
  if (Number.isNaN(ttlDays) || ttlDays < 1 || ttlDays > 365) {
    showStatus(getMessage('snapshotTtlRangeError'), 'error');
    return;
  }

  await chrome.storage.local.set({ snapshotTtlDays: ttlDays });
  showStatus(getMessage('settingsSaved'), 'success');
}

async function cleanupExpired() {
  const ttlDays = readTtlDays();
  const response = await chrome.runtime.sendMessage({
    action: 'cleanupExpiredSnapshots',
    ttlDays
  });

  if (response?.success) {
    await refreshStats();
    await refreshSnapshotList();
    showStatus(getMessage('expiredSnapshotsCleaned', [String(response.deletedSnapshots || 0)]), 'success');
  } else {
    showStatus(response?.message || getMessage('operationFailed'), 'error');
  }
}

async function clearSnapshots() {
  const confirmed = confirm(getMessage('clearSnapshotsConfirm'));
  if (!confirmed) return;

  const response = await chrome.runtime.sendMessage({ action: 'clearAllSnapshots' });
  if (response?.success) {
    await refreshStats();
    await refreshSnapshotList();
    showStatus(getMessage('snapshotsCleared'), 'success');
  } else {
    showStatus(response?.message || getMessage('operationFailed'), 'error');
  }
}

function formatSnapshotMeta(snapshot) {
  const rounds = snapshot.roundCount || 0;
  const turns = snapshot.turnCount || 0;
  return `${rounds} rounds / ${turns} turns`;
}

async function refreshSnapshotList() {
  const list = document.getElementById('snapshotConversationList');
  const viewer = document.getElementById('snapshotJsonViewer');
  viewer.classList.remove('show');
  viewer.textContent = '';
  list.textContent = getMessage('loadingSnapshots');

  const response = await chrome.runtime.sendMessage({ action: 'listConversationSnapshots' });
  if (!response?.success) {
    list.textContent = response?.message || getMessage('operationFailed');
    return;
  }

  const snapshots = response.snapshots || [];
  list.textContent = '';
  if (snapshots.length === 0) {
    list.textContent = getMessage('noSavedSnapshots');
    return;
  }

  snapshots.forEach((snapshot) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-item';
    button.dataset.conversationId = snapshot.conversationId;

    const id = document.createElement('span');
    id.textContent = snapshot.conversationId;
    const meta = document.createElement('span');
    meta.className = 'conversation-meta';
    meta.textContent = formatSnapshotMeta(snapshot);

    button.append(id, meta);
    button.addEventListener('click', () => showSnapshotDetail(snapshot.conversationId));
    list.appendChild(button);
  });
}

async function showSnapshotDetail(conversationId) {
  const viewer = document.getElementById('snapshotJsonViewer');
  viewer.textContent = getMessage('loadingSnapshots');
  viewer.classList.add('show');

  const response = await chrome.runtime.sendMessage({
    action: 'getConversationSnapshotDetail',
    conversationId
  });

  if (!response?.success) {
    viewer.textContent = response?.message || getMessage('operationFailed');
    return;
  }

  viewer.textContent = JSON.stringify(response.snapshot || null, null, 2);
}

initI18n();
loadOptions();

document.getElementById('saveOptions').addEventListener('click', saveOptions);
document.getElementById('cleanupExpired').addEventListener('click', cleanupExpired);
document.getElementById('clearSnapshots').addEventListener('click', clearSnapshots);
document.getElementById('refreshSnapshotList').addEventListener('click', refreshSnapshotList);
