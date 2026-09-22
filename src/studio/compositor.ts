// Draws one output frame at time t from the source video, the events and
// the edits. The same function serves the preview now and the export
// later, so what you see is what you get.
//
// Coordinate spaces: "region" is the recorded region in source pixels,
// origin at its top-left. The frame maps region space onto the canvas
// through fit, padding and (later) zoom. Everything drawn on the frame,
// cursor and ripples included, goes through that one mapping.

import { BACKGROUNDS, ZOOM_EASE_MS, type Edits, type Events, type Project, type Zoom } from "./model";

export interface Frame {
  t: number;
  source: CanvasImageSource;
  camera: HTMLVideoElement | null;
  /// The logo image, loaded by the caller, when one is chosen.
  logo?: HTMLImageElement | null;
  /// The background picture, loaded by the caller, when one is chosen.
  background?: HTMLImageElement | null;
}

export interface Track {
  /// Smoothed cursor path, region coordinates, sorted by t.
  path: { t: number; x: number; y: number }[];
  /// Click times and region positions.
  clicks: { t: number; x: number; y: number; button: string }[];
  /// Key badges to show: text and the time the press happened.
  badges: { t: number; text: string }[];
  /// Cursor shape at time t, sorted.
  shapes: { t: number; name: string }[];
  /// Camera paths for follow zooms, computed on first use and dropped
  /// when the block changes.
  follow: WeakMap<Zoom, { t: number; x: number; y: number }[]>;
}

const RIPPLE_MS = 500;
const BADGE_MS = 1400;

/// Prepares the per-project tracks once; drawing then only searches them.
export function buildTrack(project: Project, events: Events, edits: Edits): Track {
  const r = project.region;
  const raw = events.cursor.map(([t, x, y]) => ({ t, x: x - r.x, y: y - r.y }));
  const clicks = events.buttons
    .filter(([, , action]) => action === "down")
    .map(([t, button, , x, y]) => ({ t, x: x - r.x, y: y - r.y, button }));
  return {
    path: smooth(raw, clicks, edits.cursor.smoothing),
    clicks,
    badges: badgesFrom(events.keys, edits.keys.mode),
    shapes: events.shapes.map(([t, name]) => ({ t, name })),
    follow: new WeakMap(),
  };
}

/// QACut's own chords never belong in a walkthrough. Set from settings by
/// the studio at start-up; the defaults cover a recording made before the
/// user changed anything.
let OWN_HOTKEYS = new Set([
  "Ctrl+Shift+1",
  "Ctrl+Space",
  "Ctrl+Shift+2",
  "Ctrl+Shift+3",
  "Ctrl+Shift+R",
  "Ctrl+Shift+Z",
  "Ctrl+Shift+G",
  "Ctrl+Shift+Q",
  "Ctrl+Shift+N",
  "Ctrl+Shift+Enter",
]);

/// Specs in the shortcut parser's spelling; normalised to how the keystroke
/// hook names them ("Ctrl+Shift+N").
export function setOwnHotkeys(specs: string[]) {
  OWN_HOTKEYS = new Set(
    specs
      .filter((s) => s.trim() !== "")
      .map((s) =>
        s
          .replace(/CommandOrControl|CmdOrCtrl|Control/g, "Ctrl")
          .replace(/Super|Meta/g, "Win")
          .replace(/Option/g, "Alt")
          .replace(/Return/g, "Enter"),
      ),
  );
}

const SPECIAL_KEYS = new Set([
  "Enter", "Esc", "Tab", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "PrintScreen",
]);

/// Whether a badge is a shortcut rather than typing: a chord with Ctrl,
/// Alt or Win, a function key, or a special key.
function isShortcut(text: string) {
  const parts = text.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mods.some((m) => m === "Ctrl" || m === "Alt" || m === "Win")) return true;
  if (/^F\d{1,2}$/.test(key)) return true;
  return SPECIAL_KEYS.has(key);
}

/// Critically damped spring over the raw path at 120 Hz. `amount` 0 is the
/// raw path; 1 is very lazy. Clicks pull the path onto their exact point so
/// a click always lands where it happened.
function smooth(
  raw: { t: number; x: number; y: number }[],
  clicks: { t: number; x: number; y: number }[],
  amount: number,
) {
  if (raw.length === 0) return [];
  const out: { t: number; x: number; y: number }[] = [];
  const step = 1000 / 120;
  // Time constant from 0 ms (raw) to ~140 ms (lazy).
  const tau = Math.max(1, amount * 140);
  let x = raw[0].x;
  let y = raw[0].y;
  let vx = 0;
  let vy = 0;
  let i = 0;
  const end = raw[raw.length - 1].t;
  for (let t = raw[0].t; t <= end; t += step) {
    while (i + 1 < raw.length && raw[i + 1].t <= t) i++;
    const a = raw[i];
    const b = raw[Math.min(i + 1, raw.length - 1)];
    const f = b.t > a.t ? Math.min(1, (t - a.t) / (b.t - a.t)) : 0;
    const tx = a.x + (b.x - a.x) * f;
    const ty = a.y + (b.y - a.y) * f;
    // Critically damped: omega = 1/tau, acceleration toward target.
    const w = 1000 / tau;
    const dt = step / 1000;
    const ax = w * w * (tx - x) - 2 * w * vx;
    const ay = w * w * (ty - y) - 2 * w * vy;
    vx += ax * dt;
    vy += ay * dt;
    x += vx * dt;
    y += vy * dt;
    out.push({ t, x, y });
  }
  // Snap: in the 120 ms before a click ease onto the click point, hold for
  // 80 ms after, then let the spring resume from there.
  for (const c of clicks) {
    for (const p of out) {
      if (p.t < c.t - 120 || p.t > c.t + 80) continue;
      const f = p.t <= c.t ? (p.t - (c.t - 120)) / 120 : 1;
      const e = f * f * (3 - 2 * f);
      p.x = p.x + (c.x - p.x) * e;
      p.y = p.y + (c.y - p.y) * e;
    }
  }
  return out;
}

/// Turns key events into badges: each non-modifier press becomes
/// "Ctrl+Shift+S"; a modifier held alone for a while shows on its own.
/// In "shortcuts" mode plain typing is dropped.
function badgesFrom(
  keys: { t: number; key: string; down: boolean; mods: string }[],
  mode: "shortcuts" | "all",
) {
  const mods = new Set(["Ctrl", "Shift", "Alt", "Win"]);
  const out: { t: number; text: string }[] = [];
  const heldSince = new Map<string, number>();
  for (const k of keys) {
    if (mods.has(k.key)) {
      if (k.down) heldSince.set(k.key, k.t);
      else {
        const since = heldSince.get(k.key);
        heldSince.delete(k.key);
        // A lone modifier held for over half a second is worth showing.
        if (since !== undefined && k.t - since > 500 && !out.some((b) => Math.abs(b.t - since) < 50)) {
          out.push({ t: since, text: k.key });
        }
      }
      continue;
    }
    if (!k.down) continue;
    const text = k.mods ? `${k.mods}+${k.key}` : k.key;
    // The modifiers that make up this chord are accounted for.
    for (const m of k.mods.split("+")) heldSince.delete(m);
    if (OWN_HOTKEYS.has(text)) continue;
    if (mode === "shortcuts" && !isShortcut(text)) continue;
    out.push({ t: k.t, text });
  }
  return out;
}

// ---------------------------------------------------------------- zoom

export interface View {
  /// Magnification, 1 when not zoomed.
  scale: number;
  /// Top-left of the visible part of the region, in region pixels.
  vx: number;
  vy: number;
}

function smoothstep(f: number) {
  const x = Math.min(1, Math.max(0, f));
  return x * x * (3 - 2 * x);
}

/// The camera path for a follow block: it holds on (cx, cy) while the zoom
/// eases in, so the magnification and the pan never fight, then chases
/// the cursor. Inside the dead zone the camera drifts a little toward the
/// cursor; past it, the target moves with the cursor. The target is
/// continuous across the dead zone's edge (the old one jumped there,
/// which read as a jerk), and the camera reaches it through a critically
/// damped spring. `tightness` 0..1 sets dead zone and lag. Sampled at
/// 120 Hz over the block.
function followPath(
  z: Zoom,
  track: Track,
  region: { width: number; height: number },
  tightness: number,
) {
  const cached = track.follow.get(z);
  if (cached) return cached;
  const k = Math.min(1, Math.max(0, tightness));
  const dead = 0.45 - 0.3 * k; // fraction of the half-view: 0.45 lazy, 0.15 tight
  const tau = 300 - 170 * k; // ms: 300 lazy, 130 tight
  const drift = 0.1 + 0.3 * k; // pull toward the cursor inside the dead zone
  const out: { t: number; x: number; y: number }[] = [];
  const step = 1000 / 120;
  const halfW = region.width / (2 * z.scale);
  const halfH = region.height / (2 * z.scale);
  const deadX = halfW * dead;
  const deadY = halfH * dead;
  let x = z.cx;
  let y = z.cy;
  let vx = 0;
  let vy = 0;
  const w = 1000 / tau;
  const dt = step / 1000;
  const hold = z.start + Math.min(ZOOM_EASE_MS, (z.end - z.start) / 2);
  const aim = (from: number, to: number, dead: number) => {
    const d = to - from;
    const ad = Math.abs(d);
    return from + (ad <= dead ? drift * d : Math.sign(d) * (drift * dead + (ad - dead)));
  };
  for (let t = z.start; t <= z.end; t += step) {
    let tx = z.cx;
    let ty = z.cy;
    if (t >= hold) {
      const c = cursorAt(track.path, t) ?? { x, y };
      tx = aim(x, c.x, deadX);
      ty = aim(y, c.y, deadY);
    }
    const ax = w * w * (tx - x) - 2 * w * vx;
    const ay = w * w * (ty - y) - 2 * w * vy;
    vx += ax * dt;
    vy += ay * dt;
    x += vx * dt;
    y += vy * dt;
    out.push({ t, x, y });
  }
  track.follow.set(z, out);
  return out;
}

/// The view at time t: the active block eases in over ZOOM_EASE_MS from
/// its start and out over the same before its end, clamped so the view
/// never leaves the region. A follow block's centre comes from its camera
/// path instead of (cx, cy).
export function viewAt(
  zooms: Zoom[],
  t: number,
  region: { width: number; height: number },
  track?: Track,
  tightness = 0.6,
): View {
  let scale = 1;
  let cx = region.width / 2;
  let cy = region.height / 2;
  for (const z of zooms) {
    if (t < z.start || t > z.end) continue;
    const ease = Math.min(ZOOM_EASE_MS, (z.end - z.start) / 2);
    const fin = ease > 0 ? (t - z.start) / ease : 1;
    const fout = ease > 0 ? (z.end - t) / ease : 1;
    const f = smoothstep(Math.min(fin, fout));
    let tx = z.cx;
    let ty = z.cy;
    if (z.follow && track) {
      const p = cursorAt(followPath(z, track, region, tightness), t);
      if (p) {
        tx = p.x;
        ty = p.y;
      }
    }
    scale = 1 + (z.scale - 1) * f;
    cx = region.width / 2 + (tx - region.width / 2) * f;
    cy = region.height / 2 + (ty - region.height / 2) * f;
    break;
  }
  const vw = region.width / scale;
  const vh = region.height / scale;
  const vx = Math.min(Math.max(cx - vw / 2, 0), region.width - vw);
  const vy = Math.min(Math.max(cy - vh / 2, 0), region.height - vh);
  return { scale, vx, vy };
}

function at<T extends { t: number }>(arr: T[], t: number): T | null {
  let lo = 0;
  let hi = arr.length - 1;
  if (hi < 0 || t < arr[0].t) return arr[0] ?? null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return arr[lo];
}

function cursorAt(path: Track["path"], t: number) {
  if (path.length === 0) return null;
  const i = indexAt(path, t);
  const a = path[i];
  const b = path[Math.min(i + 1, path.length - 1)];
  const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

function indexAt(arr: { t: number }[], t: number) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/// Where the region lands on the canvas: fit inside the padded area,
/// keeping aspect. Returns the frame rect and the scale from region px.
export function layout(canvasW: number, canvasH: number, project: Project, edits: Edits) {
  const pad = edits.frame.padding;
  const availW = canvasW * (1 - pad * 2);
  const availH = canvasH * (1 - pad * 2);
  const r = project.region;
  const s = Math.min(availW / r.width, availH / r.height);
  const w = r.width * s;
  const h = r.height * s;
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h, s };
}

/// Draws the whole frame for time t (ms since the first source frame).
export function draw(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  project: Project,
  edits: Edits,
  track: Track,
) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const t = frame.t;

  // Background: a picture from the brand folder, scaled to cover, or one
  // of the gradients.
  if (edits.frame.background === "image" && frame.background && frame.background.naturalWidth > 0) {
    const im = frame.background;
    const s = Math.max(W / im.naturalWidth, H / im.naturalHeight);
    const dw = im.naturalWidth * s;
    const dh = im.naturalHeight * s;
    ctx.drawImage(im, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } else {
    const [c1, c2] = BACKGROUNDS[edits.frame.background === "image" ? "midnight" : edits.frame.background];
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  const L = layout(W, H, project, edits);
  const radius = edits.frame.radius * (W / 1280);

  // Shadow under the frame.
  if (edits.frame.shadow) {
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = W * 0.04;
    ctx.shadowOffsetY = W * 0.012;
    ctx.fillStyle = "#000";
    roundRect(ctx, L.x, L.y, L.w, L.h, radius);
    ctx.fill();
    ctx.restore();
  }

  // The frame: the visible part of the region (all of it, or the zoomed
  // window), clipped to rounded corners.
  ctx.save();
  roundRect(ctx, L.x, L.y, L.w, L.h, radius);
  ctx.clip();
  const r = project.region;
  const view = viewAt(edits.zooms, t, r, track, edits.follow_tightness);
  const k = L.s * view.scale;
  ctx.drawImage(
    frame.source,
    r.x + view.vx,
    r.y + view.vy,
    r.width / view.scale,
    r.height / view.scale,
    L.x,
    L.y,
    L.w,
    L.h,
  );

  // Everything on the frame shares the region-to-canvas mapping, zoom
  // included, so the cursor and ripples scale with the picture.
  const toCanvas = (x: number, y: number) => ({
    x: L.x + (x - view.vx) * k,
    y: L.y + (y - view.vy) * k,
  });

  // Click ripples.
  if (edits.cursor.ripple) {
    for (const c of track.clicks) {
      const age = t - c.t;
      if (age < 0 || age > RIPPLE_MS) continue;
      const f = age / RIPPLE_MS;
      const p = toCanvas(c.x, c.y);
      const rad = (8 + 34 * f) * k * edits.cursor.size;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.9 * (1 - f)})`;
      ctx.lineWidth = Math.max(1.5, 3 * k);
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 255, 255, ${0.25 * (1 - f)})`;
      ctx.fill();
    }
  }

  // Cursor.
  const pos = cursorAt(track.path, t);
  if (pos) {
    const shape = at(track.shapes, t)?.name ?? "arrow";
    const p = toCanvas(pos.x, pos.y);
    const size = 22 * k * edits.cursor.size;
    drawCursor(ctx, p.x, p.y, size, shape);
  }
  ctx.restore();

  // Keystroke badges, bottom centre of the frame, newest on the right.
  if (edits.keys.show) {
    const hidden = new Set(edits.keys.hidden);
    const live = track.badges
      .filter((b) => t >= b.t && t - b.t < BADGE_MS && !hidden.has(b.t))
      .slice(-3);
    if (live.length > 0) {
      const fontPx = Math.max(12, L.h * 0.035);
      ctx.font = `600 ${fontPx}px ${getComputedStyle(document.body).getPropertyValue("--mono") || "monospace"}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      const gap = fontPx * 0.6;
      const widths = live.map((b) => ctx.measureText(b.text).width + fontPx * 1.4);
      const total = widths.reduce((a, b) => a + b, 0) + gap * (live.length - 1);
      let x = L.x + L.w / 2 - total / 2;
      const y = L.y + L.h - fontPx * 2.2;
      live.forEach((b, i) => {
        const age = t - b.t;
        const alpha = age > BADGE_MS - 300 ? (BADGE_MS - age) / 300 : 1;
        const w = widths[i];
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "rgba(14, 17, 20, 0.85)";
        roundRect(ctx, x, y - fontPx * 0.9, w, fontPx * 1.8, fontPx * 0.5);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.fillText(b.text, x + w / 2, y + fontPx * 0.05);
        ctx.globalAlpha = 1;
        x += w + gap;
      });
    }
  }

  // Title and subtitle in the padding band above or below the frame.
  const uiFont = getComputedStyle(document.body).getPropertyValue("--sans") || "sans-serif";
  const titleText = edits.title.text.trim();
  const subText = edits.title.subtitle.trim();
  const band = edits.title.position === "top" ? L.y : H - (L.y + L.h);
  if ((titleText || subText) && band >= H * 0.05) {
    const titlePx = Math.min(band * 0.42, H * 0.045);
    const subPx = titlePx * 0.6;
    const gap = titlePx * 0.25;
    const total = (titleText ? titlePx : 0) + (subText ? subPx : 0) + (titleText && subText ? gap : 0);
    const bandTop = edits.title.position === "top" ? 0 : L.y + L.h;
    let y = bandTop + (band - total) / 2;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = titlePx * 0.25;
    ctx.shadowOffsetY = titlePx * 0.06;
    if (titleText) {
      ctx.font = `650 ${titlePx}px ${uiFont}`;
      ctx.fillStyle = "#fff";
      ctx.fillText(titleText, W / 2, y);
      y += titlePx + gap;
    }
    if (subText) {
      ctx.font = `450 ${subPx}px ${uiFont}`;
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillText(subText, W / 2, y);
    }
    ctx.restore();
  }

  // Logo in a corner of the padding, never over the frame.
  const logo = frame.logo;
  if (logo && logo.complete && logo.naturalWidth > 0) {
    const bandH = Math.min(L.y, H - (L.y + L.h));
    const sideW = L.x;
    const room = Math.max(bandH, sideW);
    if (room >= H * 0.04) {
      const target = room * 0.8 * edits.logo.size;
      const s = Math.min(target / logo.naturalHeight, (W * 0.25) / logo.naturalWidth);
      const lw = logo.naturalWidth * s;
      const lh = logo.naturalHeight * s;
      const m = Math.max(8, room * 0.15);
      const corner = edits.logo.corner;
      const x = corner.endsWith("l") ? m : W - m - lw;
      const y = corner.startsWith("t") ? m : H - m - lh;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = lh * 0.15;
      ctx.drawImage(logo, x, y, lw, lh);
      ctx.restore();
    }
  }

  // Camera bubble, on top of everything, inside the frame's corner.
  const cam = frame.camera;
  if (cam && edits.camera.show && project.camera?.has_video && cam.readyState >= 2) {
    const d = L.h * edits.camera.size;
    const m = L.w * 0.025;
    const cx = edits.camera.corner.endsWith("r") ? L.x + L.w - m - d : L.x + m;
    const cy = edits.camera.corner.startsWith("b") ? L.y + L.h - m - d : L.y + m;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = d * 0.15;
    ctx.shadowOffsetY = d * 0.05;
    ctx.fillStyle = "#000";
    if (edits.camera.shape === "circle") {
      ctx.beginPath();
      ctx.arc(cx + d / 2, cy + d / 2, d / 2, 0, Math.PI * 2);
    } else {
      roundRect(ctx, cx, cy, d, d, d * 0.18);
    }
    ctx.fill();
    ctx.restore();
    ctx.save();
    if (edits.camera.shape === "circle") {
      ctx.beginPath();
      ctx.arc(cx + d / 2, cy + d / 2, d / 2, 0, Math.PI * 2);
    } else {
      roundRect(ctx, cx, cy, d, d, d * 0.18);
    }
    ctx.clip();
    // Cover-fit the camera into the square.
    const vw = cam.videoWidth || 4;
    const vh = cam.videoHeight || 3;
    const s = Math.max(d / vw, d / vh);
    const dw = vw * s;
    const dh = vh * s;
    ctx.drawImage(cam, cx + (d - dw) / 2, cy + (d - dh) / 2, dw, dh);
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = Math.max(1.5, d * 0.012);
    if (edits.camera.shape === "circle") {
      ctx.beginPath();
      ctx.arc(cx + d / 2, cy + d / 2, d / 2, 0, Math.PI * 2);
    } else {
      roundRect(ctx, cx, cy, d, d, d * 0.18);
    }
    ctx.stroke();
  }
}

/// The pointer, drawn rather than captured: a white arrow with a dark
/// outline, or an I-beam over text. Hotspot at (x, y).
function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, shape: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = "round";
  if (shape === "text") {
    const h = size * 0.9;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineWidth = size * 0.16;
    ctx.beginPath();
    ctx.moveTo(0, -h / 2);
    ctx.lineTo(0, h / 2);
    ctx.moveTo(-h * 0.22, -h / 2);
    ctx.lineTo(h * 0.22, -h / 2);
    ctx.moveTo(-h * 0.22, h / 2);
    ctx.lineTo(h * 0.22, h / 2);
    ctx.stroke();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = size * 0.08;
    ctx.stroke();
    ctx.restore();
    return;
  }
  // Arrow: classic pointer outline scaled to `size` tall.
  const s = size / 20;
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 16);
  ctx.lineTo(4.2, 12.6);
  ctx.lineTo(7.2, 19);
  ctx.lineTo(10.2, 17.7);
  ctx.lineTo(7.3, 11.4);
  ctx.lineTo(12.4, 11.4);
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.lineWidth = 1.3;
  ctx.stroke();
  if (shape === "hand") {
    // A small ring on the tip says "clickable" without a second glyph.
    ctx.beginPath();
    ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,196,0,0.9)";
    ctx.fill();
  }
  ctx.restore();
}
