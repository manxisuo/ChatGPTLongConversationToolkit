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

## v1.4: Loaded Navigation

Goal:

```text
Add navigation for currently loaded conversation content.
```

Candidate features:

- Loaded Conversation Search.
- Message-level search results.
- Click-to-jump.
- Quick jump latest / oldest visible.
- Code block folding.

Naming requirement:

```text
Use "loaded" or "visible" language wherever completeness matters.
```

Do not promise:

- Complete history search.
- Search across unrendered ChatGPT messages.
- Search across conversations.

## v1.5: Reading And Orientation

Goal:

```text
Make long loaded conversations easier to scan.
```

Candidate features:

- Mini-map.
- Visible Conversation Outline.
- Bookmarks.
- Highlights.
- Current position indicator.
- Compact reading controls.

Outline boundary:

```text
The outline is structural and local. It should not claim deep topic understanding.
```

## v2.x: Conversation Workspace Exploration

Only explore this if users clearly ask for:

- Complete search.
- Multi-conversation management.
- Conversation archive.
- Long-term organization.

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
- Built an experimental in-page Conversation Tools panel.
- Built an experimental local message extractor.
- Built experimental Loaded Search / Outline / Navigation prototypes.

Release boundary:

```text
The experimental Conversation Tools panel is disabled by default and should not ship as a default v1.3 feature.
```

## Current Next Step

Immediate actions:

1. Prepare v1.3 as a stable repositioning release.
2. Keep Search / Outline behind an experimental flag.
3. Update store screenshots and promo copy away from performance claims.
4. Validate real user interest using the local feature interest section.
5. Decide whether v1.4 should prioritize Loaded Search, Code Block Folding, or Quick Jump based on feedback.

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
