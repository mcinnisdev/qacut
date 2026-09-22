use crate::capture::Frame;
use anyhow::Result;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};

pub const NOTE: &str = "note";
pub const PEEK: &str = "peek";
pub const REC: &str = "rec";
pub const EDIT: &str = "edit";
const PROMPTS: &str = "prompts";
pub const STUDIO: &str = "studio";
pub const BRANDS: &str = "brands";

/// Every window gets the same browser arguments (WebView2 fixes them for
/// the process at the first window). Tauri's defaults, plus: no permission
/// prompt for the microphone and camera, since the only pages that ask are
/// QACut's own, and no gesture needed for the camera preview to play.
#[cfg(windows)]
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
                            --use-fake-ui-for-media-stream \
                            --autoplay-policy=no-user-gesture-required";

fn builder<'a>(
    app: &'a AppHandle,
    label: &str,
    url: WebviewUrl,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let b = WebviewWindowBuilder::new(app, label, url);
    #[cfg(windows)]
    let b = b.additional_browser_args(BROWSER_ARGS);
    b
}

fn capture_label(monitor_id: &str) -> String {
    format!("capture-{monitor_id}")
}

/// Opens one borderless, always-on-top window per monitor, each sized and
/// positioned to cover that monitor exactly. The window shows the frozen
/// frame, so no transparency is needed and this behaves the same on X11,
/// Wayland, Windows and macOS. `mode` is "shot" or "record" and decides
/// what the overlay does with the selection.
pub fn open_capture(app: &AppHandle, frames: &[Frame], mode: &str) -> Result<()> {
    close_capture(app);

    for frame in frames {
        let label = capture_label(&frame.monitor_id);
        let url = format!("capture.html?m={}&mode={mode}", frame.monitor_id);

        let win = builder(app, &label, WebviewUrl::App(url.into()))
            .title("QACut capture")
            .position(frame.x as f64, frame.y as f64)
            .inner_size(frame.width as f64, frame.height as f64)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .focused(true)
            .build()?;

        let _ = win.set_cursor_grab(false);
        let _ = win.set_focus();
    }
    Ok(())
}

pub fn close_capture(app: &AppHandle) {
    let labels: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|l| l.starts_with("capture-"))
        .cloned()
        .collect();
    for label in labels {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        }
    }
}

/// The note box. `mode` is "shot", "quick", "recording" or "group". Centred
/// on `centre` (the middle of the monitor that was captured) when given,
/// otherwise centred on the focused monitor.
pub fn open_note(app: &AppHandle, mode: &str, centre: Option<(f64, f64)>) -> Result<()> {
    if let Some(w) = app.get_webview_window(NOTE) {
        let _ = w.close();
    }

    // Shot and quick boxes carry a thumbnail of the capture on the left.
    let (w, h) = match mode {
        "group" => (480.0, 236.0),
        "quick" => (600.0, 240.0),
        "shot" => (600.0, 208.0),
        _ => (480.0, 190.0),
    };
    let url = format!("note.html?mode={mode}");

    let win = builder(app, NOTE, WebviewUrl::App(url.into()))
        .title("QACut note")
        .inner_size(w, h)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .build()?;

    match centre {
        Some((cx, cy)) => {
            let _ = win.set_position(LogicalPosition::new(cx - w / 2.0, cy - h / 2.0));
        }
        None => {
            let _ = win.center();
        }
    }
    let _ = win.set_focus();
    Ok(())
}

pub fn close_note(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(NOTE) {
        let _ = w.close();
    }
}

/// The bundle overview. Toggles: a second press closes it.
pub fn toggle_peek(app: &AppHandle) -> Result<bool> {
    if let Some(w) = app.get_webview_window(PEEK) {
        let _ = w.close();
        return Ok(false);
    }
    open_peek(app, None)?;
    Ok(true)
}

/// Opens (or reopens) the bundle window. `focus` is "name" to land in the
/// bundle name field or "open" to show the list of past bundles.
pub fn open_peek(app: &AppHandle, focus: Option<&str>) -> Result<()> {
    close_and_wait(app, PEEK);
    let url = match focus {
        Some(f) => format!("peek.html?focus={f}"),
        None => "peek.html".to_string(),
    };
    let win = builder(app, PEEK, WebviewUrl::App(url.into()))
        .title("QACut bundle")
        .inner_size(900.0, 640.0)
        .min_inner_size(620.0, 420.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .build()?;

    let _ = win.set_size(LogicalSize::new(900.0, 640.0));
    let _ = win.center();
    let _ = win.set_focus();
    Ok(())
}

pub fn close_peek(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PEEK) {
        let _ = w.close();
    }
}

/// The recording overlay: a transparent, click-through window over the
/// whole monitor that tints everything outside the region, outlines the
/// region (just outside its edge, so the line is not recorded), and shows
/// the countdown and then the elapsed time. `x, y, w, h` are the region in
/// logical pixels relative to the monitor.
#[allow(clippy::too_many_arguments)]
pub fn open_rec_badge(
    app: &AppHandle,
    frame: &Frame,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    countdown_ms: u64,
    studio: bool,
) -> Result<()> {
    close_rec_badge(app);
    let url = format!(
        "rec.html?countdown={countdown_ms}&x={}&y={}&w={}&h={}&studio={}",
        x.round(),
        y.round(),
        w.round(),
        h.round(),
        if studio { 1 } else { 0 }
    );
    let win = builder(app, REC, WebviewUrl::App(url.into()))
        .title("QACut recording")
        .position(frame.x as f64, frame.y as f64)
        .inner_size(frame.width as f64, frame.height as f64)
        .decorations(false)
        .resizable(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .build()?;
    let _ = win.set_ignore_cursor_events(true);

    // A studio source is the whole monitor, so keep this window out of it:
    // the tint, the outline, the badge and the camera preview stay on the
    // screen for the operator and off the recording. (Auto-capture grabs
    // only the region, which the overlay never covers.)
    #[cfg(windows)]
    if studio {
        if let Ok(hwnd) = win.hwnd() {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
            };
            let ok = unsafe { SetWindowDisplayAffinity(hwnd.0 as _, WDA_EXCLUDEFROMCAPTURE) };
            if ok == 0 {
                eprintln!("qacut: could not exclude the overlay from capture; it will be in the source");
            }
        }
    }
    Ok(())
}

pub fn close_rec_badge(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(REC) {
        let _ = w.close();
    }
}

/// The markup editor for one PNG. Sized to the image plus its chrome, capped
/// to something that fits on the screen; the canvas scales down inside.
pub fn open_editor(app: &AppHandle, path: &str, label: &str, img_w: u32, img_h: u32) -> Result<()> {
    close_editor_and_wait(app);
    let w = (img_w as f64 + 40.0).clamp(560.0, 1400.0);
    let h = (img_h as f64 + 118.0).clamp(380.0, 900.0);
    let url = format!(
        "edit.html?path={}&label={}",
        urlencode(path),
        urlencode(label)
    );
    let win = builder(app, EDIT, WebviewUrl::App(url.into()))
        .title("QACut edit")
        .inner_size(w, h)
        .min_inner_size(480.0, 320.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .build()?;
    let _ = win.center();
    let _ = win.set_focus();
    Ok(())
}

/// The editor in review mode: opened on a shot in the bundle, with the
/// side panel, sized for the image plus the panel.
pub fn open_review(app: &AppHandle, group: usize, shot_id: &str, img_w: u32, img_h: u32) -> Result<()> {
    close_editor_and_wait(app);
    let w = (img_w as f64 + 40.0 + 292.0).clamp(920.0, 1500.0);
    let h = (img_h as f64 + 118.0).clamp(560.0, 940.0);
    let url = format!("edit.html?group={group}&shot={}", urlencode(shot_id));
    let win = builder(app, EDIT, WebviewUrl::App(url.into()))
        .title("QACut review")
        .inner_size(w, h)
        .min_inner_size(760.0, 420.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .build()?;
    let _ = win.center();
    let _ = win.set_focus();
    Ok(())
}

/// A quick shot opens straight into the editor: the capture large with the
/// markup tools, its note beside it, and the batch actions, so one window
/// covers "note it for an agent" and "mark it up and copy it for a person".
pub fn open_quick_editor(app: &AppHandle, path: &str, img_w: u32, img_h: u32) -> Result<()> {
    close_editor_and_wait(app);
    let w = (img_w as f64 + 40.0 + 292.0).clamp(880.0, 1500.0);
    let h = (img_h as f64 + 118.0).clamp(520.0, 940.0);
    let url = format!("edit.html?quick=1&path={}", urlencode(path));
    let win = builder(app, EDIT, WebviewUrl::App(url.into()))
        .title("QACut quick shot")
        .inner_size(w, h)
        .min_inner_size(760.0, 420.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .build()?;
    let _ = win.center();
    let _ = win.set_focus();
    Ok(())
}

/// The editor for the shot a note box is open on. The note box hides while
/// the editor is up and comes back, focused, when it closes.
pub fn open_editor_over_note(app: &AppHandle, path: &str, label: &str, img_w: u32, img_h: u32) -> Result<()> {
    if let Some(n) = app.get_webview_window(NOTE) {
        let _ = n.hide();
    }
    open_editor(app, path, label, img_w, img_h)?;
    if let Some(w) = app.get_webview_window(EDIT) {
        let app = app.clone();
        w.on_window_event(move |e| {
            if matches!(e, tauri::WindowEvent::Destroyed) {
                if let Some(n) = app.get_webview_window(NOTE) {
                    let _ = n.show();
                    let _ = n.set_focus();
                }
            }
        });
    }
    Ok(())
}

/// Closes an open editor and waits for it to be gone. Building a new
/// window with the same label while the old one is still tearing down
/// hands the new one a dead handle, and then it can never close itself.
fn close_editor_and_wait(app: &AppHandle) {
    close_and_wait(app, EDIT);
}

fn close_and_wait(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.close();
        for _ in 0..100 {
            if app.get_webview_window(label).is_none() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// QACut Studio, on a project folder or on the list of recordings.
/// The prompt library: every clipboard text and the user's own prompts,
/// in one window. `select` opens on one of the user's prompts by id.
pub fn open_prompts(app: &AppHandle, select: Option<&str>) -> Result<()> {
    close_and_wait(app, PROMPTS);
    let url = match select {
        Some(id) => format!("prompts.html?select={}", urlencode(id)),
        None => "prompts.html".to_string(),
    };
    let win = builder(app, PROMPTS, WebviewUrl::App(url.into()))
        .title("QACut prompt library")
        .inner_size(960.0, 640.0)
        .min_inner_size(720.0, 480.0)
        .decorations(false)
        .focused(true)
        .build()?;
    let _ = win.center();
    let _ = win.set_focus();
    Ok(())
}

/// The brands window: one brand per folder, its files, notes and looks.
/// `select` opens on that brand.
pub fn open_brands(app: &AppHandle, select: Option<&str>) -> Result<()> {
    close_and_wait(app, BRANDS);
    let url = match select {
        Some(slug) => format!("brands.html?select={}", urlencode(slug)),
        None => "brands.html".to_string(),
    };
    let win = builder(app, BRANDS, WebviewUrl::App(url.into()))
        .title("QACut brands")
        .inner_size(1040.0, 720.0)
        .min_inner_size(820.0, 540.0)
        .decorations(false)
        .focused(true)
        .build()?;
    let _ = win.center();
    let _ = win.set_focus();
    Ok(())
}

pub fn open_studio(app: &AppHandle, project_dir: Option<&str>) -> Result<()> {
    if let Some(w) = app.get_webview_window(STUDIO) {
        let _ = w.close();
    }
    let url = match project_dir {
        Some(d) => format!("studio.html?project={}", urlencode(d)),
        None => "studio.html".to_string(),
    };
    let win = builder(app, STUDIO, WebviewUrl::App(url.into()))
        .title("QACut Studio")
        .inner_size(1360.0, 860.0)
        .min_inner_size(960.0, 600.0)
        .decorations(false)
        .focused(true)
        .build()?;
    let _ = win.center();
    let _ = win.set_focus();
    Ok(())
}
