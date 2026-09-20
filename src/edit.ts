// The markup editor. Marks are kept as data and rendered over the untouched
// original every time, so an edit can be reopened and adjusted rather than
// painted over a flattened image. Saving writes the composite PNG in place
// (the original is kept beside it on first save) and the marks as JSON.
//
// A recording's click stills arrive with a "click" mark already in place,
// put there by the recorder, so the cursor ring is movable like anything
// else.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Session, Shot } from "./types";

type Tool = "move" | "arrow" | "rect" | "blur" | "step";

/// Closes this window; if the graceful close fails, destroys it.
async function closeSelf() {
  const w = getCurrentWindow();
  try {
    await w.close();
  } catch (err) {
    void invoke("log_error", { message: `editor close failed, destroying: ${String(err)}` });
    await w.destroy();
  }
}
type Mark =
  | { kind: "arrow"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "blur"; x: number; y: number; w: number; h: number }
  | { kind: "step"; x: number; y: number; n: number }
  | { kind: "click"; x: number; y: number };

interface Markup {
  original: string;
  marks: Mark[];
}

const params = new URLSearchParams(location.search);
let path = params.get("path") ?? "";
const label = params.get("label") ?? "Edit";

// Review mode: opened on a shot in the bundle rather than a bare file. The
// side panel carries the note, and arrows walk the bundle's shots in
// reading order, saving marks and notes as you go.
const reviewGroup = params.get("group");
const reviewShot = params.get("shot");
const review = reviewGroup !== null && reviewShot !== null;

// Quick mode: a quick shot opens here instead of a note box. Marks are
// written before anything is copied, so what goes to the agent or the
// clipboard is the marked-up image.
const quick = params.get("quick") === "1";

const title = document.getElementById("title") as HTMLSpanElement;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const bodyEl = document.getElementById("body") as HTMLDivElement;
const toolButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".tool"),
);

const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
const img = new Image();
let marks: Mark[] = [];
let tool: Tool = "arrow";
let draft: Mark | null = null;
let selected: number | null = null;
let scale = 1;
let done = false;
let marksDirty = false;

const ACCENT = "#ff5b5b";
const CLICK = "rgb(255, 196, 0)";

title.textContent = label;

function setTool(t: Tool) {
  tool = t;
  for (const b of toolButtons) b.classList.toggle("on", b.dataset.tool === t);
  canvas.style.cursor = t === "move" ? "default" : t === "step" ? "pointer" : "crosshair";
  if (t !== "move") {
    selected = null;
    render();
  }
}

// Stroke and glyph sizes follow the image so a mark reads the same on a
// 300 px crop and a 4K grab.
function unit() {
  return Math.max(3, Math.round(Math.min(img.width, img.height) / 150));
}

function clickRadius() {
  return Math.max(8, unit() * 4);
}

function drawMark(m: Mark) {
  const u = unit();
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = ACCENT;
  ctx.lineWidth = u;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (m.kind === "arrow") {
    const angle = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
    const head = u * 4;
    ctx.beginPath();
    ctx.moveTo(m.x1, m.y1);
    ctx.lineTo(m.x2, m.y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(m.x2, m.y2);
    ctx.lineTo(
      m.x2 - head * Math.cos(angle - Math.PI / 6),
      m.y2 - head * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      m.x2 - head * Math.cos(angle + Math.PI / 6),
      m.y2 - head * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();
  } else if (m.kind === "rect") {
    ctx.fillStyle = "rgba(255, 91, 91, 0.12)";
    ctx.fillRect(m.x, m.y, m.w, m.h);
    ctx.strokeRect(m.x, m.y, m.w, m.h);
  } else if (m.kind === "blur") {
    // Pixelate: draw the region tiny, then back up with smoothing off.
    // Unlike a blur this cannot be undone by sharpening.
    const block = Math.max(8, Math.round(Math.min(img.width, img.height) / 60));
    const w = Math.max(1, Math.round(m.w));
    const h = Math.max(1, Math.round(m.h));
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(w / block));
    small.height = Math.max(1, Math.round(h / block));
    const sctx = small.getContext("2d") as CanvasRenderingContext2D;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(img, m.x, m.y, w, h, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, small.width, small.height, m.x, m.y, w, h);
    ctx.imageSmoothingEnabled = true;
  } else if (m.kind === "step") {
    const r = u * 4.5;
    ctx.beginPath();
    ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.round(r * 1.25)}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(m.n), m.x, m.y + r * 0.05);
  } else {
    // The recorder's click ring: amber, filled, like the GIF shows it.
    const r = clickRadius();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = CLICK;
    ctx.beginPath();
    ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = CLICK;
    ctx.lineWidth = Math.max(2, u * 0.8);
    ctx.beginPath();
    ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function bounds(m: Mark) {
  const u = unit();
  if (m.kind === "arrow") {
    return {
      x: Math.min(m.x1, m.x2) - u * 2,
      y: Math.min(m.y1, m.y2) - u * 2,
      w: Math.abs(m.x2 - m.x1) + u * 4,
      h: Math.abs(m.y2 - m.y1) + u * 4,
    };
  }
  if (m.kind === "rect" || m.kind === "blur") return { x: m.x, y: m.y, w: m.w, h: m.h };
  const r = m.kind === "click" ? clickRadius() : u * 4.5;
  return { x: m.x - r, y: m.y - r, w: r * 2, h: r * 2 };
}

function drawSelection(m: Mark) {
  const b = bounds(m);
  const pad = unit();
  ctx.save();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.restore();
}

function touch() {
  marksDirty = true;
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  // Blurs first so a highlight or arrow can sit on top of one.
  for (const m of marks) if (m.kind === "blur") drawMark(m);
  for (const m of marks) if (m.kind !== "blur") drawMark(m);
  if (draft) drawMark(draft);
  if (selected !== null && marks[selected]) drawSelection(marks[selected]);
}

function fit() {
  const maxW = bodyEl.clientWidth - 24;
  const maxH = bodyEl.clientHeight - 24;
  scale = Math.min(1, maxW / img.width, maxH / img.height);
  canvas.style.width = `${Math.round(img.width * scale)}px`;
  canvas.style.height = `${Math.round(img.height * scale)}px`;
}

function pos(e: MouseEvent) {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(img.width, (e.clientX - r.left) / scale)),
    y: Math.max(0, Math.min(img.height, (e.clientY - r.top) / scale)),
  };
}

function normalized(x: number, y: number, x2: number, y2: number) {
  return {
    x: Math.min(x, x2),
    y: Math.min(y, y2),
    w: Math.abs(x2 - x),
    h: Math.abs(y2 - y),
  };
}

// Topmost mark under a point, with a little slack so thin arrows and
// small rings are easy to grab.
function hit(x: number, y: number): number | null {
  const slack = unit() * 2;
  for (let i = marks.length - 1; i >= 0; i--) {
    const b = bounds(marks[i]);
    if (x >= b.x - slack && x <= b.x + b.w + slack && y >= b.y - slack && y <= b.y + b.h + slack) {
      return i;
    }
  }
  return null;
}

function shift(m: Mark, dx: number, dy: number): Mark {
  if (m.kind === "arrow") {
    return { ...m, x1: m.x1 + dx, y1: m.y1 + dy, x2: m.x2 + dx, y2: m.y2 + dy };
  }
  return { ...m, x: m.x + dx, y: m.y + dy };
}

let anchor: { x: number; y: number } | null = null;
let dragFrom: { x: number; y: number } | null = null;

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const p = pos(e);
  if (tool === "move") {
    selected = hit(p.x, p.y);
    dragFrom = selected === null ? null : p;
    render();
    return;
  }
  if (tool === "step") {
    const n = marks.filter((m) => m.kind === "step").length + 1;
    marks.push({ kind: "step", x: p.x, y: p.y, n });
    touch();
    render();
    return;
  }
  anchor = p;
});

canvas.addEventListener("mousemove", (e) => {
  const p = pos(e);
  if (tool === "move") {
    if (dragFrom !== null && selected !== null) {
      marks[selected] = shift(marks[selected], p.x - dragFrom.x, p.y - dragFrom.y);
      dragFrom = p;
      touch();
      render();
    } else {
      canvas.style.cursor = hit(p.x, p.y) === null ? "default" : "move";
    }
    return;
  }
  if (!anchor) return;
  if (tool === "arrow") {
    draft = { kind: "arrow", x1: anchor.x, y1: anchor.y, x2: p.x, y2: p.y };
  } else if (tool === "rect" || tool === "blur") {
    const r = normalized(anchor.x, anchor.y, p.x, p.y);
    draft = tool === "rect" ? { kind: "rect", ...r } : { kind: "blur", ...r };
  }
  render();
});

window.addEventListener("mouseup", () => {
  dragFrom = null;
  if (!anchor) return;
  anchor = null;
  if (draft) {
    const big =
      draft.kind === "arrow"
        ? Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > 6
        : draft.kind === "rect" || draft.kind === "blur"
          ? draft.w > 4 && draft.h > 4
          : true;
    if (big) {
      marks.push(draft);
      touch();
    }
    draft = null;
    render();
  }
});

/// Writes the composite and the marks for the image on screen. In review
/// mode this runs whenever you move to another shot, so only a changed
/// image is rewritten.
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/// Breaks `text` into lines that fit `max` pixels in the context's font.
function wrapLines(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > max) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

/// Whether the last few rows of the drawn shot are mostly dark.
function isDarkAlongBottom(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const rows = Math.min(12, h);
  const px = ctx.getImageData(0, h - rows, w, rows).data;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 16) {
    sum += px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    n++;
  }
  return n > 0 && sum / n < 110;
}

/// The marked-up shot with the note printed in a band under it (the canvas
/// is extended, nothing is covered), as PNG base64. No note, no band.
async function captionedPng(note: string): Promise<string> {
  const text = note.trim();
  const w = canvas.width;
  const h = canvas.height;
  const font = Math.max(14, Math.min(28, Math.round(w / 40)));
  const pad = Math.round(font * 1.1);
  const lh = Math.round(font * 1.45);
  const out = document.createElement("canvas");
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  const family = `${font}px "Segoe UI", system-ui, sans-serif`;
  ctx.font = family;
  const lines = text ? wrapLines(ctx, text, w - pad * 2) : [];
  const band = lines.length ? pad * 2 + lines.length * lh - Math.round(lh - font) : 0;
  out.width = w;
  out.height = h + band;
  ctx.drawImage(canvas, 0, 0);
  if (band) {
    // The band takes the shot's tone, read off its bottom edge, so it reads
    // as part of the picture rather than a label stuck under it.
    const dark = isDarkAlongBottom(ctx, w, h);
    ctx.fillStyle = dark ? "#1b1f24" : "#ffffff";
    ctx.fillRect(0, h, w, band);
    ctx.fillStyle = dark ? "#343b44" : "#d0d7de";
    ctx.fillRect(0, h, w, 1);
    ctx.fillStyle = dark ? "#e6e9ec" : "#1f2328";
    ctx.font = family;
    ctx.textBaseline = "top";
    lines.forEach((l, i) => ctx.fillText(l, pad, h + pad + i * lh));
  }
  const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
  if (!blob) throw new Error("empty image");
  return toBase64(blob);
}

async function writeMarks(): Promise<boolean> {
  if (review && !marksDirty) return true;
  selected = null;
  render();
  let blob: Blob | null = null;
  try {
    blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  } catch (err) {
    report("export", err);
    return false;
  }
  if (!blob) {
    report("export", "empty image");
    return false;
  }
  const pngBase64 = await toBase64(blob);
  try {
    await invoke("save_markup", {
      path,
      pngBase64,
      marks: JSON.stringify(marks),
    });
  } catch (err) {
    report("save", err);
    return false;
  }
  marksDirty = false;
  return true;
}

async function save() {
  if (done) return;
  if (quick) {
    void quickSave(false);
    return;
  }
  done = true;
  if (review) await saveNote();
  if (!(await writeMarks())) {
    done = false;
    return;
  }
  await closeSelf();
}

async function cancel() {
  if (done) return;
  if (quick) {
    // Esc on a quick shot keeps it, like the note box did, with the marks
    // made so far and no note.
    void quickSave(false);
    return;
  }
  done = true;
  if (review) await saveNote();
  await closeSelf();
}

// ------------------------------------------------------------- quick

const quickSide = document.getElementById("quick-side") as HTMLElement;
const quickCount = document.getElementById("quick-count") as HTMLSpanElement;
const quickHint = document.getElementById("quick-hint") as HTMLSpanElement;
const quickNote = document.getElementById("quick-note") as HTMLTextAreaElement;
const quickSaveBtn = document.getElementById("quick-save") as HTMLButtonElement;
const quickCopyBtn = document.getElementById("quick-copy-image") as HTMLButtonElement;
const quickFinishBtn = document.getElementById("quick-finish") as HTMLButtonElement;
const quickNewBtn = document.getElementById("quick-new-batch") as HTMLButtonElement;
const quickDiscardBtn = document.getElementById("quick-discard") as HTMLButtonElement;
const quickStatus = document.getElementById("quick-status") as HTMLSpanElement;
const quickPrompt = document.getElementById("quick-prompt") as HTMLSelectElement;

/// The user's saved quick-shot prompts, if any, as a picker above the note.
async function loadQuickPrompts() {
  try {
    const set = await invoke<{ current: { custom?: { id: string; name: string; kind: string }[] } }>("get_prompts");
    const mine = (set.current.custom ?? []).filter((p) => p.kind === "quick");
    if (mine.length === 0) return;
    quickPrompt.replaceChildren();
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Agent hand-off: path and note";
    quickPrompt.append(none);
    for (const p of mine) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `Agent hand-off: ${p.name || "Untitled prompt"}`;
      quickPrompt.append(o);
    }
    quickPrompt.hidden = false;
  } catch {
    // No picker, then.
  }
}

function keyLabel(spec: string) {
  return spec
    .replace(/CommandOrControl|CmdOrCtrl|Control/g, "Ctrl")
    .replace(/Super|Meta/g, "Win")
    .replace(/Option/g, "Alt")
    .replace(/Return/g, "Enter");
}

let quickKey = "Ctrl+Shift+1";
let quickBatch = 1;

function showQuickBatch(n: number) {
  quickBatch = n;
  quickCount.textContent = n > 1 ? `Quick shot ${String(n).padStart(2, "0")} in this batch` : "Quick shot";
  quickNewBtn.hidden = n < 2;
  quickFinishBtn.textContent = n > 1 ? `Hand off to agent (${n})` : "Hand off to agent";
  quickHint.textContent =
    n > 1
      ? `Enter copies this picture with its note under it, for a person, and keeps the batch open. Ctrl+Shift+A hands all ${n} shots with their notes to an agent and closes the batch. Copy image is the picture alone.`
      : `Enter copies the picture with your note under it, for a chat, an email or a ticket. Ctrl+Shift+A hands the path and note to an agent instead. Take more with ${quickKey}; they join the batch. Copy image is the picture alone.`;
}

function status(text: string) {
  quickStatus.textContent = text;
  window.setTimeout(() => {
    if (quickStatus.textContent === text) quickStatus.textContent = "";
  }, 2500);
}

/// Saves the note and this shot's marks, copies, and closes. For a person
/// (`agent` false) the clipboard gets the picture with the note under it
/// and the batch stays open. For an agent it gets the path and note as
/// text, the whole batch when there is more than one shot, and the batch
/// closes.
async function quickSave(agent: boolean) {
  if (done) return;
  done = true;
  try {
    if (!(await writeMarks())) {
      done = false;
      return;
    }
    const pngBase64 = agent ? null : await captionedPng(quickNote.value);
    const all = agent && quickBatch > 1;
    await invoke("save_quick", { note: quickNote.value, all, prompt: quickPrompt.value || null, pngBase64 });
  } catch (err) {
    done = false;
    report("quick save", err);
    return;
  }
  await closeSelf();
}

async function quickCopyImage() {
  if (!(await writeMarks())) return;
  try {
    await invoke("copy_image", { path });
    status("Image copied");
  } catch (err) {
    status(String(err));
  }
}

async function quickDiscard() {
  // Discard always works, whatever state a failed save left behind.
  done = true;
  try {
    await invoke("discard_quick");
  } catch (err) {
    report("discard", err);
  }
  await closeSelf();
}

async function quickNewBatch() {
  try {
    if (!(await writeMarks())) return;
    const r = await invoke<{ count: number; path: string }>("quick_new_batch");
    path = r.path;
    showQuickBatch(r.count);
    quickNote.focus();
  } catch (err) {
    status(String(err));
  }
}

quickSaveBtn.addEventListener("click", () => void quickSave(false));
quickCopyBtn.addEventListener("click", () => void quickCopyImage());
quickFinishBtn.addEventListener("click", () => void quickSave(true));
quickNewBtn.addEventListener("click", () => void quickNewBatch());
quickDiscardBtn.addEventListener("click", () => void quickDiscard());

function removeSelected() {
  if (selected === null) return;
  marks.splice(selected, 1);
  selected = null;
  touch();
  render();
}

// ------------------------------------------------------------ review

const side = document.getElementById("side") as HTMLElement;
const countEl = document.getElementById("count") as HTMLSpanElement;
const momentEl = document.getElementById("moment") as HTMLSpanElement;
const shotTitle = document.getElementById("shot-title") as HTMLInputElement;
const shotNote = document.getElementById("shot-note") as HTMLTextAreaElement;
const prevBtn = document.getElementById("prev") as HTMLButtonElement;
const nextBtn = document.getElementById("next") as HTMLButtonElement;
const deleteBtn = document.getElementById("delete-shot") as HTMLButtonElement;
const footKeys = document.getElementById("foot-keys") as HTMLSpanElement;

interface Entry {
  group: number;
  groupName: string;
  index: number;
  total: number;
  shot: Shot;
}

let entries: Entry[] = [];
let at = 0;

/// Every shot in the bundle in reading order, with what the panel says
/// about where it sits.
async function loadEntries() {
  const session = await invoke<Session | null>("get_session");
  entries = [];
  if (!session) return;
  for (const g of session.groups) {
    const name = g.title.trim() || `Group ${g.index}`;
    g.shots.forEach((s, i) => {
      if (s.kind === "recording") return;
      entries.push({ group: g.index, groupName: name, index: i + 1, total: g.shots.length, shot: s });
    });
  }
}

function frameLabel(m: { at_ms: number; event: string; x: number | null; y: number | null }) {
  const secs = Math.round(m.at_ms / 1000);
  let s = `${secs} s`;
  if (m.event) s += `, ${m.event}`;
  if (m.x !== null && m.y !== null) s += ` at ${m.x},${m.y}`;
  return s;
}

function current(): Entry | null {
  return entries[at] ?? null;
}

async function saveNote() {
  const e = current();
  if (!e) return;
  if (shotNote.value.trim() === e.shot.note && shotTitle.value.trim() === e.shot.title) return;
  e.shot.note = shotNote.value.trim();
  e.shot.title = shotTitle.value.trim();
  await invoke("set_shot_note", {
    group: e.group,
    shot: e.shot.id,
    note: e.shot.note,
    title: e.shot.title,
  });
}

/// Puts the shot at `at` on screen: image, marks, note, counter.
async function showCurrent() {
  const e = current();
  if (!e) {
    await closeSelf();
    return;
  }
  path = e.shot.abs_path;
  title.textContent = `${e.groupName}: shot ${e.index}`;
  countEl.textContent = `${at + 1} of ${entries.length} in the bundle · ${e.groupName}, ${e.index} of ${e.total}`;
  momentEl.textContent = e.shot.moment ? `auto · ${frameLabel(e.shot.moment)}` : "";
  shotTitle.value = e.shot.title;
  shotTitle.placeholder = `Shot ${e.index}`;
  shotNote.value = e.shot.note;
  prevBtn.disabled = at === 0;
  nextBtn.disabled = at === entries.length - 1;
  await loadImage();
}

async function go(delta: number) {
  const next = at + delta;
  if (next < 0 || next >= entries.length) return;
  await saveNote();
  if (!(await writeMarks())) return;
  at = next;
  await showCurrent();
}

async function deleteCurrent() {
  const e = current();
  if (!e) return;
  await invoke("delete_shot", { group: e.group, shot: e.shot.id });
  marksDirty = false;
  await loadEntries();
  if (at >= entries.length) at = entries.length - 1;
  await showCurrent();
}

prevBtn.addEventListener("click", () => void go(-1));
nextBtn.addEventListener("click", () => void go(1));
deleteBtn.addEventListener("click", () => void deleteCurrent());
shotNote.addEventListener("change", () => void saveNote());
shotTitle.addEventListener("change", () => void saveNote());

for (const b of toolButtons) {
  b.addEventListener("click", () => setTool(b.dataset.tool as Tool));
}
(document.getElementById("undo") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    marks.pop();
    selected = null;
    touch();
    render();
  },
);
(document.getElementById("clear") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    marks = [];
    selected = null;
    touch();
    render();
  },
);
(document.getElementById("save") as HTMLButtonElement).addEventListener(
  "click",
  () => void save(),
);
(document.getElementById("cancel") as HTMLButtonElement).addEventListener(
  "click",
  () => void cancel(),
);

window.addEventListener("keydown", (e) => {
  // Typing in the side panel: leave the keys to the field, except the
  // ones that leave it.
  const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (quick && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") {
    e.preventDefault();
    void quickCopyImage();
    return;
  }
  if (quick && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "a") {
    // The agent chord: the A says so. Everything else goes to a person.
    e.preventDefault();
    void quickSave(true);
    return;
  }
  if (quick && e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    void quickSave(false);
    return;
  }
  if (inField) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (quick) void cancel();
      else (e.target as HTMLElement).blur();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    } else if (review && (e.ctrlKey || e.metaKey) && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      void go(e.key === "ArrowRight" ? 1 : -1);
    }
    return;
  }
  if (review && selected === null && (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "PageDown" || e.key === "PageUp")) {
    e.preventDefault();
    void go(e.key === "ArrowRight" || e.key === "PageDown" ? 1 : -1);
    return;
  }
  const nudge: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  if (e.key in nudge && selected !== null) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const [dx, dy] = nudge[e.key];
    marks[selected] = shift(marks[selected], dx * step, dy * step);
    touch();
    render();
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && selected !== null) {
    e.preventDefault();
    removeSelected();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    if (selected !== null) {
      selected = null;
      render();
      return;
    }
    void cancel();
  } else if (e.key === "Enter" || (e.ctrlKey && e.key.toLowerCase() === "s")) {
    e.preventDefault();
    void save();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    marks.pop();
    selected = null;
    touch();
    render();
  } else if (!e.ctrlKey && !e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === "m") setTool("move");
    if (k === "a") setTool("arrow");
    if (k === "h") setTool("rect");
    if (k === "b") setTool("blur");
    if (k === "s") setTool("step");
  }
});

window.addEventListener("resize", () => {
  fit();
  render();
});

/// Loads `path` and its marks onto the canvas.
let imgUrl: string | null = null;

/// Loads `path` and its marks onto the canvas. The image goes through a
/// blob URL: an <img> straight from the asset protocol is cross-origin to
/// the page, which taints the canvas and makes toBlob throw, so nothing
/// could ever be saved.
async function loadImage() {
  const markup = await invoke<Markup>("load_markup", { path });
  marks = markup.marks;
  marksDirty = false;
  selected = null;
  draft = null;
  const resp = await fetch(`${convertFileSrc(markup.original)}?t=${Date.now()}`);
  if (!resp.ok) throw new Error(`could not read ${markup.original}`);
  const url = URL.createObjectURL(await resp.blob());
  if (imgUrl) URL.revokeObjectURL(imgUrl);
  imgUrl = url;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      fit();
      // A still that already carries a click mark opens on Move, since
      // nudging that ring is the likely reason for opening it.
      setTool(marks.some((m) => m.kind === "click") ? "move" : "arrow");
      render();
      resolve();
    };
    img.onerror = () => reject(new Error("image failed to decode"));
    img.src = url;
  });
}

/// Something went wrong on a path the user cannot see; say so in the
/// window and in the app log.
function report(where: string, err: unknown) {
  const msg = `${where}: ${String(err)}`;
  void invoke("log_error", { message: `editor ${msg}` });
  title.textContent = msg;
  if (quick) status(msg);
}

async function boot() {
  if (quick) {
    quickSide.hidden = false;
    title.textContent = "Quick shot";
    (document.getElementById("save") as HTMLButtonElement).hidden = true;
    (document.getElementById("cancel") as HTMLButtonElement).hidden = true;
    footKeys.innerHTML =
      "<kbd>Enter</kbd> copy for a person <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> hand off to agent <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> copy image <kbd>Esc</kbd> keep, no note";
    try {
      const hk = await invoke<{ quick: string }>("get_hotkeys");
      if (hk.quick) quickKey = keyLabel(hk.quick);
    } catch {
      // The default label is fine.
    }
    showQuickBatch(await invoke<number>("quick_count"));
    await loadQuickPrompts();
    void listen("prompts-changed", () => void loadQuickPrompts());
    await loadImage();
    quickNote.focus();
    return;
  }
  if (review) {
    side.hidden = false;
    footKeys.innerHTML =
      "<kbd>←</kbd><kbd>→</kbd> prev / next shot <kbd>Del</kbd> remove mark <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo <kbd>Ctrl</kbd>+<kbd>S</kbd> save <kbd>Esc</kbd> close";
    await loadEntries();
    const i = entries.findIndex((e) => e.group === Number(reviewGroup) && e.shot.id === reviewShot);
    at = Math.max(0, i);
    await showCurrent();
    return;
  }
  await loadImage();
}

void boot();
