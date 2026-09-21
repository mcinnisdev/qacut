---
title: Changelog
sidebar: false
aside: false
---

# Changelog

What each release lets you do that the one before did not. Newest first; every heading links to the release, with the installer and the full list of commits.

## 2.4.0 (2026-09-21)

[Release notes and installer](https://github.com/mcinnisdev/qacut/releases/tag/v2.4.0)

- The quick shot window is four decisions: **Copy** (`Ctrl+C`, the picture with your note printed under it if you wrote one), **Copy for agent** (`Ctrl+Shift+A`, the path and note as text), **Add to batch** (`Ctrl+B`) and **Discard** (`Esc`). No separate copy-with and copy-without.
- The batch is visible: a strip along the bottom of the window lists every shot waiting for a hand-off. Open one to change it, drop one, **Copy batch for agent** to send them all.
- A **Text** tool (`T`) puts a label straight on the picture.
- The review window in a bundle has **Copy** too, for a shot with its note under it.
- Tray items and hotkey names say what they copy and who it is for: **Copy quick batch for agent**, **Finish bundle and copy for agent**.
- The keyboard shortcuts panel scrolls, and the caption band under a copied shot matches the shot's tone.

## 2.3.1 (2026-09-19)

[Release notes and installer](https://github.com/mcinnisdev/qacut/releases/tag/v2.3.1)

- Quick shots say who they are for. `Enter` copies the picture with your note printed under it, for a person. `Ctrl+Shift+A` copies the path and note (or the whole batch) for an agent. The A is the tell. Chats paste text in preference to an image when both are on the clipboard, so the two-in-one hand-off of 2.3.0 came out as text in Teams.
- First release you can install from **Check for updates...**.

## 2.3.0 (2026-09-19)

[Release notes and installer](https://github.com/mcinnisdev/qacut/releases/tag/v2.3.0)

- A quick shot's note can travel with the picture, printed in a band under it. (Superseded by 2.3.1's keys.)
- **Check for updates...** in the tray menu, and a quiet check at start-up, install a newer release in place. No more uninstall and reinstall.
- Every screenshot on qacut.com is now the real app, taken by QACut itself.

## 2.2.0 (2026-09-19)

[Release notes and installer](https://github.com/mcinnisdev/qacut/releases/tag/v2.2.0)

- Quick shots open in the editor: draw an arrow, highlight, blur, write the note, then **Copy image** for a person or `Ctrl+Enter` for an agent.
- **Export doc** writes a finished process document straight from a bundle, no agent needed.
- **Prompt library**: every text QACut puts on your clipboard is a template you can edit, and you can add your own and pick one before a hand-off. It has its own window from the tray.
- The quick-shot lane is now called QACut Basic everywhere, in the app and on the site.
- The keyboard shortcuts screen lists the window keys too, and hints show the live chord as you change one.
- The quick-shot window is one panel with a smaller note box and a close button that closes.
- The site has a Use cases menu, a page per mode, and a comparison table that stacks on a phone.

## 2.1.0 (2026-09-19)

[Release notes and installer](https://github.com/mcinnisdev/qacut/releases/tag/v2.1.0)

- Three tools, one tray: QACut Basic, QACut Bundles and QACut Studio, each with its own section of the menu.
- Quick shots: `Ctrl+Shift+1` takes one screenshot with one note and puts the path on your clipboard. `Enter` saves and keeps the batch open, `Ctrl+Enter` finishes and hands the batch off. Shots are filed in batches, not days.
- Review mode walks a bundle shot by shot, with markup, note and delete in one window.
- Auto-capture is a timeline of stills, filed as ordinary shots you can drop, reorder and mark up.
- Finish closes the bundle; the next capture starts a fresh one.
- The recording badge shows the shortcuts you actually have set.
- QACut is open source under the MIT License, with docs at qacut.com.

## 2.0.0 (2026-09-18)

[Release notes and installer](https://github.com/mcinnisdev/qacut/releases/tag/v2.0.0)

- **QACut Studio**: `Ctrl+Shift+R` records a region. The cursor is captured as data and drawn back smoothed and enlarged, with a ripple on every click.
- Microphone and camera: narration stays in sync, and your camera sits in a bubble on the frame.
- Zooms: mark one while recording with `Ctrl+Space`, or let them follow the cursor, with a tightness control.
- A timeline with a filmstrip, trim in and out, cuts from the middle, and zoom blocks you can drag.
- Keystroke badges, filtered to shortcuts only or every key.
- A title, subtitle and logo from your brand folder on the frame.
- Export to MP4.
- Keyboard shortcuts you can change.

## 1.0.0 (2026-09-18)

[Release notes and installer](https://github.com/mcinnisdev/qacut/releases/tag/v1.0.0)

First release: quick capture bundles for agents.

- Capture regions with a note each, grouped under master notes, from a tray icon.
- Write the bundle as a folder with a markdown file that reads in order, and hand it to an AI agent.
- Your brand kit rides along, so what the agent writes sounds like you.
