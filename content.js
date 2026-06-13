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
  messages: [],
  bookmarks: [],
  results: [],
  currentResultIndex: -1,
  searchLimitReached: false
};
let activeJumpToken = 0;
let activeHighlightTimer = null;
let searchDebounceTimer = null;
let navigatorRevealedTurn = null;
let loadedBookmarksConversationId = '';
let extensionContextInvalidated = false;
const bookmarkBubbleSlots = new WeakMap();
const bookmarkBubbleResizeObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        const slot = bookmarkBubbleSlots.get(entry.target);
        if (slot?.isConnected) {
          alignUserBookmarkSlot(slot, entry.target);
        } else {
          bookmarkBubbleResizeObserver.unobserve(entry.target);
          bookmarkBubbleSlots.delete(entry.target);
        }
      });
    })
  : null;
const SEARCH_MATCH_LIMIT = 100;
const SEARCH_HIGHLIGHT_NAME = 'chc-search-match';
const SEARCH_CURRENT_HIGHLIGHT_NAME = 'chc-search-current';
const BOOKMARKS_STORAGE_KEY = 'conversationBookmarks';

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
  const textParts = [];
  const walker = document.createTreeWalker(messageEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest(
          'button, [role="button"], .chc-bookmark-button, .chc-panel, .chc-panel-toggle'
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  while (walker.nextNode()) {
    textParts.push(walker.currentNode.nodeValue);
  }
  return stripTurnRoleLabel(textParts.join(' ').replace(/\s+/g, ' ').trim());
}

function stripTurnRoleLabel(text) {
  return String(text || '')
    .replace(/^(?:ChatGPT\s+(?:说|said)|你说|You said)\s*[:：]\s*/i, '')
    .trim();
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

function getConversationId() {
  const match = location.pathname.match(/^\/c\/([^/?#]+)/);
  return match?.[1] || location.pathname || 'current-conversation';
}

function getBookmarkKey(conversationId, messageId) {
  return `${conversationId}::${messageId}`;
}

async function loadConversationBookmarks() {
  try {
    const result = await chrome.storage.local.get({ [BOOKMARKS_STORAGE_KEY]: [] });
    const allBookmarks = Array.isArray(result[BOOKMARKS_STORAGE_KEY])
      ? result[BOOKMARKS_STORAGE_KEY]
      : [];
    const conversationId = getConversationId();
    loadedBookmarksConversationId = conversationId;
    conversationPanelState.bookmarks = allBookmarks
      .filter((bookmark) => bookmark.conversationId === conversationId)
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch (error) {
    conversationPanelState.bookmarks = [];
  }
  syncBookmarkButtons();
}

async function saveConversationBookmarks(nextConversationBookmarks) {
  const result = await chrome.storage.local.get({ [BOOKMARKS_STORAGE_KEY]: [] });
  const allBookmarks = Array.isArray(result[BOOKMARKS_STORAGE_KEY])
    ? result[BOOKMARKS_STORAGE_KEY]
    : [];
  const conversationId = getConversationId();
  const otherBookmarks = allBookmarks.filter((bookmark) => bookmark.conversationId !== conversationId);
  conversationPanelState.bookmarks = nextConversationBookmarks
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp);
  await chrome.storage.local.set({
    [BOOKMARKS_STORAGE_KEY]: [...otherBookmarks, ...conversationPanelState.bookmarks]
  });
  syncBookmarkButtons();
  renderConversationPanel();
}

function findBookmark(messageId) {
  const conversationId = getConversationId();
  return conversationPanelState.bookmarks.find(
    (bookmark) => bookmark.key === getBookmarkKey(conversationId, messageId)
  ) || null;
}

function getCurrentMessage(message) {
  if (!message) return null;
  const messages = buildMessageExtractor();
  return messages.find((current) => current.id === message.id) ||
    messages[message.index] ||
    message;
}

async function toggleMessageBookmark(message) {
  if (loadedBookmarksConversationId !== getConversationId()) {
    await loadConversationBookmarks();
  }
  const currentMessage = getCurrentMessage(message);
  if (!currentMessage) return;
  const conversationId = getConversationId();
  const key = getBookmarkKey(conversationId, currentMessage.id);
  const existing = findBookmark(currentMessage.id);
  const nextBookmarks = existing
    ? conversationPanelState.bookmarks.filter((bookmark) => bookmark.key !== key)
    : [{
      key,
      conversationId,
      messageId: currentMessage.id,
      messageIndex: currentMessage.index,
      role: currentMessage.role,
      preview: currentMessage.preview ||
        (currentMessage.markers.imageCount > 0
          ? getPanelText('bookmarkImagePreview')
          : currentMessage.text.slice(0, 180)),
      timestamp: Date.now()
    }, ...conversationPanelState.bookmarks];
  await saveConversationBookmarks(nextBookmarks);
}

function ensureBookmarkButtons() {
  ensureConversationPanelStyles();
  buildMessageExtractor().forEach((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return;
    const anchor = findMessageAnchor(message);
    if (!anchor) return;
    if (!message.text && message.markers.imageCount > 0) {
      anchor.querySelector('.chc-bookmark-slot')?.remove();
      return;
    }
    const slot = ensureBookmarkSlot(anchor, message.role);
    const existingButton = anchor.querySelector('.chc-bookmark-button');
    if (existingButton) {
      if (existingButton.parentElement !== slot) {
        slot.appendChild(existingButton);
      }
      return;
    }
    const button = document.createElement('button');
    button.className = 'chc-bookmark-button';
    button.type = 'button';
    button.dataset.messageId = message.id;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleMessageBookmark(message).catch(() => {});
    });
    slot.appendChild(button);
  });
  syncBookmarkButtons();
}

function ensureBookmarkSlot(anchor, role) {
  const messageContainer = anchor.querySelector('[data-message-author-role]') || anchor;
  const copyButton = Array.from(anchor.querySelectorAll('button')).find((button) => {
    const label = button.getAttribute('aria-label') || button.getAttribute('title') || '';
    return /^(?:复制(?:消息|回复)?|Copy(?: message| response)?)$/i.test(label.trim()) &&
      !button.closest('pre, code');
  });
  let slot = anchor.querySelector('.chc-bookmark-slot');
  if (!slot) {
    slot = document.createElement('div');
    slot.className = 'chc-bookmark-slot';
  }
  slot.dataset.role = role;

  let actionBranch = messageContainer.contains(copyButton)
    ? (copyButton.closest('[role="group"]') || copyButton)
    : null;
  while (actionBranch?.parentElement && actionBranch.parentElement !== messageContainer) {
    actionBranch = actionBranch.parentElement;
  }

  if (actionBranch?.parentElement === messageContainer) {
    if (slot.parentElement !== messageContainer || slot.nextElementSibling !== actionBranch) {
      messageContainer.insertBefore(slot, actionBranch);
    }
  } else {
    if (slot.parentElement !== messageContainer) {
      messageContainer.appendChild(slot);
    }
  }
  if (role === 'user') {
    observeUserBookmarkBubble(messageContainer, slot);
  } else {
    resetBookmarkSlotAlignment(slot);
  }
  return slot;
}

function findUserMessageBubble(messageContainer) {
  const containerRect = messageContainer.getBoundingClientRect();
  const candidates = Array.from(messageContainer.querySelectorAll('div')).filter((element) => {
    if (element.closest('.chc-bookmark-slot')) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.width > containerRect.width) return false;
    const style = getComputedStyle(element);
    const background = style.backgroundColor;
    const hasBackground = background &&
      background !== 'transparent' &&
      background !== 'rgba(0, 0, 0, 0)';
    const radius = parseFloat(style.borderTopLeftRadius) || 0;
    return hasBackground && radius >= 12 && (element.innerText || '').trim();
  });

  return candidates.sort((a, b) => {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    return bRect.width * bRect.height - aRect.width * aRect.height;
  })[0] || null;
}

function alignUserBookmarkSlot(slot, bubble) {
  if (!slot?.isConnected || !bubble?.isConnected) return;
  const container = slot.parentElement;
  if (!container) return;
  const containerRect = container.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  const rightOffset = Math.max(0, containerRect.right - bubbleRect.right);
  slot.style.width = `${Math.round(bubbleRect.width)}px`;
  slot.style.marginInlineEnd = `${Math.round(rightOffset)}px`;
}

function resetBookmarkSlotAlignment(slot) {
  slot.style.removeProperty('width');
  slot.style.removeProperty('margin-inline-end');
}

function observeUserBookmarkBubble(messageContainer, slot) {
  const bubble = findUserMessageBubble(messageContainer);
  if (!bubble) {
    resetBookmarkSlotAlignment(slot);
    return;
  }
  alignUserBookmarkSlot(slot, bubble);
  if (bookmarkBubbleResizeObserver && bookmarkBubbleSlots.get(bubble) !== slot) {
    bookmarkBubbleSlots.set(bubble, slot);
    bookmarkBubbleResizeObserver.observe(bubble);
  }
}

function refreshBookmarkContext() {
  if (loadedBookmarksConversationId !== getConversationId()) {
    loadConversationBookmarks().then(() => {
      ensureBookmarkButtons();
      renderConversationPanel();
    });
    return;
  }
  ensureBookmarkButtons();
}

function syncBookmarkButtons() {
  document.querySelectorAll('.chc-bookmark-button').forEach((button) => {
    const bookmarked = Boolean(findBookmark(button.dataset.messageId));
    button.dataset.bookmarked = String(bookmarked);
    button.textContent = bookmarked
      ? `⭐ ${getPanelText('bookmarkRemoveAction')}`
      : `☆ ${getPanelText('bookmarkAddAction')}`;
    const actionLabel = bookmarked
      ? getPanelText('bookmarkCancelAction')
      : getPanelText('bookmarkAddAction');
    button.title = actionLabel;
    button.setAttribute('aria-label', actionLabel);
  });
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

function revealHiddenTurnForNavigator(turnEl) {
  clearNavigatorReveal();
  if (!turnEl || turnEl.dataset.chcHidden !== 'true') return;

  navigatorRevealedTurn = turnEl;
  turnEl.dataset.chcNavigatorRevealed = 'true';
  turnEl.style.removeProperty('display');
  turnEl.style.overflowAnchor = 'none';

  const layoutEl = getSafeTurnLayoutElement(turnEl);
  if (layoutEl && layoutEl !== turnEl) {
    layoutEl.dataset.chcNavigatorRevealedLayout = 'true';
    layoutEl.style.removeProperty('display');
    layoutEl.style.overflowAnchor = 'none';
  }
}

function clearNavigatorReveal() {
  if (!navigatorRevealedTurn) return;
  const turnEl = navigatorRevealedTurn;
  navigatorRevealedTurn = null;

  delete turnEl.dataset.chcNavigatorRevealed;
  if (turnEl.dataset.chcHidden === 'true') {
    turnEl.style.display = 'none';
  }

  const layoutEl = getSafeTurnLayoutElement(turnEl);
  if (layoutEl && layoutEl !== turnEl && layoutEl.dataset.chcNavigatorRevealedLayout === 'true') {
    delete layoutEl.dataset.chcNavigatorRevealedLayout;
    if (layoutEl.dataset.chcHiddenLayout === 'true') {
      layoutEl.style.display = 'none';
    }
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
  if (node.closest?.('.chc-bookmark-slot, .chc-bookmark-button, .chc-panel, .chc-panel-toggle')) return false;

  const isTurnSection =
    node.matches?.('section[data-testid^="conversation-turn-"][data-turn-id]') ||
    node.querySelector?.('section[data-testid^="conversation-turn-"][data-turn-id]');
  const containsAsyncMedia =
    (node.matches?.('img, picture, video') || node.querySelector?.('img, picture, video')) &&
    node.closest?.('section[data-testid^="conversation-turn-"][data-turn-id], article');

  return (
    node.id === 'thread' ||
    node.tagName === 'ARTICLE' ||
    node.querySelector?.('#thread') ||
    node.querySelector?.('article') ||
    isTurnSection ||
    containsAsyncMedia
  );
}

function isTurnRelatedMutation(mutation) {
  if (mutation.type !== 'childList') return false;
  const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
  if (changedNodes.some(isTurnRelatedNode)) return true;

  const target = mutation.target.nodeType === Node.ELEMENT_NODE
    ? mutation.target
    : mutation.target.parentElement;
  if (!target?.closest?.('section[data-testid^="conversation-turn-"][data-turn-id], article')) {
    return false;
  }
  if (target.closest('.chc-bookmark-slot, .chc-bookmark-button, .chc-panel, .chc-panel-toggle')) {
    return false;
  }
  return changedNodes.some((node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !element?.closest?.(
      '.chc-bookmark-slot, .chc-bookmark-button, .chc-panel, .chc-panel-toggle'
    );
  });
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
  clearNavigatorReveal();
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
      display: flex;
      font: 700 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      min-height: 36px;
      overflow: hidden;
      position: fixed;
      right: 18px;
      z-index: 2147483600;
    }
    .chc-panel-toggle button {
      align-items: center;
      background: transparent;
      border: 0;
      color: inherit;
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      min-height: 34px;
    }
    .chc-panel-toggle-open {
      padding: 0 12px;
    }
    .chc-panel-toggle:hover .chc-panel-toggle-open,
    .chc-panel-toggle:focus-within .chc-panel-toggle-open {
      padding-right: 4px;
    }
    .chc-panel-toggle-dismiss {
      display: none !important;
      font-size: 15px !important;
      padding: 0 12px 0 4px;
    }
    .chc-panel-toggle:hover .chc-panel-toggle-dismiss,
    .chc-panel-toggle:focus-within .chc-panel-toggle-dismiss {
      display: inline-flex !important;
    }
    .chc-panel-toggle-dismiss:hover,
    .chc-panel-toggle-dismiss:focus-visible {
      color: #fca5a5;
    }
    .chc-panel-toggle button:focus-visible {
      outline: 2px solid #93c5fd;
      outline-offset: -3px;
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
      width: min(400px, calc(100vw - 36px));
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
      grid-template-columns: 1fr 1fr;
    }
    .chc-tab {
      background: #fff;
      border: 0;
      border-bottom: 2px solid transparent;
      color: #6b7280;
      cursor: pointer;
      font: 800 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 9px 8px;
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
    .chc-search-controls {
      align-items: center;
      display: grid;
      gap: 6px;
      grid-template-columns: 1fr auto auto auto;
    }
    .chc-search-count {
      color: #4b5563;
      font-size: 12px;
      font-weight: 700;
    }
    .chc-result-list {
      display: grid;
      gap: 7px;
    }
    .chc-result {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      color: #111827;
      cursor: pointer;
      display: grid;
      gap: 5px;
      padding: 9px;
      text-align: left;
      width: 100%;
    }
    .chc-result:hover {
      background: #eef6ff;
      border-color: #93c5fd;
    }
    .chc-result[data-active="true"] {
      background: #eff6ff;
      border-color: #2563eb;
      box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.12);
    }
    .chc-result-meta {
      align-items: center;
      color: #6b7280;
      display: flex;
      flex-wrap: wrap;
      font-size: 10px;
      font-weight: 800;
      gap: 6px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .chc-result-role {
      color: #1d4ed8;
    }
    .chc-result-hidden {
      color: #92400e;
    }
    .chc-result-preview {
      color: #374151;
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .chc-result-preview mark {
      background: #fde68a;
      border-radius: 2px;
      color: inherit;
      padding: 0 1px;
    }
    .chc-bookmark-row {
      align-items: start;
      display: grid;
      gap: 6px;
      grid-template-columns: 1fr auto;
    }
    .chc-bookmark-main {
      background: transparent;
      border: 0;
      color: inherit;
      cursor: pointer;
      display: grid;
      gap: 5px;
      min-width: 0;
      padding: 0;
      text-align: left;
    }
    .chc-bookmark-main:disabled {
      cursor: default;
      opacity: 0.55;
    }
    .chc-bookmark-remove {
      background: transparent;
      border: 0;
      color: #9ca3af;
      cursor: pointer;
      font: 800 16px/1 sans-serif;
      padding: 2px 3px;
    }
    .chc-bookmark-remove:hover {
      color: #b91c1c;
    }
    .chc-bookmark-time {
      color: #6b7280;
      font-size: 10px;
    }
    .chc-search-button {
      background: #f3f4f6;
      border: 1px solid #d1d5db;
      border-radius: 7px;
      color: #111827;
      cursor: pointer;
      font: 700 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      min-height: 32px;
      padding: 6px 9px;
    }
    .chc-search-button:hover:not(:disabled) {
      background: #e5e7eb;
    }
    .chc-search-button:disabled {
      cursor: default;
      opacity: 0.45;
    }
    .chc-search-scope {
      color: #6b7280;
      font-size: 11px;
      line-height: 1.4;
    }
    .chc-search-limit {
      color: #92400e;
      font-size: 11px;
      line-height: 1.4;
    }
    .chc-navigator-reveal-note {
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 7px;
      color: #92400e;
      font-size: 11px;
      line-height: 1.4;
      padding: 7px 8px;
    }
    .chc-muted {
      color: #6b7280;
      font-size: 12px;
      padding: 8px 2px;
    }
    .chc-highlight {
      outline: 2px solid #2563eb;
      outline-offset: 3px;
      transition: outline-color 0.2s ease;
    }
    .chc-bookmark-slot {
      align-self: stretch;
      display: flex;
      justify-content: flex-start;
      min-height: 18px;
      width: 100%;
    }
    .chc-bookmark-slot[data-role="user"] {
      align-self: flex-end;
      justify-content: flex-start;
      width: var(--user-chat-width, 70%);
    }
    .chc-bookmark-slot[data-role="assistant"] {
      align-self: stretch;
      justify-content: flex-start;
    }
    .chc-bookmark-button {
      background: transparent;
      border: 0;
      color: inherit;
      cursor: pointer;
      display: inline-flex;
      font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 4px 0 2px;
      opacity: 0.62;
      padding: 2px 0;
      transition: opacity 0.15s ease;
    }
    .chc-bookmark-button:hover {
      opacity: 1;
    }
    ::highlight(${SEARCH_HIGHLIGHT_NAME}) {
      background: #fde68a;
      color: inherit;
    }
    ::highlight(${SEARCH_CURRENT_HIGHLIGHT_NAME}) {
      background: #f59e0b;
      color: #111827;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function getPanelText(key) {
  const fallback = {
    panelButton: 'Navigator',
    panelButtonDismiss: 'Hide Navigator button',
    panelTitle: 'Conversation Navigator',
    panelSubtitle: 'Search, bookmark, and jump to important content',
    panelClose: 'Close',
    panelSearch: 'Search messages',
    panelBookmarks: 'Bookmarks',
    panelSearchPlaceholder: 'Search within current conversation',
    panelSearchEmpty: 'Search by keyword to find matching messages.',
    panelSearchNoResults: 'No matching messages',
    panelSearchPrevious: 'Previous',
    panelSearchNext: 'Next',
    panelSearchClear: 'Clear',
    panelSearchResultCount: '$1 matching messages',
    panelSearchScope: 'Navigator only covers content currently available on the page.',
    panelSearchLimit: 'Too many matches. Showing the first results.',
    panelTemporaryReveal: 'This hidden message is temporarily shown. Auto-maintain remains active.',
    panelResultUser: 'User',
    panelResultAssistant: 'Assistant',
    panelResultMessage: 'Message',
    panelResultHidden: 'Hidden',
    panelResultMatches: '$1 matches',
    bookmarkAddAction: 'Bookmark',
    bookmarkRemoveAction: 'Bookmarked',
    bookmarkCancelAction: 'Remove bookmark',
    bookmarkEmpty: 'No bookmarks in this conversation yet.',
    bookmarkUnavailable: 'Not available in the current page',
    bookmarkImagePreview: 'Image',
    bookmarkRemove: 'Remove bookmark'
  };
  return getMessage(key) || fallback[key] || key;
}

function ensureConversationPanel() {
  if (conversationPanel) return conversationPanel;
  ensureConversationPanelStyles();

  const toggle = document.createElement('div');
  toggle.className = 'chc-panel-toggle';

  const toggleOpen = document.createElement('button');
  toggleOpen.className = 'chc-panel-toggle-open';
  toggleOpen.type = 'button';
  toggleOpen.textContent = panelButtonText();
  toggleOpen.addEventListener('click', () => setConversationPanelOpen(true));

  const toggleDismiss = document.createElement('button');
  toggleDismiss.className = 'chc-panel-toggle-dismiss';
  toggleDismiss.type = 'button';
  toggleDismiss.textContent = '\u00d7';
  toggleDismiss.title = getPanelText('panelButtonDismiss');
  toggleDismiss.setAttribute('aria-label', getPanelText('panelButtonDismiss'));
  toggleDismiss.addEventListener('click', () => toggle.remove());

  toggle.appendChild(toggleOpen);
  toggle.appendChild(toggleDismiss);

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
  return getPanelText('panelButton');
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
  if (!isOpen) {
    clearConversationSearch();
  }
  conversationPanelState.isOpen = isOpen;
  conversationPanel.panel.dataset.open = String(isOpen);
  conversationPanel.toggle.style.display = isOpen ? 'none' : 'flex';
  if (isOpen) {
    loadConversationBookmarks().then(refreshConversationPanelMessages);
    requestAnimationFrame(() => conversationPanel?.panel.querySelector('.chc-search-input')?.focus());
  }
}

function refreshConversationPanelMessages() {
  conversationPanelState.messages = buildMessageExtractor();
  ensureBookmarkButtons();
  runConversationSearch(conversationPanelState.query, false, true);
}

function scheduleConversationPanelRefresh() {
  if (!conversationPanel || !conversationPanelState.isOpen) return;
  refreshConversationPanelMessages();
}

function removeConversationPanel() {
  if (!conversationPanel) return;
  clearConversationSearch();
  conversationPanel.toggle.remove();
  conversationPanel.panel.remove();
  conversationPanel = null;
  conversationPanelState.isOpen = false;
}

function renderConversationPanel() {
  if (!conversationPanel) return;
  const tabs = [
    { id: 'search', label: getPanelText('panelSearch') },
    {
      id: 'bookmarks',
      label: `${getPanelText('panelBookmarks')} (${conversationPanelState.bookmarks.length})`
    }
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
      clearNavigatorReveal();
      conversationPanelState.activeTab = tab.id;
      if (tab.id === 'bookmarks') {
        clearSearchHighlights();
      } else {
        applySearchHighlights();
      }
      renderConversationPanel();
    });
    tabsEl.appendChild(button);
  });

  const body = conversationPanel.panel.querySelector('.chc-panel-body');
  body.textContent = '';
  if (conversationPanelState.activeTab === 'bookmarks') {
    renderBookmarksView(body);
  } else {
    renderSearchView(body);
  }
}

function renderSearchView(body) {
  const input = document.createElement('input');
  input.className = 'chc-search-input';
  input.type = 'search';
  input.placeholder = getPanelText('panelSearchPlaceholder');
  input.value = conversationPanelState.query;
  let isComposing = false;
  const scheduleSearch = () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      runConversationSearch(conversationPanelState.query);
    }, 250);
  };
  input.addEventListener('compositionstart', () => {
    isComposing = true;
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
  });
  input.addEventListener('compositionend', () => {
    isComposing = false;
    conversationPanelState.query = input.value;
    scheduleSearch();
  });
  input.addEventListener('input', () => {
    conversationPanelState.query = input.value;
    if (!isComposing) scheduleSearch();
  });
  input.addEventListener('keydown', (event) => {
    if (isComposing || event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
        runConversationSearch(conversationPanelState.query);
        return;
      }
      navigateSearchResult(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      clearConversationSearch();
      renderConversationPanel();
    }
  });
  body.appendChild(input);

  const query = conversationPanelState.query.trim();
  if (!query) {
    appendMuted(body, getPanelText('panelSearchEmpty'));
    appendSearchScope(body);
    return;
  }

  const controls = document.createElement('div');
  controls.className = 'chc-search-controls';
  const count = document.createElement('div');
  count.className = 'chc-search-count';
  const total = conversationPanelState.results.length;
  count.textContent = total === 0
    ? getPanelText('panelSearchNoResults')
    : getMessage('panelSearchResultCount', [String(total)]) || `${total} matching messages`;
  controls.appendChild(count);
  controls.appendChild(createSearchButton(
    getPanelText('panelSearchPrevious'),
    () => navigateSearchResult(-1),
    total === 0
  ));
  controls.appendChild(createSearchButton(
    getPanelText('panelSearchNext'),
    () => navigateSearchResult(1),
    total === 0
  ));
  controls.appendChild(createSearchButton(
    getPanelText('panelSearchClear'),
    () => {
      clearConversationSearch();
      renderConversationPanel();
      requestAnimationFrame(() => conversationPanel?.panel.querySelector('.chc-search-input')?.focus());
    },
    false
  ));
  body.appendChild(controls);

  if (total > 0) {
    appendSearchResultList(body);
  }
  const currentResult = conversationPanelState.results[conversationPanelState.currentResultIndex];
  if (autoMaintainEnabled && currentResult?.anchor.dataset.chcNavigatorRevealed === 'true') {
    const note = document.createElement('div');
    note.className = 'chc-navigator-reveal-note';
    note.textContent = getPanelText('panelTemporaryReveal');
    body.appendChild(note);
  }
  if (conversationPanelState.searchLimitReached) {
    const limit = document.createElement('div');
    limit.className = 'chc-search-limit';
    limit.textContent = getPanelText('panelSearchLimit');
    body.appendChild(limit);
  }
  appendSearchScope(body);
}

function createSearchButton(label, onClick, disabled) {
  const button = document.createElement('button');
  button.className = 'chc-search-button';
  button.type = 'button';
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function appendSearchScope(body) {
  const scope = document.createElement('div');
  scope.className = 'chc-search-scope';
  scope.textContent = getPanelText('panelSearchScope');
  body.appendChild(scope);
}

function clearSearchHighlights() {
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete(SEARCH_HIGHLIGHT_NAME);
    CSS.highlights.delete(SEARCH_CURRENT_HIGHLIGHT_NAME);
  }
  document.querySelectorAll('.chc-highlight').forEach((element) => {
    element.classList.remove('chc-highlight');
  });
}

function clearConversationSearch() {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
  conversationPanelState.query = '';
  conversationPanelState.results = [];
  conversationPanelState.currentResultIndex = -1;
  conversationPanelState.searchLimitReached = false;
  clearNavigatorReveal();
  clearSearchHighlights();
}

function getSearchableTextNodes(anchor) {
  const nodes = [];
  const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(
        '.chc-panel, .chc-panel-toggle, button, input, textarea, select, option, script, style, [contenteditable="true"]'
      )) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

function collectConversationSearchResults(query) {
  const normalizedQuery = query.toLowerCase();
  const results = [];
  let totalMatches = 0;
  let limitReached = false;
  for (const message of conversationPanelState.messages) {
    const anchor = findMessageAnchor(message);
    if (!anchor) continue;
    const normalizedMessageText = message.text.toLowerCase();
    const messageMatchCount = countTextMatches(normalizedMessageText, normalizedQuery);
    if (messageMatchCount === 0) continue;
    const remainingMatchCapacity = SEARCH_MATCH_LIMIT - totalMatches;
    if (remainingMatchCapacity <= 0) {
      limitReached = true;
      break;
    }
    const acceptedMatchCount = Math.min(messageMatchCount, remainingMatchCapacity);
    const ranges = [];
    for (const textNode of getSearchableTextNodes(anchor)) {
      const normalizedText = textNode.nodeValue.toLowerCase();
      let fromIndex = 0;
      while (fromIndex < normalizedText.length) {
        const matchIndex = normalizedText.indexOf(normalizedQuery, fromIndex);
        if (matchIndex === -1) break;
        if (ranges.length >= acceptedMatchCount) break;
        const range = document.createRange();
        range.setStart(textNode, matchIndex);
        range.setEnd(textNode, matchIndex + query.length);
        ranges.push(range);
        fromIndex = matchIndex + Math.max(query.length, 1);
      }
      if (ranges.length >= acceptedMatchCount) break;
    }
    totalMatches += acceptedMatchCount;
    results.push({
      message,
      anchor,
      ranges,
      matchCount: acceptedMatchCount,
      snippet: buildSearchResultSnippet(message.text, query)
    });
    if (acceptedMatchCount < messageMatchCount) {
      limitReached = true;
      break;
    }
  }
  return { results, limitReached };
}

function countTextMatches(text, query) {
  let count = 0;
  let fromIndex = 0;
  while (fromIndex < text.length) {
    const matchIndex = text.indexOf(query, fromIndex);
    if (matchIndex === -1) break;
    count += 1;
    fromIndex = matchIndex + Math.max(query.length, 1);
  }
  return count;
}

function applySearchHighlights() {
  clearSearchHighlights();
  const { results, currentResultIndex } = conversationPanelState;
  if (results.length === 0) return;
  const ranges = results.flatMap((result) => result.ranges);

  if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') {
    CSS.highlights.set(SEARCH_HIGHLIGHT_NAME, new Highlight(...ranges));
    const current = results[currentResultIndex];
    if (current) {
      CSS.highlights.set(SEARCH_CURRENT_HIGHLIGHT_NAME, new Highlight(...current.ranges));
    }
    return;
  }

  results[currentResultIndex]?.anchor.classList.add('chc-highlight');
}

function runConversationSearch(query, jumpToFirst = true, preserveCurrentIndex = false) {
  const trimmedQuery = query.trim();
  const previousIndex = conversationPanelState.currentResultIndex;
  clearSearchHighlights();
  const searchResult = trimmedQuery
    ? collectConversationSearchResults(trimmedQuery)
    : { results: [], limitReached: false };
  conversationPanelState.searchLimitReached = searchResult.limitReached;
  conversationPanelState.results = searchResult.results;
  conversationPanelState.currentResultIndex = conversationPanelState.results.length > 0
    ? (preserveCurrentIndex ? Math.min(Math.max(previousIndex, 0), conversationPanelState.results.length - 1) : 0)
    : -1;
  if (conversationPanelState.results.length === 0) {
    clearNavigatorReveal();
  }
  applySearchHighlights();
  renderConversationPanel();
  requestAnimationFrame(() => {
    const input = conversationPanel?.panel.querySelector('.chc-search-input');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
  if (jumpToFirst && conversationPanelState.results.length > 0) {
    navigateToCurrentSearchResult();
  }
}

function navigateSearchResult(delta) {
  const total = conversationPanelState.results.length;
  if (total === 0) return;
  conversationPanelState.currentResultIndex =
    (conversationPanelState.currentResultIndex + delta + total) % total;
  applySearchHighlights();
  renderConversationPanel();
  navigateToCurrentSearchResult();
}

async function navigateToCurrentSearchResult() {
  const result = conversationPanelState.results[conversationPanelState.currentResultIndex];
  if (!result) return;
  if (result.anchor.dataset.chcHidden === 'true') {
    if (autoMaintainEnabled) {
      revealHiddenTurnForNavigator(result.anchor);
      renderConversationPanel();
    } else {
      clearNavigatorReveal();
      await new SafeDomStore().restore(Number.MAX_SAFE_INTEGER);
      scheduleBadgeUpdate();
    }
  } else {
    clearNavigatorReveal();
  }
  applySearchHighlights();
  jumpToMessageAnchor(result.anchor);
}

function buildSearchResultSnippet(text, query) {
  const normalizedText = text.toLowerCase();
  const matchIndex = normalizedText.indexOf(query.toLowerCase());
  if (matchIndex === -1) return text.slice(0, 180);
  const start = Math.max(0, matchIndex - 60);
  const end = Math.min(text.length, matchIndex + query.length + 100);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

function appendSearchResultList(body) {
  const list = document.createElement('div');
  list.className = 'chc-result-list';
  conversationPanelState.results.forEach((result, index) => {
    const button = document.createElement('button');
    button.className = 'chc-result';
    button.type = 'button';
    button.dataset.active = String(index === conversationPanelState.currentResultIndex);
    button.addEventListener('click', () => {
      conversationPanelState.currentResultIndex = index;
      applySearchHighlights();
      renderConversationPanel();
      navigateToCurrentSearchResult();
    });

    const meta = document.createElement('div');
    meta.className = 'chc-result-meta';
    const role = document.createElement('span');
    role.className = 'chc-result-role';
    role.textContent = getSearchResultRoleLabel(result.message.role);
    meta.appendChild(role);
    const messageNumber = document.createElement('span');
    messageNumber.textContent = `#${result.message.index + 1}`;
    meta.appendChild(messageNumber);
    const matchCount = document.createElement('span');
    matchCount.textContent =
      getMessage('panelResultMatches', [String(result.matchCount)]) || `${result.matchCount} matches`;
    meta.appendChild(matchCount);
    if (result.message.isHidden) {
      const hidden = document.createElement('span');
      hidden.className = 'chc-result-hidden';
      hidden.textContent = getPanelText('panelResultHidden');
      meta.appendChild(hidden);
    }

    const preview = document.createElement('div');
    preview.className = 'chc-result-preview';
    appendHighlightedText(preview, result.snippet, conversationPanelState.query.trim());
    button.appendChild(meta);
    button.appendChild(preview);
    list.appendChild(button);
  });
  body.appendChild(list);
}

function appendHighlightedText(container, text, query) {
  if (!query) {
    container.textContent = text;
    return;
  }
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, cursor);
    if (matchIndex === -1) {
      container.appendChild(document.createTextNode(text.slice(cursor)));
      break;
    }
    if (matchIndex > cursor) {
      container.appendChild(document.createTextNode(text.slice(cursor, matchIndex)));
    }
    const mark = document.createElement('mark');
    mark.textContent = text.slice(matchIndex, matchIndex + query.length);
    container.appendChild(mark);
    cursor = matchIndex + query.length;
  }
}

function getSearchResultRoleLabel(role) {
  if (role === 'user') return getPanelText('panelResultUser');
  if (role === 'assistant') return getPanelText('panelResultAssistant');
  return getPanelText('panelResultMessage');
}

function findBookmarkAnchor(bookmark) {
  const turns = findTurnElements();
  const byId = turns.find((turnEl, index) => getTurnId(turnEl, index) === bookmark.messageId);
  if (byId) return byId;

  const normalizedPreview = normalizeBookmarkText(bookmark.preview).slice(0, 100);
  if (normalizedPreview) {
    const byPreview = turns.find((turnEl) => {
      if (detectTurnRole(turnEl) !== bookmark.role) return false;
      return normalizeBookmarkText(getTurnText(turnEl)).includes(normalizedPreview);
    });
    if (byPreview) return byPreview;
  }

  const indexedTurn = turns[bookmark.messageIndex];
  const indexedText = indexedTurn ? normalizeBookmarkText(getTurnText(indexedTurn)) : '';
  const previewPrefix = normalizedPreview.slice(0, 40);
  if (
    indexedTurn &&
    detectTurnRole(indexedTurn) === bookmark.role &&
    (!previewPrefix || indexedText.includes(previewPrefix))
  ) {
    return indexedTurn;
  }
  return null;
}

function normalizeBookmarkText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function renderBookmarksView(body) {
  if (conversationPanelState.bookmarks.length === 0) {
    appendMuted(body, getPanelText('bookmarkEmpty'));
    return;
  }

  const list = document.createElement('div');
  list.className = 'chc-result-list';
  conversationPanelState.bookmarks.forEach((bookmark) => {
    const anchor = findBookmarkAnchor(bookmark);
    const item = document.createElement('div');
    item.className = 'chc-result chc-bookmark-row';

    const main = document.createElement('button');
    main.className = 'chc-bookmark-main';
    main.type = 'button';
    main.disabled = !anchor;
    main.addEventListener('click', () => navigateToBookmark(bookmark));

    const meta = document.createElement('div');
    meta.className = 'chc-result-meta';
    const role = document.createElement('span');
    role.className = 'chc-result-role';
    role.textContent = getSearchResultRoleLabel(bookmark.role);
    meta.appendChild(role);
    if (!anchor) {
      const unavailable = document.createElement('span');
      unavailable.className = 'chc-result-hidden';
      unavailable.textContent = getPanelText('bookmarkUnavailable');
      meta.appendChild(unavailable);
    }

    const preview = document.createElement('div');
    preview.className = 'chc-result-preview';
    const livePreview = anchor ? getTurnText(anchor).slice(0, 180) : '';
    const previewText = stripTurnRoleLabel(bookmark.preview || livePreview);
    preview.textContent = previewText ||
      (anchor?.querySelector('img, picture, video')
        ? getPanelText('bookmarkImagePreview')
        : bookmark.preview || livePreview);
    const time = document.createElement('div');
    time.className = 'chc-bookmark-time';
    time.textContent = formatBookmarkTime(bookmark.timestamp);
    main.appendChild(meta);
    main.appendChild(preview);
    main.appendChild(time);

    const remove = document.createElement('button');
    remove.className = 'chc-bookmark-remove';
    remove.type = 'button';
    remove.textContent = 'x';
    remove.title = getPanelText('bookmarkRemove');
    remove.setAttribute('aria-label', getPanelText('bookmarkRemove'));
    remove.addEventListener('click', () => removeBookmark(bookmark.key));

    item.appendChild(main);
    item.appendChild(remove);
    list.appendChild(item);
  });
  body.appendChild(list);
}

async function navigateToBookmark(bookmark) {
  const anchor = findBookmarkAnchor(bookmark);
  if (!anchor) return;
  if (anchor.dataset.chcHidden === 'true') {
    if (autoMaintainEnabled) {
      revealHiddenTurnForNavigator(anchor);
      renderConversationPanel();
    } else {
      clearNavigatorReveal();
      await new SafeDomStore().restore(Number.MAX_SAFE_INTEGER);
      scheduleBadgeUpdate();
    }
  } else {
    clearNavigatorReveal();
  }
  jumpToMessageAnchor(anchor);
}

async function removeBookmark(key) {
  await saveConversationBookmarks(
    conversationPanelState.bookmarks.filter((bookmark) => bookmark.key !== key)
  );
}

function formatBookmarkTime(timestamp) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp));
  } catch (error) {
    return new Date(timestamp).toLocaleString();
  }
}

function appendMuted(body, text) {
  const el = document.createElement('div');
  el.className = 'chc-muted';
  el.textContent = text;
  body.appendChild(el);
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
  if (anchor.dataset.chcHidden === 'true' && anchor.dataset.chcNavigatorRevealed !== 'true') {
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
      if (isTurnRelatedMutation(mutation)) {
        refreshBookmarkContext();
        scheduleBadgeUpdate();
        scheduleConversationPanelRefresh();
        return;
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
    await loadConversationBookmarks();
    ensureBookmarkButtons();
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

  if (changes[BOOKMARKS_STORAGE_KEY]) {
    loadConversationBookmarks().then(() => {
      ensureBookmarkButtons();
      renderConversationPanel();
    });
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

  if (request.action === 'openConversationNavigator') {
    ensureConversationPanel();
    setConversationPanelOpen(true);
    sendResponse({ success: true });
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
