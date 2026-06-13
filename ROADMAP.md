# ChatGPT Long Conversation Roadmap

## Strategic Reassessment

The original product assumption is weakening:

```text
Long conversation -> large DOM -> slow page -> remove old messages -> improve performance
```

ChatGPT now uses lazy loading, virtualization, and other frontend optimizations. The page DOM no longer reliably contains the full conversation, and extension features that depend on complete frontend DOM access will be incomplete or fragile.

This does not remove the user need. It changes the product path.

The real user need is not:

```text
Reduce DOM nodes by 30%.
```

The real user need is:

```text
Make long AI conversations easier to read, navigate, organize, and revisit.
```

Long conversations will become more common as model context windows grow. The product should stop trying to prove that performance cleanup still matters and instead focus on long conversation experience.

## Product Positioning

Old positioning:

```text
ChatGPT History Cleaner
Make ChatGPT faster by cleaning old history.
```

Current transition name:

```text
ChatGPT Conversation Toolkit
```

Long-term positioning candidates:

```text
AI Conversation Workspace
```

Working product definition:

```text
A lightweight, local-first tool for reading, navigating, organizing, and revisiting long ChatGPT conversations.
```

The product should not be centered on performance. Performance can remain a secondary benefit of visual control, but the core story is long conversation experience.

## Design Principles

### Do Not Fight ChatGPT Internals

Avoid:

- Assuming the full conversation exists in the frontend DOM.
- Automatically scrolling through a conversation to build an index by default.
- Trying to access unrendered content through fragile page internals.
- Large-scale DOM deletion that conflicts with ChatGPT virtualization.

Prefer:

- Enhancing currently loaded content.
- Non-invasive UI layers.
- Local-only indexing of content the page exposes.
- Reversible reading controls.
- Soft failure when ChatGPT DOM changes.

### State Capability Boundaries Clearly

Do not call a feature "History Search" if it only searches rendered page content.

Preferred naming:

```text
Loaded Conversation Search
Conversation Navigation
Visible Conversation Outline
```

Search and Outline should be framed as navigation for currently loaded content, not as complete cloud history management.

### Start From User Pain, Not DOM Possibility

The product should solve problems users actually feel in long conversations:

- Finding where something was discussed.
- Understanding what the conversation contains.
- Moving around without getting lost.
- Reducing visual overload from long messages, code blocks, and images.
- Marking important sections for later.
- Extracting decisions, TODOs, and useful snippets.

## Validated User Demand

Recent questionnaire feedback further validates the direction of the roadmap and clarifies the current priority order:

- Highest demand: Search, Navigation.
- Validated demand: Outline, Export.
- Lower demand for now: AI Summary.

This supports continuing with Conversation Navigator as the immediate foundation, followed by deterministic structure and portable output. AI-assisted features should remain later-stage options rather than displacing Outline, Export, or Knowledge Organization.

## Product Layers

### Layer 1: Reading Experience

Goal:

```text
Make long conversations more comfortable to read.
```

Candidate features:

- Keep latest N visible.
- Visual collapse / expand.
- Jump latest.
- Jump oldest visible.
- Message folding.
- Code block folding.
- Compact image view.
- Bookmarks.
- Highlights.

### Layer 2: Navigation

Goal:

```text
Help users move through loaded conversation content without getting lost.
```

Candidate features:

- Loaded Conversation Search.
- Visible Conversation Outline.
- Message navigation.
- Quick jump.
- Section anchors.
- Current visible region indicator.
- Last Position / Continue Reading: remember the user's last reading or interaction position and provide a quick way to return.

Important boundary:

```text
These features operate on currently loaded content unless explicitly stated otherwise.
```

### Layer 3: Organization

Goal:

```text
Help users keep useful parts of long conversations.
```

Candidate features:

- Bookmark snippets.
- Tags.
- TODO extraction.
- Decision extraction.
- Export Markdown.
- Lightweight local summaries.

### Layer 4: Workspace

Goal:

```text
Turn useful conversations into a local AI conversation workspace.
```

Candidate features:

- Cross-conversation search.
- Local indexing.
- Saved snippet library.
- Multi-conversation management.
- Local archive.
- Shareable exports.

This requires a different product surface and should not be rushed into the current extension before demand is validated.

### Layer 5: AI Enhancement

Long-term examples:

- "Where did we discuss the Plum platform?"
- "What design changes happened in the last 100 turns?"
- "Find all network framework discussions."
- "Summarize the decision process."

This layer may require optional user-triggered LLM integration. It should be considered only after privacy, cost, latency, and complexity are acceptable.

## Version Roadmap

## v1.3: Reposition And Stabilize

Goal:

```text
Move from performance cleaner to long conversation control without changing the core workflow.
```

Ship:

- Keep latest N visible.
- Visual Control for hiding older rounds.
- Refresh Restore as an advanced option.
- Popup UI and copy repositioned around long conversation control.
- Local-only "What do you want next?" feature interest section.
- Stability fixes.
- Store copy and screenshots no longer centered on "Speed up ChatGPT".

Do not ship by default:

- Search.
- Outline.
- Conversation Tools panel.
- Any feature that implies full history access.

Release principle:

```text
v1.3 is a low-risk positioning and maintenance release.
```

## v1.4: Conversation Navigator - Search + Basic Bookmarks

Goal:

```text
Help users find and return to important content in a long loaded conversation.
```

Product structure:

```text
Conversation Navigator
|- Search
`- Bookmarks
```

Ship:

- Message-level keyword search results.
- User and Assistant role labels with context previews.
- Click-to-jump from a result to its message.
- Previous and next message-result navigation.
- Non-destructive keyword highlighting.
- Visual Hide integration: temporarily reveal a hidden result while auto-maintain stays active, or restore normally when auto-maintain is off.
- A basic local Bookmark action on loaded User and Assistant messages.
- Search and Bookmarks tabs inside the Conversation Navigator.
- Bookmark previews, role labels, timestamps, jump-to-message, and removal.
- Clear bookmark states: unbookmarked, bookmarked, and remove bookmark.
- Bookmark count in the Navigator tab.
- Bookmark fallback location using message ID, role and preview, then message index.
- A reusable Conversation Navigator panel that can later host Outline.
- A clear notice that navigation only covers content currently available on the page.

Product principle:

```text
Do not build Search as a standalone Ctrl+F replacement.
Build Navigator; Search and Bookmarks are its first management capabilities.
```

Naming requirement:

```text
Use "loaded" or "visible" language wherever completeness matters.
```

Do not promise:

- Complete history search.
- Search across unrendered ChatGPT messages.
- Search across conversations.
- Semantic or AI-powered search.
- Regular expression or advanced query syntax.

Do not add to v1.4:

- Outline.
- Tags, categories, folders, or bookmark notes.
- AI summaries or AI-generated outlines.
- Export.
- Cloud sync.
- Cross-conversation search.

Release positioning:

```text
ChatGPT Long Conversation Toolkit 1.4.0 - Conversation Navigator
Search long conversations, jump to hidden or visible messages,
bookmark important content, and return to it quickly.
```

## v1.5: Outline + Export

Goal:

```text
Help users turn long conversations into understandable, navigable,
saveable, and portable structured content.
```

Outline candidates:

- Segment by user messages.
- Add a stable node every N conversation exchanges when useful.
- Extract Assistant Markdown headings.
- Extract section headings from long answers.
- Click an outline item to jump to its source message.

Export candidates:

- Export currently available conversation content to Markdown.
- Preserve User and Assistant roles and message order.
- Preserve useful structure such as headings, code blocks, and links where practical.
- Allow users to save or migrate useful long-conversation content without a backend.
- State clearly when exported content is limited to what is currently available on the page.

Lightweight navigation candidate:

- Last Position / Continue Reading.
- Remember the user's last reading or interaction position locally.
- Provide a one-click return without requiring a full conversation index.

First-release boundary:

```text
Use deterministic, explainable rules.
Do not require an AI model, backend, cloud storage, or full-history loading.
```

## v1.6: Knowledge Organization

Goal:

```text
Turn validated bookmarks into lightweight local knowledge organization
without expanding into a full cross-conversation workspace.
```

Candidate features:

- Bookmark management.
- Categories or tags.
- Bookmark notes.
- Bookmark renaming.
- Bookmark search.
- Better bookmark navigation.
- Lightweight organization of saved answers, decisions, code snippets, and solutions.

## v1.7: AI-Assisted Organization

Goal:

```text
Use optional AI assistance to reduce cognitive load in long conversations.
```

Candidate features:

- AI-generated outlines.
- AI summaries.
- AI-assisted navigation.

Decision boundary:

```text
Do not prioritize this until privacy, API choice, cost,
latency, and model quality are acceptable.
```

Current priority:

```text
AI Summary has lower validated demand for now.
Do not move AI-assisted work ahead of Outline, Export,
or Knowledge Organization.
```

## v2.x: Conversation Workspace Exploration

Only explore this if users clearly ask for:

- Complete search.
- Multi-conversation management.
- Conversation archive.
- Long-term organization.

Do not bring these large product-surface capabilities into the v1.x roadmap prematurely:

- Cross-conversation search.
- Automatic local archiving.
- Complete conversation indexing.
- Full multi-conversation knowledge management.

Candidate architecture:

- Local storage.
- IndexedDB.
- Import/export files.
- Local index.
- Optional user-triggered AI features.

This is a separate product step, not an incremental DOM feature.

## Current Implementation Status

Done:

- Reframed popup copy around Long Conversation Control.
- Removed Local Snapshot from the product surface.
- Added Visual Control and Refresh Restore framing.
- Added local-only feature interest settings.
- Built the Conversation Navigator foundation.
- Built message-level loaded conversation search.
- Added basic local bookmarks for loaded User and Assistant messages.

Release boundary:

```text
Navigator features operate only on content currently available in the page.
```

## Current Next Step

Immediate actions:

1. Validate Search + Basic Bookmarks as the v1.4 conversation-management foundation.
2. Test bookmark identity and navigation across Visual Hide, refresh, and Temporary Trim.
3. Update store screenshots and copy around conversation navigation and preservation.
4. Keep categories, notes, and bookmark management out of v1.4.
5. Prepare deterministic Outline and local Export work for v1.5.
6. Evaluate Last Position / Continue Reading as a low-cost navigation improvement.

## Engineering Policy

High-risk patterns:

- Deep coupling to ChatGPT class names.
- Large-scale DOM removal.
- Automatic full-history scroll indexing.
- Features that imply access to unrendered content.

Preferred patterns:

- Semantic selectors where available.
- Small DOM adapter layer.
- Local-only state.
- Reversible UI changes.
- Explicit capability boundaries.
- Fail softly when ChatGPT changes.
