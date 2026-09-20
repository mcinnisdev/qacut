---
description: "Quick shots in QACut Basic: one hotkey, one region, a note, then paste the path into an AI agent or copy the marked-up image for a person. Saved either way."
---

# Quick shots

QACut Basic is the quick lane. A quick shot is one screenshot and one note, saved on its own and pasted straight into whatever agent you are talking to. Or, marked up and copied as an image, sent straight to a person.

## Taking one

`Ctrl+Shift+1` freezes the screen. Drag a region and the shot opens large, with the markup tools along the top and the note beside it. Type a note. Then the one decision: who is it for? `Enter` is for a person: the picture goes on the clipboard with your note printed under it, ready for Teams, Slack, an email or a ticket. `Ctrl+Shift+A` is for an agent: the screenshot's path and your note go on the clipboard as text, ready to paste into a terminal with whatever else you want to say. The A is the tell; anything without it goes to a person.

<figure class="qc-shot">
<img src="/media/docs/quick-window.png" alt="The quick shot window: markup tools along the top, the note and the hand-off picker beside the shot." loading="lazy" />
<figcaption>The quick shot window: markup tools along the top, the note and the hand-off picker beside the shot.</figcaption>
</figure>

```
C:\Users\nick\QACut\Quick\2026-09-19_101512\01.png
The save button is clipped at 125% scaling.
```

The file lands in a batch folder under `~/QACut/Quick/`, named for when the batch started, with the note beside it as a small markdown file and a `notes.md` listing every shot in the batch.

## Sending it to a person

Draw an arrow, highlight the button, blur the account number, type what you mean and press `Enter`. The shot arrives with your note printed in a band under it, so the picture and the explanation travel together and nothing is covered. **Copy image** (or `Ctrl+Shift+C`) is the picture alone, no note, for when the screenshot speaks for itself. Either way the shot is saved in the batch if you want it later.

## Sending a few together

Just keep going: `Ctrl+Shift+1`, note, `Enter`, again. Each shot joins the open batch, and the window header counts them. `Ctrl+Shift+A` on the last one (or **Finish quick batch and copy paths** in the tray) copies every shot in the batch with its note, plus a line naming the folder, in one paste for the agent, and closes the batch.

<figure class="qc-shot">
<img src="/media/docs/quick-batch.png" alt="The second shot of a batch. The header counts them; New batch moves this one to a fresh folder." loading="lazy" />
<figcaption>The second shot of a batch. The header counts them; New batch moves this one to a fresh folder.</figcaption>
</figure>

Closing matters: the next quick shot starts a fresh folder, so an agent is never pointed at shots you have already dealt with. **New batch** in the note box moves the shot you are noting into a fresh folder without closing the old one.

## Your own wording

**Prompt library…** in the tray (or **Hand off → Prompt library…** in the bundle window) lets you rewrite what goes on the clipboard: the single-shot line, the batch preamble, and the bundle prompts. Words in braces such as `{path}` and `{note}` are filled in. Reset puts a default back.

You can also add prompts of your own and pick one before a hand-off. A quick-shot prompt wraps the shots: write the instruction and put `{shots}` where the paths and notes should go, or leave it out and they are appended. Once you have one, the quick shot window shows an "Agent hand-off" picker above the note.

## When to use a bundle instead

Use quick shots for one-off fixes and short sessions. Use a [bundle](/docs/qacut) when there are enough shots across enough pages that an agent needs groups and master notes to keep them straight, when you want auto-capture to record a process, or when the hand-off should carry a purpose-specific prompt and your brand kit.
