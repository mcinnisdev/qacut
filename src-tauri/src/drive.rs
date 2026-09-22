//! Drive mode, for producing the site's and docs' screenshots with the app
//! itself. Off unless `QACUT_DRIVE_DIR` is set at start-up. The app then
//! watches that folder for `*.json` requests, runs each one (open a window
//! on fixture data, capture a window to a PNG, and so on), and answers with
//! `<name>.done.json`. Nothing here is reachable from the UI.
//!
//! A request is `{"action": "...", ...}`; see `Req`. A capture uses the same
//! monitor grab a bundle shot uses, so the PNG is what is on screen.

use crate::model::{Moment, Shot, ShotKind};
use crate::{
    base_dir, brand_dir, do_finish, do_new_bundle, do_open_bundle, ensure_session, open_overlay, overlay,
    shot_id, Inner, Shared,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::MutexGuard;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Req {
    /// Put the current bundle away and start a fresh one.
    NewBundle { name: Option<String> },
    /// Copy a PNG into the current group as a shot. `marks` is the editor's
    /// marks JSON; with it the untouched original is kept beside the shot.
    AddShot { png: String, note: Option<String>, title: Option<String>, moment: Option<Moment>, marks: Option<String> },
    /// Name the current group, give it a master note, and open the next.
    CloseGroup { title: String, master_note: String },
    OpenBundle { path: String },
    /// The bundle window, optionally on a panel ("shortcuts", "name", "open").
    Peek { focus: Option<String> },
    /// The review window on the nth shot (1-based) of a group.
    Review { group: usize, shot: usize },
    /// The note box waiting on the nth shot of a group.
    Note { group: usize, shot: usize },
    /// A quick shot: the PNG goes into the batch (a fresh one with
    /// `new_batch`) and the quick editor opens on it.
    Quick { png: String, marks: Option<String>, new_batch: Option<bool> },
    /// Throw away the open quick batch, folder and all.
    QuickBatchDiscard,
    Prompts { select: Option<String> },
    /// Open the brands window, on one brand if given.
    Brands { select: Option<String> },
    /// Run JavaScript in a window: fill a field, open a panel, tick a box.
    Eval { label: String, js: String },
    Studio { dir: String },
    /// The capture overlay in "shot", "record" or "studio" mode.
    Overlay { mode: String },
    CancelOverlay,
    /// The recording badge over a region of the primary monitor.
    Badge { x: f64, y: f64, w: f64, h: f64, studio: bool, countdown_ms: u64 },
    Emit { event: String },
    Resize { label: String, w: f64, h: f64 },
    /// Capture a window (by label; "capture-" matches the first overlay) to a PNG.
    Shot { label: String, out: String, delay_ms: Option<u64> },
    /// Save a rectangle of the screen (whatever is on it) to `out`.
    Region { x: i32, y: i32, w: u32, h: u32, out: String, delay_ms: Option<u64> },
    Close { label: String },
    ExportDoc { format: String, brand: Option<String> },
    Finish,
    Sleep { ms: u64 },
}

#[derive(Serialize)]
struct Done {
    ok: bool,
    result: Option<String>,
    error: Option<String>,
}

pub fn start(app: AppHandle, dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    eprintln!("qacut: drive mode on, watching {}", dir.display());
    std::thread::spawn(move || loop {
        let mut reqs: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
                    .filter(|p| !p.to_string_lossy().ends_with(".done.json"))
                    .collect()
            })
            .unwrap_or_default();
        reqs.sort();
        for req in reqs {
            let text = std::fs::read_to_string(&req).unwrap_or_default();
            let outcome = match serde_json::from_str::<Req>(&text) {
                Ok(r) => run(&app, r),
                Err(e) => Err(format!("bad request: {e}")),
            };
            let done = match outcome {
                Ok(v) => Done { ok: true, result: Some(v), error: None },
                Err(e) => {
                    eprintln!("qacut: drive request {} failed: {e}", req.display());
                    Done { ok: false, result: None, error: Some(e) }
                }
            };
            let stem = req.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let _ = std::fs::write(dir.join(format!("{stem}.done.json")), serde_json::to_string(&done).unwrap_or_default());
            let _ = std::fs::remove_file(&req);
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    });
}

fn lock(app: &AppHandle) -> MutexGuard<'_, Inner> {
    app.state::<Shared>().inner().lock().unwrap()
}

/// Copies `png` to `abs`, and when marks are given keeps the original and
/// the marks beside it the way the editor does.
fn place(png: &str, abs: &Path, marks: Option<&str>) -> Result<(), String> {
    std::fs::copy(png, abs).map_err(|e| format!("copy {png}: {e}"))?;
    if let Some(m) = marks {
        let [orig, marks_path, _] = crate::model::sidecars(abs);
        std::fs::copy(abs, &orig).map_err(|e| e.to_string())?;
        std::fs::write(&marks_path, m).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn shot_at(app: &AppHandle, group: usize, n: usize) -> Result<(String, String), String> {
    let inner = lock(app);
    let session = inner.session.as_ref().ok_or("no bundle open")?;
    let g = session.groups.iter().find(|g| g.index == group).ok_or("no such group")?;
    let s = g.shots.get(n.saturating_sub(1)).ok_or("no such shot")?;
    Ok((s.id.clone(), s.abs_path.clone()))
}

fn primary_frame() -> Result<crate::capture::Frame, String> {
    let m = xcap::Monitor::all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .ok_or("no primary monitor")?;
    let scale = m.scale_factor().unwrap_or(1.0) as f64;
    Ok(crate::capture::Frame {
        monitor_id: m.id().map(|v| v.to_string()).unwrap_or_default(),
        x: m.x().unwrap_or(0),
        y: m.y().unwrap_or(0),
        width: (m.width().unwrap_or(0) as f64 / scale).round() as u32,
        height: (m.height().unwrap_or(0) as f64 / scale).round() as u32,
        scale,
        png_path: String::new(),
    })
}

fn find_window(app: &AppHandle, label: &str) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(label) {
        return Some(w);
    }
    if label.ends_with('-') || label.ends_with('*') {
        let prefix = label.trim_end_matches('*');
        let windows = app.webview_windows();
        let mut labels: Vec<&String> = windows.keys().filter(|l| l.starts_with(prefix)).collect();
        labels.sort();
        return labels.first().and_then(|l| app.get_webview_window(l));
    }
    None
}

fn capture_window(app: &AppHandle, label: &str, out: &str) -> Result<String, String> {
    let w = find_window(app, label).ok_or_else(|| format!("no window {label}"))?;
    // The client area: the outer bounds include Windows' invisible resize
    // borders, which would put a strip of desktop around every capture.
    let pos = w.inner_position().map_err(|e| e.to_string())?;
    let size = w.inner_size().map_err(|e| e.to_string())?;
    let mon = xcap::Monitor::from_point(pos.x + 1, pos.y + 1).map_err(|e| e.to_string())?;
    let (mx, my) = (mon.x().unwrap_or(0), mon.y().unwrap_or(0));
    let img = mon
        .capture_region((pos.x - mx).max(0) as u32, (pos.y - my).max(0) as u32, size.width, size.height)
        .map_err(|e| e.to_string())?;
    if let Some(dir) = Path::new(out).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    img.save(out).map_err(|e| e.to_string())?;
    Ok(format!("{}x{} -> {out}", size.width, size.height))
}

fn run(app: &AppHandle, req: Req) -> Result<String, String> {
    match req {
        Req::NewBundle { name } => {
            do_new_bundle(app)?;
            if let Some(n) = name {
                let mut inner = lock(app);
                let s = ensure_session(app, &mut inner)?;
                s.rename(&n).map_err(|e| e.to_string())?;
            }
            Ok("new bundle".into())
        }
        Req::AddShot { png, note, title, moment, marks } => {
            let (w, h) = image::image_dimensions(&png).map_err(|e| e.to_string())?;
            let mut inner = lock(app);
            let session = ensure_session(app, &mut inner)?;
            let (g, file, abs) = session.reserve_shot("png");
            place(&png, &abs, marks.as_deref())?;
            session.current().shots.push(Shot {
                id: shot_id(g),
                file,
                abs_path: abs.to_string_lossy().to_string(),
                title: title.unwrap_or_default(),
                note: note.unwrap_or_default(),
                width: w,
                height: h,
                captured_at: chrono::Local::now().to_rfc3339(),
                kind: ShotKind::Image,
                duration_ms: 0,
                frames: Vec::new(),
                video: None,
                moment,
            });
            inner.dirty = true;
            inner.finished = false;
            drop(inner);
            let _ = app.emit("session-changed", ());
            Ok(abs.to_string_lossy().to_string())
        }
        Req::CloseGroup { title, master_note } => {
            let mut inner = lock(app);
            let session = ensure_session(app, &mut inner)?;
            let i = session.close_group(&title, &master_note).map_err(|e| e.to_string())?;
            inner.dirty = true;
            drop(inner);
            let _ = app.emit("session-changed", ());
            Ok(format!("group {i}"))
        }
        Req::OpenBundle { path } => {
            do_open_bundle(app, &path)?;
            Ok("opened".into())
        }
        Req::Peek { focus } => {
            overlay::open_peek(app, focus.as_deref()).map_err(|e| e.to_string())?;
            Ok("peek".into())
        }
        Req::Review { group, shot } => {
            let (id, path) = shot_at(app, group, shot)?;
            let (w, h) = image::image_dimensions(&path).map_err(|e| e.to_string())?;
            overlay::open_review(app, group, &id, w, h).map_err(|e| e.to_string())?;
            Ok("review".into())
        }
        Req::Note { group, shot } => {
            let (id, _) = shot_at(app, group, shot)?;
            {
                let mut inner = lock(app);
                inner.pending = Some((group, id));
                if let Some(s) = inner.session.as_mut() {
                    s.current = group;
                }
            }
            overlay::open_note(app, "shot", None).map_err(|e| e.to_string())?;
            Ok("note".into())
        }
        Req::Quick { png, marks, new_batch } => {
            let (w, h) = image::image_dimensions(&png).map_err(|e| e.to_string())?;
            let abs = {
                let mut inner = lock(app);
                if new_batch.unwrap_or(false) {
                    inner.quick_batch = None;
                }
                let abs = crate::quick_single_path(app);
                place(&png, &abs, marks.as_deref())?;
                inner.quick_pending = Some(abs.clone());
                abs
            };
            overlay::open_quick_editor(app, &abs.to_string_lossy(), w, h).map_err(|e| e.to_string())?;
            Ok(abs.to_string_lossy().to_string())
        }
        Req::QuickBatchDiscard => {
            let mut inner = lock(app);
            if let Some(d) = inner.quick_batch.take() {
                let _ = std::fs::remove_dir_all(&d);
            }
            Ok("discarded".into())
        }
        Req::Brands { select } => {
            overlay::open_brands(app, select.as_deref()).map_err(|e| e.to_string())?;
            Ok("brands".into())
        }
        Req::Prompts { select } => {
            overlay::open_prompts(app, select.as_deref()).map_err(|e| e.to_string())?;
            Ok("prompts".into())
        }
        Req::Studio { dir } => {
            overlay::open_studio(app, Some(&dir)).map_err(|e| e.to_string())?;
            Ok("studio".into())
        }
        Req::Overlay { mode } => {
            open_overlay(app, &mode);
            Ok("overlay".into())
        }
        Req::CancelOverlay => {
            overlay::close_capture(app);
            lock(app).frames.clear();
            crate::capture::clear_scratch();
            Ok("cancelled".into())
        }
        Req::Badge { x, y, w, h, studio, countdown_ms } => {
            let frame = primary_frame()?;
            overlay::open_rec_badge(app, &frame, x, y, w, h, countdown_ms, studio).map_err(|e| e.to_string())?;
            Ok("badge".into())
        }
        Req::Eval { label, js } => {
            let win = find_window(app, &label).ok_or_else(|| format!("no window {label}"))?;
            win.eval(&js).map_err(|e| e.to_string())?;
            Ok(label)
        }
        Req::Emit { event } => {
            app.emit(&event, ()).map_err(|e| e.to_string())?;
            Ok(event)
        }
        Req::Resize { label, w, h } => {
            let win = find_window(app, &label).ok_or_else(|| format!("no window {label}"))?;
            win.set_size(tauri::LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
            let _ = win.center();
            Ok("resized".into())
        }
        Req::Shot { label, out, delay_ms } => {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms.unwrap_or(600)));
            capture_window(app, &label, &out)
        }
        Req::Region { x, y, w, h, out, delay_ms } => {
            // Logical pixels in, like every window position the app deals in;
            // scaled to the monitor's physical pixels for the capture.
            std::thread::sleep(std::time::Duration::from_millis(delay_ms.unwrap_or(300)));
            let mon = xcap::Monitor::from_point(x + 1, y + 1).map_err(|e| e.to_string())?;
            let sf = mon.scale_factor().unwrap_or(1.0) as f64;
            let (mx, my) = (mon.x().unwrap_or(0), mon.y().unwrap_or(0));
            let px = |v: i32| ((v as f64) * sf).round();
            let img = mon
                .capture_region(px(x - mx).max(0.0) as u32, px(y - my).max(0.0) as u32, px(w as i32) as u32, px(h as i32) as u32)
                .map_err(|e| e.to_string())?;
            if let Some(dir) = Path::new(&out).parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            img.save(&out).map_err(|e| e.to_string())?;
            Ok(format!("{w}x{h} -> {out}"))
        }
        Req::Close { label } => {
            if let Some(w) = find_window(app, &label) {
                let _ = w.close();
            }
            Ok("closed".into())
        }
        Req::ExportDoc { format, brand } => {
            let fmt = crate::model::DocFormat::parse(&format).ok_or("unknown format")?;
            let brand = brand.map(PathBuf::from).unwrap_or_else(|| brand_dir(app));
            let mut inner = lock(app);
            let session = inner.session.as_mut().ok_or("no bundle open")?;
            let frame = crate::brand::resolve_shot_frame(app);
            let p = crate::export::write_document(session, &brand, fmt, &frame).map_err(|e| e.to_string())?;
            Ok(p.to_string_lossy().to_string())
        }
        Req::Finish => {
            let ex = do_finish(app, "path")?;
            Ok(ex.root)
        }
        Req::Sleep { ms } => {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            Ok("slept".into())
        }
    }
}

#[allow(dead_code)]
fn _base(app: &AppHandle) -> PathBuf {
    base_dir(app)
}
