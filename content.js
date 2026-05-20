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
let autoCleanupPausedUntil = 0;

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
  if (!thread) {
    return [];
  }

  const turnSections = Array.from(
    thread.querySelectorAll('section[data-testid^="conversation-turn-"][data-turn-id]')
  ).filter(turnEl => !turnEl.dataset.chcPlaceholder);

  if (turnSections.length > 0) {
    return turnSections;
  }

  return Array.from(thread.querySelectorAll('article'))
    .filter(turnEl => !turnEl.dataset.chcPlaceholder);
}

function calculateRounds(turnElements) {
  return Math.floor(turnElements.length / 2);
}

function calculateVisibleRounds(turnElements) {
  return Math.floor(turnElements.filter(turnEl => !turnEl.dataset.chcHidden).length / 2);
}

function getPlaceholderHiddenRounds() {
  return getExistingPlaceholders().reduce((sum, placeholder) => {
    return sum + (parseInt(placeholder.dataset.chcHiddenRounds || '0', 10) || 0);
  }, 0);
}

function getRoundStats() {
  const turnElements = findTurnElements();
  const visibleRounds = calculateVisibleRounds(turnElements);
  const hiddenRounds = getPlaceholderHiddenRounds();
  return {
    visibleRounds,
    totalRounds: visibleRounds + hiddenRounds
  };
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

function getExistingPerformancePlaceholder() {
  return getExistingPlaceholders()
    .find(placeholder => placeholder.dataset.chcMode === CLEANUP_MODES.PERFORMANCE);
}

function removeExistingPlaceholders() {
  getExistingPlaceholders().forEach((placeholder) => placeholder.remove());
}

function showTurn(turnEl) {
  delete turnEl.dataset.chcHidden;
  turnEl.style.removeProperty('display');
}

function hideTurn(turnEl) {
  turnEl.dataset.chcHidden = 'true';
  turnEl.style.display = 'none';
}

function parseHtmlNodes(htmlList) {
  return htmlList.flatMap((html) => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(parsed.body.children).map(node => document.importNode(node, true));
  });
}

function insertNodesBefore(nodes, placeholder) {
  const parent = placeholder.parentNode;
  if (!parent) return 0;

  nodes.forEach((node) => {
    markRestoredSnapshotNode(node);
    parent.insertBefore(node, placeholder);
  });
  return nodes.length;
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

async function expandSafePlaceholder(placeholder) {
  const groupId = placeholder.dataset.chcGroupId;
  findTurnElements()
    .filter(turnEl => turnEl.dataset.chcGroupId === groupId)
    .forEach((turnEl) => {
      delete turnEl.dataset.chcGroupId;
      showTurn(turnEl);
    });
  placeholder.remove();
  scheduleBadgeUpdate();
}

async function expandPerformancePlaceholder(placeholder) {
  pauseAutoCleanup(3000);
  const groupId = placeholder.dataset.chcGroupId;
  const response = await sendRuntimeMessage({
    action: 'getCollapsedSnapshot',
    groupId
  });

  if (!response?.success || !response.snapshot?.html) {
    placeholder.textContent = getMessage('snapshotRestoreFailed');
    return;
  }

  const nodes = parseHtmlNodes(response.snapshot.html);
  const insertedCount = insertNodesBefore(nodes, placeholder);
  if (insertedCount === 0) {
    placeholder.textContent = getMessage('snapshotRestoreFailed');
    return;
  }

  placeholder.remove();

  await sendRuntimeMessage({
    action: 'deleteCollapsedSnapshot',
    groupId
  }).catch(() => {});

  scheduleBadgeUpdate();
}

function setPlaceholderContent(placeholder, { mode, hiddenRounds, canExpand }) {
  const modeLabelKey = mode === CLEANUP_MODES.PERFORMANCE
    ? 'performanceHiddenOlderMessages'
    : mode === CLEANUP_MODES.REMOVE
      ? 'removedOlderMessages'
      : 'hiddenOlderMessages';
  placeholder.textContent = getMessage(modeLabelKey, [hiddenRounds.toString()]);

  if (canExpand) {
    const expandText = getMessage('expandHiddenMessages');
    if (expandText) {
      const expand = document.createElement('span');
      expand.textContent = ` ${expandText}`;
      expand.style.textDecoration = 'underline';
      expand.style.marginLeft = '6px';
      placeholder.appendChild(expand);
    }
  } else if (mode !== CLEANUP_MODES.REMOVE && autoMaintainEnabled) {
    const hint = getMessage('turnOffAutoMaintainToExpand');
    if (hint) {
      const hintEl = document.createElement('span');
      hintEl.textContent = ` ${hint}`;
      hintEl.style.display = 'block';
      hintEl.style.fontWeight = '400';
      hintEl.style.marginTop = '4px';
      placeholder.appendChild(hintEl);
    }
  }
}

function expandPlaceholder(placeholder) {
  if (autoMaintainEnabled) return;
  if (placeholder.dataset.chcMode === CLEANUP_MODES.PERFORMANCE) {
    expandPerformancePlaceholder(placeholder).catch(() => {
      placeholder.textContent = getMessage('snapshotRestoreFailed');
    });
  } else {
    expandSafePlaceholder(placeholder);
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

function createPlaceholder({ mode, groupId, hiddenRounds, canExpand }) {
  const placeholder = document.createElement('section');
  placeholder.dataset.chcPlaceholder = 'true';
  placeholder.dataset.chcMode = mode;
  placeholder.dataset.chcGroupId = groupId;
  placeholder.dataset.chcHiddenRounds = String(hiddenRounds);

  if (canExpand) {
    placeholder.setAttribute('role', 'button');
    placeholder.tabIndex = 0;
  } else {
    placeholder.removeAttribute('role');
    placeholder.removeAttribute('tabindex');
  }

  setPlaceholderContent(placeholder, { mode, hiddenRounds, canExpand });

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
    cursor: canExpand ? 'pointer' : 'default',
    font: '500 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    textAlign: 'center'
  });

  bindPlaceholderExpandHandlers(placeholder, canExpand);

  return placeholder;
}

function refreshPlaceholderInteractivity() {
  getExistingPlaceholders().forEach((placeholder) => {
    const mode = placeholder.dataset.chcMode;
    const hiddenRounds = parseInt(placeholder.dataset.chcHiddenRounds || '0', 10);
    const canExpand = mode !== CLEANUP_MODES.REMOVE && !autoMaintainEnabled;

    if (canExpand) {
      placeholder.setAttribute('role', 'button');
      placeholder.tabIndex = 0;
      placeholder.style.cursor = 'pointer';
    } else {
      placeholder.removeAttribute('role');
      placeholder.removeAttribute('tabindex');
      placeholder.style.cursor = 'default';
    }

    setPlaceholderContent(placeholder, { mode, hiddenRounds, canExpand });
    bindPlaceholderExpandHandlers(placeholder, canExpand);
  });
}

function insertPlaceholder(turnElementsToLimit, firstKeptTurn, placeholder) {
  const parent = firstKeptTurn?.parentNode || turnElementsToLimit.at(-1)?.parentNode;
  if (parent && turnElementsToLimit.length > 0) {
    parent.insertBefore(placeholder, firstKeptTurn || null);
  }
}

function collapseSafeTurns(turnElements, turnsToHide) {
  removeExistingPlaceholders();

  const turnElementsToHide = turnElements.slice(0, turnsToHide);
  const firstKeptTurn = turnElements[turnsToHide];
  const conversationId = getConversationId();
  const groupId = makeGroupId(conversationId);

  turnElements.forEach(showTurn);
  turnElementsToHide.forEach((turnEl) => {
    turnEl.dataset.chcGroupId = groupId;
    hideTurn(turnEl);
  });

  insertPlaceholder(
    turnElementsToHide,
    firstKeptTurn,
    createPlaceholder({
      mode: CLEANUP_MODES.SAFE,
      groupId,
      hiddenRounds: Math.floor(turnElementsToHide.length / 2),
      canExpand: !autoMaintainEnabled
    })
  );

  return Math.floor(turnElementsToHide.length / 2);
}

async function collapsePerformanceTurns(turnElements, keepRounds) {
  turnElements.forEach(showTurn);

  const conversationId = getConversationId();
  const existingPlaceholder = getExistingPerformancePlaceholder();
  const existingGroupId = existingPlaceholder?.dataset.chcGroupId;
  let groupId = existingGroupId || makeGroupId(conversationId);
  let existingSnapshot = null;
  let existingHtml = [];
  let existingTurnCount = 0;

  if (existingGroupId) {
    const existingResponse = await sendRuntimeMessage({
      action: 'getCollapsedSnapshot',
      groupId: existingGroupId
    });

    if (existingResponse?.success && existingResponse.snapshot?.html) {
      existingSnapshot = existingResponse.snapshot;
      existingHtml = existingSnapshot.html;
      existingTurnCount = existingSnapshot.turnCount || existingHtml.length;
      groupId = existingSnapshot.groupId || existingGroupId;
    }
  }

  const totalTurns = existingTurnCount + turnElements.length;
  const turnsToKeep = keepRounds * 2;
  const totalTurnsToDetach = Math.max(0, totalTurns - turnsToKeep);
  const additionalTurnsToDetach = Math.max(0, totalTurnsToDetach - existingTurnCount);
  const turnElementsToDetach = turnElements.slice(0, additionalTurnsToDetach);
  const firstKeptTurn = turnElements[additionalTurnsToDetach];
  const nextHtml = existingHtml.concat(turnElementsToDetach.map(turnEl => turnEl.outerHTML));
  const nextTurnCount = existingTurnCount + turnElementsToDetach.length;
  const roundCount = Math.floor(nextTurnCount / 2);

  if (additionalTurnsToDetach <= 0 && existingPlaceholder) {
    setPlaceholderContent(existingPlaceholder, {
      mode: CLEANUP_MODES.PERFORMANCE,
      hiddenRounds: roundCount,
      canExpand: !autoMaintainEnabled
    });
    existingPlaceholder.dataset.chcHiddenRounds = String(roundCount);
    return roundCount;
  }

  for (let index = 0; index < nextHtml.length; index += 1) {
    const turnSaveResponse = await sendRuntimeMessage({
      action: 'saveCollapsedTurn',
      groupId,
      index,
      html: nextHtml[index]
    });

    if (!turnSaveResponse?.success) {
      throw new Error(turnSaveResponse?.message || `Unable to save local snapshot turn ${index}`);
    }
  }

  const saveResponse = await sendRuntimeMessage({
    action: 'saveCollapsedSnapshot',
    groupId,
    conversationId,
    turnCount: nextTurnCount,
    roundCount,
    html: []
  });

  if (!saveResponse?.success) {
    throw new Error(saveResponse?.message || 'Unable to save local snapshot');
  }

  if (existingPlaceholder) {
    setPlaceholderContent(existingPlaceholder, {
      mode: CLEANUP_MODES.PERFORMANCE,
      hiddenRounds: roundCount,
      canExpand: !autoMaintainEnabled
    });
    existingPlaceholder.dataset.chcHiddenRounds = String(roundCount);
  } else {
    insertPlaceholder(
      turnElementsToDetach,
      firstKeptTurn,
      createPlaceholder({
        mode: CLEANUP_MODES.PERFORMANCE,
        groupId,
        hiddenRounds: roundCount,
        canExpand: !autoMaintainEnabled
      })
    );
  }

  turnElementsToDetach.forEach((turnEl) => turnEl.remove());

  return roundCount;
}

function removeOldTurns(turnElements, turnsToRemove) {
  removeExistingPlaceholders();
  turnElements.forEach(showTurn);

  const turnElementsToDelete = turnElements.slice(0, turnsToRemove);
  const firstKeptTurn = turnElements[turnsToRemove];
  const conversationId = getConversationId();
  const groupId = makeGroupId(conversationId);
  const removedRounds = Math.floor(turnElementsToDelete.length / 2);

  insertPlaceholder(
    turnElementsToDelete,
    firstKeptTurn,
    createPlaceholder({
      mode: CLEANUP_MODES.REMOVE,
      groupId,
      hiddenRounds: removedRounds,
      canExpand: false
    })
  );

  turnElementsToDelete.forEach(turnEl => {
    if (turnEl.parentNode) {
      turnEl.remove();
    }
  });

  return removedRounds;
}

async function limitOldRounds(keepRounds, cleanupMode) {
  let turnElements = findTurnElements();

  if (turnElements.length === 0) {
    return {
      success: false,
      message: getMessage('errorNotFound')
    };
  }

  const mode = Object.values(CLEANUP_MODES).includes(cleanupMode)
    ? cleanupMode
    : CLEANUP_MODES.SAFE;

  const existingPerformancePlaceholder = getExistingPerformancePlaceholder();
  if (mode !== CLEANUP_MODES.PERFORMANCE && existingPerformancePlaceholder) {
    await expandPerformancePlaceholder(existingPerformancePlaceholder);
    turnElements = findTurnElements();
  }

  const totalTurns = turnElements.length;
  const turnsToKeep = keepRounds * 2;
  const turnsToLimit = totalTurns - turnsToKeep;

  if (turnsToLimit <= 0) {
    const currentPerformancePlaceholder = getExistingPerformancePlaceholder();
    if (mode === CLEANUP_MODES.PERFORMANCE && currentPerformancePlaceholder) {
      const response = await sendRuntimeMessage({
        action: 'getCollapsedSnapshot',
        groupId: currentPerformancePlaceholder.dataset.chcGroupId
      });
      const hiddenRounds = response?.snapshot?.roundCount || 0;
      return {
        success: true,
        message: getMessage('successPerformanceDetailed', [hiddenRounds.toString(), keepRounds.toString()]),
        rounds: calculateRounds(turnElements)
      };
    }

    turnElements.forEach(showTurn);
    removeExistingPlaceholders();
    const currentRounds = calculateRounds(turnElements);
    return {
      success: true,
      message: getMessage('infoNoNeedClean', [currentRounds.toString()]),
      rounds: currentRounds
    };
  }

  let limitedRounds;
  if (mode === CLEANUP_MODES.PERFORMANCE) {
    limitedRounds = await collapsePerformanceTurns(turnElements, keepRounds);
  } else if (mode === CLEANUP_MODES.REMOVE) {
    limitedRounds = removeOldTurns(turnElements, turnsToLimit);
  } else {
    limitedRounds = collapseSafeTurns(turnElements, turnsToLimit);
  }

  const remainingRounds = Math.floor(turnsToKeep / 2);
  const messageKey = mode === CLEANUP_MODES.PERFORMANCE
    ? 'successPerformanceDetailed'
    : mode === CLEANUP_MODES.REMOVE
      ? 'successCleanedDetailed'
      : 'successCollapsedDetailed';

  return {
    success: true,
    message: getMessage(messageKey, [limitedRounds.toString(), remainingRounds.toString()]),
    rounds: remainingRounds
  };
}

async function removeOldRounds(keepRounds, cleanupMode) {
  try {
    const result = await limitOldRounds(keepRounds, cleanupMode);
    scheduleBadgeUpdate();
    return result;
  } catch (error) {
    console.error('Failed to limit old conversation rounds:', error);
    return {
      success: false,
      message: getMessage('errorCleanFailed') + error.message
    };
  }
}

function pauseAutoCleanup(durationMs) {
  autoCleanupPausedUntil = Date.now() + durationMs;
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
}

function scheduleAutoCleanup() {
  if (Date.now() < autoCleanupPausedUntil) return;
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    if (!autoMaintainEnabled) return;
    if (Date.now() < autoCleanupPausedUntil) return;
    const turnElements = findTurnElements();
    const turnsToKeep = autoMaintainKeepRounds * 2;
    if (turnElements.length > turnsToKeep) {
      limitOldRounds(autoMaintainKeepRounds, cleanupModeEnabled).catch((error) => {
        console.error('Auto-maintain failed:', error);
      }).finally(() => {
        scheduleBadgeUpdate();
      });
    }
  }, 500);
}

async function runAutoCleanupNow() {
  if (!autoMaintainEnabled) {
    scheduleBadgeUpdate();
    return { success: true, stats: getRoundStats() };
  }

  const result = await limitOldRounds(autoMaintainKeepRounds, cleanupModeEnabled);
  scheduleBadgeUpdate();
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
  if (wasEnabled !== enabled) {
    refreshPlaceholderInteractivity();
  }

  if (enabled) {
    startObserver();
    if (runImmediately) {
      return runAutoCleanupNow();
    }
    scheduleAutoCleanup();
  } else {
    stopObserver();
    scheduleBadgeUpdate();
  }
  return Promise.resolve({ success: true, stats: getRoundStats() });
}

let badgeTimer = null;
let domCheckTimer = null;

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

let badgeObserver = null;

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
  if (result.cleanupMode) {
    return result.cleanupMode;
  }
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
    const enabled = changes.autoMaintain
      ? changes.autoMaintain.newValue
      : autoMaintainEnabled;
    const rounds = changes.keepRounds
      ? changes.keepRounds.newValue
      : autoMaintainKeepRounds;
    const cleanupMode = changes.cleanupMode
      ? changes.cleanupMode.newValue
      : cleanupModeEnabled;
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
  const thread = findThread();
  if (thread) {
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
