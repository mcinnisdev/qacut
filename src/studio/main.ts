// QACut Studio: opens a recording, plays it back composited, and keeps the
// edits in project.json. Playback is driven by the hidden source <video>;
// every presented frame is drawn through the compositor, so the preview is
// the export.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { buildTrack, draw, layout, setOwnHotkeys, viewAt, type Track } from "./compositor";
import { keptSegments, exportVideo, SourceFrames, type Cancel } from "./export";
import {
  DEFAULT_ZOOM_SCALE,
  withDefaults,
  zoomsFromMarks,
  type Edits,
  type Events,
  type Project,
  type StudioInfo,
  type Zoom, outputMs, rateAt, SPEED_MAX, SPEED_MIN, type Speed } from "./model";

const params = new URLSearchParams(location.search);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("canvas");
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
const stage = $<HTMLDivElement>("stage");
const empty = $<HTMLDivElement>("empty");
const src = $<HTMLVideoElement>("src");
const cam = $<HTMLVideoElement>("cam");
const nameInput = $<HTMLInputElement>("name");
const playBtn = $<HTMLButtonElement>("play");
const timeEl = $<HTMLSpanElement>("time");
const scrub = $<HTMLInputElement>("scrub");
const facts = $<HTMLDivElement>("facts");
const inspector = $<HTMLElement>("inspector");
const recordings = $<HTMLDivElement>("recordings");
const recordingsList = $<HTMLDivElement>("recordings-list");
const toastEl = $<HTMLDivElement>("toast");
const timeline = $<HTMLDivElement>("timeline");
const tlCuts = $<HTMLDivElement>("tl-cuts");
const tlZooms = $<HTMLDivElement>("tl-zooms");
const tlSpeeds = $<HTMLDivElement>("tl-speeds");
const tlCams = $<HTMLDivElement>("tl-cams");
const tlMarks = $<HTMLDivElement>("tl-marks");
const tlHead = $<HTMLDivElement>("tl-head");
const tlFilm = $<HTMLCanvasElement>("tl-film");
const tlLabel = $<HTMLDivElement>("tl-label");

let dir: string | null = null;
let project: Project | null = null;
let events: Events | null = null;
let edits: Edits = withDefaults(undefined);
let track: Track | null = null;
let saveTimer = 0;
let rafPending = false;
let selectedZoom: Zoom | null = null;
/// The chosen logo, loaded once per path.
let logoImg: HTMLImageElement | null = null;
let logoPath: string | null = null;

// Anything drawn onto the export canvas must be same-origin, or the
// canvas is tainted and cannot become a video frame. Files are therefore
// fetched and handed to elements as blob URLs.
async function blobUrl(path: string) {
  const resp = await fetch(`${convertFileSrc(path)}?v=${Date.now()}`);
  if (!resp.ok) throw new Error(`could not read ${path}`);
  return URL.createObjectURL(await resp.blob());
}

let logoUrl: string | null = null;

function loadLogo(path: string | null) {
  if (path === logoPath) return;
  logoPath = path;
  if (logoUrl) {
    URL.revokeObjectURL(logoUrl);
    logoUrl = null;
  }
  if (!path) {
    logoImg = null;
    scheduleRender();
    return;
  }
  void blobUrl(path)
    .then((url) => {
      if (logoPath !== path) {
        URL.revokeObjectURL(url);
        return;
      }
      logoUrl = url;
      const img = new Image();
      img.onload = () => {
        if (logoPath === path) {
          logoImg = img;
          scheduleRender();
        }
      };
      img.src = url;
    })
    .catch((e) => toast(String(e)));
}
/// The background picture, when the frame's background is "image".
let bgImg: HTMLImageElement | null = null;
let bgPath: string | null = null;
let bgUrl: string | null = null;

function loadBackground(path: string | null) {
  if (path === bgPath) return;
  bgPath = path;
  if (bgUrl) {
    URL.revokeObjectURL(bgUrl);
    bgUrl = null;
  }
  if (!path) {
    bgImg = null;
    scheduleRender();
    return;
  }
  void blobUrl(path)
    .then((url) => {
      if (bgPath !== path) {
        URL.revokeObjectURL(url);
        return;
      }
      bgUrl = url;
      const img = new Image();
      img.onload = () => {
        if (bgPath === path) {
          bgImg = img;
          scheduleRender();
        }
      };
      img.src = url;
    })
    .catch((e) => toast(String(e)));
}

/// A cut being made: its start, waiting for the end.
let cutFrom: number | null = null;
let selectedCut: { start: number; end: number } | null = null;
let selectedSpeed: Speed | null = null;
let selectedCam: { start: number; end: number } | null = null;

/// The camera section's two states follow the selection.
function camPanels() {
  $<HTMLElement>("cam-full-none").hidden = selectedCam !== null;
  $<HTMLElement>("cam-full-edit").hidden = selectedCam === null;
  if (selectedCam) $<HTMLElement>("cam-full-times").textContent = `${fmt(selectedCam.start)} to ${fmt(selectedCam.end)}`;
}

function toast(text: string) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(saveTimer);
  window.setTimeout(() => (toastEl.hidden = true), 1600);
}

function fmt(ms: number) {
  const s = Math.max(0, ms / 1000);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${Math.floor((s % 1) * 10)}`;
}

// ------------------------------------------------------------- canvas

// 16:9 output, sized to the stage; drawn at device pixels for crispness.
function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const maxW = stage.clientWidth - 32;
  const maxH = stage.clientHeight - 32;
  let w = maxW;
  let h = (w * 9) / 16;
  if (h > maxH) {
    h = maxH;
    w = (h * 16) / 9;
  }
  canvas.style.width = `${Math.round(w)}px`;
  canvas.style.height = `${Math.round(h)}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  render();
}

function currentMs() {
  return src.currentTime * 1000;
}

// --------------------------------------------------------- trim and cuts

function outMs() {
  return edits.trim.out_ms ?? project?.duration_ms ?? 0;
}

/// How long the finished video runs: what is kept, at the speeds set.
function keptMs() {
  if (!project) return 0;
  return outputMs(keptSegments(project, edits), edits.speeds);
}

/// The source video runs at the speed block's rate, and the camera with it.
function applyRate(t: number) {
  const r = rateAt(edits.speeds, t);
  if (src.playbackRate !== r) {
    src.playbackRate = r;
    cam.playbackRate = r;
  }
}

/// Where playback should be if it has landed on removed material.
function playable(ms: number) {
  if (ms < edits.trim.in_ms) return edits.trim.in_ms;
  for (const c of edits.cuts) if (ms >= c.start && ms < c.end) return c.end;
  return ms;
}

function render() {
  if (!project || !track) return;
  draw(ctx, { t: currentMs(), source: src, camera: project.camera ? cam : null, logo: logoImg, background: bgImg }, project, edits, track);
  timeEl.textContent = `${fmt(currentMs())} / ${fmt(project.duration_ms)}  ·  ${fmt(keptMs())} out`;
  if (document.activeElement !== scrub) {
    scrub.value = String(Math.round((currentMs() / Math.max(1, project.duration_ms)) * 1000));
  }
  tlHead.style.left = `${(currentMs() / Math.max(1, project.duration_ms)) * 100}%`;
}

function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    render();
  });
}

// Every presented source frame is composited; while paused, edits re-render.
// Removed material is skipped on the way through, and playback stops at
// the out point.
function onFrame() {
  if (!src.paused) {
    const t = currentMs();
    if (t >= outMs()) {
      pause();
      return;
    }
    const p = playable(t);
    if (p !== t) {
      src.currentTime = p / 1000;
      syncCamera(true);
    }
    applyRate(p);
  }
  render();
  syncCamera();
  if (!src.paused && !src.ended) src.requestVideoFrameCallback(onFrame);
}

// ------------------------------------------------------------ playback

function syncCamera(force = false) {
  if (!project?.camera) return;
  const want = src.currentTime - project.camera.offset_ms / 1000;
  if (want < 0) {
    if (!cam.paused) cam.pause();
    return;
  }
  const drift = Math.abs(cam.currentTime - want);
  if (force || drift > 0.12) cam.currentTime = want;
  if (!src.paused && cam.paused) void cam.play().catch(() => {});
  if (src.paused && !cam.paused) cam.pause();
}

async function play() {
  if (!project) return;
  if (src.ended || currentMs() >= outMs() - 20) src.currentTime = edits.trim.in_ms / 1000;
  else src.currentTime = playable(currentMs()) / 1000;
  applyRate(currentMs());
  await src.play();
  syncCamera(true);
  playBtn.textContent = "Pause";
  src.requestVideoFrameCallback(onFrame);
}

function pause() {
  src.pause();
  cam.pause();
  playBtn.textContent = "Play";
  render();
}

// Seeks are queued one at a time: a seek into an HEVC group of pictures
// can take a while, and piling them up is what made dragging feel dead.
// The latest requested time always wins.
let seekInFlight = false;
let seekWanted: number | null = null;

function seekMs(ms: number) {
  if (!project) return;
  const clamped = Math.max(0, Math.min(project.duration_ms, ms));
  if (seekInFlight) {
    seekWanted = clamped;
    return;
  }
  seekInFlight = true;
  src.currentTime = clamped / 1000;
  syncCamera(true);
}

src.addEventListener("seeked", () => {
  seekInFlight = false;
  render();
  if (seekWanted !== null) {
    const w = seekWanted;
    seekWanted = null;
    seekMs(w);
  }
});

// --------------------------------------------------------------- edits

function bindInspector() {
  const on = (id: string, ev: string, fn: (el: HTMLInputElement | HTMLSelectElement) => void) => {
    const el = $<HTMLInputElement | HTMLSelectElement>(id);
    el.addEventListener(ev, () => {
      fn(el);
      scheduleRender();
      saveSoon();
    });
  };
  on("padding", "input", (el) => (edits.frame.padding = Number(el.value)));
  on("radius", "input", (el) => (edits.frame.radius = Number(el.value)));
  on("background", "change", (el) => {
    edits.frame.background = el.value as Edits["frame"]["background"];
    $<HTMLElement>("bg-image-row").hidden = edits.frame.background !== "image";
  });
  on("bg-image", "change", (el) => {
    edits.frame.image = el.value || null;
    loadBackground(edits.frame.image);
  });
  on("shadow", "change", (el) => (edits.frame.shadow = (el as HTMLInputElement).checked));
  on("frame-x", "input", (el) => (edits.frame.x = Number(el.value)));
  on("frame-y", "input", (el) => (edits.frame.y = Number(el.value)));
  on("bg-anchor", "change", (el) => (edits.frame.anchor = el.value as Edits["frame"]["anchor"]));
  on("cursor-size", "input", (el) => (edits.cursor.size = Number(el.value)));
  on("smoothing", "input", (el) => {
    edits.cursor.smoothing = Number(el.value);
    // A new cursor path means new camera paths too.
    if (project && events) track = buildTrack(project, events, edits);
  });
  on("ripple", "change", (el) => (edits.cursor.ripple = (el as HTMLInputElement).checked));
  on("show-keys", "change", (el) => (edits.keys.show = (el as HTMLInputElement).checked));
  on("key-mode", "change", (el) => {
    edits.keys.mode = el.value as Edits["keys"]["mode"];
    if (project && events) track = buildTrack(project, events, edits);
    renderTimeline();
  });
  on("cam-show", "change", (el) => (edits.camera.show = (el as HTMLInputElement).checked));
  on("cam-size", "input", (el) => (edits.camera.size = Number(el.value)));
  on("cam-corner", "change", (el) => (edits.camera.corner = el.value as Edits["camera"]["corner"]));
  on("cam-shape", "change", (el) => (edits.camera.shape = el.value as Edits["camera"]["shape"]));
  on("title-text", "input", (el) => (edits.title.text = el.value));
  on("title-sub", "input", (el) => (edits.title.subtitle = el.value));
  on("title-pos", "change", (el) => (edits.title.position = el.value as Edits["title"]["position"]));
  on("logo-path", "change", (el) => {
    edits.logo.path = el.value || null;
    loadLogo(edits.logo.path);
  });
  on("logo-corner", "change", (el) => (edits.logo.corner = el.value as Edits["logo"]["corner"]));
  on("logo-size", "input", (el) => (edits.logo.size = Number(el.value)));
}

async function fillLogoChoices() {
  const images = await invoke<{ name: string; path: string }[]>("list_brand_images");
  const fill = (sel: HTMLSelectElement, current: string | null, noneText: string) => {
    sel.replaceChildren();
    const none = document.createElement("option");
    none.value = "";
    none.textContent = images.length ? noneText : `${noneText} (brand folder has no images)`;
    sel.append(none);
    for (const im of images) {
      const o = document.createElement("option");
      o.value = im.path;
      o.textContent = im.name;
      sel.append(o);
    }
    sel.value = current ?? "";
    // The file is gone; forget it.
    return current && sel.value !== current ? null : current;
  };
  edits.logo.path = fill($<HTMLSelectElement>("logo-path"), edits.logo.path, "None");
  edits.frame.image = fill($<HTMLSelectElement>("bg-image"), edits.frame.image, "Choose one");
  $<HTMLElement>("bg-image-row").hidden = edits.frame.background !== "image";
}

// Choose a file: it is copied into the brand folder, so it shows up for
// logos too and stays with the kit.
$("bg-pick").addEventListener("click", async () => {
  try {
    const path = await invoke<string | null>("pick_brand_image");
    if (!path) return;
    edits.frame.image = path;
    edits.frame.background = "image";
    $<HTMLSelectElement>("background").value = "image";
    await fillLogoChoices();
    loadBackground(path);
    saveSoon();
  } catch (e) {
    toast(String(e));
  }
});

// ------------------------------------------------------------ timeline

function pct(ms: number) {
  return `${(ms / Math.max(1, project?.duration_ms ?? 1)) * 100}%`;
}

function msAt(clientX: number) {
  const r = timeline.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  return f * (project?.duration_ms ?? 0);
}

function selectZoom(z: Zoom | null) {
  selectedZoom = z;
  if (z && selectedCut) {
    selectedCut = null;
    $<HTMLElement>("cut-edit").hidden = true;
  }
  if (z && selectedSpeed) {
    selectedSpeed = null;
    $<HTMLElement>("speed-none").hidden = false;
    $<HTMLElement>("speed-edit").hidden = true;
  }
  if (z && selectedCam) {
    selectedCam = null;
    camPanels();
  }
  $<HTMLElement>("zoom-none").hidden = z !== null;
  $<HTMLElement>("zoom-edit").hidden = z === null;
  if (z) {
    $<HTMLInputElement>("zoom-scale").value = String(z.scale);
    $<HTMLInputElement>("zoom-follow").checked = z.follow ?? false;
  }
  $<HTMLInputElement>("zoom-follow-default").checked = edits.zoom_follow;
  $<HTMLInputElement>("follow-tightness").value = String(edits.follow_tightness);
  renderTimeline();
  scheduleRender();
}

function showLabel(clientX: number, ms: number) {
  const r = timeline.getBoundingClientRect();
  tlLabel.hidden = false;
  tlLabel.textContent = fmt(ms);
  tlLabel.style.left = `${Math.min(Math.max(clientX - r.left, 24), r.width - 24)}px`;
}

function hideLabel() {
  tlLabel.hidden = true;
}

/// Generic drag on the timeline: `apply(ms, dms)` updates the model, then
/// the preview seeks to `follow(ms)` and the label shows it.
function dragOnTimeline(
  e: MouseEvent,
  apply: (ms: number, dms: number) => number,
  onEnd: () => void,
) {
  e.stopPropagation();
  e.preventDefault();
  const fromX = e.clientX;
  const onMove = (m: MouseEvent) => {
    const ms = msAt(m.clientX);
    const shown = apply(ms, msAt(m.clientX) - msAt(fromX));
    seekMs(shown);
    showLabel(m.clientX, shown);
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    hideLabel();
    onEnd();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function selectCam(b: { start: number; end: number } | null) {
  selectedCam = b;
  if (b) {
    selectedZoom = null;
    selectedCut = null;
    selectedSpeed = null;
    $<HTMLElement>("zoom-none").hidden = false;
    $<HTMLElement>("zoom-edit").hidden = true;
    $<HTMLElement>("cut-edit").hidden = true;
    $<HTMLElement>("speed-none").hidden = false;
    $<HTMLElement>("speed-edit").hidden = true;
  }
  camPanels();
  renderTimeline();
  scheduleRender();
}

function selectSpeed(b: Speed | null) {
  selectedSpeed = b;
  if (b) {
    selectedZoom = null;
    selectedCut = null;
    selectedCam = null;
    camPanels();
    $<HTMLElement>("zoom-none").hidden = false;
    $<HTMLElement>("zoom-edit").hidden = true;
    $<HTMLElement>("cut-edit").hidden = true;
    $<HTMLInputElement>("speed-rate").value = String(b.rate);
    $<HTMLElement>("speed-readout").textContent = `${b.rate}×`;
  }
  $<HTMLElement>("speed-none").hidden = b !== null;
  $<HTMLElement>("speed-edit").hidden = b === null;
  renderTimeline();
  scheduleRender();
}

function selectCut(c: { start: number; end: number } | null) {
  selectedCut = c;
  if (c) {
    selectedZoom = null;
    selectedSpeed = null;
    selectedCam = null;
    camPanels();
    $<HTMLElement>("speed-none").hidden = false;
    $<HTMLElement>("speed-edit").hidden = true;
  }
  $<HTMLElement>("cut-edit").hidden = c === null;
  if (c) $<HTMLElement>("cut-times").textContent = `${fmt(c.start)} to ${fmt(c.end)}`;
  renderTimeline();
}

function renderTimeline() {
  if (!project || !track) return;
  tlZooms.replaceChildren();
  tlSpeeds.replaceChildren();
  tlCams.replaceChildren();
  tlMarks.replaceChildren();
  tlCuts.replaceChildren();
  const D = project.duration_ms;

  // Removed material: head before in, tail after out, and cuts. Cuts can be
  // selected, moved and resized; the head and tail are set by the handles.
  const dim = (from: number, to: number) => {
    if (to <= from) return;
    const el = document.createElement("div");
    el.className = "tl-dim";
    el.style.left = pct(from);
    el.style.width = pct(to - from);
    tlCuts.append(el);
  };
  dim(0, edits.trim.in_ms);
  dim(outMs(), D);

  for (const cut of edits.cuts) {
    const el = document.createElement("div");
    el.className = "tl-dim tl-cut" + (cut === selectedCut ? " selected" : "");
    el.style.left = pct(cut.start);
    el.style.width = pct(cut.end - cut.start);
    el.title = `Cut ${fmt(cut.start)} to ${fmt(cut.end)}. Drag to move, drag an edge to resize.`;
    const l = document.createElement("div");
    l.className = "edge l";
    const r = document.createElement("div");
    r.className = "edge r";
    el.append(l, r);
    const from = { start: cut.start, end: cut.end };
    const finish = () => {
      edits.cuts.sort((a, b) => a.start - b.start);
      saveSoon();
      selectCut(cut);
      scheduleRender();
    };
    el.addEventListener("mousedown", (e) => {
      selectCut(cut);
      Object.assign(from, cut);
      dragOnTimeline(e, (_ms, dms) => {
        const len = from.end - from.start;
        cut.start = Math.min(Math.max(0, from.start + dms), D - len);
        cut.end = cut.start + len;
        el.style.left = pct(cut.start);
        return cut.start;
      }, finish);
    });
    l.addEventListener("mousedown", (e) => {
      selectCut(cut);
      Object.assign(from, cut);
      dragOnTimeline(e, (ms) => {
        cut.start = Math.min(Math.max(0, ms), cut.end - 100);
        el.style.left = pct(cut.start);
        el.style.width = pct(cut.end - cut.start);
        return cut.start;
      }, finish);
    });
    r.addEventListener("mousedown", (e) => {
      selectCut(cut);
      Object.assign(from, cut);
      dragOnTimeline(e, (ms) => {
        cut.end = Math.max(Math.min(D, ms), cut.start + 100);
        el.style.width = pct(cut.end - cut.start);
        return cut.end;
      }, finish);
    });
    tlCuts.append(el);
  }

  if (cutFrom !== null) {
    const el = document.createElement("div");
    el.className = "tl-dim tl-cut pending";
    el.style.left = pct(Math.min(cutFrom, currentMs()));
    el.style.width = pct(Math.abs(currentMs() - cutFrom));
    tlCuts.append(el);
  }

  // In and out handles: wide grips, and the preview follows while dragging.
  for (const which of ["in", "out"] as const) {
    const h = document.createElement("div");
    h.className = `tl-handle ${which}`;
    h.style.left = pct(which === "in" ? edits.trim.in_ms : outMs());
    h.title = which === "in" ? "Where the video starts. Drag, or press I at the playhead." : "Where the video ends. Drag, or press O at the playhead.";
    h.addEventListener("mousedown", (e) => {
      dragOnTimeline(e, (ms) => {
        if (which === "in") edits.trim.in_ms = Math.min(ms, outMs() - 500);
        else edits.trim.out_ms = Math.max(ms, edits.trim.in_ms + 500);
        h.style.left = pct(which === "in" ? edits.trim.in_ms : outMs());
        return which === "in" ? edits.trim.in_ms : outMs();
      }, () => {
        saveSoon();
        renderTimeline();
      });
    });
    tlCuts.append(h);
  }

  for (const z of edits.zooms) {
    const el = document.createElement("div");
    el.className = "tl-zoom" + (z === selectedZoom ? " selected" : "");
    el.style.left = pct(z.start);
    el.style.width = pct(z.end - z.start);
    el.title = `Zoom ${z.scale.toFixed(1)}×, ${fmt(z.start)} to ${fmt(z.end)}`;
    const l = document.createElement("div");
    l.className = "edge l";
    const r = document.createElement("div");
    r.className = "edge r";
    el.append(l, r);
    const from = { start: z.start, end: z.end };
    const finish = () => {
      edits.zooms.sort((a, b) => a.start - b.start);
      track?.follow.delete(z);
      saveSoon();
      renderTimeline();
    };
    el.addEventListener("mousedown", (e) => {
      selectZoom(z);
      Object.assign(from, z);
      dragOnTimeline(e, (_ms, dms) => {
        const len = from.end - from.start;
        z.start = Math.min(Math.max(0, from.start + dms), D - len);
        z.end = z.start + len;
        el.style.left = pct(z.start);
        return z.start + Math.min(700, len / 2);
      }, finish);
    });
    l.addEventListener("mousedown", (e) => {
      selectZoom(z);
      dragOnTimeline(e, (ms) => {
        z.start = Math.min(Math.max(0, ms), z.end - 300);
        el.style.left = pct(z.start);
        el.style.width = pct(z.end - z.start);
        return z.start + 1;
      }, finish);
    });
    r.addEventListener("mousedown", (e) => {
      selectZoom(z);
      dragOnTimeline(e, (ms) => {
        z.end = Math.max(Math.min(D, ms), z.start + 300);
        el.style.width = pct(z.end - z.start);
        return z.end - 1;
      }, finish);
    });
    tlZooms.append(el);
  }

  for (const b of edits.speeds) {
    const el = document.createElement("div");
    el.className = "tl-speed" + (b === selectedSpeed ? " selected" : "");
    el.style.left = pct(b.start);
    el.style.width = pct(b.end - b.start);
    el.title = `${b.rate}× from ${fmt(b.start)} to ${fmt(b.end)}. Drag to move, drag an edge to resize.`;
    const tag = document.createElement("span");
    tag.textContent = `${b.rate}×`;
    const l = document.createElement("div");
    l.className = "edge l";
    const r = document.createElement("div");
    r.className = "edge r";
    el.append(tag, l, r);
    const from = { start: b.start, end: b.end };
    const finish = () => {
      edits.speeds.sort((a, c) => a.start - c.start);
      saveSoon();
      renderTimeline();
    };
    el.addEventListener("mousedown", (e) => {
      selectSpeed(b);
      Object.assign(from, b);
      dragOnTimeline(e, (_ms, dms) => {
        const len = from.end - from.start;
        b.start = Math.min(Math.max(0, from.start + dms), D - len);
        b.end = b.start + len;
        el.style.left = pct(b.start);
        return b.start + 1;
      }, finish);
    });
    l.addEventListener("mousedown", (e) => {
      selectSpeed(b);
      dragOnTimeline(e, (ms) => {
        b.start = Math.min(Math.max(0, ms), b.end - 200);
        el.style.left = pct(b.start);
        el.style.width = pct(b.end - b.start);
        return b.start + 1;
      }, finish);
    });
    r.addEventListener("mousedown", (e) => {
      selectSpeed(b);
      dragOnTimeline(e, (ms) => {
        b.end = Math.max(Math.min(D, ms), b.start + 200);
        el.style.width = pct(b.end - b.start);
        return b.end - 1;
      }, finish);
    });
    tlSpeeds.append(el);
  }

  for (const b of edits.camera_full) {
    const el = document.createElement("div");
    el.className = "tl-cam" + (b === selectedCam ? " selected" : "");
    el.style.left = pct(b.start);
    el.style.width = pct(b.end - b.start);
    el.title = `Camera full screen from ${fmt(b.start)} to ${fmt(b.end)}. Drag to move, drag an edge to resize.`;
    const tag = document.createElement("span");
    tag.textContent = "camera";
    const l = document.createElement("div");
    l.className = "edge l";
    const r = document.createElement("div");
    r.className = "edge r";
    el.append(tag, l, r);
    const from = { start: b.start, end: b.end };
    const finish = () => {
      edits.camera_full.sort((a, c) => a.start - c.start);
      saveSoon();
      renderTimeline();
      camPanels();
    };
    el.addEventListener("mousedown", (e) => {
      selectCam(b);
      Object.assign(from, b);
      dragOnTimeline(e, (_ms, dms) => {
        const len = from.end - from.start;
        b.start = Math.min(Math.max(0, from.start + dms), D - len);
        b.end = b.start + len;
        el.style.left = pct(b.start);
        return b.start + Math.min(500, len / 2);
      }, finish);
    });
    l.addEventListener("mousedown", (e) => {
      selectCam(b);
      dragOnTimeline(e, (ms) => {
        b.start = Math.min(Math.max(0, ms), b.end - 300);
        el.style.left = pct(b.start);
        el.style.width = pct(b.end - b.start);
        return b.start + 1;
      }, finish);
    });
    r.addEventListener("mousedown", (e) => {
      selectCam(b);
      dragOnTimeline(e, (ms) => {
        b.end = Math.max(Math.min(D, ms), b.start + 300);
        el.style.width = pct(b.end - b.start);
        return b.end - 1;
      }, finish);
    });
    tlCams.append(el);
  }

  for (const c of track.clicks) {
    const d = document.createElement("div");
    d.className = "tl-click";
    d.style.left = pct(c.t);
    tlMarks.append(d);
  }
  const hidden = new Set(edits.keys.hidden);
  for (const b of track.badges) {
    const k = document.createElement("div");
    k.className = "tl-key" + (hidden.has(b.t) ? " hidden-key" : "");
    k.style.left = pct(b.t);
    k.title = `${b.text} at ${fmt(b.t)}${hidden.has(b.t) ? " (hidden)" : ""}. Click to ${hidden.has(b.t) ? "show" : "hide"}.`;
    k.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (hidden.has(b.t)) edits.keys.hidden = edits.keys.hidden.filter((t) => t !== b.t);
      else edits.keys.hidden.push(b.t);
      seekMs(b.t + 50);
      saveSoon();
      renderTimeline();
    });
    tlMarks.append(k);
  }
}

// ------------------------------------------------------------ filmstrip
//
// Thumbnails behind the timeline, decoded once per recording through the
// export's frame reader, so handles and blocks can be placed by eye before
// the preview catches up.

let film: { t: number; bmp: ImageBitmap }[] = [];
let filmFor: string | null = null;

async function buildFilmstrip() {
  if (!project || !dir || filmFor === dir) return;
  const forDir = dir;
  filmFor = dir;
  film = [];
  drawFilm();
  try {
    const reader = await SourceFrames.open(src.src, () => {});
    const n = Math.max(24, Math.min(160, Math.floor(timeline.clientWidth / 40)));
    const r = project.region;
    const th = 64;
    const tw = Math.max(1, Math.round((th * r.width) / r.height));
    const c = document.createElement("canvas");
    c.width = tw;
    c.height = th;
    const g = c.getContext("2d") as CanvasRenderingContext2D;
    for (let i = 0; i < n; i++) {
      if (dir !== forDir) break;
      const t = ((i + 0.5) / n) * project.duration_ms;
      const f = await reader.at(t);
      if (!f) continue;
      g.drawImage(f, r.x, r.y, r.width, r.height, 0, 0, tw, th);
      film.push({ t, bmp: await createImageBitmap(c) });
      if (i % 8 === 0) drawFilm();
    }
    reader.close();
  } catch (e) {
    console.warn("filmstrip", e);
  }
  drawFilm();
}

function drawFilm() {
  const w = timeline.clientWidth;
  const h = timeline.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  tlFilm.width = Math.round(w * dpr);
  tlFilm.height = Math.round(h * dpr);
  const g = tlFilm.getContext("2d") as CanvasRenderingContext2D;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  if (!project || film.length === 0) return;
  const D = project.duration_ms;
  const slot = w / film.length;
  g.globalAlpha = 0.6;
  film.forEach(({ t, bmp }, i) => {
    const x0 = i * slot;
    const cx = (t / D) * w;
    const tw = (h * bmp.width) / bmp.height;
    g.save();
    g.beginPath();
    g.rect(x0, 0, slot + 0.5, h);
    g.clip();
    g.drawImage(bmp, cx - tw / 2, 0, tw, h);
    g.restore();
  });
  g.globalAlpha = 1;
}

// Clicking or dragging the empty timeline scrubs; it also deselects.
timeline.addEventListener("mousedown", (e) => {
  if (!project) return;
  selectZoom(null);
  selectCut(null);
  selectSpeed(null);
  selectCam(null);
  const move = (m: MouseEvent) => {
    const ms = msAt(m.clientX);
    seekMs(ms);
    showLabel(m.clientX, ms);
    if (cutFrom !== null) renderTimeline();
  };
  move(e);
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    hideLabel();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

// Drag in the preview while a zoom is selected to move where it looks.
canvas.addEventListener("mousedown", (e) => {
  if (!project || !selectedZoom) return;
  const z = selectedZoom;
  const t = currentMs();
  if (t < z.start || t > z.end) seekMs(z.start + Math.min(700, (z.end - z.start) / 2));
  const rect = canvas.getBoundingClientRect();
  const L = layout(canvas.width, canvas.height, project, edits);
  const view = viewAt(edits.zooms, currentMs(), project.region, track ?? undefined, edits.follow_tightness);
  const perPx = (canvas.width / rect.width) / (L.s * view.scale);
  let last = { x: e.clientX, y: e.clientY };
  canvas.style.cursor = "grabbing";
  const onMove = (m: MouseEvent) => {
    z.cx = Math.min(Math.max(z.cx - (m.clientX - last.x) * perPx, 0), project!.region.width);
    z.cy = Math.min(Math.max(z.cy - (m.clientY - last.y) * perPx, 0), project!.region.height);
    last = { x: m.clientX, y: m.clientY };
    track?.follow.delete(z);
    scheduleRender();
  };
  const onUp = () => {
    canvas.style.cursor = "";
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    saveSoon();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});

// Trim and cut actions on the transport bar; I, O and X do the same from
// the keyboard.
function setIn() {
  if (!project) return;
  edits.trim.in_ms = Math.min(currentMs(), outMs() - 500);
  saveSoon();
  renderTimeline();
  toast(`Starts at ${fmt(edits.trim.in_ms)}`);
}
function setOut() {
  if (!project) return;
  edits.trim.out_ms = Math.max(currentMs(), edits.trim.in_ms + 500);
  saveSoon();
  renderTimeline();
  toast(`Ends at ${fmt(outMs())}`);
}
function toggleCut() {
  if (!project) return;
  const t = currentMs();
  const btn = $<HTMLButtonElement>("cut-toggle");
  if (cutFrom === null) {
    cutFrom = t;
    btn.textContent = "Cut to here";
    btn.classList.add("on");
    toast(`Cutting from ${fmt(t)}. Move the playhead to where it should resume, then press Cut to here.`);
  } else {
    const start = Math.min(cutFrom, t);
    const end = Math.max(cutFrom, t);
    cutFrom = null;
    btn.textContent = "Cut";
    btn.classList.remove("on");
    if (end - start >= 100) {
      const cut = { start, end };
      edits.cuts.push(cut);
      edits.cuts.sort((a, b) => a.start - b.start);
      saveSoon();
      selectCut(cut);
      toast(`Cut ${fmt(start)} to ${fmt(end)}. Drag it or its edges to adjust.`);
    }
  }
  renderTimeline();
}
function removeSelectedCut() {
  if (!selectedCut) return;
  edits.cuts = edits.cuts.filter((c) => c !== selectedCut);
  selectCut(null);
  saveSoon();
  scheduleRender();
}
$("trim-in").addEventListener("click", setIn);
$("trim-out").addEventListener("click", setOut);
$("cut-toggle").addEventListener("click", toggleCut);
$("cut-remove").addEventListener("click", removeSelectedCut);
$("trim-reset").addEventListener("click", () => {
  edits.trim = { in_ms: 0, out_ms: null };
  edits.cuts = [];
  cutFrom = null;
  const btn = $<HTMLButtonElement>("cut-toggle");
  btn.textContent = "Cut";
  btn.classList.remove("on");
  selectCut(null);
  saveSoon();
  renderTimeline();
  scheduleRender();
});

$("zoom-add").addEventListener("click", () => {
  if (!project || !track) return;
  const t = currentMs();
  const path = track.path;
  let cx = project.region.width / 2;
  let cy = project.region.height / 2;
  if (path.length > 0) {
    const p = path.reduce((best, q) => (Math.abs(q.t - t) < Math.abs(best.t - t) ? q : best), path[0]);
    cx = p.x;
    cy = p.y;
  }
  const z: Zoom = {
    start: t,
    end: Math.min(project.duration_ms, t + 3000),
    cx,
    cy,
    scale: DEFAULT_ZOOM_SCALE,
    follow: edits.zoom_follow,
  };
  edits.zooms.push(z);
  edits.zooms.sort((a, b) => a.start - b.start);
  selectZoom(z);
  saveSoon();
});
$("zoom-add-bar").addEventListener("click", () => $("zoom-add").click());

$("speed-add").addEventListener("click", () => {
  if (!project) return;
  const t = currentMs();
  const b: Speed = { start: t, end: Math.min(project.duration_ms, t + 3000), rate: 2 };
  edits.speeds.push(b);
  edits.speeds.sort((a, c) => a.start - c.start);
  selectSpeed(b);
  saveSoon();
});
$("speed-add-bar").addEventListener("click", () => $("speed-add").click());

$("cam-full-add").addEventListener("click", () => {
  if (!project?.camera?.has_video) return;
  const t = currentMs();
  const b = { start: t, end: Math.min(project.duration_ms, t + 5000) };
  edits.camera_full.push(b);
  edits.camera_full.sort((a, c) => a.start - c.start);
  selectCam(b);
  saveSoon();
});
$("cam-full-add-bar").addEventListener("click", () => $("cam-full-add").click());
$("cam-full-remove").addEventListener("click", () => {
  if (!selectedCam) return;
  edits.camera_full = edits.camera_full.filter((b) => b !== selectedCam);
  selectCam(null);
  saveSoon();
});
$("speed-remove").addEventListener("click", () => {
  if (!selectedSpeed) return;
  edits.speeds = edits.speeds.filter((b) => b !== selectedSpeed);
  selectSpeed(null);
  saveSoon();
});
$<HTMLInputElement>("speed-rate").addEventListener("input", (e) => {
  if (!selectedSpeed) return;
  const v = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number((e.target as HTMLInputElement).value)));
  selectedSpeed.rate = v;
  $<HTMLElement>("speed-readout").textContent = `${v}×`;
  applyRate(currentMs());
  renderTimeline();
  scheduleRender();
  saveSoon();
});
$("zoom-remove").addEventListener("click", () => {
  if (!selectedZoom) return;
  edits.zooms = edits.zooms.filter((z) => z !== selectedZoom);
  selectZoom(null);
  saveSoon();
});
$<HTMLInputElement>("zoom-scale").addEventListener("input", (e) => {
  if (!selectedZoom) return;
  selectedZoom.scale = Number((e.target as HTMLInputElement).value);
  track?.follow.delete(selectedZoom);
  renderTimeline();
  scheduleRender();
  saveSoon();
});
$<HTMLInputElement>("zoom-follow").addEventListener("change", (e) => {
  if (!selectedZoom) return;
  selectedZoom.follow = (e.target as HTMLInputElement).checked;
  track?.follow.delete(selectedZoom);
  scheduleRender();
  saveSoon();
});
$<HTMLInputElement>("zoom-follow-default").addEventListener("change", (e) => {
  edits.zoom_follow = (e.target as HTMLInputElement).checked;
  saveSoon();
});
$<HTMLInputElement>("follow-tightness").addEventListener("input", (e) => {
  edits.follow_tightness = Number((e.target as HTMLInputElement).value);
  // Every follow path depends on it.
  if (track) track.follow = new WeakMap();
  scheduleRender();
  saveSoon();
});

interface BrandLook {
  name: string;
  background: string;
  image: string | null;
  padding: number;
  radius: number;
  shadow: boolean;
  logo: string | null;
  logo_corner: string;
  logo_size: number;
}

/// The active brand's studio look onto this recording's frame and logo.
async function applyBrandLook(announce: boolean) {
  let look: BrandLook;
  try {
    look = await invoke<BrandLook>("brand_studio_look");
  } catch (e) {
    if (announce) toast(String(e));
    return;
  }
  edits.frame.background = (look.background === "image" && look.image ? "image" : look.background === "image" ? "midnight" : look.background) as Edits["frame"]["background"];
  edits.frame.image = look.image;
  edits.frame.padding = look.padding;
  edits.frame.radius = look.radius;
  edits.frame.shadow = look.shadow;
  // The brand's look puts the video back in the middle.
  edits.frame.x = 0;
  edits.frame.y = 0;
  edits.frame.anchor = "center";
  edits.logo.path = look.logo;
  edits.logo.corner = look.logo_corner as Edits["logo"]["corner"];
  edits.logo.size = look.logo_size;
  if (announce) {
    showInspector();
    scheduleRender();
    saveSoon();
    toast(`${look.name}'s look applied`);
  }
}

$("frame-brand").addEventListener("click", () => void applyBrandLook(true));

function showInspector() {
  $<HTMLInputElement>("padding").value = String(edits.frame.padding);
  $<HTMLInputElement>("radius").value = String(edits.frame.radius);
  $<HTMLSelectElement>("background").value = edits.frame.background;
  $<HTMLInputElement>("shadow").checked = edits.frame.shadow;
  $<HTMLInputElement>("frame-x").value = String(edits.frame.x);
  $<HTMLInputElement>("frame-y").value = String(edits.frame.y);
  $<HTMLSelectElement>("bg-anchor").value = edits.frame.anchor;
  $<HTMLInputElement>("cursor-size").value = String(edits.cursor.size);
  $<HTMLInputElement>("smoothing").value = String(edits.cursor.smoothing);
  $<HTMLInputElement>("ripple").checked = edits.cursor.ripple;
  $<HTMLInputElement>("show-keys").checked = edits.keys.show;
  $<HTMLSelectElement>("key-mode").value = edits.keys.mode;
  $<HTMLInputElement>("cam-show").checked = edits.camera.show;
  $<HTMLInputElement>("cam-size").value = String(edits.camera.size);
  $<HTMLSelectElement>("cam-corner").value = edits.camera.corner;
  $<HTMLSelectElement>("cam-shape").value = edits.camera.shape;
  $<HTMLElement>("camera-section").hidden = !project?.camera?.has_video;
  $<HTMLElement>("cam-full-add-bar").hidden = !project?.camera?.has_video;
  camPanels();
  $<HTMLInputElement>("title-text").value = edits.title.text;
  $<HTMLInputElement>("title-sub").value = edits.title.subtitle;
  $<HTMLSelectElement>("title-pos").value = edits.title.position;
  $<HTMLSelectElement>("logo-corner").value = edits.logo.corner;
  $<HTMLInputElement>("logo-size").value = String(edits.logo.size);
  void fillLogoChoices().then(() => {
    loadLogo(edits.logo.path);
    loadBackground(edits.frame.background === "image" ? edits.frame.image : null);
  });

  const p = project!;
  const secs = Math.round(p.duration_ms / 1000);
  const fps = p.duration_ms > 0 ? Math.round((p.frames / p.duration_ms) * 1000) : 0;
  facts.replaceChildren();
  for (const line of [
    `${p.region.width} × ${p.region.height} region on a ${p.monitor.width} × ${p.monitor.height} monitor`,
    `${secs} s, ${p.frames} frames (${fps} fps delivered)`,
    p.camera ? `camera${p.camera.has_video ? " and mic" : " mic only"}, offset ${p.camera.offset_ms} ms` : "no camera or mic",
    `${events?.buttons.filter((b) => b[2] === "down").length ?? 0} clicks, ${events?.keys.filter((k) => k.down).length ?? 0} key presses`,
  ]) {
    const d = document.createElement("div");
    d.textContent = line;
    facts.append(d);
  }
}

function saveSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    if (!dir) return;
    try {
      const newDir = await invoke<string>("save_studio_edits", { dir, edits, name: nameInput.value });
      if (newDir !== dir && project) {
        // The folder was renamed after the recording; point the source at
        // its new home without losing the playhead.
        const at = currentMs();
        dir = newDir;
        filmFor = newDir;
        src.src = convertFileSrc(`${newDir}/${project.source}`);
        await new Promise<void>((resolve) => src.addEventListener("loadeddata", () => resolve(), { once: true }));
        seekMs(at);
      }
    } catch (e) {
      toast(String(e));
    }
  }, 400);
}

// -------------------------------------------------------------- loading

async function open(projectDir: string) {
  pause();
  const loaded = await invoke<{ project: Project; events: Events }>("load_studio_project", { dir: projectDir });
  dir = projectDir;
  project = loaded.project;
  events = loaded.events;
  const fresh = !project.edits || Object.keys(project.edits as object).length === 0;
  edits = withDefaults(project.edits as Partial<Edits>);
  // A recording opening for the first time takes the active brand's look.
  if (fresh) await applyBrandLook(false);
  // The operator's zoom marks become blocks once; after that the blocks
  // are theirs to change or delete.
  if (!edits.zooms_seeded) {
    edits.zooms = zoomsFromMarks(events.zooms, project.region, project.duration_ms, edits.zoom_follow);
    edits.zooms_seeded = true;
    saveSoon();
  }
  track = buildTrack(project, events, edits);
  selectedZoom = null;
  selectedSpeed = null;
  selectedCam = null;
  cutFrom = null;
  nameInput.value = project.name;

  src.src = convertFileSrc(`${projectDir}/${project.source}`);
  if (cam.src.startsWith("blob:")) URL.revokeObjectURL(cam.src);
  if (project.camera) {
    cam.src = await blobUrl(`${projectDir}/${project.camera.file}`);
    cam.muted = !project.camera.has_audio;
  } else {
    cam.removeAttribute("src");
  }
  empty.hidden = true;
  inspector.hidden = false;
  recordings.hidden = true;
  showInspector();
  selectZoom(null);
  await new Promise<void>((resolve) => {
    src.addEventListener("loadeddata", () => resolve(), { once: true });
  });
  seekMs(edits.trim.in_ms);
  selectCut(null);
  renderTimeline();
  void buildFilmstrip();
}

async function showRecordings() {
  const list = await invoke<StudioInfo[]>("list_studio_projects");
  recordingsList.replaceChildren();
  if (list.length === 0) {
    const none = document.createElement("div");
    none.className = "empty";
    none.textContent = "No studio recordings yet.";
    recordingsList.append(none);
  }
  for (const r of list) {
    const row = document.createElement("div");
    row.className = "bundle-row";
    if (r.dir === dir) row.classList.add("current");
    const name = document.createElement("span");
    name.className = "bundle-name-cell";
    name.textContent = r.name || r.id;
    const meta = document.createElement("span");
    meta.className = "bundle-meta";
    meta.textContent = `${r.created_at.slice(0, 16).replace("T", " ")}  ${Math.round(r.duration_ms / 1000)} s${r.has_camera ? "  camera" : ""}`;
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = r.dir === dir ? "Open now" : "Open";
    btn.disabled = r.dir === dir;
    btn.addEventListener("click", () => void open(r.dir).catch((e) => toast(String(e))));
    row.append(name, meta, btn);
    recordingsList.append(row);
  }
  recordings.hidden = false;
}

// -------------------------------------------------------------- export

const exportPanel = $<HTMLDivElement>("export");
const exportOptions = $<HTMLDivElement>("export-options");
const exportProgress = $<HTMLDivElement>("export-progress");
const exportDone = $<HTMLDivElement>("export-done");
let exportCancel: Cancel | null = null;
let exportedPath = "";

function showExportStage(stage: "options" | "progress" | "done") {
  exportOptions.hidden = stage !== "options";
  exportProgress.hidden = stage !== "progress";
  exportDone.hidden = stage !== "done";
}

$("export-open").addEventListener("click", () => {
  if (!project) return;
  pause();
  recordings.hidden = true;
  showExportStage("options");
  exportPanel.hidden = false;
});
$("export-close").addEventListener("click", () => {
  if (exportCancel) exportCancel.cancelled = true;
  exportPanel.hidden = true;
});
$("export-cancel").addEventListener("click", () => {
  if (exportCancel) exportCancel.cancelled = true;
});
$("export-again").addEventListener("click", () => showExportStage("options"));
$("export-reveal").addEventListener("click", () => {
  if (exportedPath) void invoke("reveal_path", { path: exportedPath });
});

$("export-start").addEventListener("click", async () => {
  if (!project || !track || !dir) return;
  const [w, h] = $<HTMLSelectElement>("export-size").value.split("x").map(Number);
  const fps = Number($<HTMLSelectElement>("export-fps").value);
  // About 4 Mbit/s per megapixel at 30 fps, half again at 60.
  const bitrate = Math.round(((w * h) / 1_000_000) * 4_000_000 * (fps === 60 ? 1.5 : 1));
  const cancel: Cancel = { cancelled: false };
  exportCancel = cancel;
  showExportStage("progress");
  const fill = $<HTMLDivElement>("export-fill");
  const status = $<HTMLDivElement>("export-status");
  const started = performance.now();
  try {
    const path = await exportVideo(
      { width: w, height: h, fps, bitrate },
      project,
      edits,
      track,
      dir,
      nameInput.value || project.id,
      src.src,
      project.camera ? convertFileSrc(`${dir}/${project.camera.file}`) : null,
      project.camera?.has_video ? cam : null,
      logoImg,
      edits.frame.background === "image" ? bgImg : null,
      (p) => {
        const f = p.total > 0 ? p.done / p.total : 0;
        fill.style.width = `${Math.round(f * 100)}%`;
        const secs = (performance.now() - started) / 1000;
        const rate = p.done > 0 ? p.done / secs : 0;
        const left = rate > 0 ? Math.max(0, (p.total - p.done) / rate) : 0;
        status.textContent =
          p.phase === "Rendering" && rate > 0
            ? `${p.phase}: ${p.done} of ${p.total} frames, about ${Math.ceil(left)} s left`
            : p.phase;
      },
      cancel,
    );
    exportedPath = path;
    $<HTMLElement>("export-path").textContent = path;
    showExportStage("done");
    toast(`Exported in ${Math.round((performance.now() - started) / 1000)} s`);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    toast(msg === "cancelled" ? "Export cancelled" : `Export failed: ${msg}`);
    showExportStage("options");
  } finally {
    exportCancel = null;
    // The camera element was seeked around during export.
    syncCamera(true);
    render();
  }
});

// ------------------------------------------------------------- wiring

bindInspector();

playBtn.addEventListener("click", () => (src.paused ? void play() : pause()));
scrub.addEventListener("input", () => {
  if (!project) return;
  seekMs((Number(scrub.value) / 1000) * project.duration_ms);
});
nameInput.addEventListener("change", saveSoon);
$("open-list").addEventListener("click", () => void showRecordings());
$("list-close").addEventListener("click", () => (recordings.hidden = true));
$("open-folder").addEventListener("click", () => {
  if (dir) void invoke("open_path", { path: dir });
});
$("close").addEventListener("click", () => void getCurrentWindow().close());

window.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  if (e.key === "Escape") {
    if (!recordings.hidden) recordings.hidden = true;
    else if (!exportPanel.hidden) exportPanel.hidden = true;
    else if (selectedCut || selectedZoom || selectedSpeed || selectedCam) {
      selectCut(null);
      selectZoom(null);
      selectSpeed(null);
      selectCam(null);
    } else void getCurrentWindow().close();
    return;
  }
  if (typing) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    if (selectedCut) removeSelectedCut();
    else if (selectedSpeed) $("speed-remove").click();
    else if (selectedCam) $("cam-full-remove").click();
    else if (selectedZoom) {
      edits.zooms = edits.zooms.filter((z) => z !== selectedZoom);
      selectZoom(null);
      saveSoon();
    }
    return;
  }
  if (e.key === " ") {
    e.preventDefault();
    if (src.paused) void play();
    else pause();
  } else if (e.key === "ArrowLeft") {
    seekMs(currentMs() - (e.shiftKey ? 5000 : 1000));
  } else if (e.key === "ArrowRight") {
    seekMs(currentMs() + (e.shiftKey ? 5000 : 1000));
  } else if (e.key.toLowerCase() === "i") {
    setIn();
  } else if (e.key.toLowerCase() === "o") {
    setOut();
  } else if (e.key.toLowerCase() === "x") {
    toggleCut();
  }
});

src.addEventListener("ended", () => pause());
window.addEventListener("resize", fitCanvas);
new ResizeObserver(fitCanvas).observe(stage);
new ResizeObserver(drawFilm).observe(timeline);

// The keystroke filter should know the user's own chords, whatever they
// are, and every hint that names a chord shows the live one.
void invoke<Record<string, string>>("get_hotkeys").then((h) => {
  setOwnHotkeys(Object.values(h));
  for (const el of document.querySelectorAll<HTMLElement>("[data-hk]")) {
    const spec = h[el.dataset.hk ?? ""];
    if (!spec) continue;
    el.innerHTML = spec
      .replace(/CommandOrControl|CmdOrCtrl|Control/g, "Ctrl/Cmd")
      .replace(/Super|Meta/g, "Win")
      .replace(/Option/g, "Alt")
      .replace(/Return/g, "Enter")
      .split("+")
      .map((k) => `<kbd>${k}</kbd>`)
      .join("+");
  }
});

const initial = params.get("project");
if (initial) {
  void open(initial).catch((e) => toast(String(e)));
} else {
  empty.hidden = false;
  inspector.hidden = true;
  void showRecordings();
}
fitCanvas();
