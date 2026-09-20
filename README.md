<p align="center">
  <img src="site/public/og.png" alt="QACut: capture your screen, hand off the work" width="720" />
</p>

<h1 align="center">QACut</h1>

<p align="center">
  Screen capture that hands off. Screenshots an AI agent can act on. Screen recordings people will actually watch.
</p>

<p align="center">
  <a href="https://github.com/mcinnisdev/qacut/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/mcinnisdev/qacut?color=ff5b5b&label=download" /></a>
  <a href="https://github.com/mcinnisdev/qacut/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/mcinnisdev/qacut/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-2f4e6f" /></a>
  <a href="https://qacut.com"><img alt="Docs" src="https://img.shields.io/badge/docs-qacut.com-2ac4ea" /></a>
</p>

<p align="center">
  <a href="https://github.com/mcinnisdev/qacut/releases/latest"><b>Download for Windows</b></a> ·
  <a href="https://qacut.com/docs/getting-started">Getting started</a> ·
  <a href="https://qacut.com/use-cases/quick-shots">Use cases</a> ·
  <a href="https://qacut.com/docs/shortcuts">Shortcuts</a>
</p>

---

QACut lives in the system tray. Press a hotkey, drag a region, do the thing. No account, no upload, no telemetry: everything is plain files under `~/QACut/` until you choose to send them somewhere.

Free and open source under the [MIT License](LICENSE). Windows 10 (2004+) or 11, x64. The installers are not code-signed yet, so SmartScreen warns on first run: **More info**, then **Run anyway**. After that, **Check for updates...** in the tray menu installs newer releases in place, and QACut also checks quietly when it starts.

## Three modes, one tray

| | Mode | For | How |
| --- | --- | --- | --- |
| **1** | **QACut Basic** · quick shots | One fix, or three, for an agent; or a marked-up screenshot for a person. | `Ctrl+Shift+1`, drag, mark up, note. `Enter` copies the picture with the note under it for a person; `Ctrl+Shift+A` copies the path and note for an agent, the whole batch if there are several. **Copy image** is the picture alone. Keep going to build a batch and paste them together. |
| **2** | **QACut Bundles** · bigger jobs | A fix list across a whole app, or the raw material for a process doc or tutorial. | `Ctrl+Shift+2` for a screenshot, `Ctrl+Shift+3` to auto-capture a process. Group by page, note each shot, finish, hand the folder to an agent with a prompt written for the job. |
| **R** | **QACut Studio** · recordings for people | A walkthrough someone will actually watch. | `Ctrl+Shift+R` records the screen with the cursor as data. Get it back smoothed and enlarged, with click ripples, follow zooms, key badges, a camera bubble and narration. Trim, cut, export to MP4. |

## QACut Basic: quick shots

`Ctrl+Shift+1` freezes the screen. Drag a region, type a note, then say who it is for: `Enter` for a person, `Ctrl+Shift+A` for an agent. The A is the tell.

```
C:\Users\nick\QACut\Quick\2026-09-19_101512\01.png
The save button is clipped at 125% scaling.
```

The shot opens large with the markup tools (arrow, highlight, blur, step counters) and the note beside it. `Enter` puts the picture on the clipboard with your note printed in a band under it, ready for Teams, Slack, an email or a ticket. `Ctrl+Shift+A` puts the screenshot's path and the note on the clipboard as text, ready for an agent's terminal. **Copy image** (`Ctrl+Shift+C`) is the picture alone: the fastest answer to "which button do you mean?"

Take a few in a row and `Ctrl+Shift+A` on the last one copies the whole batch for the agent, each shot tied to its note. The batch then closes, so the next quick shot starts a fresh folder and an agent is never pointed at shots you've already dealt with. The **Prompt library…** in the tray holds every clipboard text, quick-shot lines and bundle prompts alike, and the prompts you add yourself, picked by name before a hand-off; words in braces are filled in.

## QACut Bundles

A bundle is a folder: screenshots in groups, a note on each, and a `bundle.md` that reads top to bottom with every image linked relatively. An agent reads the file, opens the images, and knows which page each note belongs to.

- **Capture** with `Ctrl+Shift+2`. The header reads "Group 1 / Shot 1"; click either to name it. `Ctrl+Shift+G` wraps up a group with a master note and starts the next.
- **Auto-capture** with `Ctrl+Shift+3`. While you do something, QACut takes a full-resolution still at the start, at every click or Enter (ringed where the click landed), and at the end. Press it again to stop and the bundle window opens on the sequence. Every still is an ordinary shot: drop the noise, note the keepers, drag any that landed out of order. No video is made; agents can't use one, and recordings for people are the Studio's job.
- **Review** any shot from the bundle window: the image large, markup tools (arrow, highlight, blur that really removes pixels, step counters, a movable click ring), its note beside it, arrows to the next and previous shot, and delete. A whole auto-captured run can be cleaned up without leaving the window.
- **Finish** with `Ctrl+Shift+Enter`. The folder path is on your clipboard and the bundle is closed; the next capture starts a new one. **Copy agent prompt** fills the path into an instruction for a CLI agent. **Save ZIP for chat** packages the folder for an agent that only takes uploads. Reopen any bundle from **Bundle → Open bundle…** to add to it.
- **Export doc** writes a finished process document straight from the bundle: sections from the groups, numbered steps from the notes, images under each. One self-contained web page you can send, or Markdown beside the images. No agent needed.
- **Purpose** changes the agent prompt: fix issues, write a process doc (for an agent to polish), or your own template.
- **Brand kit**: put your logo, colours and voice notes in `~/QACut/brand/` and they ride along in every bundle, so what the agent produces sounds and looks like you.

```
~/QACut/2026-09-19_143022-settings-review/
  bundle.md              everything in reading order, images linked relatively
  manifest.json          the same data, structured
  01-settings-page/      01.png 02.png 03.png  (NN.orig.png and NN.marks.json beside an edited one)
  02-billing/            01.png
  brand/                 copy of ~/QACut/brand, if included
```

## QACut Studio

`Ctrl+Shift+R` records a source: the monitor under the region at up to 60 fps as H.264, with the cursor hidden, plus `events.json` carrying the cursor path at 120 Hz, cursor shapes, clicks, keystrokes (opt-in) and window titles, all on one clock. With the tray toggles on, the microphone and camera are recorded beside it.

When the recording stops the studio opens on it. Everything is drawn back in from data, so everything is editable after the fact:

- **Zooms** marked live with `Ctrl+Space` (only registered while recording) become blocks on the timeline; add more later. New zooms follow the cursor, with a dead zone so they never twitch and a tightness slider.
- **Trim and cut** with handles you can grab; cut a stretch out of the middle and put it back if you change your mind. The preview follows every move.
- **Cursor, clicks and keys**: smoothed and enlarged cursor, ripple on every click, keystroke badges for shortcuts only or every key, any badge hideable.
- **Camera bubble and narration**, any corner, any size, in sync.
- **Frame**: padding, corner radius, background, a title above the frame, your logo in a corner.
- **Export**: H.264 MP4 with AAC narration, 720p to 1440p, 30 or 60 fps, exactly as previewed, written into the recording's folder.

## Shortcuts

All of these can be changed in **Keyboard shortcuts…** (tray, or Help in the bundle window).

| Default | Does |
| --- | --- |
| `Ctrl+Shift+1` | Quick shot |
| `Ctrl+Shift+2` | Capture a region into the bundle |
| `Ctrl+Shift+3` | Auto-capture start / stop |
| `Ctrl+Shift+G` | New group (wrap up the current one with a master note) |
| `Ctrl+Shift+Q` | View / edit bundle |
| `Ctrl+Shift+Enter` | Finish the bundle and copy its path |
| `Ctrl+Shift+R` | Studio recording start / stop |
| `Ctrl+Space` | Zoom in here / out, only while a Studio recording runs |

In a note box: `Enter` saves, `Shift+Enter` adds a line, `Esc` keeps the shot with no note, `Ctrl+E` opens the markup editor on it. Quick shots: `Enter` copies the picture with the note for a person, `Ctrl+Shift+A` hands the path and note (or the batch) to an agent, `Ctrl+Shift+C` copies the picture alone. In the review window: `←` `→` previous and next shot, `M A H B S` tools, `Ctrl+Z` undo, `Ctrl+S` save, `Esc` close.

## Development

Tauri 2: a Rust backend and a vanilla TypeScript frontend built with Vite. Needs Node 22+ and a Rust toolchain, plus the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. The bundle and quick-shot halves are cross-platform in principle; Studio capture is Windows only (Windows Graphics Capture).

```bash
npm install
npm run tauri dev        # the app, with hot reload
cd site && npm install && npm run dev   # the docs site
```

```
capture.html note.html peek.html rec.html edit.html studio.html   one Vite entry per window
src/            capture, note, peek (bundle window), rec (recording badge), edit (markup + review)
src/studio/     compositor, timeline, export (WebCodecs)
src-tauri/src/  main.rs (tray, hotkeys, commands), model.rs, capture.rs, export.rs, overlay.rs
src-tauri/src/studio/  source capture, events, project files, settings
site/           VitePress docs deployed to qacut.com
scripts/        release.mjs
notes/          your own plans and scratch, gitignored
```

Where things are decided:

- Hotkey defaults: `src-tauri/src/studio/settings.rs`. Saved to `~/QACut/settings.json`.
- What `bundle.md` looks like: `render_markdown()` in `src-tauri/src/export.rs`. The agent prompts: `agent_prompt()` in `main.rs`.
- Auto-capture timing: the constants at the top of the auto-capture section in `src-tauri/src/capture.rs`.
- App icons come from `npx tauri icon assets/logo.png`; `src-tauri/icons/tray.png` is cropped by hand so the mark fills the tray.
- `harness.html` renders click moments through the Studio compositor in a browser, for checking cursor alignment against a real recording.

Checks: `npm run build` (type-check and bundle) and `cd src-tauri && cargo test`. CI runs both on every push and pull request.

## Releasing

```bash
npm run release 2.1.0     # or patch | minor | major
```

That bumps the version in `package.json`, `tauri.conf.json` and `Cargo.toml`, commits, tags `vX.Y.Z` and pushes. The Release workflow builds the MSI and NSIS installers on a Windows runner and publishes the GitHub release with notes generated from the commits. The site's Download links point at `releases/latest`, so nothing else moves. `main` takes pull requests with a green CI, or a direct push from a repository admin.

## Site

`site/` is a VitePress site deployed to [qacut.com](https://qacut.com) by the Site workflow on every push to `main`. The docs are written with QACut itself: process docs exported from a bundle land under `site/docs/` with their images beside them.

---

Made by [Nick McInnis](https://github.com/mcinnisdev). If QACut saves you a round of "which button do you mean?", a star helps the next person find it.
