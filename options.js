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
}

async function refreshStats() {
  const response = await chrome.runtime.sendMessage({ action: 'getSnapshotStats' });
  const stats = response?.stats || { groupCount: 0, roundCount: 0, turnCount: 0 };
  document.getElementById('snapshotStats').textContent = getMessage('snapshotStatsText', [
    String(stats.groupCount),
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
    showStatus(getMessage('expiredSnapshotsCleaned', [String(response.deletedGroups || 0)]), 'success');
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
    showStatus(getMessage('snapshotsCleared'), 'success');
  } else {
    showStatus(response?.message || getMessage('operationFailed'), 'error');
  }
}

initI18n();
loadOptions();

document.getElementById('saveOptions').addEventListener('click', saveOptions);
document.getElementById('cleanupExpired').addEventListener('click', cleanupExpired);
document.getElementById('clearSnapshots').addEventListener('click', clearSnapshots);
