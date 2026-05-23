# ChatGPT Long Conversation Toolkit

A lightweight Chrome and Edge extension for making long ChatGPT conversations easier to control and revisit.

The extension keeps the latest N conversation exchanges visible and can hide older messages behind a small expandable placeholder. It only changes the current page display. It does not delete ChatGPT account data or upload conversation content.

## Current Focus

Long Conversation Experience:

- Keep recent conversation exchanges visible
- Hide older exchanges visually when a conversation becomes hard to scan
- Optionally discard older page nodes until refresh
- Stay local, lightweight, and privacy-first

The extension no longer treats performance cleanup as the core product promise. ChatGPT may lazy-load or virtualize conversation content, so future search and outline features are scoped to currently loaded content unless explicitly stated otherwise.

## Features

- Configurable recent-exchange limit, defaulting to 10 exchanges
- Visual Hide: lowest risk, expandable in place
- Temporary Trim: strongest page reduction, restored by refreshing ChatGPT
- Optional auto-maintain mode for long sessions
- Conversation exchange count badge
- English and Simplified Chinese UI

## Privacy

- No backend
- No tracking
- No analytics
- No conversation upload

All behavior runs locally in the browser page. The extension does not store conversation snapshots or send conversation content anywhere.

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
3. Set how many recent exchanges to keep visible
4. Choose a mode:
   - Visual Hide: lowest risk, expandable in place
   - Temporary Trim: strongest page reduction, restored by refreshing ChatGPT
5. Click Apply view control

Visual Hide shows an expandable placeholder for older messages. Temporary Trim leaves a non-expandable placeholder.

## Roadmap Principle

New features must answer yes to:

Does this improve long conversation experience?

Features outside that scope should not enter the main extension.
