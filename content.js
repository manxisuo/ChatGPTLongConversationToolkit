// Content Script - runs on ChatGPT pages.

const CLEANUP_MODES = {
  SAFE: 'safe',
  PERFORMANCE: 'performance',
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

function getConversationId() {
  const match = location.pathname.match(/\/c\/([^/?#]+)/);
  return match?.[1] || 'unknown-conversation';
}

function makeGroupId(conversationId) {
  return `${conversationId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
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
  delete turnEl.dataset.chcGroupId;
  turnEl.style.removeProperty('display');
}

function hideTurn(turnEl, groupId) {
  turnEl.dataset.chcHidden = 'true';
  turnEl.dataset.chcGroupId = groupId;
  turnEl.style.display = 'none';
}

function parseHtmlNodes(htmlList) {
  return htmlList.flatMap((html) => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(parsed.body.children).map(node => document.importNode(node, true));
  });
}

function insertNodesAfter(nodes, anchor) {
  const parent = anchor?.parentNode;
  if (!parent) return 0;
  let referenceNode = anchor.nextSibling;
  nodes.forEach((node) => {
    markRestoredSnapshotNode(node);
    parent.insertBefore(node, referenceNode);
  });
  return nodes.length;
}

function moveTurnsAfter(turns, anchor) {
  const parent = anchor?.parentNode;
  if (!parent) return 0;
  const referenceNode = anchor.nextSibling;
  turns.forEach((turn) => {
    parent.insertBefore(turn, referenceNode);
  });
  return turns.length;
}

function markRestoredSnapshotNode(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  node.dataset.chcRestoredSnapshot = 'true';
  hideRestoredSnapshotControls(node);
}

function hideRestoredSnapshotControls(root) {
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
  const modeLabelKey = mode === CLEANUP_MODES.PERFORMANCE
    ? 'performanceHiddenOlderMessages'
    : mode === CLEANUP_MODES.REMOVE
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

function createPlaceholder({ mode, groupId, hiddenTurns }) {
  const placeholder = document.createElement('section');
  placeholder.dataset.chcPlaceholder = 'true';
  placeholder.dataset.chcMode = mode;
  placeholder.dataset.chcGroupId = groupId;

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

function ensurePlaceholder({ mode, groupId, hiddenTurns, beforeTurn }) {
  let placeholder = getPlaceholderForMode(mode);
  if (!placeholder) {
    placeholder = createPlaceholder({ mode, groupId, hiddenTurns });
    const parent = beforeTurn?.parentNode || findThread();
    if (parent) parent.insertBefore(placeholder, beforeTurn || parent.firstChild);
  }
  placeholder.dataset.chcGroupId = groupId;
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
  store.hiddenCount().then((hiddenCount) => store.restore(hiddenCount)).then(() => {
    scheduleBadgeUpdate();
  }).catch(() => {
    placeholder.textContent = getMessage('snapshotRestoreFailed');
  });
}

class SafeDomStore {
  constructor() {
    this.mode = CLEANUP_MODES.SAFE;
    this.groupId = getPlaceholderForMode(this.mode)?.dataset.chcGroupId || makeGroupId(getConversationId());
  }

  hiddenTurns() {
    return findTurnElements().filter(turnEl => turnEl.dataset.chcHidden === 'true');
  }

  hiddenCount() {
    return this.hiddenTurns().length;
  }

  async store(turns) {
    if (turns.length === 0) return this.hiddenCount();
    const firstVisible = getVisibleTurnElements()[turns.length] || getVisibleTurnElements()[0] || null;
    const placeholder = ensurePlaceholder({
      mode: this.mode,
      groupId: this.groupId,
      hiddenTurns: this.hiddenCount() + turns.length,
      beforeTurn: firstVisible
    });
    turns.forEach((turn) => {
      hideTurn(turn, this.groupId);
      placeholder.parentNode?.insertBefore(turn, placeholder);
    });
    setPlaceholderContent(placeholder, { mode: this.mode, hiddenTurns: this.hiddenCount() });
    return this.hiddenCount();
  }

  async restore(count) {
    const placeholder = getPlaceholderForMode(this.mode);
    if (!placeholder || count <= 0) return this.hiddenCount();
    const turns = this.hiddenTurns();
    const restoreTurns = turns.slice(Math.max(0, turns.length - count));
    restoreTurns.forEach((turn) => {
      showTurn(turn);
    });
    moveTurnsAfter(restoreTurns, placeholder);
    const hiddenCount = this.hiddenCount();
    if (hiddenCount === 0) {
      placeholder.remove();
    } else {
      setPlaceholderContent(placeholder, { mode: this.mode, hiddenTurns: hiddenCount });
    }
    return hiddenCount;
  }
}

class IndexedDbStore {
  constructor() {
    this.mode = CLEANUP_MODES.PERFORMANCE;
    this.placeholder = getPlaceholderForMode(this.mode);
    this.groupId = this.placeholder?.dataset.chcGroupId || makeGroupId(getConversationId());
    this.snapshot = null;
    this.html = [];
  }

  async load() {
    if (this.snapshot !== null) return;
    if (!this.placeholder) {
      this.snapshot = null;
      this.html = [];
      return;
    }
    const response = await sendRuntimeMessage({
      action: 'getCollapsedSnapshot',
      groupId: this.groupId
    });
    this.snapshot = response?.success ? response.snapshot : null;
    this.html = this.snapshot?.html || [];
  }

  async hiddenCount() {
    await this.load();
    return this.html.length;
  }

  async save(html) {
    for (let index = 0; index < html.length; index += 1) {
      const turnSaveResponse = await sendRuntimeMessage({
        action: 'saveCollapsedTurn',
        groupId: this.groupId,
        index,
        html: html[index]
      });
      if (!turnSaveResponse?.success) {
        throw new Error(turnSaveResponse?.message || `Unable to save local snapshot turn ${index}`);
      }
    }

    const response = await sendRuntimeMessage({
      action: 'saveCollapsedSnapshot',
      groupId: this.groupId,
      conversationId: getConversationId(),
      turnCount: html.length,
      roundCount: calculateRounds(html.length),
      html: []
    });
    if (!response?.success) {
      throw new Error(response?.message || 'Unable to save local snapshot');
    }
    this.html = html;
  }

  async store(turns) {
    await this.load();
    if (turns.length === 0) return this.html.length;
    const firstKeptTurn = getVisibleTurnElements()[turns.length] || null;
    const nextHtml = this.html.concat(turns.map(turn => turn.outerHTML));
    await this.save(nextHtml);
    this.placeholder = ensurePlaceholder({
      mode: this.mode,
      groupId: this.groupId,
      hiddenTurns: nextHtml.length,
      beforeTurn: firstKeptTurn
    });
    turns.forEach(turn => turn.remove());
    return nextHtml.length;
  }

  async restore(count) {
    await this.load();
    if (!this.placeholder || count <= 0 || this.html.length === 0) return this.html.length;
    const restoreCount = Math.min(count, this.html.length);
    const remainingHtml = this.html.slice(0, this.html.length - restoreCount);
    const restoredHtml = this.html.slice(this.html.length - restoreCount);
    const restoredNodes = parseHtmlNodes(restoredHtml);
    insertNodesAfter(restoredNodes, this.placeholder);

    if (remainingHtml.length === 0) {
      await sendRuntimeMessage({ action: 'deleteCollapsedSnapshot', groupId: this.groupId }).catch(() => {});
      this.placeholder.remove();
      this.html = [];
      return 0;
    }

    const deleteResponse = await sendRuntimeMessage({
      action: 'deleteCollapsedTurnsFromIndex',
      groupId: this.groupId,
      startIndex: remainingHtml.length
    });
    if (!deleteResponse?.success) {
      throw new Error(deleteResponse?.message || 'Unable to update local snapshot turns');
    }
    await this.save(remainingHtml);
    setPlaceholderContent(this.placeholder, { mode: this.mode, hiddenTurns: remainingHtml.length });
    return remainingHtml.length;
  }
}

class NullStore {
  constructor() {
    this.mode = CLEANUP_MODES.REMOVE;
    this.groupId = getPlaceholderForMode(this.mode)?.dataset.chcGroupId || makeGroupId(getConversationId());
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
      groupId: this.groupId,
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
  if (mode === CLEANUP_MODES.PERFORMANCE) return new IndexedDbStore();
  if (mode === CLEANUP_MODES.REMOVE) return new NullStore();
  return new SafeDomStore();
}

async function restoreForeignRecoverableStores(activeMode) {
  if (activeMode !== CLEANUP_MODES.SAFE) {
    await new SafeDomStore().restore(Number.MAX_SAFE_INTEGER);
  }
  if (activeMode !== CLEANUP_MODES.PERFORMANCE) {
    await new IndexedDbStore().restore(Number.MAX_SAFE_INTEGER);
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
  if (mode === CLEANUP_MODES.PERFORMANCE) {
    return getMessage('successPerformanceDetailed', [hiddenRounds.toString(), stats.visibleRounds.toString()]);
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

function scheduleAutoCleanup() {
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    if (!autoMaintainEnabled) return;
    reconcileConversation(autoMaintainKeepRounds, cleanupModeEnabled).catch((error) => {
      console.error('Auto-maintain failed:', error);
    });
  }, 500);
}

async function runAutoCleanupNow() {
  if (!autoMaintainEnabled) {
    scheduleBadgeUpdate();
    return { success: true, stats: getRoundStats() };
  }
  const result = await reconcileConversation(autoMaintainKeepRounds, cleanupModeEnabled);
  return {
    success: result.success,
    message: result.message,
    stats: getRoundStats()
  };
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

function startObserver() {
  if (observer) return;
  const target = document.documentElement || document.body;
  if (!target) return;

  observer = new MutationObserver((mutations) => {
    if (!autoMaintainEnabled) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (isTurnRelatedNode(node)) {
          scheduleAutoCleanup();
          return;
        }
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
  cleanupModeEnabled = cleanupMode || CLEANUP_MODES.SAFE;
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
  if (result.cleanupMode) return result.cleanupMode;
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
