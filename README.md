# ChatGPT Long Conversation Toolkit

A lightweight, local-first Chrome and Edge extension for searching, navigating, organizing, and revisiting long ChatGPT conversations.

Version 1.4.0 introduces Conversation Navigator: search loaded messages, bookmark important content, and jump back to relevant User or Assistant messages. The extension also keeps the latest N conversation exchanges visible and can hide older messages behind a small expandable placeholder.

It only works with conversation content currently available on the page. It does not delete ChatGPT account data or upload conversation content.

## Current Focus

Long Conversation Experience:

- Search loaded User and Assistant messages with message-level results
- Bookmark important messages locally and return to them quickly
- Jump to visible or visually hidden messages
- Keep recent conversation exchanges visible
- Hide older exchanges visually when a conversation becomes hard to scan
- Optionally discard older page nodes until refresh
- Stay local, lightweight, and privacy-first

The extension no longer treats performance cleanup as the core product promise. ChatGPT may lazy-load or virtualize conversation content, so Navigator and future Outline features are scoped to currently loaded content unless explicitly stated otherwise.

## Features

- Configurable recent-exchange limit, defaulting to 10 exchanges
- Visual Hide: lowest risk, expandable in place
- Temporary Trim: strongest page reduction, restored by refreshing ChatGPT
- Conversation Navigator with message-level search and local bookmarks
- Optional auto-maintain mode for long sessions
- Conversation exchange count badge
- English and Simplified Chinese UI

The Navigator shows matching User and Assistant messages with context previews, rather than only stepping through text matches. It only covers conversation content currently available in the ChatGPT page. With auto-maintain enabled, a hidden result is temporarily revealed without changing the hidden count or disabling the limit; it is hidden again when navigation moves away or closes. Content removed by Temporary Trim is not searchable until the page is refreshed.

Each loaded User or Assistant message can be bookmarked. Bookmarks store only the conversation/message identifiers, a short preview, role, and timestamp in `chrome.storage.local`. They are not uploaded.

The Navigator keeps Search and Bookmarks as separate tabs. The Bookmarks tab always shows the current conversation's bookmark count.

## Privacy

- No backend
- No tracking
- No analytics
- No conversation upload

All behavior runs locally in the browser page. The extension does not store conversation snapshots or send conversation content anywhere. Search terms are not stored. Bookmarks remain in `chrome.storage.local`.

## Installation

### Chrome

1. Open `chrome://extensions/`
2. Enable Developer mode
3. Click Load unpacked
4. Select this project folder

### Edge

1. Open `edge://extensions/`
2. Enable Developer mode
3. Click Load unpacked
4. Select this project folder

## Usage

1. Open a ChatGPT conversation on `chatgpt.com` or `chat.openai.com`
2. Click the extension icon

To search and revisit important content:

1. Click **Open →** in the Conversation Navigator section
2. Enter a keyword to see message-level results
3. Click a User or Assistant result to jump directly to that message
4. Use **Bookmark** on a message to save it locally
5. Open the Bookmarks tab to revisit or remove saved messages

To manage the visible conversation:

1. Set how many recent exchanges to keep visible
2. Choose a mode:
   - Visual Hide: lowest risk, expandable in place
   - Temporary Trim: strongest page reduction, restored by refreshing ChatGPT
3. Click **Organize conversation now**

Visual Hide shows an expandable placeholder for older messages. Temporary Trim leaves a non-expandable placeholder.

Search terms are not stored. Bookmark identifiers, short previews, roles, and timestamps are stored locally and are never uploaded.

## Links

- [Open Source](https://github.com/manxisuo/ChatGPTLongConversationToolkit)
- Feedback: [English](https://tally.so/r/2EDLp9) · [简体中文](https://tally.so/r/ZjZYAv)

## Roadmap Principle

New features must answer yes to:

Does this improve long conversation experience?

Features outside that scope should not enter the main extension.
