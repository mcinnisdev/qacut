---
title: Send screenshots and notes to an AI agent
description: "Spot a UI bug while an AI agent is working, screenshot it, type a note and press Copy for agent. The agent gets a path it can open and an instruction to act on."
---

# Send screenshots and notes to an AI agent

**For:** the moment you spot a UI problem while an AI agent is already working with you, and you want it fixed without breaking your stride.

Describing a layout bug in words is slow, and the agent still guesses. A screenshot with a one-line note is faster to make and harder to misread, but only if the agent can open the file. A quick shot puts the path and the note on your clipboard together, so one paste is the whole instruction.

## The flow

1. Press `Ctrl+Shift+1` and drag the button that is wrong.
2. Type what is wrong in the note box beside the shot.
3. Press **Copy for agent**, or `Ctrl+Shift+A`. The path and the note are on the clipboard.
4. Paste into your agent and carry on.

Three small things on the same page? Press **Add to batch** (`Ctrl+B`) on each and keep going; the window counts the batch and **Show batch** lists it. On the last one, **Copy batch for agent** copies all of them with their notes, so the agent gets one message with three screenshots and three instructions.

<figure class="qc-shot">
<img src="/media/use-cases/agent-feedback-loops-1.png" alt="Step 2: the note typed. Copy for agent puts the path and this note on the clipboard." loading="lazy" />
<figcaption>Step 2: the note typed. Copy for agent puts the path and this note on the clipboard.</figcaption>
</figure>
<figure class="qc-shot">
<img src="/media/use-cases/agent-feedback-loops-3.png" alt="The batch strip: three shots waiting for one hand-off." loading="lazy" />
<figcaption>The batch strip: three shots waiting for one hand-off.</figcaption>
</figure>

## What you get

For a single shot, the clipboard holds a path the agent can open and the note that tells it what to do:

```
C:\Users\nick\QACut\Quick\2026-09-19_101512\01.png
The save button is clipped at 125% scaling.
```

For a batch, the paste starts with a line naming the folder, then every shot with its note:

```
3 quick shots in C:\Users\nick\QACut\Quick\2026-09-19_101512. Each PNG has
its note in the .md beside it; notes.md lists them all.

C:\Users\nick\QACut\Quick\2026-09-19_101512\01.png
The save button is clipped at 125% scaling.

C:\Users\nick\QACut\Quick\2026-09-19_101512\02.png
This toggle animates but the state never saves.

C:\Users\nick\QACut\Quick\2026-09-19_101512\03.png
Align this label with the field above it.
```

On disk, each PNG has its note in a small markdown file beside it, and `notes.md` in the batch folder lists them all.

## Tips

- Batches close on hand-off. Your next quick shot starts a fresh folder, so an agent you talk to later never sees the shots you already had fixed. **New batch** in the note box moves the shot you are noting into a fresh folder without closing the old one.
- If you always want the same instruction around the shots, save it once in the [Prompt library](/docs/prompts) as a quick-shot prompt, with `{shots}` where the paths and notes go. A **Hand off as** picker then appears above the note.
- The single-shot and batch texts are templates too. `{path}`, `{note}`, `{count}`, `{dir}` and `{entries}` are filled in; edit them under **Prompt library…** in the tray.
- **Copy quick batch for agent** is a tray item with no default hotkey; bind one under **Keyboard shortcuts…** if you hand batches off from outside the window.

## Related

- [Copy and paste a screenshot in seconds](/use-cases/copy-and-paste), when the reader is a person and there is nothing to explain.
- [Mark up a screenshot and paste it anywhere](/use-cases/mark-up-and-paste), when an arrow says it faster than a note.
- [Build a task list of UI fixes for an AI agent](/use-cases/task-list-for-agents), when the list grows past a handful or spans several pages.
- [Quick shots](/docs/quick) in the docs.

[How it works in detail](/docs/quick) · [Download QACut](https://github.com/mcinnisdev/qacut/releases/latest)
