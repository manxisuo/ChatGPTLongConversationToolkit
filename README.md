# ChatGPT History Cleaner & Performance Booster

A lightweight Chrome and Edge extension for making long ChatGPT conversations smoother and easier to use.

The extension keeps the latest N conversation rounds visible and can collapse older messages behind a small expandable placeholder. It only changes the current page display. It does not delete ChatGPT account data or upload conversation content.

<img width="400" alt="image" src="https://github.com/user-attachments/assets/79c1e828-15bf-4df7-87aa-c1f6233e9095" />
<img width="410" alt="image" src="https://github.com/user-attachments/assets/bb822f79-15b1-4291-9677-4f75dc0038b8" />


## Current Focus

Long Conversation Experience:

- Keep recent conversation rounds visible
- Choose Safe Mode, Performance Mode, or Maximum Performance for older messages
- Reduce lag in long chats
- Improve browser responsiveness
- Stay local, lightweight, and privacy-first

## Features

- Configurable recent-round limit, defaulting to 10 rounds
- Safe mode: hide older messages visually and expand instantly
- Performance mode: save older message HTML snapshots to the extension's local IndexedDB, remove those nodes from the page DOM, and expand by restoring the snapshot
- Maximum Performance: discard older page nodes without saving a snapshot; refresh the ChatGPT page to restore the full conversation
- Options page for Performance mode snapshot TTL and manual cleanup
- Optional auto-maintain mode for long sessions
- Conversation round count badge
- English and Simplified Chinese UI

## Privacy

- No backend
- No tracking
- No analytics
- No conversation upload

All behavior runs locally in the browser page. Performance mode stores static snapshots locally in the extension's IndexedDB. They can be cleared from the Settings page and are automatically eligible for TTL cleanup.

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
3. Set how many recent rounds to keep visible
4. Choose a mode:
   - Safe: lowest risk, smaller visual surface
   - Performance: real DOM reduction with local snapshots
   - Maximum Performance: strongest page reduction, no in-page restore
5. Click Optimize current conversation

Safe and Performance mode show an expandable placeholder for older messages. Remove mode leaves a non-expandable placeholder. Refreshing the page asks ChatGPT to render the full conversation again.

## Roadmap Principle

New features must answer yes to:

Does this improve long conversation experience?

Features outside that scope should not enter the main extension.
