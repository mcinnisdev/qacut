// Types mirroring src-tauri/src/studio/{project,events}.rs, plus the edit
// model the studio keeps in project.json's `edits` block.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Camera {
  file: string;
  offset_ms: number;
  has_video: boolean;
  has_audio: boolean;
}

export interface Project {
  version: number;
  id: string;
  name: string;
  created_at: string;
  source: string;
  events: string;
  camera: Camera | null;
  monitor: Rect;
  scale: number;
  region: Rect;
  fps: number;
  first_frame_ts: number;
  frames: number;
  duration_ms: number;
  keystrokes: boolean;
  edits: Partial<Edits> | Record<string, never>;
}

export interface KeyOut {
  t: number;
  key: string;
  down: boolean;
  mods: string;
}

export interface Events {
  version: number;
  cursor: [number, number, number][];
  shapes: [number, string][];
  buttons: [number, string, string, number, number][];
  keys: KeyOut[];
  windows: [number, string][];
  zooms?: [number, string, number, number][];
}

export interface StudioInfo {
  dir: string;
  id: string;
  name: string;
  created_at: string;
  duration_ms: number;
  frames: number;
  has_camera: boolean;
}

export type Background = "midnight" | "sunset" | "ocean" | "slate" | "plain" | "image";
export type Corner = "br" | "bl" | "tr" | "tl";

export type KeyMode = "shortcuts" | "all";

/// A zoom block: between start and end the view eases in to `scale` times
/// magnification centred on (cx, cy) in region pixels, and eases back out.
export interface Zoom {
  start: number;
  end: number;
  cx: number;
  cy: number;
  scale: number;
  /// Camera follows the cursor (with a dead zone and lag) instead of
  /// staying on (cx, cy), which then only sets where it starts.
  follow?: boolean;
}

/// A playback speed block: between start and end (source time) the video
/// runs at `rate` times normal speed.
export interface Speed {
  start: number;
  end: number;
  rate: number;
}

export interface Edits {
  /// `image` is a picture from the brand folder, used when background is "image".
  /// `x` and `y` move the video across the space the padding leaves, -1
  /// (left, top) to 1; `anchor` is the part of a picture kept when it is
  /// cropped to the video's shape.
  frame: {
    padding: number;
    radius: number;
    background: Background;
    shadow: boolean;
    image: string | null;
    x: number;
    y: number;
    anchor: "center" | "top" | "bottom";
  };
  cursor: { size: number; smoothing: number; ripple: boolean };
  /// `hidden` holds the press times of badges the user removed.
  keys: { show: boolean; mode: KeyMode; hidden: number[] };
  camera: { show: boolean; size: number; corner: Corner; shape: "circle" | "rounded" };
  trim: { in_ms: number; out_ms: number | null };
  /// Stretches removed from the middle, in source time.
  cuts: { start: number; end: number }[];
  zooms: Zoom[];
  /// Stretches played faster or slower, in source time.
  speeds: Speed[];
  /// Stretches where the camera fills the frame instead of the screen:
  /// a talking section. Source time.
  camera_full: { start: number; end: number }[];
  /// Set once the recorded zoom marks have been turned into blocks, so a
  /// deleted block does not come back on the next open.
  zooms_seeded: boolean;
  /// Whether new zooms (marks and "Add zoom here") follow the cursor.
  zoom_follow: boolean;
  /// 0 lazy (big dead zone, long lag) to 1 tight (small dead zone, short
  /// lag). Applies to every follow zoom.
  follow_tightness: number;
  /// Text in the padding above or below the frame.
  title: { text: string; subtitle: string; position: "top" | "bottom" };
  /// A logo from the brand folder in a corner of the padding.
  logo: { path: string | null; corner: Corner; size: number };
}

export const DEFAULT_EDITS: Edits = {
  frame: { padding: 0.06, radius: 14, background: "midnight", shadow: true, image: null, x: 0, y: 0, anchor: "center" },
  cursor: { size: 1.6, smoothing: 0.35, ripple: true },
  keys: { show: true, mode: "shortcuts", hidden: [] },
  camera: { show: true, size: 0.22, corner: "br", shape: "circle" },
  trim: { in_ms: 0, out_ms: null },
  cuts: [],
  zooms: [],
  speeds: [],
  camera_full: [],
  zooms_seeded: false,
  zoom_follow: true,
  follow_tightness: 0.6,
  title: { text: "", subtitle: "", position: "top" },
  logo: { path: null, corner: "tl", size: 0.5 },
};

export const DEFAULT_ZOOM_SCALE = 2;
/// How long the camera takes to fade over the screen, and back.
export const CAM_FADE_MS = 350;

/// How much the camera covers the frame at t: 0 screen, 1 camera, with a
/// short fade at each end of a block.
export function cameraFullAt(spans: { start: number; end: number }[], t: number) {
  for (const b of spans) {
    if (t < b.start || t > b.end) continue;
    const fade = Math.min(CAM_FADE_MS, (b.end - b.start) / 2);
    const f = fade > 0 ? Math.min((t - b.start) / fade, (b.end - t) / fade) : 1;
    const x = Math.min(1, Math.max(0, f));
    return x * x * (3 - 2 * x);
  }
  return 0;
}

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 3;

/// Playback rate at source time t: the block covering it, else 1.
export function rateAt(speeds: Speed[], t: number) {
  for (const s of speeds) if (t >= s.start && t < s.end) return s.rate;
  return 1;
}

/// Kept source segments split at every speed boundary, each with its rate,
/// so a walk through them can advance at the right pace.
export function speedPieces(segs: { start: number; end: number }[], speeds: Speed[]) {
  const out: { start: number; end: number; rate: number }[] = [];
  for (const s of segs) {
    const edges = new Set<number>([s.start, s.end]);
    for (const b of speeds) {
      if (b.start > s.start && b.start < s.end) edges.add(b.start);
      if (b.end > s.start && b.end < s.end) edges.add(b.end);
    }
    const pts = [...edges].sort((a, b) => a - b);
    for (let i = 0; i + 1 < pts.length; i++) {
      out.push({ start: pts[i], end: pts[i + 1], rate: rateAt(speeds, pts[i]) });
    }
  }
  return out;
}

/// How long the kept material plays for, speed changes included.
export function outputMs(segs: { start: number; end: number }[], speeds: Speed[]) {
  return speedPieces(segs, speeds).reduce((a, p) => a + (p.end - p.start) / p.rate, 0);
}
/// How long a zoom takes to ease in or out.
export const ZOOM_EASE_MS = 600;

/// Fills in whatever an older project.json lacks.
export function withDefaults(e: Partial<Edits> | undefined): Edits {
  const d = DEFAULT_EDITS;
  return {
    frame: { ...d.frame, ...(e?.frame ?? {}) },
    cursor: { ...d.cursor, ...(e?.cursor ?? {}) },
    keys: { ...d.keys, ...(e?.keys ?? {}) },
    camera: { ...d.camera, ...(e?.camera ?? {}) },
    trim: { ...d.trim, ...(e?.trim ?? {}) },
    cuts: e?.cuts ?? [],
    zooms: e?.zooms ?? [],
    speeds: e?.speeds ?? [],
    camera_full: e?.camera_full ?? [],
    zooms_seeded: e?.zooms_seeded ?? false,
    zoom_follow: e?.zoom_follow ?? true,
    follow_tightness: e?.follow_tightness ?? 0.6,
    title: { ...d.title, ...(e?.title ?? {}) },
    logo: { ...d.logo, ...(e?.logo ?? {}) },
  };
}

/// Turns the operator's recorded zoom marks into blocks. An unmatched
/// "start" runs to the end of the recording.
export function zoomsFromMarks(
  marks: [number, string, number, number][] | undefined,
  region: Rect,
  duration_ms: number,
  follow: boolean,
): Zoom[] {
  const out: Zoom[] = [];
  let open: Zoom | null = null;
  for (const [t, action, x, y] of marks ?? []) {
    if (action === "start") {
      if (open) {
        open.end = t;
        out.push(open);
      }
      open = { start: t, end: duration_ms, cx: x - region.x, cy: y - region.y, scale: DEFAULT_ZOOM_SCALE, follow };
    } else if (open) {
      open.end = Math.max(t, open.start + 200);
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
}

export const BACKGROUNDS: Record<Exclude<Background, "image">, [string, string]> = {
  midnight: ["#141a2b", "#2a1f4d"],
  sunset: ["#3a1c3f", "#c2503a"],
  ocean: ["#0d2b3e", "#1e6f8c"],
  slate: ["#2b2f36", "#4a515b"],
  plain: ["#1b1e23", "#1b1e23"],
};
