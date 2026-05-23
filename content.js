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
let conversationPanel = null;
let conversationPanelState = {
  isOpen: false,
  activeTab: 'search',
  query: '',
  messages: []
};
let activeJumpToken = 0;
let activeHighlightTimer = null;
let extensionContextInvalidated = false;

function getMessage(key, substitutions = []) {
  if (extensionContextInvalidated || typeof chrome === 'undefined' || !chrome.i18n?.getMessage) {
    return '';
  }
  try {
    return chrome.i18n.getMessage(key, substitutions);
  } catch (error) {
    extensionContextInvalidated = true;
    return '';
  }
}

function sendRuntimeMessage(message) {
  if (extensionContextInvalidated || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return Promise.resolve();
  }
  try {
    return chrome.runtime.sendMessage(message);
  } catch (error) {
    extensionContextInvalidated = true;
    return Promise.resolve();
  }
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

function getTurnId(turnEl, index) {
  return turnEl.dataset.turnId ||
    turnEl.getAttribute('data-turn-id') ||
    turnEl.getAttribute('data-testid') ||
    `turn-${index}`;
}

function detectTurnRole(turnEl) {
  const roleEl = turnEl.querySelector('[data-message-author-role]');
  const role = roleEl?.getAttribute('data-message-author-role');
  if (role === 'user' || role === 'assistant' || role === 'system') return role;

  const testId = turnEl.getAttribute('data-testid') || '';
  const testIdMatch = testId.match(/conversation-turn-(\d+)/);
  if (testIdMatch) {
    const turnNumber = parseInt(testIdMatch[1], 10);
    if (!Number.isNaN(turnNumber)) {
      return turnNumber % 2 === 1 ? 'user' : 'assistant';
    }
  }

  return 'unknown';
}

function buildConversationRounds(turns) {
  const rounds = [];
  let currentRound = null;

  turns.forEach((turn) => {
    const role = detectTurnRole(turn);
    if (role === 'user' || !currentRound) {
      currentRound = [turn];
      rounds.push(currentRound);
      return;
    }
    currentRound.push(turn);
  });

  return rounds;
}

function countConversationRounds(turns) {
  return buildConversationRounds(turns).length;
}

function flattenRounds(rounds) {
  return rounds.reduce((allTurns, round) => allTurns.concat(round), []);
}

function sortTurnsByPageOrder(turns) {
  const order = new Map(findTurnElements().map((turn, index) => [turn, index]));
  return turns.slice().sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

function getTurnText(turnEl) {
  const messageEl = turnEl.querySelector('[data-message-author-role]') || turnEl;
  return (messageEl.innerText || messageEl.textContent || '').replace(/\s+/g, ' ').trim();
}

function getTurnHeadings(turnEl) {
  return Array.from(turnEl.querySelectorAll('h1, h2, h3, h4'))
    .map((heading) => (heading.innerText || heading.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 5);
}

function getCodeMarkers(turnEl) {
  return Array.from(turnEl.querySelectorAll('pre, code'))
    .map((codeEl) => {
      const language = codeEl.getAttribute('data-language') ||
        codeEl.className?.match(/language-([a-z0-9_-]+)/i)?.[1] ||
        '';
      const text = (codeEl.innerText || codeEl.textContent || '').trim();
      return language || text.split('\n')[0]?.slice(0, 40) || 'Code block';
    })
    .filter(Boolean)
    .slice(0, 5);
}

function buildMessageExtractor() {
  const turns = findTurnElements();
  return turns.map((turnEl, index) => {
    const role = detectTurnRole(turnEl);
    const text = getTurnText(turnEl);
    const headings = getTurnHeadings(turnEl);
    const codeMarkers = getCodeMarkers(turnEl);
    const imageCount = turnEl.querySelectorAll('img, picture, video').length;

    return {
      id: getTurnId(turnEl, index),
      index,
      role,
      text,
      preview: text.slice(0, 180),
      anchor: turnEl,
      isHidden: turnEl.dataset.chcHidden === 'true',
      markers: {
        headings,
        codeMarkers,
        imageCount,
        hasQuestion: role === 'user' && /[?？]\s*$/.test(text)
      }
    };
  }).filter((message) => message.text || message.markers.headings.length || message.markers.codeMarkers.length || message.markers.imageCount);
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
  const visibleRounds = countConversationRounds(getVisibleTurnElements());
  return {
    visibleRounds,
    totalRounds: visibleRounds + getPlaceholderHiddenRounds()
  };
}

function getTurnSelector() {
  return 'section[data-testid^="conversation-turn-"][data-turn-id], article';
}

function getSafeTurnLayoutElement(turnEl) {
  const thread = findThread();
  if (!thread || !turnEl || !thread.contains(turnEl)) return turnEl;

  const parent = turnEl.parentElement;
  if (!parent || parent === thread || !thread.contains(parent)) return turnEl;

  const siblingTurns = Array.from(parent.querySelectorAll(getTurnSelector()))
    .filter((candidate) => !candidate.dataset.chcPlaceholder);
  const hasComposerLikeContent = parent.querySelector('textarea, [contenteditable="true"], form');

  if (siblingTurns.length === 1 && siblingTurns[0] === turnEl && !hasComposerLikeContent) {
    return parent;
  }

  return turnEl;
}

function showTurn(turnEl) {
  delete turnEl.dataset.chcHidden;
  turnEl.dataset.chcRestoredVisual = 'true';
  turnEl.style.removeProperty('display');
  turnEl.style.overflowAnchor = 'none';

  const layoutEl = getSafeTurnLayoutElement(turnEl);
  if (layoutEl && layoutEl !== turnEl && layoutEl.dataset.chcHiddenLayout === 'true') {
    delete layoutEl.dataset.chcHiddenLayout;
    layoutEl.style.removeProperty('display');
    layoutEl.style.overflowAnchor = 'none';
  }
}

function hideTurn(turnEl) {
  turnEl.dataset.chcHidden = 'true';
  turnEl.style.display = 'none';
  turnEl.style.overflowAnchor = 'none';

  const layoutEl = getSafeTurnLayoutElement(turnEl);
  if (layoutEl && layoutEl !== turnEl) {
    layoutEl.dataset.chcHiddenLayout = 'true';
    layoutEl.style.display = 'none';
    layoutEl.style.overflowAnchor = 'none';
  }
}

function clearHiddenLayoutContainers() {
  document.querySelectorAll('[data-chc-hidden-layout="true"]').forEach((layoutEl) => {
    delete layoutEl.dataset.chcHiddenLayout;
    layoutEl.style.removeProperty('display');
    layoutEl.style.overflowAnchor = 'none';
  });
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

function setPlaceholderContent(placeholder, { mode, hiddenTurns, hiddenRounds }) {
  const hiddenRoundCount = hiddenRounds ?? (parseInt(placeholder.dataset.chcHiddenRounds || '0', 10) || Math.ceil(hiddenTurns / 2));
  const canExpand = mode !== CLEANUP_MODES.REMOVE && !autoMaintainEnabled && hiddenTurns > 0;
  const modeLabelKey = mode === CLEANUP_MODES.REMOVE
      ? 'removedOlderMessages'
      : 'hiddenOlderMessages';

  placeholder.dataset.chcHiddenTurns = String(hiddenTurns);
  placeholder.dataset.chcHiddenRounds = String(hiddenRoundCount);
  placeholder.textContent = getMessage(modeLabelKey, [hiddenRoundCount.toString()]);

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

function createPlaceholder({ mode, hiddenTurns, hiddenRounds }) {
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

  setPlaceholderContent(placeholder, { mode, hiddenTurns, hiddenRounds });
  return placeholder;
}

function ensurePlaceholder({ mode, hiddenTurns, hiddenRounds, beforeTurn }) {
  let placeholder = getPlaceholderForMode(mode);
  if (!placeholder) {
    placeholder = createPlaceholder({ mode, hiddenTurns, hiddenRounds });
    const parent = beforeTurn?.parentNode || findThread();
    if (parent) parent.insertBefore(placeholder, beforeTurn || parent.firstChild);
  }
  setPlaceholderContent(placeholder, { mode, hiddenTurns, hiddenRounds });
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
      hiddenTurns: getPlaceholderHiddenTurns(placeholder),
      hiddenRounds: parseInt(placeholder.dataset.chcHiddenRounds || '0', 10) || 0
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
    const beforeTurn = getSafeTurnLayoutElement(firstHiddenTurn) || firstHiddenTurn;
    const nextHiddenTurns = sortTurnsByPageOrder([...this.hiddenTurns(), ...turns]);
    const placeholder = ensurePlaceholder({
      mode: this.mode,
      hiddenTurns: nextHiddenTurns.length,
      hiddenRounds: countConversationRounds(nextHiddenTurns),
      beforeTurn
    });
    turns.forEach((turn) => {
      hideTurn(turn);
    });
    setPlaceholderContent(placeholder, {
      mode: this.mode,
      hiddenTurns: this.hiddenCount(),
      hiddenRounds: countConversationRounds(this.hiddenTurns())
    });
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
      setPlaceholderContent(placeholder, {
        mode: this.mode,
        hiddenTurns: hiddenCount,
        hiddenRounds: countConversationRounds(this.hiddenTurns())
      });
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
    const hiddenRounds = getPlaceholderHiddenRounds() + countConversationRounds(turns);
    ensurePlaceholder({
      mode: this.mode,
      hiddenTurns,
      hiddenRounds,
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
  const visibleRounds = buildConversationRounds(visibleTurns);
  if (visibleRounds.length > keepRounds) {
    const turnsToStore = flattenRounds(visibleRounds.slice(0, visibleRounds.length - keepRounds));
    await store.store(turnsToStore);
  } else if (visibleRounds.length < keepRounds && hiddenCount > 0 && typeof store.hiddenTurns === 'function') {
    const hiddenRounds = buildConversationRounds(store.hiddenTurns());
    const roundsToRestore = hiddenRounds.slice(-(keepRounds - visibleRounds.length));
    await store.restore(flattenRounds(roundsToRestore).length);
  } else {
    const placeholder = getPlaceholderForMode(mode);
    if (placeholder) {
      const currentHiddenCount = await store.hiddenCount();
      if (currentHiddenCount > 0) {
        const currentHiddenTurns = typeof store.hiddenTurns === 'function' ? store.hiddenTurns() : [];
        setPlaceholderContent(placeholder, {
          mode,
          hiddenTurns: currentHiddenCount,
          hiddenRounds: currentHiddenTurns.length > 0
            ? countConversationRounds(currentHiddenTurns)
            : getPlaceholderHiddenRounds()
        });
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

  console.error(`[ChatGPT Conversation Toolkit] DOM structure may have changed.\nSample: ${sample}`);
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

function ensureConversationPanelStyles() {
  if (document.getElementById('chc-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'chc-panel-styles';
  style.textContent = `
    .chc-panel-toggle {
      align-items: center;
      background: #111827;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 999px;
      bottom: 88px;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.22);
      color: #fff;
      cursor: pointer;
      display: flex;
      font: 700 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      gap: 6px;
      min-height: 36px;
      padding: 0 12px;
      position: fixed;
      right: 18px;
      z-index: 2147483600;
    }
    .chc-panel {
      background: #fff;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      bottom: 88px;
      box-shadow: 0 18px 46px rgba(15, 23, 42, 0.24);
      color: #111827;
      display: none;
      flex-direction: column;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      max-height: min(620px, calc(100vh - 126px));
      overflow: hidden;
      position: fixed;
      right: 18px;
      width: min(360px, calc(100vw - 36px));
      z-index: 2147483601;
    }
    .chc-panel[data-open="true"] {
      display: flex;
    }
    .chc-panel-header {
      align-items: center;
      border-bottom: 1px solid #e5e7eb;
      display: flex;
      justify-content: space-between;
      padding: 10px 10px 8px;
    }
    .chc-panel-title {
      display: grid;
      gap: 1px;
    }
    .chc-panel-title strong {
      font-size: 13px;
      line-height: 1.2;
    }
    .chc-panel-title span {
      color: #6b7280;
      font-size: 11px;
    }
    .chc-icon-button {
      align-items: center;
      background: #f3f4f6;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      color: #374151;
      cursor: pointer;
      display: inline-flex;
      height: 28px;
      justify-content: center;
      width: 28px;
    }
    .chc-tabs {
      border-bottom: 1px solid #e5e7eb;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
    }
    .chc-tab {
      background: #fff;
      border: 0;
      border-bottom: 2px solid transparent;
      color: #4b5563;
      cursor: pointer;
      font: 700 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 9px 6px;
    }
    .chc-tab[data-active="true"] {
      border-bottom-color: #2563eb;
      color: #1d4ed8;
    }
    .chc-panel-body {
      display: grid;
      gap: 8px;
      overflow: auto;
      padding: 10px;
    }
    .chc-search-input {
      border: 1px solid #d1d5db;
      border-radius: 7px;
      color: #111827;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 8px 9px;
      width: 100%;
    }
    .chc-search-input:focus {
      border-color: #2563eb;
      outline: 2px solid rgba(37, 99, 235, 0.14);
    }
    .chc-result-list {
      display: grid;
      gap: 6px;
    }
    .chc-result {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 7px;
      cursor: pointer;
      display: grid;
      gap: 3px;
      padding: 8px;
      text-align: left;
    }
    .chc-result:hover {
      background: #eef6ff;
      border-color: #93c5fd;
    }
    .chc-result-meta {
      align-items: center;
      color: #6b7280;
      display: flex;
      font-size: 10px;
      font-weight: 700;
      gap: 5px;
      text-transform: uppercase;
    }
    .chc-result-preview {
      color: #111827;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .chc-outline-items {
      border-top: 1px solid #e5e7eb;
      display: grid;
      gap: 4px;
      margin-top: 5px;
      padding-top: 6px;
    }
    .chc-outline-item {
      color: #4b5563;
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .chc-muted {
      color: #6b7280;
      font-size: 12px;
      padding: 8px 2px;
    }
    .chc-nav-grid {
      display: grid;
      gap: 8px;
      grid-template-columns: 1fr 1fr;
    }
    .chc-nav-button {
      background: #f3f4f6;
      border: 1px solid #d1d5db;
      border-radius: 7px;
      color: #111827;
      cursor: pointer;
      font: 700 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      min-height: 36px;
      padding: 8px;
    }
    .chc-nav-button:hover {
      background: #e5e7eb;
    }
    .chc-highlight {
      outline: 2px solid #2563eb;
      outline-offset: 3px;
      transition: outline-color 0.2s ease;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function getPanelText(key) {
  const fallback = {
    panelButton: 'Conversation',
    panelTitle: 'Conversation Tools',
    panelSubtitle: 'Search, outline, and navigation',
    panelClose: 'Close',
    panelSearch: 'Search',
    panelOutline: 'Outline',
    panelNavigation: 'Navigation',
    panelSearchPlaceholder: 'Search messages',
    panelSearchEmpty: 'Type to search loaded messages.',
    panelSearchNoResults: 'No results in currently loaded messages.',
    panelOutlineEmpty: 'No outline items found yet.',
    panelJumpLatest: 'Latest',
    panelJumpOldest: 'Oldest visible',
    panelRefresh: 'Refresh',
    panelHidden: 'Hidden',
    panelAssistant: 'Assistant',
    panelUser: 'User',
    panelUnknown: 'Message',
    panelMessageCount: '$1 loaded messages indexed'
  };
  return getMessage(key) || fallback[key] || key;
}

function ensureConversationPanel() {
  if (conversationPanel) return conversationPanel;
  ensureConversationPanelStyles();

  const toggle = document.createElement('button');
  toggle.className = 'chc-panel-toggle';
  toggle.type = 'button';
  toggle.textContent = panelButtonText();
  toggle.addEventListener('click', () => setConversationPanelOpen(!conversationPanelState.isOpen));

  const panel = document.createElement('aside');
  panel.className = 'chc-panel';
  panel.dataset.open = 'false';
  panel.setAttribute('aria-label', getPanelText('panelTitle'));
  panel.innerHTML = `
    <div class="chc-panel-header">
      <div class="chc-panel-title">
        <strong></strong>
        <span></span>
      </div>
      <button class="chc-icon-button" type="button" title="${escapeHtml(getPanelText('panelClose'))}" aria-label="${escapeHtml(getPanelText('panelClose'))}">x</button>
    </div>
    <div class="chc-tabs" role="tablist"></div>
    <div class="chc-panel-body"></div>
  `;

  panel.querySelector('.chc-panel-title strong').textContent = getPanelText('panelTitle');
  panel.querySelector('.chc-panel-title span').textContent = getPanelText('panelSubtitle');
  panel.querySelector('.chc-icon-button').addEventListener('click', () => setConversationPanelOpen(false));

  (document.body || document.documentElement).appendChild(toggle);
  (document.body || document.documentElement).appendChild(panel);
  conversationPanel = { toggle, panel };
  renderConversationPanel();
  return conversationPanel;
}

function panelButtonText() {
  return `Menu ${getPanelText('panelButton')}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function setConversationPanelOpen(isOpen) {
  ensureConversationPanel();
  conversationPanelState.isOpen = isOpen;
  conversationPanel.panel.dataset.open = String(isOpen);
  conversationPanel.toggle.style.display = isOpen ? 'none' : 'flex';
  if (isOpen) refreshConversationPanelMessages();
}

function refreshConversationPanelMessages() {
  conversationPanelState.messages = buildMessageExtractor();
  renderConversationPanel();
}

function scheduleConversationPanelRefresh() {
  if (!conversationPanel || !conversationPanelState.isOpen) return;
  refreshConversationPanelMessages();
}

function removeConversationPanel() {
  if (!conversationPanel) return;
  conversationPanel.toggle.remove();
  conversationPanel.panel.remove();
  conversationPanel = null;
  conversationPanelState.isOpen = false;
}

function renderConversationPanel() {
  if (!conversationPanel) return;
  const tabs = [
    { id: 'search', label: getPanelText('panelSearch') },
    { id: 'outline', label: getPanelText('panelOutline') },
    { id: 'navigation', label: getPanelText('panelNavigation') }
  ];
  const tabsEl = conversationPanel.panel.querySelector('.chc-tabs');
  tabsEl.textContent = '';
  tabs.forEach((tab) => {
    const button = document.createElement('button');
    button.className = 'chc-tab';
    button.type = 'button';
    button.dataset.active = String(conversationPanelState.activeTab === tab.id);
    button.textContent = tab.label;
    button.addEventListener('click', () => {
      conversationPanelState.activeTab = tab.id;
      renderConversationPanel();
    });
    tabsEl.appendChild(button);
  });

  const body = conversationPanel.panel.querySelector('.chc-panel-body');
  body.textContent = '';
  if (conversationPanelState.activeTab === 'search') renderSearchView(body);
  if (conversationPanelState.activeTab === 'outline') renderOutlineView(body);
  if (conversationPanelState.activeTab === 'navigation') renderNavigationView(body);
}

function renderSearchView(body) {
  const input = document.createElement('input');
  input.className = 'chc-search-input';
  input.type = 'search';
  input.placeholder = getPanelText('panelSearchPlaceholder');
  input.value = conversationPanelState.query;
  input.addEventListener('input', () => {
    conversationPanelState.query = input.value;
    renderConversationPanel();
    requestAnimationFrame(() => {
      const nextInput = conversationPanel?.panel.querySelector('.chc-search-input');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length);
      }
    });
  });
  body.appendChild(input);

  const query = conversationPanelState.query.trim().toLowerCase();
  if (!query) {
    appendMuted(body, getPanelText('panelSearchEmpty'));
    return;
  }

  const results = conversationPanelState.messages
    .filter((message) => message.text.toLowerCase().includes(query))
    .slice(0, 30);

  if (results.length === 0) {
    appendMuted(body, getPanelText('panelSearchNoResults'));
    return;
  }

  appendResultList(body, results.map((message) => ({
    message,
    title: message.preview || getPanelText('panelUnknown'),
    meta: [roleLabel(message.role), `#${message.index + 1}`, message.isHidden ? getPanelText('panelHidden') : ''].filter(Boolean)
  })));
}

function renderOutlineView(body) {
  const groups = buildOutlineGroups(conversationPanelState.messages).slice(0, 50);
  if (groups.length === 0) {
    appendMuted(body, getPanelText('panelOutlineEmpty'));
    return;
  }
  appendOutlineList(body, groups);
}

function renderNavigationView(body) {
  const grid = document.createElement('div');
  grid.className = 'chc-nav-grid';

  const oldestButton = createNavButton(getPanelText('panelJumpOldest'), () => {
    const first = getVisibleTurnElements()[0];
    if (first) jumpToMessageAnchor(first);
  });
  const latestButton = createNavButton(getPanelText('panelJumpLatest'), () => {
    const visible = getVisibleTurnElements();
    const last = visible[visible.length - 1];
    if (last) jumpToMessageAnchor(last);
  });
  const refreshButton = createNavButton(getPanelText('panelRefresh'), refreshConversationPanelMessages);

  grid.appendChild(oldestButton);
  grid.appendChild(latestButton);
  body.appendChild(grid);
  body.appendChild(refreshButton);
  appendMuted(body, getMessage('panelMessageCount', [String(conversationPanelState.messages.length)]) ||
    `${conversationPanelState.messages.length} messages indexed`);
}

function createNavButton(label, onClick) {
  const button = document.createElement('button');
  button.className = 'chc-nav-button';
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function buildOutlineGroups(messages) {
  const groups = [];
  messages.forEach((message) => {
    const details = [];

    if (message.role === 'assistant') {
      message.markers.headings.forEach((heading) => {
        details.push(`Heading: ${heading}`);
      });
    }

    message.markers.codeMarkers.forEach((marker) => {
      details.push(`Code: ${marker}`);
    });

    if (message.markers.imageCount > 0) {
      details.push(`Media: ${message.markers.imageCount} item(s)`);
    }

    if (message.role === 'user' && message.text) {
      groups.push({
        message,
        title: `? ${message.preview}`,
        meta: [roleLabel(message.role), `#${message.index + 1}`],
        details: []
      });
      return;
    }

    if (details.length > 0) {
      const firstHeading = message.markers.headings[0];
      groups.push({
        message,
        title: firstHeading || message.preview || getPanelText('panelUnknown'),
        meta: [roleLabel(message.role), `#${message.index + 1}`],
        details: firstHeading ? details.slice(1) : details
      });
    }
  });
  return groups;
}

function appendResultList(body, items) {
  const list = document.createElement('div');
  list.className = 'chc-result-list';
  items.forEach((item) => {
    const button = document.createElement('button');
    button.className = 'chc-result';
    button.type = 'button';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      jumpToMessage(item.message);
    });

    const meta = document.createElement('div');
    meta.className = 'chc-result-meta';
    meta.textContent = item.meta.join(' · ');

    const preview = document.createElement('div');
    preview.className = 'chc-result-preview';
    preview.textContent = item.title;

    button.appendChild(meta);
    button.appendChild(preview);
    list.appendChild(button);
  });
  body.appendChild(list);
}

function appendOutlineList(body, groups) {
  const list = document.createElement('div');
  list.className = 'chc-result-list';
  groups.forEach((group) => {
    const button = document.createElement('button');
    button.className = 'chc-result';
    button.type = 'button';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      jumpToMessage(group.message);
    });

    const meta = document.createElement('div');
    meta.className = 'chc-result-meta';
    meta.textContent = group.meta.join(' · ');

    const preview = document.createElement('div');
    preview.className = 'chc-result-preview';
    preview.textContent = group.title;

    button.appendChild(meta);
    button.appendChild(preview);

    if (group.details.length > 0) {
      const detailList = document.createElement('div');
      detailList.className = 'chc-outline-items';
      group.details.slice(0, 8).forEach((detail) => {
        const detailEl = document.createElement('div');
        detailEl.className = 'chc-outline-item';
        detailEl.textContent = detail;
        detailList.appendChild(detailEl);
      });
      button.appendChild(detailList);
    }

    list.appendChild(button);
  });
  body.appendChild(list);
}

function appendMuted(body, text) {
  const el = document.createElement('div');
  el.className = 'chc-muted';
  el.textContent = text;
  body.appendChild(el);
}

function roleLabel(role) {
  if (role === 'assistant') return getPanelText('panelAssistant');
  if (role === 'user') return getPanelText('panelUser');
  return getPanelText('panelUnknown');
}

function findMessageAnchor(message) {
  if (!message) return null;
  const turns = findTurnElements();
  const byId = turns.find((turnEl, index) => getTurnId(turnEl, index) === message.id);
  if (byId) return byId;
  return turns[message.index] || message.anchor || null;
}

function suppressScrollAnchoring(duration = 1800) {
  const elements = [document.documentElement, document.body, findThread()].filter(Boolean);
  const previous = elements.map((element) => element.style.overflowAnchor);
  elements.forEach((element) => {
    element.style.overflowAnchor = 'none';
  });
  setTimeout(() => {
    elements.forEach((element, index) => {
      if (previous[index]) {
        element.style.overflowAnchor = previous[index];
      } else {
        element.style.removeProperty('overflow-anchor');
      }
    });
  }, duration);
}

function jumpToMessage(message) {
  const token = ++activeJumpToken;
  suppressScrollAnchoring();

  const run = (attempt) => {
    if (token !== activeJumpToken) return;
    const anchor = findMessageAnchor(message);
    if (!anchor) return;
    jumpToMessageAnchor(anchor, attempt);
    if (attempt < 5) {
      const delay = [80, 160, 280, 460, 720][attempt] || 720;
      setTimeout(() => run(attempt + 1), delay);
    }
  };

  run(0);
}

function jumpToMessageAnchor(anchor, attempt = 0) {
  if (!anchor) return;
  if (anchor.dataset.chcHidden === 'true') {
    const placeholder = getPlaceholderForMode(CLEANUP_MODES.SAFE);
    if (placeholder) {
      placeholder.scrollIntoView({ block: 'center', behavior: 'auto' });
      return;
    }
  }
  anchor.style.scrollMarginTop = '96px';
  anchor.style.scrollMarginBottom = '96px';
  anchor.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });

  const rect = anchor.getBoundingClientRect();
  const viewportCenter = window.innerHeight / 2;
  const anchorCenter = rect.top + rect.height / 2;
  const delta = anchorCenter - viewportCenter;
  if (attempt > 0 && Math.abs(delta) > 24) {
    const scrollRoot = getScrollRoot();
    if (scrollRoot) {
      scrollRoot.scrollTop += delta;
    } else {
      window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
    }
  }

  if (activeHighlightTimer) clearTimeout(activeHighlightTimer);
  document.querySelectorAll('.chc-highlight').forEach((element) => {
    element.classList.remove('chc-highlight');
  });
  anchor.classList.add('chc-highlight');
  activeHighlightTimer = setTimeout(() => {
    anchor.classList.remove('chc-highlight');
    activeHighlightTimer = null;
  }, 1800);
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
          scheduleConversationPanelRefresh();
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
    clearHiddenLayoutContainers();
    const result = await chrome.storage.local.get({
      autoMaintain: false,
      keepRounds: 10,
      cleanupMode: CLEANUP_MODES.SAFE,
      collapseOldMessages: true,
      conversationToolsEnabled: false
    });
    updateAutoMaintain(result.autoMaintain, result.keepRounds, resolveCleanupMode(result));
    startBadgeObserver();
    if (result.conversationToolsEnabled) {
      ensureConversationPanel();
      refreshConversationPanelMessages();
    }
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

  if (changes.conversationToolsEnabled) {
    if (changes.conversationToolsEnabled.newValue) {
      ensureConversationPanel();
      refreshConversationPanelMessages();
    } else {
      removeConversationPanel();
    }
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
