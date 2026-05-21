# ChatGPT Long Conversation Roadmap

## Product Direction

The product is moving from a DOM cleanup / performance-first extension to a long conversation management product.

Core goal:

```text
Make long ChatGPT conversations easier to understand, control, search, and revisit.
```

Primary user problem:

```text
Long conversations become difficult to find, navigate, and revisit.
```

The old performance-first assumption is weakening:

```text
Long conversation -> huge DOM -> slow page -> remove DOM to fix it
```

ChatGPT's own virtualization/lazy rendering may solve much of the page performance problem at the platform layer. The extension should not keep fighting the platform renderer as its main strategy.

The new product thesis:

```text
Even if long chats are fast, they are still hard to navigate, search, summarize, and read.
```

## Product Guardrails

New features should answer yes to:

```text
Does this improve the long conversation experience?
```

Avoid expanding into:

- AI drawing
- Multi-model aggregation
- Agent systems
- Knowledge base platforms
- Prompt marketplaces
- Broad productivity suites

Keep the extension:

- Lightweight
- Local-first
- Privacy-first
- No backend dependency
- No analytics or conversation upload

## Naming Direction

Current published name:

```text
ChatGPT History Cleaner
```

Naming candidates to evaluate:

```text
ChatGPT Conversation Manager
ChatGPT Long Conversation Manager
ChatGPT Conversation Navigator
ChatGPT Conversation Cleaner
```

Avoid making "Performance Booster" the main name or headline. Performance can remain a feature area, but not the core identity.

Avoid over-generic names like:

```text
ChatGPT Toolkit
ChatGPT Long Chat Toolkit
```

Reason:

- Too broad.
- Weak search intent.
- Does not immediately explain the user benefit.
- Can pull the product toward unrelated tool accumulation.

## Roadmap Status

Legend:

```text
[ ] Not started
[/] In progress
[x] Done
[~] Reconsider / paused
```

## Phase 0: Learn Before Build

Goal:

```text
Use the existing user base to validate the new direction before overbuilding.
```

Why this phase matters:

```text
The product already has real users. Ask and observe before guessing.
```

Tasks:

- [ ] Review Chrome Web Store and Edge Add-ons reviews for repeated complaints.
- [ ] Review support emails / user feedback if available.
- [ ] Add a lightweight "What do you want next?" section in settings.
- [ ] Let users indicate interest in search, outline, navigation, code folding, and image folding.
- [ ] Track only local preference state unless explicit privacy-safe feedback collection is designed.
- [ ] Decide the next major feature based on observed demand, not only intuition.

Validation questions:

- [ ] Do users still mention lag after ChatGPT virtualization?
- [ ] Do users ask for finding old content?
- [ ] Do users ask for jumping between sections?
- [ ] Do users ask for reducing visual clutter?

Success Criteria:

- [ ] The next major feature is chosen from observed user interest, not only internal speculation.
- [ ] Settings page can show local user preference signals without uploading conversation data.

## Phase 1: Reposition Existing Features As View Control

Goal:

```text
Keep existing users stable while moving the product story away from raw performance.
```

Tasks:

- [x] Update extension naming strategy away from "Performance Booster" as the main identity.
- [x] Rewrite popup copy around "View Control" and "Long Conversation Control".
- [x] Reconsider default mode. Prefer safe visual control with ChatGPT virtualization.
- [x] Keep "only show recent N rounds" as a view-control feature.
- [x] Keep safe collapse and one-click restore.
- [x] Remove Local Snapshot / Performance Mode from the main extension.
- [x] Rework store listing copy around long conversation control, search, and navigation.
- [ ] Rework screenshots/promo text away from "Speed up ChatGPT" as the primary claim.

Success Criteria:

- [ ] Existing users still understand the core "only show recent N rounds" workflow.
- [x] New copy no longer depends on "ChatGPT is slow" as the main promise.
- [x] Local Snapshot / Performance Mode is removed from the product surface.

## Phase 1.5: UI Experiment

Goal:

```text
Find a UI container that can support Search, Outline, Navigation, and Reading Control without cluttering ChatGPT.
```

Why this matters:

```text
The next features are not one-off buttons. They need a durable surface.
```

Candidates:

- [ ] Floating compact panel.
- [ ] Right-side fixed sidebar.
- [ ] Collapsible drawer.
- [ ] Top toolbar entry point.
- [ ] Minimal floating button that opens the full panel.

Evaluation criteria:

- [ ] Does not block ChatGPT's composer or message content.
- [ ] Works on narrow and wide screens.
- [ ] Can hold search results and outline items.
- [ ] Easy to hide.
- [ ] Minimizes cognitive load.
- [ ] Feels like a tool surface, not a marketing widget.

Success Criteria:

- [ ] Search and Outline can share the same UI container.
- [ ] The container can be opened, hidden, and reopened without losing state.
- [ ] The container does not block normal ChatGPT usage.

## Phase 2A: Message-Aware Search V0

Goal:

```text
Help users quickly find old content by searching message structure, not just visible page text.
```

Why this is not just Ctrl+F:

- Ctrl+F searches visible page text.
- Message-aware search groups results by message.
- Results can show role, type, preview, and position.
- Results can include hidden/collapsed content if it is available to the extension.
- Users can jump directly to the relevant message instead of stepping through every text match.

Tasks:

Phase 2A-1: Extract messages

- [ ] Build a message extraction adapter.
- [ ] Extract message id, role, text, index, and DOM anchor.
- [ ] Detect basic content markers: code, heading, image-heavy, question.
- [ ] Prefer semantic selectors and isolate ChatGPT DOM assumptions.

Phase 2A-2: Index messages

- [ ] Build a local in-page message index.
- [ ] Update index when visible messages change.
- [ ] Include hidden/collapsed content where available.
- [ ] Keep the index local to the page/browser.

Phase 2A-3: Search UI

- [ ] Add local message-aware search input.
- [ ] Group results by message boundary.
- [ ] Label result type: question, answer, code, heading, image-heavy message.
- [ ] Show context preview around the match.

Phase 2A-4: Jump and highlight

- [ ] Add click-to-jump from search results.
- [ ] Highlight matched text where safe.
- [ ] Clear highlight cleanly.
- [ ] Handle hidden/collapsed result targets.

Success Criteria:

- [ ] User can find and jump to a message within 3 clicks after opening the search UI.
- [ ] Search results are grouped by message, not raw text occurrences.
- [ ] Search feels meaningfully different from Ctrl+F.
- [ ] Search remains responsive on 300+ message conversations.

V0 should avoid:

```text
Plain allText.includes(keyword) with a flat match count.
```

If search does not provide message context, it is too close to Ctrl+F and should not be shipped as a flagship feature.

## Phase 2B: Conversation Outline V0

Goal:

```text
Give users an immediately visible reason to install: ChatGPT conversations get a table of contents.
```

Why this comes before smaller navigation helpers:

- Outline is screenshot-friendly.
- Users can understand the value in one screenshot.
- It clearly differs from ChatGPT's built-in rendering improvements.
- It addresses the real long-conversation problem: finding where a discussion happened.

Tasks:

- [ ] Add a conversation outline panel.
- [ ] Build V0 with rule-based extraction only.
- [ ] Extract user questions.
- [ ] Extract headings from assistant responses.
- [ ] Extract code block markers.
- [ ] Extract image-heavy message markers.
- [ ] Add click-to-jump from outline items.
- [ ] Keep all indexing local to the browser.
- [ ] Avoid cloud summarization by default.
- [ ] Do not attempt topic-shift detection in V0.

Success Criteria:

- [ ] Users can understand the outline without reading instructions.
- [ ] A screenshot of the outline immediately communicates product value.
- [ ] Outline items jump to the relevant message or section.
- [ ] V0 does not pretend to understand deep topics it cannot reliably infer.

Display principle:

```text
The internal extractor can be structural, but the UI should feel like a natural conversation map.
```

The implementation can extract:

- Questions
- Assistant headings
- Code markers
- Image-heavy messages

But the display can group them into simple sections/cards where that is obvious from nearby structure. Do not claim deep topic understanding in V0.

V0 should not try to infer deep topics like:

```text
Qt plugin architecture -> dynamic libraries -> qmake -> build system
```

Without an LLM, topic-shift detection will be brittle. With an LLM, privacy, cost, latency, and product complexity all increase. Start with observable structure first.

Potential outline format:

```text
Conversation Outline

Extension Development
- ? How should v1.3.0 be planned?
- # Manifest
- <code> background.js
- <code> content.js

View Control Discussion
- ? Why can virtualized messages be hard to manage?
- # Virtualization / lazy rendering
- <image> Image-heavy section
```

## Phase 3: Navigation Layer

Goal:

```text
Help users move around long conversations without getting lost.
```

Tasks:

- [ ] Add jump to latest.
- [ ] Add jump to oldest visible / oldest kept message.
- [ ] Add current visible region indicator.
- [ ] Add recent questions list as a supporting navigation view.
- [ ] Add click-to-jump behavior for recent questions.
- [ ] Persist minimal UI settings locally.

Success Criteria:

- [ ] User can move to latest, oldest visible, and selected outline/search results without manual scrolling.
- [ ] Navigation controls do not add visual clutter when unused.

Note:

```text
Recent Questions is useful, but should support Outline/Search rather than become the flagship feature.
```

## Phase 4: Reading Control

Goal:

```text
Reduce visual overload inside long conversations.
```

Tasks:

- [ ] Add large code block auto-collapse.
- [ ] Add configurable code block threshold.
- [ ] Add image collapse / compact image view.
- [ ] Add "collapse all code blocks" action.
- [ ] Add "expand all in visible region" action.
- [ ] Keep all controls local and reversible.

Success Criteria:

- [ ] Large code and image-heavy conversations become visibly easier to scan.
- [ ] Collapsed content can be restored without losing context.

## Phase 5: Optional Local Intelligence

Goal:

```text
Add lightweight intelligence without creating privacy or complexity risk.
```

Tasks:

- [ ] Explore local-only summary heuristics.
- [ ] Extract question timeline.
- [ ] Extract code/file references.
- [ ] Extract decisions / TODO-like lines using simple rules.
- [ ] Consider optional user-triggered LLM integration only if privacy and complexity are clearly acceptable.

## Deferred / Removed From Early Roadmap

Deferred:

```text
Deep topic-shift detection
Cloud summary
Automatic topic clustering
```

Reason:

```text
These can create privacy, reliability, cost, and complexity risks before the product has validated simpler local features.
```

## Performance Features Policy

Current performance-related features:

- Visual Control: visual hiding only.
- Refresh Restore: remove old nodes from the current view until refresh.

Policy:

- [x] Remove Local Snapshot mode because ChatGPT virtualization makes DOM snapshots unreliable.
- [ ] Do not keep investing heavily in DOM removal unless user feedback proves it is still needed.
- [ ] Keep Refresh Restore available only as an advanced edge-case tool.
- [x] Prefer view control, search, outline, and navigation for the main roadmap.

## Engineering Risks

Core risk:

```text
ChatGPT is a moving target. DOM structure, virtualization, and lazy rendering can change without notice.
```

Risks:

- [ ] ChatGPT DOM structure changes.
- [ ] Virtualization behavior changes.
- [ ] Dynamic loading timing differs by account, browser, or conversation type.
- [ ] Mobile / narrow layout differs from desktop.
- [ ] Browser compatibility issues across Chrome and Edge.
- [ ] Hidden/collapsed extension state conflicts with ChatGPT's own virtualized rendering.

Mitigation:

- [ ] Prefer semantic selectors over fragile hierarchy selectors.
- [ ] Build a small DOM adapter layer for message extraction.
- [ ] Keep extraction, indexing, rendering, and actions separated.
- [ ] Fail softly when message structure cannot be detected.
- [ ] Keep a DOM diagnostic path for developer builds, but do not expose noisy diagnostics to normal users.
- [ ] Avoid deep coupling to ChatGPT internal class names.

## Current Next Step

Immediate Next Action:

```text
1. Update popup copy and mode framing away from Performance Booster.
2. Build a quick UI container prototype for Search/Outline.
3. Implement buildMessageExtractor() as the first Message-Aware Search foundation.
```

Recommended roadmap node:

```text
Phase 0: add a local-only "What do you want next?" section in settings.
```

After that:

```text
Phase 1: update popup copy and mode framing from Performance Booster to Long Conversation / View Control.
```

Then:

```text
Phase 1.5: run a UI Experiment for the durable panel/drawer surface.
```

Then:

```text
Phase 2A: implement Message-Aware Search V0.
```

Then:

```text
Phase 2B: implement Conversation Outline V0.
```
