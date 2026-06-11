# Changelog

## Unreleased

## Version 1.4.0 - Conversation Navigator: Search + Basic Bookmarks

- Added an in-page Conversation Navigator opened from the extension popup
- Added message-level results with User and Assistant labels
- Added context previews and per-message keyword match counts
- Added click-to-jump from each result to its source message
- Added Previous, Next, Enter, and Shift+Enter message-result navigation
- Added non-destructive keyword highlighting using browser Range highlights
- Added a 250 ms input debounce and a 100-match display limit
- Added temporary reveal for Visual Hide results while auto-maintain is enabled, preserving the configured limit and popup statistics
- Clarified that Temporary Trim content is not searchable after it leaves the current DOM
- Kept search local-only with no new permissions, uploads, analytics, or stored search history
- Added English and Simplified Chinese Navigator UI
- Added a Bookmark action to loaded User and Assistant messages
- Added local bookmark storage scoped by conversation and message identifiers
- Added a Bookmarks tab with role, preview, timestamp, jump, and remove actions
- Added bookmark count to the Bookmarks tab
- Added clear `☆ Bookmark` and `★ Bookmarked` message states
- Added message ID, preview, role, and index fallback for bookmark navigation
- Added Visual Hide integration for bookmark navigation
- Marked bookmarks whose messages are unavailable after Temporary Trim
- Replaced the outdated v1.3 first-use notice with a one-time v1.4 Conversation Navigator introduction

## Version 1.3.0 - Long Conversation Control

Long conversation management has been improved.

What's new:

- Reframed the extension around long conversation view control
- Added a one-time v1.3 update note explaining that the original cleanup workflow remains available
- Added Visual Control for safely hiding and expanding older rounds
- Kept Refresh Restore for users who want stronger page reduction until refresh
- Removed Local Snapshot mode because ChatGPT virtualization makes stored DOM snapshots unreliable
- Updated UI and copy for the new conversation-management direction
- Added local-only future tool interest settings for Search, Outline, Navigation, Code folding, and Image folding
