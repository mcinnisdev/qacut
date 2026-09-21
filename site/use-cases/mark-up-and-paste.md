---
title: Mark up a screenshot and paste it anywhere
description: "Add an arrow, highlight a field and pixelate a name before you paste a screenshot. QACut Basic marks up the shot where it opened and copies it as an image."
---

# Mark up a screenshot and paste it anywhere

**For:** anyone answering "which button do you mean?" for a colleague or a customer, when the screenshot has to point at the thing and hide what should not leave the building.

A raw screenshot makes the reader hunt. An arrow on the button, a highlight on the field and the customer's name pixelated out turns it into an instruction. Most screenshot tools do this in a second editor with a second save; in QACut Basic the tools are already in the window the shot opened in.

## The flow

1. Press `Ctrl+Shift+1` and drag the region. The shot opens large with the tools along the top.
2. Pick a tool: **Arrow**, **Highlight**, **Blur**, the **Step** counter or a **Text** label, and draw on the shot. The keys `A`, `H`, `B`, `S` and `T` pick the same tools; `M` goes back to moving marks.
3. Nudge a mark with the arrow keys (ten pixels at a time with `Shift`), `Delete` removes the selected one, and `Ctrl+Z` undoes.
4. Press **Copy**, or `Ctrl+C`.
5. Paste into the chat, the email or the ticket.

<figure class="qc-shot">
<img src="/media/use-cases/mark-up-and-paste-1.png" alt="Step 2: an arrow at the misaligned label." loading="lazy" />
<figcaption>Step 2: an arrow at the misaligned label.</figcaption>
</figure>
<figure class="qc-shot">
<img src="/media/use-cases/mark-up-and-paste-2.png" alt="Step 2: the email pixelated with Blur. The text underneath is gone from the saved file." loading="lazy" />
<figcaption>Step 2: the email pixelated with Blur. The text underneath is gone from the saved file.</figcaption>
</figure>

## What you get

The marked-up screenshot on the clipboard as an image, ready to paste anywhere that takes one. On disk, `~/QACut/Quick/` holds two files for the shot:

```
2026-09-21_093656.png        the shot with your marks
2026-09-21_093656.orig.png   the untouched original
```

So you can send the arrow-and-blur version now and still have the clean capture if someone needs it later.

## Tips

- Blur is pixelation. The text underneath is really gone from the saved shot, not softened, so an account number or a name cannot be recovered by sharpening the image.
- The **Step** counter puts numbered markers on the shot, the fastest way to say "first here, then here, then here" on a single screenshot.
- **Copy** writes the marks into the file before it copies, so the saved shot and the pasted one are the same picture.
- Type a note and Copy prints it in a band under the picture, so the explanation travels with it. A **Text** label is the other way: words placed right on the thing they are about.

## Related

- [Copy and paste a screenshot in seconds](/use-cases/copy-and-paste), when the shot needs no marks at all.
- [Send screenshots and notes to an AI agent](/use-cases/agent-feedback-loops), when the reader is an agent and the note does the pointing.
- [Organize screenshots into a document and export it](/use-cases/organize-and-export): the same tools on every shot in a bundle, from the bundle window.
- [Quick shots](/docs/quick) in the docs.

[How it works in detail](/docs/quick) · [Download QACut](https://github.com/mcinnisdev/qacut/releases/latest)
