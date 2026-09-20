---
description: "Install QACut on Windows, find it in the tray, and take your first bundle: hotkey, region, note, group, hand off. Free and open source, no account needed."
---

# Getting started

QACut lives in the system tray. There is no window to open first: press a hotkey, drag a region, do the thing.

## Install

Download the installer from the [latest release](https://github.com/mcinnisdev/qacut/releases/latest) and run it. Windows 10 (2004 or later) or Windows 11, 64-bit.

The installers are not code-signed yet, so SmartScreen will warn on first run. Choose **More info**, then **Run anyway**.

After install, look for the coral scissors in the tray. Left-click it for the menu.

**Updating.** QACut checks for a newer release shortly after it starts and offers to install it; **Check for updates...** in the tray menu does the same on demand. The installer runs in place, nothing to uninstall first, and your bundles, settings and prompts stay where they are.

## Three tools, one tray

The menu has three sections.

**QACut Basic** is the quick lane: one screenshot, one note, pasted straight into an agent. Read [Quick shots](/docs/quick).

**QACut Bundles** is the structured lane: screenshots, auto-captured sequences, notes and groups, bundled into a folder for an AI agent to work from. Read [Bundles for agents](/docs/qacut).

**QACut Studio** is for people: a screen recording edited into something polished, with zooms, a camera bubble and narration, exported as a video. Read [Polished screen recordings](/docs/studio).

Both put their files under `~/QACut/`. Everything is plain files you can open, move or delete.

## Your first bundle

1. Press `Ctrl+Shift+2`. The screen freezes. Drag a region.
2. Type what is wrong, or what this is, and press `Enter`. Press `Esc` to keep the shot with no note.
3. Repeat. Press `Ctrl+Shift+G` when you move to a new page or area, and give the group you just finished a master note.
4. Press `Ctrl+Shift+Enter` to write the bundle. The folder path is on your clipboard and the bundle window opens showing the result.

<figure class="qc-shot narrow">
<img src="/media/docs/getting-started-note.png" alt="The note box after a first capture." loading="lazy" />
<figcaption>The note box after a first capture.</figcaption>
</figure>

Point an agent at the folder, or use **Copy agent prompt** in the bundle window for a ready-made instruction. The bundle is finished; your next capture starts a new one.

For a one-off, skip the bundle: `Ctrl+Shift+1` takes a quick shot. `Enter` on its note copies the picture with the note under it for a person; `Ctrl+Shift+A` copies the screenshot's path and the note for an agent, and with several shots in the batch, all of them at once.

## Your first Studio recording

1. Press `Ctrl+Shift+R`, drag the region to record, adjust its edges, and press **Record**. A three-second countdown lets you get in place.
2. Do the thing. Press `Ctrl+Space` to zoom in where the cursor is, and again to zoom out.
3. Press `Ctrl+Shift+R` to stop. The studio opens on the recording.
4. Trim, adjust the zooms, add a title, and press **Export…**.

Turn on the microphone and camera toggles in the tray's Studio section first if you want narration and a camera bubble.

## Where things go

```
~/QACut/
  2026-09-17_143022-settings-review/   a bundle
  Studio/2026-09-18_125833-onedrive/   a studio recording
  brand/                                your logo, colours and voice notes
  settings.json                         shortcuts and toggles
```
