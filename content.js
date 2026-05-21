// Content Script - runs on ChatGPT pages.

const CLEANUP_MODES = {
  SAFE: 'safe',
  REMOVE: 'remove'
};

let autoMaintainEnabled = false;
let autoMaintainKeepRounds = 10;
let cleanupModeEnabled = CLEANUP_MODES.SAFE;
let observer = null;
let cleanupTimer = null;
let badgeTimer = null;
let domCheckTimer = null;
let badgeObserver = null;
let reconcileQueue = Promise.resolve();
let restoreProtectionTimer = null;

function getMessage(key, substitutions = []) {
  return chrome.i18n.getMessage(key, substitutions);
}

function sendRuntimeMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function updateBadge(stats) {
  sendRuntimeMessage({ action: 'updateBadge', stats }).catch(() => {});
}

function findThread() {
  return document.querySelector('#thread');
}

function findTurnElements() {
  const thread = findThread();
  if (!thread) return [];

  const turnSections = Array.from(
    thread.querySelectorAll('section[data-testid^="conversation-turn-"][data-turn-id]')
  ).filter(turnEl => !turnEl.dataset.chcPlaceholder);

  if (turnSections.length > 0) return turnSections;

  return Array.from(thread.querySelectorAll('article'))
    .filter(turnEl => !turnEl.dataset.chcPlaceholder);
}

function getVisibleTurnElements() {
  return findTurnElements().filter(turnEl => !turnEl.dataset.chcHidden);
}

function calculateRounds(turnCount) {
  return Math.floor(turnCount / 2);
}

function toWholeRoundTurnCount(turnCount) {
  return Math.max(0, turnCount - (turnCount % 2));
}

function getExistingPlaceholders() {
  return Array.from(document.querySelectorAll('[data-chc-placeholder="true"]'));
}

function getPlaceholderForMode(mode) {
  return getExistingPlaceholders().find(placeholder => placeholder.dataset.chcMode === mode) || null;
}

function getPlaceholderHiddenTurns(placeholder) {
  return parseInt(placeholder?.dataset.chcHiddenTurns || '0', 10) || 0;
}

function getPlaceholderHiddenRounds() {
  return getExistingPlaceholders().reduce((sum, placeholder) => {
    return sum + (parseInt(placeholder.dataset.chcHiddenRounds || '0', 10) || 0);
  }, 0);
}

function getRoundStats() {
  const visibleRounds = calculateRounds(getVisibleTurnElements().length);
  return {
    visibleRounds,
    totalRounds: visibleRounds + getPlaceholderHiddenRounds()
  };
}

function showTurn(turnEl) {
  delete turnEl.dataset.chcHidden;
  turnEl.dataset.chcRestoredVisual = 'true';
  turnEl.style.removeProperty('display');
  turnEl.style.overflowAnchor = 'none';
}

function hideTurn(turnEl) {
  turnEl.dataset.chcHidden = 'true';
  turnEl.style.display = 'none';
  turnEl.style.overflowAnchor = 'none';
}

function getScrollRoot() {
  return document.scrollingElement || document.documentElement;
}

function withScrollRestoreProtection(task) {
  const scrollRoot = getScrollRoot();
  const previousScrollTop = scrollRoot?.scrollTop || window.scrollY || 0;
  const protectedElements = [
    document.documentElement,
    document.body,
    findThread()
  ].filter(Boolean);
  const previousOverflowAnchors = protectedElements.map((element) => element.style.overflowAnchor);

  if (restoreProtectionTimer) {
    clearTimeout(restoreProtectionTimer);
    restoreProtectionTimer = null;
  }

  protectedElements.forEach((element) => {
    element.style.overflowAnchor = 'none';
  });

  return Promise.resolve()
    .then(task)
    .finally(() => {
      requestAnimationFrame(() => {
        const currentRoot = getScrollRoot();
        if (currentRoot) {
          currentRoot.scrollTop = previousScrollTop;
        } else {
          window.scrollTo(window.scrollX, previousScrollTop);
        }

        restoreProtectionTimer = setTimeout(() => {
          protectedElements.forEach((element, index) => {
            if (previousOverflowAnchors[index]) {
              element.style.overflowAnchor = previousOverflowAnchors[index];
            } else {
              element.style.removeProperty('overflow-anchor');
            }
          });
          restoreProtectionTimer = null;
        }, 2500);
      });
    });
}

function markRestoredNode(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  node.dataset.chcRestored = 'true';
  hideRestoredControls(node);
}

function hideRestoredControls(root) {
  const controlSelectors = [
    'button',
    '[role="button"]',
    '[data-testid*="copy"]',
    '[data-testid*="feedback"]',
    '[data-testid*="share"]',
    '[data-testid*="voice"]',
    '[data-testid*="regenerate"]',
    '[aria-label*="Copy"]',
    '[aria-label*="copy"]',
    '[aria-label*="Good response"]',
    '[aria-label*="Bad response"]',
    '[aria-label*="Read aloud"]',
    '[aria-label*="Regenerate"]',
    '[aria-label*="Share"]',
    '[aria-label*="复制"]',
    '[aria-label*="朗读"]',
    '[aria-label*="重新生成"]',
    '[aria-label*="分享"]'
  ];

  root.querySelectorAll(controlSelectors.join(',')).forEach((control) => {
    control.dataset.chcHiddenNativeControl = 'true';
    control.style.display = 'none';
  });
}

function setPlaceholderContent(placeholder, { mode, hiddenTurns }) {
  const hiddenRounds = calculateRounds(hiddenTurns);
  const canExpand = mode !== CLEANUP_MODES.REMOVE && !autoMaintainEnabled && hiddenTurns > 0;
  const modeLabelKey = mode === CLEANUP_MODES.REMOVE
      ? 'removedOlderMessages'
      : 'hiddenOlderMessages';

  placeholder.dataset.chcHiddenTurns = String(hiddenTurns);
  placeholder.dataset.chcHiddenRounds = String(hiddenRounds);
  placeholder.textContent = getMessage(modeLabelKey, [hiddenRounds.toString()]);

  if (canExpand) {
    const expand = document.createElement('span');
    expand.textContent = ` ${getMessage('expandHiddenMessages')}`;
    expand.style.textDecoration = 'underline';
    expand.style.marginLeft = '6px';
    placeholder.appendChild(expand);
  } else if (mode !== CLEANUP_MODES.REMOVE && autoMaintainEnabled) {
    const hint = document.createElement('span');
    hint.textContent = ` ${getMessage('turnOffAutoMaintainToExpand')}`;
    hint.style.display = 'block';
    hint.style.fontWeight = '400';
    hint.style.marginTop = '4px';
    placeholder.appendChild(hint);
  }

  placeholder.style.cursor = canExpand ? 'pointer' : 'default';
  if (canExpand) {
    placeholder.setAttribute('role', 'button');
    placeholder.tabIndex = 0;
  } else {
    placeholder.removeAttribute('role');
    placeholder.removeAttribute('tabindex');
  }
  bindPlaceholderExpandHandlers(placeholder, canExpand);
}

function createPlaceholder({ mode, hiddenTurns }) {
  const placeholder = document.createElement('section');
  placeholder.dataset.chcPlaceholder = 'true';
  placeholder.dataset.chcMode = mode;

  Object.assign(placeholder.style, {
    boxSizing: 'border-box',
    margin: '12px auto',
    maxWidth: '768px',
    width: 'calc(100% - 32px)',
    padding: '12px 14px',
    border: '1px solid rgba(16, 163, 127, 0.28)',
    borderRadius: '8px',
    background: mode === CLEANUP_MODES.REMOVE ? 'rgba(245, 158, 11, 0.10)' : 'rgba(16, 163, 127, 0.08)',
    color: mode === CLEANUP_MODES.REMOVE ? '#92400e' : '#0f766e',
    font: '500 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    textAlign: 'center'
  });

  setPlaceholderContent(placeholder, { mode, hiddenTurns });
  return placeholder;
}

function ensurePlaceholder({ mode, hiddenTurns, beforeTurn }) {
  let placeholder = getPlaceholderForMode(mode);
  if (!placeholder) {
    placeholder = createPlaceholder({ mode, hiddenTurns });
    const parent = beforeTurn?.parentNode || findThread();
    if (parent) parent.insertBefore(placeholder, beforeTurn || parent.firstChild);
  }
  setPlaceholderContent(placeholder, { mode, hiddenTurns });
  return placeholder;
}

function removePlaceholderIfEmpty(mode) {
  const placeholder = getPlaceholderForMode(mode);
  if (placeholder && getPlaceholderHiddenTurns(placeholder) <= 0) {
    placeholder.remove();
  }
}

function bindPlaceholderExpandHandlers(placeholder, canExpand) {
  placeholder.onclick = null;
  placeholder.onkeydown = null;
  if (!canExpand) return;

  placeholder.onclick = () => expandPlaceholder(placeholder);
  placeholder.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      expandPlaceholder(placeholder);
    }
  };
}

function refreshPlaceholderInteractivity() {
  getExistingPlaceholders().forEach((placeholder) => {
    setPlaceholderContent(placeholder, {
      mode: placeholder.dataset.chcMode,
      hiddenTurns: getPlaceholderHiddenTurns(placeholder)
    });
  });
}

function expandPlaceholder(placeholder) {
  if (autoMaintainEnabled) return;
  const mode = placeholder.dataset.chcMode;
  const store = createStore(mode);
  withScrollRestoreProtection(() => (
    Promise.resolve(store.hiddenCount()).then((hiddenCount) => store.restore(hiddenCount))
  )).then(() => {
    scheduleBadgeUpdate();
  }).catch(() => {
    placeholder.textContent = getMessage('expandHiddenMessagesFailed');
  });
}

class SafeDomStore {
  constructor() {
    this.mode = CLEANUP_MODES.SAFE;
  }

  hiddenTurns() {
    return findTurnElements().filter(turnEl => turnEl.dataset.chcHidden === 'true');
  }

  hiddenCount() {
    return this.hiddenTurns().length;
  }

  async store(turns) {
    if (turns.length === 0) return this.hiddenCount();
    const firstHiddenTurn = turns[0] || null;
    const placeholder = ensurePlaceholder({
      mode: this.mode,
      hiddenTurns: this.hiddenCount() + turns.length,
      beforeTurn: firstHiddenTurn
    });
    turns.forEach((turn) => {
      hideTurn(turn);
    });
    setPlaceholderContent(placeholder, { mode: this.mode, hiddenTurns: this.hiddenCount() });
    return this.hiddenCount();
  }

  async restore(count) {
    const placeholder = getPlaceholderForMode(this.mode);
    if (!placeholder || count <= 0) return this.hiddenCount();
    const turns = this.hiddenTurns();
    if (count >= turns.length) {
      turns.forEach((turn) => {
        showTurn(turn);
      });
      placeholder.remove();
      return 0;
    }
    const restoreTurns = turns.slice(Math.max(0, turns.length - count));
    restoreTurns.forEach((turn) => {
      showTurn(turn);
    });
    const hiddenCount = this.hiddenCount();
    if (hiddenCount === 0) {
      placeholder.remove();
    } else {
      setPlaceholderContent(placeholder, { mode: this.mode, hiddenTurns: hiddenCount });
    }
    return hiddenCount;
  }
}

class NullStore {
  constructor() {
    this.mode = CLEANUP_MODES.REMOVE;
  }

  hiddenCount() {
    return getPlaceholderHiddenTurns(getPlaceholderForMode(this.mode));
  }

  async store(turns) {
    if (turns.length === 0) return this.hiddenCount();
    const firstKeptTurn = getVisibleTurnElements()[turns.length] || null;
    const hiddenTurns = this.hiddenCount() + turns.length;
    ensurePlaceholder({
      mode: this.mode,
      hiddenTurns,
      beforeTurn: firstKeptTurn
    });
    turns.forEach(turn => turn.remove());
    return hiddenTurns;
  }

  async restore() {
    return this.hiddenCount();
  }
}

function createStore(mode) {
  if (mode === CLEANUP_MODES.REMOVE) return new NullStore();
  return new SafeDomStore();
}

async function restoreForeignRecoverableStores(activeMode) {
  if (activeMode !== CLEANUP_MODES.SAFE) {
    await new SafeDomStore().restore(Number.MAX_SAFE_INTEGER);
  }
}

async function reconcileConversation(keepRounds, cleanupMode) {
  return enqueueReconcile(() => reconcileConversationUnlocked(keepRounds, cleanupMode));
}

function enqueueReconcile(task) {
  const nextTask = reconcileQueue.then(task, task);
  reconcileQueue = nextTask.catch(() => {});
  return nextTask;
}

async function reconcileConversationUnlocked(keepRounds, cleanupMode) {
  const mode = Object.values(CLEANUP_MODES).includes(cleanupMode) ? cleanupMode : CLEANUP_MODES.SAFE;
  await restoreForeignRecoverableStores(mode);

  const store = createStore(mode);
  const hiddenCount = await store.hiddenCount();
  const visibleTurns = getVisibleTurnElements();
  const targetVisibleTurns = keepRounds * 2;
  if (visibleTurns.length > targetVisibleTurns) {
    const turnsToStoreCount = toWholeRoundTurnCount(visibleTurns.length - targetVisibleTurns);
    const turnsToStore = visibleTurns.slice(0, turnsToStoreCount);
    await store.store(turnsToStore);
  } else if (visibleTurns.length < targetVisibleTurns && hiddenCount > 0) {
    const turnsToRestore = toWholeRoundTurnCount(Math.min(targetVisibleTurns - visibleTurns.length, hiddenCount));
    await store.restore(turnsToRestore);
  } else {
    const placeholder = getPlaceholderForMode(mode);
    if (placeholder) {
      const currentHiddenCount = await store.hiddenCount();
      if (currentHiddenCount > 0) {
        setPlaceholderContent(placeholder, { mode, hiddenTurns: currentHiddenCount });
      } else {
        placeholder.remove();
      }
    }
  }

  scheduleBadgeUpdate();
  const stats = getRoundStats();
  return {
    success: true,
    message: getModeResultMessage(mode, stats),
    rounds: stats.visibleRounds,
    stats
  };
}

function getModeResultMessage(mode, stats) {
  const hiddenRounds = Math.max(0, stats.totalRounds - stats.visibleRounds);
  if (stats.totalRounds === stats.visibleRounds) {
    return getMessage('infoNoNeedClean', [stats.visibleRounds.toString()]);
  }
  if (mode === CLEANUP_MODES.REMOVE) {
    return getMessage('successCleanedDetailed', [hiddenRounds.toString(), stats.visibleRounds.toString()]);
  }
  return getMessage('successCollapsedDetailed', [hiddenRounds.toString(), stats.visibleRounds.toString()]);
}

async function removeOldRounds(keepRounds, cleanupMode) {
  try {
    return await reconcileConversation(keepRounds, cleanupMode);
  } catch (error) {
    console.error('Failed to limit old conversation rounds:', error);
    return {
      success: false,
      message: getMessage('errorCleanFailed') + error.message
    };
  }
}

function scheduleAutoCleanup(delay = 500) {
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    if (!autoMaintainEnabled) return;
    reconcileConversation(autoMaintainKeepRounds, cleanupModeEnabled).catch((error) => {
      console.error('Auto-maintain failed:', error);
    });
  }, delay);
}

async function runAutoCleanupNow() {
  if (!autoMaintainEnabled) {
    scheduleBadgeUpdate();
    return { success: true, stats: getRoundStats() };
  }
  try {
    const result = await reconcileConversation(autoMaintainKeepRounds, cleanupModeEnabled);
    return {
      success: result.success,
      message: result.message,
      stats: getRoundStats()
    };
  } catch (error) {
    if (retryAutoCleanupAfterIncomplete(error)) {
      scheduleBadgeUpdate();
      return { success: true, message: error.message, stats: getRoundStats() };
    }
    throw error;
  }
}

function isTurnRelatedNode(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  if (node.dataset?.chcPlaceholder === 'true') return false;

  const isTurnSection =
    node.matches?.('section[data-testid^="conversation-turn-"][data-turn-id]') ||
    node.querySelector?.('section[data-testid^="conversation-turn-"][data-turn-id]');

  return (
    node.id === 'thread' ||
    node.tagName === 'ARTICLE' ||
    node.querySelector?.('#thread') ||
    node.querySelector?.('article') ||
    isTurnSection
  );
}

function isTurnRelatedMutation(mutation) {
  if (mutation.type === 'childList') {
    return [...mutation.addedNodes].some(isTurnRelatedNode);
  }
  return false;
}

function startObserver() {
  if (observer) return;
  const target = document.documentElement || document.body;
  if (!target) return;

  observer = new MutationObserver((mutations) => {
    if (!autoMaintainEnabled) return;
    for (const mutation of mutations) {
      if (isTurnRelatedMutation(mutation)) {
        scheduleAutoCleanup();
        return;
      }
    }
  });

  observer.observe(target, { childList: true, subtree: true });
}

function stopObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
}

function updateAutoMaintain(enabled, keepRounds, cleanupMode, runImmediately = false) {
  const wasEnabled = autoMaintainEnabled;
  autoMaintainEnabled = enabled;
  autoMaintainKeepRounds = keepRounds;
  cleanupModeEnabled = Object.values(CLEANUP_MODES).includes(cleanupMode) ? cleanupMode : CLEANUP_MODES.SAFE;
  if (wasEnabled !== enabled) refreshPlaceholderInteractivity();

  if (enabled) {
    startObserver();
    if (runImmediately) return runAutoCleanupNow();
    scheduleAutoCleanup();
  } else {
    stopObserver();
    scheduleBadgeUpdate();
  }
  return Promise.resolve({ success: true, stats: getRoundStats() });
}

function runDOMDiagnostic() {
  const thread = findThread();
  if (!thread) return;
  const hasMessageContent =
    thread.querySelector('[data-message-author-role]') ||
    thread.querySelector('[data-turn-id]');
  if (!hasMessageContent) return;

  const sample = [...thread.querySelectorAll('[data-testid]')]
    .slice(0, 5)
    .map(el => `${el.tagName.toLowerCase()}[data-testid="${el.dataset.testid}"]`)
    .join(' | ') || '(no data-testid elements found)';

  console.error(`[ChatGPT History Cleaner] DOM structure may have changed.\nSample: ${sample}`);
  sendRuntimeMessage({ action: 'domWarning', sample }).catch(() => {});
}

function scheduleDOMCheck() {
  if (domCheckTimer) return;
  domCheckTimer = setTimeout(() => {
    domCheckTimer = null;
    if (findTurnElements().length > 0) return;
    if (!location.pathname.includes('/c/')) return;
    runDOMDiagnostic();
  }, 10000);
}

function cancelDOMCheck() {
  if (domCheckTimer) {
    clearTimeout(domCheckTimer);
    domCheckTimer = null;
  }
}

function scheduleBadgeUpdate() {
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    const stats = getRoundStats();
    updateBadge(stats);
    if (stats.totalRounds > 0) {
      cancelDOMCheck();
    } else if (location.pathname.includes('/c/')) {
      scheduleDOMCheck();
    }
  }, 300);
}

function startBadgeObserver() {
  if (badgeObserver) return;
  const target = document.documentElement || document.body;
  if (!target) return;

  badgeObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
      for (const node of nodes) {
        if (isTurnRelatedNode(node)) {
          scheduleBadgeUpdate();
          return;
        }
      }
    }
  });

  badgeObserver.observe(target, { childList: true, subtree: true });
}

function resolveCleanupMode(result) {
  if (Object.values(CLEANUP_MODES).includes(result.cleanupMode)) return result.cleanupMode;
  return result.collapseOldMessages === false ? CLEANUP_MODES.REMOVE : CLEANUP_MODES.SAFE;
}

async function initAutoMaintain() {
  try {
    const result = await chrome.storage.local.get({
      autoMaintain: false,
      keepRounds: 10,
      cleanupMode: CLEANUP_MODES.SAFE,
      collapseOldMessages: true
    });
    updateAutoMaintain(result.autoMaintain, result.keepRounds, resolveCleanupMode(result));
    startBadgeObserver();
    scheduleBadgeUpdate();
  } catch (e) {
    // Ignore storage failures; manual popup actions can still retry later.
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.autoMaintain || changes.keepRounds || changes.cleanupMode || changes.collapseOldMessages) {
    const enabled = changes.autoMaintain ? changes.autoMaintain.newValue : autoMaintainEnabled;
    const rounds = changes.keepRounds ? changes.keepRounds.newValue : autoMaintainKeepRounds;
    const cleanupMode = changes.cleanupMode ? changes.cleanupMode.newValue : cleanupModeEnabled;
    updateAutoMaintain(enabled, rounds, cleanupMode);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ success: true, message: 'content script loaded' });
    return true;
  }

  if (request.action === 'testDOMWarning') {
    sendRuntimeMessage({
      action: 'domWarning',
      sample: '[TEST] section[data-testid="conversation-turn-1"] | div[data-message-author-role="user"]'
    });
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'setAutoMaintain') {
    updateAutoMaintain(request.autoMaintain, request.keepRounds, request.cleanupMode, true)
      .then(sendResponse)
      .catch((error) => {
        console.error('Failed to apply auto-maintain settings:', error);
        sendResponse({
          success: false,
          message: getMessage('errorOccurred') + error.message,
          stats: getRoundStats()
        });
      });
    return true;
  }

  if (request.action === 'getRoundStats') {
    sendResponse({ success: true, stats: getRoundStats() });
    return true;
  }

  if (request.action === 'removeOldRounds') {
    removeOldRounds(request.keepRounds, request.cleanupMode)
      .then(sendResponse)
      .catch((error) => {
        console.error('Error handling message:', error);
        sendResponse({
          success: false,
          message: getMessage('errorOccurred') + error.message
        });
      });
    return true;
  }

  return true;
});

function waitForThreadAndInit() {
  if (findThread()) {
    initAutoMaintain();
    return;
  }

  const bodyObserver = new MutationObserver(() => {
    if (findThread()) {
      bodyObserver.disconnect();
      initAutoMaintain();
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', waitForThreadAndInit);
} else {
  waitForThreadAndInit();
}
