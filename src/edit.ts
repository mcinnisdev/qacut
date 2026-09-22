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
import { BACKGROUNDS } from "./studio/model";

type Tool = "move" | "arrow" | "rect" | "blur" | "step" | "text";

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
  | { kind: "arrow"; x1: number; y1: number; x2: number; y2: number; color?: string }
  | { kind: "rect"; x: number; y: number; w: number; h: number; color?: string }
  | { kind: "blur"; x: number; y: number; w: number; h: number }
  | { kind: "step"; x: number; y: number; n: number; color?: string }
  | { kind: "text"; x: number; y: number; text: string; color?: string; w?: number }
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

/// The colour a mark was drawn in; older marks have none and get the accent.
function markColor(m: Mark): string {
  return "color" in m && m.color ? m.color : ACCENT;
}

function withAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/// Ink that reads on a swatch: dark on the light and mid colours (white on
/// coral is poor contrast), white on the dark ones.
function contrastOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.5 ? "#141414" : "#ffffff";
}

title.textContent = label;

function setTool(t: Tool) {
  tool = t;
  for (const b of toolButtons) b.classList.toggle("on", b.dataset.tool === t);
  canvas.style.cursor = t === "move" ? "default" : t === "step" || t === "text" ? "text" : "crosshair";
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
  const c = markColor(m);
  ctx.save();
  ctx.strokeStyle = c;
  ctx.fillStyle = c;
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
    ctx.fillStyle = withAlpha(c, 0.12);
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
    ctx.fillStyle = contrastOn(c);
    ctx.font = `bold ${Math.round(r * 1.25)}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(m.n), m.x, m.y + r * 0.05);
  } else if (m.kind === "text") {
    // A label: ink that contrasts with its colour, rounded, sized with the
    // image; wraps inside a width set by its handle.
    const { fs, pad, lh, lines, w, h } = textBox(m);
    ctx.beginPath();
    ctx.roundRect(m.x, m.y, w, h, u * 1.5);
    ctx.fill();
    ctx.fillStyle = contrastOn(c);
    ctx.font = textFont(fs);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    lines.forEach((l, i) => ctx.fillText(l, m.x + pad, m.y + pad + i * lh + lh / 2 + fs * 0.04));
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

function textFont(fs: number) {
  return `600 ${fs}px ${getComputedStyle(document.body).fontFamily}`;
}

/// A text label's box: font size, padding, line height, the lines (wrapped
/// to the label's width when it has one) and the outer size.
function textBox(m: { text: string; w?: number }) {
  const u = unit();
  const fs = Math.round(u * 3.6);
  const pad = u * 1.5;
  const lh = Math.round(fs * 1.3);
  ctx.save();
  ctx.font = textFont(fs);
  const lines = m.w ? wrapLines(ctx, m.text, Math.max(fs, m.w - pad * 2)) : m.text.split(/\r?\n/);
  const tw = lines.reduce((max, l) => Math.max(max, ctx.measureText(l).width), 0);
  ctx.restore();
  const w = m.w ?? tw + pad * 2;
  return { fs, pad, lh, lines, w, h: Math.max(1, lines.length) * lh + pad * 2 };
}

/// The resize handle at a selected label's bottom-right corner.
function handleAt(m: Mark) {
  if (m.kind !== "text") return null;
  const b = bounds(m);
  return { x: b.x + b.w, y: b.y + b.h, r: unit() * 2.5 };
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
  if (m.kind === "text") {
    const b = textBox(m);
    return { x: m.x, y: m.y, w: b.w, h: b.h };
  }
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
  const h = handleAt(m);
  if (h) {
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#000";
    ctx.fillRect(h.x - h.r, h.y - h.r, h.r * 2, h.r * 2);
    ctx.strokeRect(h.x - h.r, h.y - h.r, h.r * 2, h.r * 2);
  }
  ctx.restore();
}

function overHandle(p: { x: number; y: number }) {
  if (selected === null) return false;
  const h = handleAt(marks[selected]);
  return h !== null && Math.abs(p.x - h.x) <= h.r * 1.6 && Math.abs(p.y - h.y) <= h.r * 1.6;
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
let resizing = false;

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const p = pos(e);
  if (tool === "move") {
    if (overHandle(p)) {
      resizing = true;
      return;
    }
    selected = hit(p.x, p.y);
    dragFrom = selected === null ? null : p;
    render();
    return;
  }
  if (tool === "step") {
    const n = marks.filter((m) => m.kind === "step").length + 1;
    marks.push({ kind: "step", x: p.x, y: p.y, n, color });
    touch();
    render();
    return;
  }
  if (tool === "text") {
    // Without this the default mousedown action moves focus off the label
    // box the moment it opens, and the blur throws the label away.
    e.preventDefault();
    beginText(p);
    return;
  }
  anchor = p;
});

// A text label is typed in a small box over the spot that was clicked,
// then drawn onto the shot on Enter.
const textEntry = document.getElementById("text-entry") as HTMLInputElement;
let textAt: { x: number; y: number } | null = null;
let textEditing: number | null = null;

/// Opens the label box at image point `p`; with `edit`, on that mark's text.
function beginText(p: { x: number; y: number }, edit: number | null = null) {
  const body = bodyEl.getBoundingClientRect();
  const r = canvas.getBoundingClientRect();
  textAt = p;
  textEditing = edit;
  const m = edit === null ? null : marks[edit];
  textEntry.value = m && m.kind === "text" ? m.text : "";
  textEntry.style.left = `${r.left - body.left + p.x * scale}px`;
  textEntry.style.top = `${r.top - body.top + p.y * scale}px`;
  textEntry.hidden = false;
  textEntry.focus();
  textEntry.select();
}

function endText(commit: boolean) {
  if (textEntry.hidden) return;
  const text = textEntry.value.trim();
  if (commit && textAt) {
    if (textEditing !== null) {
      const m = marks[textEditing];
      if (m.kind === "text") {
        if (text) marks[textEditing] = { ...m, text };
        else marks.splice(textEditing, 1);
        selected = null;
        touch();
      }
    } else if (text) {
      marks.push({ kind: "text", x: textAt.x, y: textAt.y, text, color });
      touch();
    }
  }
  textEntry.hidden = true;
  textAt = null;
  textEditing = null;
  render();
}

// ------------------------------------------------------------ colour

const swatches = Array.from(document.querySelectorAll<HTMLButtonElement>(".swatch"));
let color = ACCENT;
try {
  const saved = localStorage.getItem("qacut.markColor");
  if (saved && swatches.some((b) => b.dataset.color === saved)) color = saved;
} catch {
  // Fine without it.
}

/// The colour for new marks; with a mark selected, that mark's too.
function setColor(c: string) {
  color = c;
  try {
    localStorage.setItem("qacut.markColor", c);
  } catch {
    // Fine without it.
  }
  for (const b of swatches) b.classList.toggle("on", b.dataset.color === c);
  textEntry.style.background = c;
  textEntry.style.borderColor = c;
  textEntry.style.color = contrastOn(c);
  if (selected !== null) {
    const m = marks[selected];
    if (m.kind !== "blur" && m.kind !== "click") {
      marks[selected] = { ...m, color: c };
      touch();
      render();
    }
  }
}
for (const b of swatches) b.addEventListener("click", () => setColor(b.dataset.color ?? ACCENT));
setColor(color);

textEntry.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    endText(true);
  } else if (e.key === "Escape") {
    e.preventDefault();
    endText(false);
  }
});
textEntry.addEventListener("blur", () => endText(true));

canvas.addEventListener("mousemove", (e) => {
  const p = pos(e);
  if (tool === "move") {
    if (resizing && selected !== null) {
      const m = marks[selected];
      if (m.kind === "text") {
        marks[selected] = { ...m, w: Math.max(unit() * 10, p.x - m.x) };
        touch();
        render();
      }
      return;
    }
    if (dragFrom !== null && selected !== null) {
      marks[selected] = shift(marks[selected], p.x - dragFrom.x, p.y - dragFrom.y);
      dragFrom = p;
      touch();
      render();
    } else {
      canvas.style.cursor = overHandle(p) ? "nwse-resize" : hit(p.x, p.y) === null ? "default" : "move";
    }
    return;
  }
  if (!anchor) return;
  if (tool === "arrow") {
    draft = { kind: "arrow", x1: anchor.x, y1: anchor.y, x2: p.x, y2: p.y, color };
  } else if (tool === "rect" || tool === "blur") {
    const r = normalized(anchor.x, anchor.y, p.x, p.y);
    draft = tool === "rect" ? { kind: "rect", ...r, color } : { kind: "blur", ...r };
  }
  render();
});

// Double-click a label to reword it.
canvas.addEventListener("dblclick", (e) => {
  const p = pos(e);
  const i = hit(p.x, p.y);
  if (i === null || marks[i].kind !== "text") return;
  e.preventDefault();
  setTool("move");
  selected = i;
  render();
  beginText({ x: marks[i].x, y: marks[i].y }, i);
});

window.addEventListener("mouseup", () => {
  dragFrom = null;
  resizing = false;
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

// ------------------------------------------------------------- frame
//
// How a copied or exported shot is dressed: none, one of the studio's
// gradients, or a picture from the brand folder, with padding, rounded
// corners and a shadow. Remembered in settings; files on disk stay plain.

interface ShotFrame {
  style: string;
  image: string | null;
  padding: number;
  radius: number;
  shadow: boolean;
}
let shotFrame: ShotFrame = { style: "none", image: null, padding: 0.06, radius: 14, shadow: true };
let frameImg: HTMLImageElement | null = null;
const frameSelect = document.getElementById("frame-style") as HTMLSelectElement;

async function loadFrameImage(path: string | null) {
  frameImg = null;
  if (!path) return;
  const resp = await fetch(`${convertFileSrc(path)}?v=${Date.now()}`);
  if (!resp.ok) return;
  const url = URL.createObjectURL(await resp.blob());
  await new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      frameImg = img;
      resolve();
    };
    img.onerror = () => resolve();
    img.src = url;
  });
}

/// The editor's backdrop previews the frame.
function previewFrame() {
  const g = BACKGROUNDS[shotFrame.style as keyof typeof BACKGROUNDS];
  if (g) bodyEl.style.background = `linear-gradient(135deg, ${g[0]}, ${g[1]})`;
  else if (shotFrame.style === "image" && shotFrame.image) bodyEl.style.background = `url("${convertFileSrc(shotFrame.image)}") center / cover no-repeat`;
  else bodyEl.style.background = "";
}

async function fillFrameChoices() {
  const images = await invoke<{ name: string; path: string }[]>("list_brand_images").catch(() => []);
  frameSelect.replaceChildren();
  const add = (value: string, text: string) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    frameSelect.append(o);
  };
  add("none", "No frame");
  for (const [k, label] of [["midnight", "Midnight"], ["sunset", "Sunset"], ["ocean", "Ocean"], ["slate", "Slate"], ["plain", "Plain"]]) add(k, label);
  for (const im of images) add(`image:${im.path}`, `Picture: ${im.name}`);
  add("pick", "Choose a picture…");
  frameSelect.value = shotFrame.style === "image" && shotFrame.image ? `image:${shotFrame.image}` : shotFrame.style;
  if (frameSelect.value === "") frameSelect.value = "none";
}

async function loadFrame() {
  try {
    shotFrame = { ...shotFrame, ...(await invoke<ShotFrame>("get_shot_frame")) };
  } catch {
    // Defaults, then.
  }
  await fillFrameChoices();
  await loadFrameImage(shotFrame.style === "image" ? shotFrame.image : null);
  previewFrame();
}

frameSelect.addEventListener("change", async () => {
  const v = frameSelect.value;
  if (v === "pick") {
    try {
      const path = await invoke<string | null>("pick_brand_image");
      if (path) shotFrame = { ...shotFrame, style: "image", image: path };
    } catch (err) {
      report("picture", err);
    }
  } else if (v.startsWith("image:")) {
    shotFrame = { ...shotFrame, style: "image", image: v.slice(6) };
  } else {
    shotFrame = { ...shotFrame, style: v };
  }
  await fillFrameChoices();
  await loadFrameImage(shotFrame.style === "image" ? shotFrame.image : null);
  previewFrame();
  void invoke("set_shot_frame", { frame: shotFrame }).catch((err) => report("frame", err));
});

/// The shot on its frame: background, padding, rounded corners, shadow,
/// and the note in the padding below, as PNG base64.
async function framedPng(note: string): Promise<string> {
  const text = note.trim();
  const w = canvas.width;
  const h = canvas.height;
  const P = Math.round(Math.max(w, h) * Math.min(0.25, Math.max(0.02, shotFrame.padding)));
  const font = Math.max(14, Math.min(28, Math.round(w / 40)));
  const lh = Math.round(font * 1.45);
  const out = document.createElement("canvas");
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  const family = `${font}px "Segoe UI", system-ui, sans-serif`;
  ctx.font = family;
  const lines = text ? wrapLines(ctx, text, w) : [];
  const textH = lines.length ? Math.round(font * 0.9) + lines.length * lh : 0;
  const W = w + P * 2;
  const H = h + P * 2 + textH;
  out.width = W;
  out.height = H;
  const g = BACKGROUNDS[shotFrame.style as keyof typeof BACKGROUNDS];
  if (shotFrame.style === "image" && frameImg && frameImg.naturalWidth > 0) {
    // White under the picture, as the exported document has, so a picture
    // with transparent parts looks the same in both.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    const s = Math.max(W / frameImg.naturalWidth, H / frameImg.naturalHeight);
    const dw = frameImg.naturalWidth * s;
    const dh = frameImg.naturalHeight * s;
    ctx.drawImage(frameImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } else {
    const [c1, c2] = g ?? BACKGROUNDS.midnight;
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }
  const radius = Math.max(4, Math.round(shotFrame.radius * Math.max(0.5, Math.min(1.5, w / 1280))));
  if (shotFrame.shadow) {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
    ctx.shadowBlur = P * 0.7;
    ctx.shadowOffsetY = P * 0.2;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.roundRect(P, P, w, h, radius);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(P, P, w, h, radius);
  ctx.clip();
  ctx.drawImage(canvas, P, P);
  ctx.restore();
  if (lines.length) {
    // White on every gradient (they are all dark); on a picture, white with
    // a shadow so it reads on anything.
    ctx.font = family;
    ctx.textBaseline = "top";
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = font * 0.5;
    ctx.shadowOffsetY = 1;
    lines.forEach((l, i) => ctx.fillText(l, P, P + h + Math.round(font * 0.9) + i * lh));
  }
  const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
  if (!blob) throw new Error("empty image");
  return toBase64(blob);
}

/// The marked-up shot with the note printed in a band under it (the canvas
/// is extended, nothing is covered), as PNG base64. No note, no band. With
/// a frame chosen, the shot sits on it instead.
async function captionedPng(note: string): Promise<string> {
  if (shotFrame.style !== "none" && !(shotFrame.style === "image" && !frameImg)) return framedPng(note);
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
    void quickAddToBatch();
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
    // Esc discards a fresh shot; on a batch shot it saves and closes.
    if (inBatch) void quickAddToBatch();
    else void quickDiscard();
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
const quickCopyBtn = document.getElementById("quick-copy") as HTMLButtonElement;
const quickAgentBtn = document.getElementById("quick-agent") as HTMLButtonElement;
const quickBatchBtn = document.getElementById("quick-batch") as HTMLButtonElement;
const quickDiscardBtn = document.getElementById("quick-discard") as HTMLButtonElement;
const quickBatchRow = document.getElementById("quick-batch-row") as HTMLDivElement;
const quickBatchLabel = document.getElementById("quick-batch-label") as HTMLSpanElement;
const quickShowBtn = document.getElementById("quick-show-batch") as HTMLButtonElement;
const quickStatus = document.getElementById("quick-status") as HTMLSpanElement;
const quickPrompt = document.getElementById("quick-prompt") as HTMLSelectElement;
const strip = document.getElementById("quick-strip") as HTMLDivElement;
const stripList = document.getElementById("quick-strip-list") as HTMLDivElement;
const stripCount = document.getElementById("quick-strip-count") as HTMLSpanElement;
const stripCopyBtn = document.getElementById("quick-strip-copy") as HTMLButtonElement;
const stripDiscardBtn = document.getElementById("quick-strip-discard") as HTMLButtonElement;
const stripHideBtn = document.getElementById("quick-strip-hide") as HTMLButtonElement;

// A shot opened from the batch strip, rather than one fresh from the screen.
const inBatch = params.get("batch") === "1";

interface QuickShotInfo {
  path: string;
  name: string;
  note: string;
}
interface QuickBatchInfo {
  dir: string | null;
  shots: QuickShotInfo[];
}
let batch: QuickBatchInfo = { dir: null, shots: [] };

/// The user's saved quick-shot prompts, if any, as a picker above the note.
async function loadQuickPrompts() {
  try {
    const set = await invoke<{ current: { custom?: { id: string; name: string; kind: string }[] } }>("get_prompts");
    const mine = (set.current.custom ?? []).filter((p) => p.kind === "quick");
    if (mine.length === 0) return;
    quickPrompt.replaceChildren();
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "For agent: path and note";
    quickPrompt.append(none);
    for (const p of mine) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `For agent: ${p.name || "Untitled prompt"}`;
      quickPrompt.append(o);
    }
    quickPrompt.hidden = false;
  } catch {
    // No picker, then.
  }
}

function showBatch(b: QuickBatchInfo) {
  batch = b;
  const n = b.shots.length;
  quickBatchRow.hidden = n === 0;
  quickBatchLabel.textContent = n === 1 ? "1 shot in the batch" : `${n} shots in the batch`;
  quickBatchBtn.textContent = inBatch ? "Save to batch" : "Add to batch";
  quickDiscardBtn.textContent = inBatch ? "Remove from batch" : "Discard";
  quickCount.textContent = inBatch ? `Batch shot ${path.split(/[\\/]/).pop() ?? ""}` : "Quick shot";
  // The buttons say what they do; no explainer.
  quickHint.textContent = "";
  stripCount.textContent = n === 1 ? "Batch: 1 shot" : `Batch: ${n} shots`;
  renderStrip();
  if (n === 0) strip.hidden = true;
}

function renderStrip() {
  stripList.replaceChildren();
  for (const s of batch.shots) {
    const item = document.createElement("div");
    item.className = "strip-item";
    if (s.path === path) item.classList.add("on");
    const im = document.createElement("img");
    im.src = `${convertFileSrc(s.path)}?t=${Date.now()}`;
    im.alt = "";
    const cap = document.createElement("span");
    cap.className = "cap";
    cap.textContent = s.note || s.name;
    cap.title = s.note || s.name;
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "\u00d7";
    x.title = "Drop this shot from the batch";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      void stripRemove(s);
    });
    item.append(im, cap, x);
    item.addEventListener("click", () => void openBatchShot(s));
    stripList.append(item);
  }
}

async function refreshBatch() {
  showBatch(await invoke<QuickBatchInfo>("quick_batch"));
}

function status(text: string) {
  quickStatus.textContent = text;
  window.setTimeout(() => {
    if (quickStatus.textContent === text) quickStatus.textContent = "";
  }, 2500);
}

/// Copy: the picture, with the note printed under it when there is one.
async function quickCopy() {
  if (done) return;
  done = true;
  try {
    if (!(await writeMarks())) {
      done = false;
      return;
    }
    const pngBase64 = await captionedPng(quickNote.value);
    await invoke("quick_copy", { path, note: quickNote.value, pngBase64 });
  } catch (err) {
    done = false;
    report("copy", err);
    return;
  }
  await closeSelf();
}

/// Copy for agent: the path and note as text.
async function quickCopyAgent() {
  if (done) return;
  done = true;
  try {
    if (!(await writeMarks())) {
      done = false;
      return;
    }
    await invoke("quick_copy_agent", { path, note: quickNote.value, prompt: quickPrompt.value || null });
  } catch (err) {
    done = false;
    report("copy for agent", err);
    return;
  }
  await closeSelf();
}

/// Add to batch (or, on a batch shot, save): the shot and its note join
/// the open batch, and the window closes.
async function quickAddToBatch() {
  if (done) return;
  done = true;
  try {
    if (!(await writeMarks())) {
      done = false;
      return;
    }
    await invoke("quick_add_to_batch", { path, note: quickNote.value });
  } catch (err) {
    done = false;
    report("add to batch", err);
    return;
  }
  await closeSelf();
}

async function quickDiscard() {
  // Discard always works, whatever state a failed save left behind.
  done = true;
  try {
    if (inBatch) await invoke("quick_batch_remove", { path });
    else await invoke("discard_quick", { path });
  } catch (err) {
    report("discard", err);
  }
  await closeSelf();
}

/// Opens a batch shot in this window. A fresh shot on screen joins the
/// batch first, so nothing is lost on the way.
async function openBatchShot(s: QuickShotInfo) {
  if (s.path === path) return;
  try {
    if (!(await writeMarks())) return;
    await invoke("quick_add_to_batch", { path, note: quickNote.value });
  } catch (err) {
    status(String(err));
    return;
  }
  done = true;
  location.href = `edit.html?quick=1&batch=1&path=${encodeURIComponent(s.path)}`;
}

async function stripRemove(s: QuickShotInfo) {
  try {
    const b = await invoke<QuickBatchInfo>("quick_batch_remove", { path: s.path });
    if (s.path === path) {
      done = true;
      await closeSelf();
      return;
    }
    showBatch(b);
    if (b.shots.length) strip.hidden = false;
  } catch (err) {
    status(String(err));
  }
}

async function stripCopyAgent() {
  try {
    if (inBatch && !(await writeMarks())) return;
    if (inBatch) await invoke("quick_add_to_batch", { path, note: quickNote.value });
    await invoke("quick_batch_copy_agent", { prompt: quickPrompt.value || null });
  } catch (err) {
    status(String(err));
    return;
  }
  if (inBatch) {
    done = true;
    await closeSelf();
    return;
  }
  status("Batch copied for agent");
  await refreshBatch();
}

async function stripDiscard() {
  try {
    await invoke("quick_batch_discard");
  } catch (err) {
    status(String(err));
    return;
  }
  if (inBatch) {
    done = true;
    await closeSelf();
    return;
  }
  await refreshBatch();
}

quickCopyBtn.addEventListener("click", () => void quickCopy());
quickAgentBtn.addEventListener("click", () => void quickCopyAgent());
quickBatchBtn.addEventListener("click", () => void quickAddToBatch());
quickDiscardBtn.addEventListener("click", () => void quickDiscard());
quickShowBtn.addEventListener("click", () => {
  strip.hidden = !strip.hidden;
  quickShowBtn.textContent = strip.hidden ? "Show batch" : "Hide batch";
});
stripHideBtn.addEventListener("click", () => {
  strip.hidden = true;
  quickShowBtn.textContent = "Show batch";
});
stripCopyBtn.addEventListener("click", () => void stripCopyAgent());
stripDiscardBtn.addEventListener("click", () => void stripDiscard());

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

/// The shot with its note printed under it, for a chat or an email.
async function reviewCopy() {
  try {
    if (!(await writeMarks())) return;
    const pngBase64 = await captionedPng(shotNote.value);
    await invoke("copy_png", { pngBase64 });
    title.textContent = `${label}: copied`;
    window.setTimeout(() => {
      if (title.textContent === `${label}: copied`) title.textContent = label;
    }, 2000);
  } catch (err) {
    report("copy", err);
  }
}

(document.getElementById("review-copy") as HTMLButtonElement).addEventListener("click", () => void reviewCopy());
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
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  // Selected text in a field still copies as text; otherwise Ctrl+C is
  // the shot.
  const textSelected =
    inField && (e.target as HTMLInputElement | HTMLTextAreaElement).selectionStart !== (e.target as HTMLInputElement | HTMLTextAreaElement).selectionEnd;
  if (quick) {
    if (ctrl && e.shiftKey && key === "a") {
      // The agent chord: the A says so. Everything else goes to a person.
      e.preventDefault();
      void quickCopyAgent();
      return;
    }
    if (ctrl && !e.shiftKey && key === "c" && !textSelected) {
      e.preventDefault();
      void quickCopy();
      return;
    }
    if (ctrl && key === "b") {
      e.preventDefault();
      void quickAddToBatch();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (selected !== null && !inField) {
        selected = null;
        render();
        return;
      }
      void cancel();
      return;
    }
  }
  if (review && ctrl && !e.shiftKey && key === "c" && !textSelected) {
    e.preventDefault();
    void reviewCopy();
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
  } else if ((e.key === "Enter" && !quick) || (e.ctrlKey && e.key.toLowerCase() === "s")) {
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
    if (k === "t") setTool("text");
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
  void loadFrame();
  if (quick) {
    quickSide.hidden = false;
    title.textContent = "Quick shot";
    (document.getElementById("save") as HTMLButtonElement).hidden = true;
    (document.getElementById("cancel") as HTMLButtonElement).hidden = true;
    footKeys.innerHTML = inBatch
      ? "<kbd>Ctrl</kbd>+<kbd>C</kbd> copy <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> copy for agent <kbd>Ctrl</kbd>+<kbd>B</kbd> save to batch <kbd>Esc</kbd> save and close"
      : "<kbd>Ctrl</kbd>+<kbd>C</kbd> copy <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> copy for agent <kbd>Ctrl</kbd>+<kbd>B</kbd> add to batch <kbd>Esc</kbd> discard";
    if (inBatch) quickNote.value = await invoke<string>("quick_note", { path });
    await refreshBatch();
    if (inBatch && batch.shots.length) {
      strip.hidden = false;
      quickShowBtn.textContent = "Hide batch";
    }
    await loadQuickPrompts();
    void listen("prompts-changed", () => void loadQuickPrompts());
    await loadImage();
    quickNote.focus();
    return;
  }
  if (review) {
    side.hidden = false;
    footKeys.innerHTML =
      "<kbd>←</kbd><kbd>→</kbd> prev / next shot <kbd>Del</kbd> remove mark <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo <kbd>Ctrl</kbd>+<kbd>C</kbd> copy <kbd>Ctrl</kbd>+<kbd>S</kbd> save <kbd>Esc</kbd> close";
    await loadEntries();
    const i = entries.findIndex((e) => e.group === Number(reviewGroup) && e.shot.id === reviewShot);
    at = Math.max(0, i);
    await showCurrent();
    return;
  }
  await loadImage();
}

void boot();
