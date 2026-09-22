use anyhow::{anyhow, Result};
use image::RgbaImage;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::model::KeyFrame;

/// One monitor's frozen frame. Geometry is in logical points (what Tauri
/// uses to place windows); `scale` converts to the physical pixels the
/// captured image is actually in.
#[derive(Clone, Debug, Serialize)]
pub struct Frame {
    pub monitor_id: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    /// PNG on disk so the overlay webview can display it.
    pub png_path: String,
}

/// Captures every monitor and writes each frame to `tmp`. Returns the frames
/// alongside the in-memory images, which are kept so cropping does not have to
/// decode the PNG again.
pub fn freeze_all(tmp: &Path) -> Result<Vec<(Frame, RgbaImage)>> {
    std::fs::create_dir_all(tmp)?;

    let monitors = xcap::Monitor::all().map_err(|e| anyhow!("monitor enumeration: {e}"))?;
    if monitors.is_empty() {
        return Err(anyhow!("no monitors found"));
    }

    let mut out = Vec::new();
    for m in monitors {
        let image = match m.capture_image() {
            Ok(img) => img,
            // A monitor can refuse capture (locked, DRM-protected output).
            // Skip it rather than aborting the whole capture.
            Err(_) => continue,
        };

        let id = m.id().map(|v| v.to_string()).unwrap_or_else(|_| "0".into());
        let scale = m.scale_factor().unwrap_or(1.0) as f64;
        let phys_w = image.width();
        let phys_h = image.height();

        let png_path = tmp.join(format!("frame-{id}.png"));
        image.save(&png_path)?;

        out.push((
            Frame {
                monitor_id: id,
                x: m.x().unwrap_or(0),
                y: m.y().unwrap_or(0),
                // Logical size, so the overlay window covers the monitor exactly.
                width: (phys_w as f64 / scale).round() as u32,
                height: (phys_h as f64 / scale).round() as u32,
                scale,
                png_path: png_path.to_string_lossy().to_string(),
            },
            image,
        ));
    }

    if out.is_empty() {
        return Err(anyhow!("every monitor refused capture"));
    }
    Ok(out)
}

/// Crops a selection given in CSS pixels relative to the overlay window,
/// writes it to `dest`, and returns the physical pixel size written.
pub fn crop_selection(
    frame: &Frame,
    src: &RgbaImage,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    dest: &Path,
) -> Result<(u32, u32)> {
    let s = frame.scale;
    let px = (x * s).round().max(0.0) as u32;
    let py = (y * s).round().max(0.0) as u32;
    let mut pw = (w * s).round() as u32;
    let mut ph = (h * s).round() as u32;

    if pw == 0 || ph == 0 {
        return Err(anyhow!("selection was empty"));
    }
    // Clamp to the frame so a drag that ran off the edge still works.
    pw = pw.min(src.width().saturating_sub(px));
    ph = ph.min(src.height().saturating_sub(py));
    if pw == 0 || ph == 0 {
        return Err(anyhow!("selection fell outside the monitor"));
    }

    let cropped = image::imageops::crop_imm(src, px, py, pw, ph).to_image();
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    cropped.save(dest)?;
    Ok((pw, ph))
}

/// Per-run scratch directory for frozen frames.
pub fn scratch_dir() -> PathBuf {
    std::env::temp_dir().join("qacut-frames")
}

pub fn clear_scratch() {
    let _ = std::fs::remove_dir_all(scratch_dir());
}

// ---------------------------------------------------------- auto-capture
//
// Auto-capture is a timeline of stills, not a video: one at the start, one
// at every click or Enter (with where the click landed), and one at the
// end, each becoming an ordinary shot in the bundle that can be noted,
// reordered, marked up or dropped. Agents cannot do anything with a clip;
// the Studio is where recordings for people happen.

/// How often a fallback still is saved when no clicks happen.
const KEYFRAME_EVERY: Duration = Duration::from_secs(3);
/// Interval stills are thinned to at most this many when the recording stops.
const MAX_KEYFRAMES: usize = 12;
/// Click stills are thinned to at most this many.
const MAX_CLICK_FRAMES: usize = 40;
/// How often the mouse buttons and Enter are polled.
const INPUT_POLL: Duration = Duration::from_millis(15);
/// A recording nobody stopped ends itself here.
const MAX_DURATION: Duration = Duration::from_secs(10 * 60);

/// What a finished auto-capture produced: the region's size and the stills,
/// oldest first, each `file` a bare name inside the frames directory.
pub struct Recorded {
    pub width: u32,
    pub height: u32,
    pub frames: Vec<KeyFrame>,
}

/// An auto-capture in progress. Input is polled and stills are saved on a
/// worker thread, so stopping is immediate.
pub struct Recording {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<Result<Recorded>>,
}

impl Recording {
    pub fn stop(self) -> Result<Recorded> {
        self.stop.store(true, Ordering::SeqCst);
        self.handle
            .join()
            .map_err(|_| anyhow!("recorder thread panicked"))?
    }
}

/// Starts auto-capturing a region of `frame`'s monitor. The selection is in
/// CSS pixels relative to the overlay window, like `crop_selection`. Stills
/// are written to `frames_dir` at full resolution; the caller files them as
/// shots when the capture stops.
pub fn start_recording(
    app: AppHandle,
    frame: &Frame,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    frames_dir: PathBuf,
) -> Result<Recording> {
    let s = frame.scale;
    let px = (x * s).round().max(0.0) as u32;
    let py = (y * s).round().max(0.0) as u32;
    let phys_w = (frame.width as f64 * s).round() as u32;
    let phys_h = (frame.height as f64 * s).round() as u32;
    let pw = ((w * s).round() as u32).min(phys_w.saturating_sub(px));
    let ph = ((h * s).round() as u32).min(phys_h.saturating_sub(py));
    if pw == 0 || ph == 0 {
        return Err(anyhow!("selection was empty"));
    }

    let monitor_id = frame.monitor_id.clone();
    let (mon_x, mon_y) = (frame.x, frame.y);
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();

    let handle = std::thread::spawn(move || -> Result<Recorded> {
        let monitor = xcap::Monitor::all()
            .map_err(|e| anyhow!("monitor enumeration: {e}"))?
            .into_iter()
            .find(|m| m.id().map(|v| v.to_string()).unwrap_or_default() == monitor_id)
            .ok_or_else(|| anyhow!("that monitor is gone"))?;
        std::fs::create_dir_all(&frames_dir)?;

        let ring: i64 = 12;
        let start = Instant::now();
        let mut last_interval = start;
        let mut frames: Vec<KeyFrame> = Vec::new();
        let mut saved = 0usize;
        let mut buttons = buttons_down();

        // Where the cursor is in region pixels, if it is inside the region.
        let cursor_in_region = || {
            app.cursor_position().ok().and_then(|pos| {
                let cx = pos.x.round() as i64 - mon_x as i64 - px as i64;
                let cy = pos.y.round() as i64 - mon_y as i64 - py as i64;
                (cx >= 0 && cy >= 0 && cx < pw as i64 && cy < ph as i64).then_some((cx as u32, cy as u32))
            })
        };

        // Grabs the region now and saves it as the next still. A click gets
        // a ring at the click point, saved as a mark beside the untouched
        // image so it can be moved in the editor rather than being paint.
        // A transient grab failure (screen lock, resolution change) skips
        // the still rather than ending the capture.
        let mut save = |event: &str, at: Option<(u32, u32)>, frames: &mut Vec<KeyFrame>| {
            let Ok(raw) = monitor.capture_region(px, py, pw, ph) else { return };
            saved += 1;
            let name = format!("{saved:02}.png");
            let png = frames_dir.join(&name);
            let is_click = matches!(event, "click" | "right-click" | "middle-click");
            let ok = match (is_click, at) {
                (true, Some((cx, cy))) => {
                    let mut composite = raw.clone();
                    mark_cursor(&mut composite, cx as i64, cy as i64, ring, true);
                    let [orig, marks, ..] = crate::model::sidecars(&png);
                    raw.save(&orig).is_ok()
                        && std::fs::write(&marks, format!(r#"[{{"kind":"click","x":{cx},"y":{cy}}}]"#)).is_ok()
                        && composite.save(&png).is_ok()
                }
                _ => raw.save(&png).is_ok(),
            };
            if ok {
                frames.push(KeyFrame {
                    file: name,
                    at_ms: start.elapsed().as_millis() as u64,
                    event: event.to_string(),
                    x: if is_click { at.map(|p| p.0) } else { None },
                    y: if is_click { at.map(|p| p.1) } else { None },
                });
            }
        };

        save("start", None, &mut frames);
        loop {
            std::thread::sleep(INPUT_POLL);
            if flag.load(Ordering::SeqCst) || start.elapsed() > MAX_DURATION {
                break;
            }
            let now_down = buttons_down();
            let mut fired: Option<(&'static str, Option<(u32, u32)>)> = None;
            for (i, name) in ["click", "right-click", "middle-click", "enter"].iter().enumerate() {
                if now_down[i] && !buttons[i] {
                    fired = Some((name, if i < 3 { cursor_in_region() } else { None }));
                }
            }
            buttons = now_down;
            let now = Instant::now();
            if let Some((event, at)) = fired {
                save(event, at, &mut frames);
                last_interval = now;
            } else if now - last_interval >= KEYFRAME_EVERY {
                save("interval", None, &mut frames);
                last_interval = now;
            }
        }
        save("end", None, &mut frames);

        let frames = choose_keyframes(frames, &frames_dir);
        Ok(Recorded { width: pw, height: ph, frames })
    });

    Ok(Recording { stop, handle })
}

/// Which of left, right, middle and Enter are held right now.
#[cfg(windows)]
fn buttons_down() -> [bool; 4] {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON, VK_RETURN,
    };
    [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON, VK_RETURN]
        .map(|vk| unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000 != 0)
}

/// No input polling on this platform yet; interval stills are the fallback.
#[cfg(not(windows))]
fn buttons_down() -> [bool; 4] {
    [false; 4]
}

/// Draws a ring at a point, since screen grabs do not include the cursor
/// and a still of a click without one is hard to read.
fn mark_cursor(img: &mut RgbaImage, cx: i64, cy: i64, r: i64, filled: bool) {
    let (w, h) = (img.width() as i64, img.height() as i64);
    if cx < -r || cy < -r || cx > w + r || cy > h + r {
        return;
    }
    for dy in -r - 2..=r + 2 {
        for dx in -r - 2..=r + 2 {
            let (x, y) = (cx + dx, cy + dy);
            if x < 0 || y < 0 || x >= w || y >= h {
                continue;
            }
            let d = ((dx * dx + dy * dy) as f64).sqrt();
            let rf = r as f64;
            let alpha = if d > rf + 1.5 {
                0.0
            } else if d >= rf - 2.5 {
                0.9
            } else if filled {
                0.7
            } else {
                0.25
            };
            if alpha == 0.0 {
                continue;
            }
            let p = img.get_pixel_mut(x as u32, y as u32);
            let blend = |c: u8, t: u8| (c as f64 * (1.0 - alpha) + t as f64 * alpha).round() as u8;
            p.0 = [blend(p.0[0], 255), blend(p.0[1], 196), blend(p.0[2], 0), 255];
        }
    }
}

/// Decides which stills survive. If any action happened, the interval
/// stills go (actions say what mattered; timestamps do not) and the action
/// stills are thinned to `MAX_CLICK_FRAMES`. Otherwise the interval stills
/// are thinned to `MAX_KEYFRAMES`. Start and end always stay. Dropped
/// stills are deleted from disk.
fn choose_keyframes(frames: Vec<KeyFrame>, dir: &Path) -> Vec<KeyFrame> {
    let has_actions = frames
        .iter()
        .any(|f| !matches!(f.event.as_str(), "start" | "end" | "interval"));
    let (keep_kind, cap) = if has_actions {
        (false, MAX_CLICK_FRAMES)
    } else {
        (true, MAX_KEYFRAMES)
    };

    let mut kept = Vec::new();
    for f in frames {
        let interval = f.event == "interval";
        if interval && !keep_kind {
            drop_still(&f, dir);
        } else {
            kept.push(f);
        }
    }

    if kept.len() <= cap {
        return kept;
    }
    let n = kept.len();
    let keep: std::collections::BTreeSet<usize> =
        (0..cap).map(|i| (i * (n - 1)) / (cap - 1)).collect();
    let mut out = Vec::new();
    for (i, f) in kept.into_iter().enumerate() {
        if keep.contains(&i) {
            out.push(f);
        } else {
            drop_still(&f, dir);
        }
    }
    out
}

fn drop_still(f: &KeyFrame, dir: &Path) {
    if let Some(name) = Path::new(&f.file).file_name() {
        let _ = std::fs::remove_file(dir.join(name));
    }
}
