#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod drive;
mod export;
mod model;
mod overlay;
mod studio;

use capture::Frame;
use export::{BrandKit, Export};
use image::RgbaImage;
use model::{BundleInfo, DocFormat, Moment, Purpose, Session, Shot, ShotKind};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

// Hotkeys are user settings (see studio::settings::Hotkeys for the
// defaults); they are registered from settings at boot and whenever the
// user changes them.

/// Time between confirming a recording region and the first frame, so the
/// user can get windows and the mouse into place.
const RECORD_COUNTDOWN_MS: u64 = 3000;

#[derive(Default)]
struct Inner {
    session: Option<Session>,
    /// Frozen monitor frames, held only while the capture overlay is up.
    frames: Vec<(Frame, RgbaImage)>,
    /// True from the moment a capture is requested until its frames are
    /// stored, so a key-repeat cannot start a second grab mid-way.
    capturing: bool,
    /// The shot awaiting a note: (group index, shot id).
    pending: Option<(usize, String)>,
    /// A quick shot (outside any bundle) awaiting its note.
    quick_pending: Option<std::path::PathBuf>,
    /// The folder the current batch of quick shots is going into. A batch
    /// closes when it is copied as a whole, so the next shot starts a new
    /// folder and an agent is never pointed at shots already dealt with.
    quick_batch: Option<std::path::PathBuf>,
    /// An auto-capture in progress, the group its stills will land in, and
    /// the scratch folder they are written to meanwhile.
    recording: Option<(capture::Recording, usize, std::path::PathBuf)>,
    /// Set while the pre-recording countdown runs; storing true cancels it.
    countdown: Option<Arc<AtomicBool>>,
    /// A studio recording in progress.
    studio: Option<studio::Active>,
    /// A studio recording whose screen side has stopped; the overlay is
    /// flushing the camera track before the project is finalised.
    studio_finishing: Option<studio::Finishing>,
    /// An export file being written by the studio, chunk by chunk.
    export: Option<(std::path::PathBuf, std::fs::File)>,
    /// Registered shortcuts, canonical spelling to action.
    hotkeys: Vec<Binding>,
    /// The zoom chord from settings. It is only registered while a Studio
    /// recording runs (see `arm_zoom_key`), so a default like Ctrl+Space
    /// does not take the key away from editors the rest of the time.
    zoom_spec: Option<String>,
    zoom_armed: Option<Shortcut>,
    /// True after a finish until the bundle is touched again. The next hotkey
    /// capture then starts a new bundle; editing in the window, or Capture
    /// here, reopens this one.
    finished: bool,
    /// True when the session has changed since it was last written out, so
    /// "New bundle" knows whether there is anything to save first.
    dirty: bool,
    last_export: Option<Export>,
}

/// Everything the bundle window needs in one call.
#[derive(Clone, Serialize)]
struct AppState {
    session: Option<Session>,
    last_export: Option<Export>,
    dirty: bool,
    finished: bool,
    custom_prompt: String,
    brand: BrandKit,
}

type Shared = Mutex<Inner>;
/// A registered shortcut: its canonical spelling and what it triggers.
type Binding = (String, fn(&AppHandle));

fn base_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .home_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("QACut")
}

/// Returns the live session, starting one if there is none. A session only
/// ends when the user explicitly starts a new bundle; finishing writes it out
/// but leaves it open so more shots can be added and it can be written again.
fn ensure_session<'a>(app: &AppHandle, inner: &'a mut Inner) -> Result<&'a mut Session, String> {
    if inner.session.is_none() {
        let s = Session::start(&base_dir(app)).map_err(|e| e.to_string())?;
        inner.session = Some(s);
        inner.last_export = None;
        inner.dirty = false;
    }
    Ok(inner.session.as_mut().expect("just ensured"))
}

/// The user's own prompt template lives next to the bundles so it is easy
/// to find and edit by hand.
fn custom_prompt_path(app: &AppHandle) -> std::path::PathBuf {
    base_dir(app).join("custom-prompt.txt")
}

fn load_custom_prompt(app: &AppHandle) -> String {
    std::fs::read_to_string(custom_prompt_path(app)).unwrap_or_default()
}

/// Logo, colours, fonts, style guides, voice notes: whatever the user drops
/// here is copied into each bundle so the agent's output matches the brand.
fn brand_dir(app: &AppHandle) -> std::path::PathBuf {
    base_dir(app).join("brand")
}

/// The sentence added to the built-in prompts when a brand kit rides along.
const BRAND_LINE: &str = " The brand/ folder holds the business's brand kit and voice notes; match \
                          them in anything you produce.";

/// Where the prompt is going: a CLI agent that can open the folder, or a
/// chat agent that only sees an uploaded ZIP.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Target {
    Cli,
    Chat,
}

/// Fills `{root}` and `{name}` in a custom template. A template that never
/// mentions the folder gets it appended, so the agent can always find it.
fn fill_custom_prompt(template: &str, root: &str, name: &str, target: Target) -> String {
    let location = match target {
        Target::Cli => root.to_string(),
        Target::Chat => "the attached ZIP".to_string(),
    };
    let mut out = template
        .trim()
        .replace("{root}", &location)
        .replace("{name}", name);
    if !template.contains("{root}") {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&match target {
            Target::Cli => format!("The bundle is at {root}. Start with bundle.md."),
            Target::Chat => "The bundle is the attached ZIP. Unzip it and start with bundle.md.".to_string(),
        });
    }
    out
}

/// The texts QACut puts on the clipboard, each overridable. An empty field
/// means the built-in default. Placeholders in braces are filled in.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Prompts {
    /// One quick shot: `{path}`, `{note}`.
    quick_entry: String,
    /// A batch of quick shots: `{count}`, `{dir}`, `{entries}`.
    quick_batch: String,
    /// The Fix issues prompt: `{location}`, `{root}`, `{name}`.
    fix: String,
    /// The process doc prompt: `{location}`, `{root}`, `{name}`, `{deliverable}`.
    document: String,
    /// What `{deliverable}` becomes for a Markdown document.
    deliverable_markdown: String,
    /// What `{deliverable}` becomes for a web page.
    deliverable_html: String,
    /// The user's own prompts, picked by name before a hand-off.
    custom: Vec<CustomPrompt>,
}

/// A prompt of the user's own. A quick one wraps the shots it is sent with
/// (`{shots}` is the path-and-note text, or gets it appended); a bundle one
/// is a full instruction with `{root}` and `{name}`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct CustomPrompt {
    id: String,
    name: String,
    /// "quick" or "bundle".
    kind: String,
    template: String,
}

impl Prompts {
    fn defaults() -> Prompts {
        Prompts {
            quick_entry: "{path}\n{note}".into(),
            quick_batch: "{count} quick shots in {dir}. Each PNG has its note in the .md beside it; notes.md lists them all.\n\n{entries}".into(),
            fix: concat!(
                "Work through {location}. ",
                "Start with bundle.md: each group is a page or area, its quoted master note ",
                "applies to every screenshot under it, and each screenshot's note says what is ",
                "wrong. Open each screenshot before changing anything. Screenshots marked ",
                "auto-captured were taken in sequence while the reviewer did something; ",
                "the moment on each says what happened."
            )
            .into(),
            document: concat!(
                "Using {location}. write a step-by-step process document ",
                "for the workflow it shows. Read bundle.md first: each group is a stage, the ",
                "quoted note under it describes that stage, and each screenshot is one step ",
                "with the reviewer's note saying what is happening. Auto-captured screenshots ",
                "were taken in sequence at each click, with where the click landed marked, ",
                "so each is one action to describe. Open every screenshot before writing. ",
                "{deliverable}"
            )
            .into(),
            deliverable_markdown: concat!(
                "Write the steps in second person and embed each image where it belongs ",
                "using its relative path. Save the result as process.md inside the bundle ",
                "folder and keep the file names, so the document works next to its images."
            )
            .into(),
            deliverable_html: concat!(
                "Deliver one self-contained web page, process.html, saved inside the bundle ",
                "folder: inline CSS, images by relative path, one step per screenshot with ",
                "the image under its step. Write in second person and keep the file names."
            )
            .into(),
            custom: Vec::new(),
        }
    }

    fn path(app: &AppHandle) -> std::path::PathBuf {
        base_dir(app).join("prompts.json")
    }

    fn load(app: &AppHandle) -> Prompts {
        std::fs::read_to_string(Self::path(app))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn save(&self, app: &AppHandle) -> Result<(), String> {
        let p = Self::path(app);
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&p, serde_json::to_string_pretty(self).unwrap_or_default()).map_err(|e| e.to_string())
    }

    /// Every field filled: the override where there is one, else the default.
    fn resolved(&self) -> Prompts {
        let d = Prompts::defaults();
        let pick = |v: &str, def: String| if v.trim().is_empty() { def } else { v.to_string() };
        Prompts {
            quick_entry: pick(&self.quick_entry, d.quick_entry),
            quick_batch: pick(&self.quick_batch, d.quick_batch),
            fix: pick(&self.fix, d.fix),
            document: pick(&self.document, d.document),
            deliverable_markdown: pick(&self.deliverable_markdown, d.deliverable_markdown),
            deliverable_html: pick(&self.deliverable_html, d.deliverable_html),
            custom: self.custom.clone(),
        }
    }

    fn saved(&self, id: &str) -> Option<&CustomPrompt> {
        self.custom.iter().find(|p| p.id == id)
    }
}

#[derive(Serialize)]
struct PromptSet {
    defaults: Prompts,
    current: Prompts,
}

#[tauri::command]
fn get_prompts(app: AppHandle) -> PromptSet {
    PromptSet { defaults: Prompts::defaults(), current: Prompts::load(&app) }
}

#[tauri::command]
fn set_prompts(app: AppHandle, prompts: Prompts) -> Result<(), String> {
    prompts.save(&app)?;
    // Pickers elsewhere (the quick shot window, the bundle window's purpose
    // menu) refresh from this.
    let _ = app.emit("prompts-changed", ());
    Ok(())
}

/// The instruction handed to an agent alongside the folder path or ZIP.
fn agent_prompt(
    root: &str,
    name: &str,
    purpose: Purpose,
    doc_format: DocFormat,
    custom: &str,
    brand: bool,
    target: Target,
    prompts: &Prompts,
) -> String {
    if purpose == Purpose::Custom {
        return fill_custom_prompt(custom, root, name, target);
    }
    let p = prompts.resolved();
    let location = match target {
        Target::Cli => format!("the QA bundle at {root}"),
        Target::Chat => "the QA bundle in the attached ZIP. Unzip it first".to_string(),
    };
    let deliverable = match doc_format {
        DocFormat::Markdown => p.deliverable_markdown,
        DocFormat::Html => p.deliverable_html,
    };
    let template = match purpose {
        Purpose::Fix => p.fix,
        _ => p.document,
    };
    let base = template
        .replace("{location}", &location)
        .replace("{deliverable}", &deliverable)
        .replace("{root}", root)
        .replace("{name}", name)
        .trim()
        .to_string();
    if brand {
        base + BRAND_LINE
    } else {
        base
    }
}

// ---------------------------------------------------------------- triggers
//
// Hotkey and tray callbacks arrive on the main thread, inside a WndProc. If a
// window is built there, wry pumps a nested message loop while it waits for
// the WebView2 controller, and any queued window close that lands during that
// pump can deadlock the app. So every trigger runs on a worker thread; window
// creation is then queued to the event loop and handled at the top level like
// any other Tauri window.

fn off_main(app: &AppHandle, f: fn(&AppHandle)) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app));
}

fn trigger_capture(app: &AppHandle) {
    open_overlay(app, "shot");
}

/// A quick shot: one screenshot and one note, saved under ~/QACut/Quick
/// by day with no bundle around it, and its path and note put on the
/// clipboard ready to paste into an agent.
fn trigger_quick(app: &AppHandle) {
    open_overlay(app, "quick");
}

/// Where a fresh quick shot lands: flat under ~/QACut/Quick, named for the
/// moment. Add to batch moves it into a batch folder.
fn quick_single_path(app: &AppHandle) -> std::path::PathBuf {
    let dir = base_dir(app).join("Quick");
    let _ = std::fs::create_dir_all(&dir);
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S").to_string();
    let mut p = dir.join(format!("{stamp}.png"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stamp}-{n}.png"));
        n += 1;
    }
    p
}

/// The current batch folder, starting one (named for the moment it began)
/// if there is none.
fn quick_batch_dir(app: &AppHandle, inner: &mut Inner) -> std::path::PathBuf {
    if let Some(d) = &inner.quick_batch {
        if d.is_dir() {
            return d.clone();
        }
    }
    let dir = base_dir(app)
        .join("Quick")
        .join(chrono::Local::now().format("%Y-%m-%d_%H%M%S").to_string());
    inner.quick_batch = Some(dir.clone());
    dir
}

/// Next free NN in a batch folder.
fn quick_next(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().to_string_lossy().split('.').next()?.parse::<usize>().ok())
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0)
        + 1
}

fn quick_pngs(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut pngs: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x == "png").unwrap_or(false))
                // The markup editor's untouched original sits beside an
                // annotated shot; it is not a shot.
                .filter(|p| !p.file_stem().map(|s| s.to_string_lossy().ends_with(".orig")).unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    pngs.sort();
    pngs
}

/// Toggles: starts a recording via the overlay, cancels a countdown, or
/// stops the recording that is running.
fn trigger_record(app: &AppHandle) {
    let state: State<Shared> = app.state();
    let (countdown, active) = {
        let inner = state.lock().unwrap();
        (inner.countdown.clone(), inner.recording.is_some())
    };
    if let Some(flag) = countdown {
        flag.store(true, Ordering::SeqCst);
    } else if active {
        finish_recording(app);
    } else {
        open_overlay(app, "record");
    }
}

/// Toggles a studio recording: opens the overlay, cancels a countdown, or
/// stops the recording that is running.
fn trigger_studio(app: &AppHandle) {
    let state: State<Shared> = app.state();
    let (countdown, active) = {
        let inner = state.lock().unwrap();
        (inner.countdown.clone(), inner.studio.is_some())
    };
    if let Some(flag) = countdown {
        flag.store(true, Ordering::SeqCst);
    } else if active {
        finish_studio(app);
    } else {
        open_overlay(app, "studio");
    }
}

/// Stops the studio recording's screen side and asks the overlay to flush
/// the camera track; `finalize_studio` completes it when that is done, or
/// after a grace period if the overlay never answers.
fn finish_studio(app: &AppHandle) {
    let state: State<Shared> = app.state();
    let Some(active) = state.lock().unwrap().studio.take() else {
        return;
    };
    disarm_zoom_key(app);
    match active.stop() {
        Ok(finishing) => {
            state.lock().unwrap().studio_finishing = Some(finishing);
            let _ = app.emit("recording-stop", ());
            let app2 = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                finalize_studio(&app2);
            });
        }
        Err(e) => {
            overlay::close_rec_badge(app);
            eprintln!("qacut: studio recording failed: {e}");
        }
    }
}

fn finalize_studio(app: &AppHandle) {
    let state: State<Shared> = app.state();
    let Some(finishing) = state.lock().unwrap().studio_finishing.take() else {
        return;
    };
    overlay::close_rec_badge(app);
    match finishing.finalize() {
        Ok(()) => {
            eprintln!("qacut: studio recording saved to {}", finishing.dir.display());
            let dir = finishing.dir.to_string_lossy().to_string();
            if let Err(e) = overlay::open_studio(app, Some(&dir)) {
                eprintln!("qacut: could not open the studio: {e}");
                let _ = app.opener().reveal_item_in_dir(finishing.dir.join("source.mp4"));
            }
        }
        Err(e) => eprintln!("qacut: studio recording could not be finalised: {e}"),
    }
}

/// Zoom mark during a studio recording; ignored otherwise.
fn trigger_zoom_mark(app: &AppHandle) {
    let state: State<Shared> = app.state();
    let zoomed = {
        let mut inner = state.lock().unwrap();
        inner.studio.as_mut().map(|a| a.mark_zoom())
    };
    if let Some(on) = zoomed {
        let _ = app.emit("zoom-changed", on);
    }
}

fn trigger_open_studio(app: &AppHandle) {
    if let Err(e) = overlay::open_studio(app, None) {
        eprintln!("qacut: could not open the studio: {e}");
    }
}

/// Freezes every monitor and opens the selection overlay in `mode`.
fn open_overlay(app: &AppHandle, mode: &str) {
    let state: State<Shared> = app.state();

    // Don't stack overlays if one is already up or on its way, and don't
    // start a still capture while a recording is running.
    {
        let mut inner = state.lock().unwrap();
        if inner.capturing
            || !inner.frames.is_empty()
            || inner.recording.is_some()
            || inner.studio.is_some()
        {
            return;
        }
        inner.capturing = true;
    }
    // Get out of the way: the user's screenshots should not have QACut in
    // them. Anything open comes back when they ask for it.
    overlay::close_note(app);
    overlay::close_peek(app);

    let frames = match capture::freeze_all(&capture::scratch_dir()) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("qacut: capture failed: {e}");
            state.lock().unwrap().capturing = false;
            return;
        }
    };

    let meta: Vec<Frame> = frames.iter().map(|(f, _)| f.clone()).collect();
    {
        let mut inner = state.lock().unwrap();
        inner.capturing = false;
        if mode == "shot" || mode == "record" {
            if inner.finished {
                if let Err(e) = stash_session(app, &mut inner) {
                    eprintln!("qacut: could not put the finished bundle away: {e}");
                    return;
                }
            }
            if let Err(e) = ensure_session(app, &mut inner) {
                eprintln!("qacut: could not start session: {e}");
                return;
            }
        }
        inner.frames = frames;
    }

    if let Err(e) = overlay::open_capture(app, &meta, mode) {
        eprintln!("qacut: could not open overlay: {e}");
        let mut inner = state.lock().unwrap();
        inner.frames.clear();
    }
}

/// Stops the auto-capture and files each still as a shot in the group it
/// was started in, then opens the bundle window so the noise can be cut,
/// the keepers noted and the order fixed.
fn finish_recording(app: &AppHandle) {
    let state: State<Shared> = app.state();
    let Some((rec, group, frames_dir)) = state.lock().unwrap().recording.take() else {
        return;
    };
    overlay::close_rec_badge(app);

    let done = match rec.stop() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("qacut: auto-capture failed: {e}");
            let _ = std::fs::remove_dir_all(&frames_dir);
            return;
        }
    };

    {
        let mut inner = state.lock().unwrap();
        if let Some(session) = inner.session.as_mut() {
            let restore = session.current().index;
            session.set_current(group);
            for f in &done.frames {
                let (g, file, abs) = session.reserve_shot("png");
                let src = frames_dir.join(&f.file);
                if std::fs::rename(&src, &abs).is_err() && std::fs::copy(&src, &abs).is_err() {
                    continue;
                }
                let [src_orig, src_marks, _] = model::sidecars(&src);
                let [orig, marks, _] = model::sidecars(&abs);
                if src_orig.exists() {
                    let _ = std::fs::rename(&src_orig, &orig).or_else(|_| std::fs::copy(&src_orig, &orig).map(|_| ()));
                }
                if src_marks.exists() {
                    let _ = std::fs::rename(&src_marks, &marks).or_else(|_| std::fs::copy(&src_marks, &marks).map(|_| ()));
                }
                let (w, h) = image::image_dimensions(&abs).unwrap_or((done.width, done.height));
                session.current().shots.push(Shot {
                    id: shot_id(g),
                    file,
                    abs_path: abs.to_string_lossy().to_string(),
                    title: String::new(),
                    note: String::new(),
                    width: w,
                    height: h,
                    captured_at: chrono::Local::now().to_rfc3339(),
                    kind: ShotKind::Image,
                    duration_ms: 0,
                    frames: Vec::new(),
                    video: None,
                    moment: Some(Moment { at_ms: f.at_ms, event: f.event.clone(), x: f.x, y: f.y }),
                });
            }
            session.set_current(restore);
        }
        inner.dirty = true;
        inner.finished = false;
    }
    let _ = std::fs::remove_dir_all(&frames_dir);

    let _ = app.emit("session-changed", ());
    if let Err(e) = overlay::open_peek(app, None) {
        eprintln!("qacut: could not open bundle window: {e}");
    }
}

fn trigger_group(app: &AppHandle) {
    overlay::close_peek(app);
    if let Err(e) = overlay::open_note(app, "group", None) {
        eprintln!("qacut: could not open group prompt: {e}");
    }
}

fn trigger_peek(app: &AppHandle) {
    if let Err(e) = overlay::toggle_peek(app) {
        eprintln!("qacut: could not open bundle view: {e}");
    }
}

fn trigger_finish(app: &AppHandle) {
    match do_finish(app, "path") {
        Ok(_) => {
            overlay::close_peek(app);
            let _ = overlay::toggle_peek(app);
        }
        Err(e) => eprintln!("qacut: finish failed: {e}"),
    }
}

// ------------------------------------------------------------ hotkeys

fn action_for(id: &str) -> Option<fn(&AppHandle)> {
    Some(match id {
        "quick" => trigger_quick,
        "quick_finish" => trigger_quick_finish,
        "capture" => trigger_capture,
        "record" => trigger_record,
        "studio" => trigger_studio,
        "zoom" => trigger_zoom_mark,
        "group" => trigger_group,
        "peek" => trigger_peek,
        "finish" => trigger_finish,
        _ => return None,
    })
}

/// Registers the shortcuts from settings, replacing whatever was
/// registered before. Returns a line per key that could not be used.
fn apply_hotkeys(app: &AppHandle, hk: &studio::settings::Hotkeys) -> Vec<String> {
    let mut problems = Vec::new();
    let mut registered = Vec::new();
    let _ = app.global_shortcut().unregister_all();
    let mut zoom_spec = None;
    for (id, spec) in hk.entries() {
        let spec = spec.trim();
        if spec.is_empty() {
            continue;
        }
        if id == "zoom" {
            zoom_spec = Some(spec.to_string());
            continue;
        }
        let Some(action) = action_for(id) else { continue };
        match Shortcut::from_str(spec) {
            Ok(sc) => match app.global_shortcut().register(sc) {
                Ok(()) => registered.push((sc.to_string(), action)),
                Err(e) => {
                    eprintln!("qacut: hotkey {spec} is taken by something else ({e})");
                    problems.push(format!("{spec} is already taken by another app"));
                }
            },
            Err(e) => {
                eprintln!("qacut: hotkey {spec} is not valid ({e})");
                problems.push(format!("{spec} is not a valid shortcut"));
            }
        }
    }
    let state: State<Shared> = app.state();
    let recording = {
        let mut inner = state.lock().unwrap();
        inner.hotkeys = registered;
        inner.zoom_spec = zoom_spec;
        inner.zoom_armed = None;
        inner.studio.is_some()
    };
    if recording {
        arm_zoom_key(app);
    }
    problems
}

/// Registers the zoom chord for the duration of a Studio recording.
fn arm_zoom_key(app: &AppHandle) {
    let state: State<Shared> = app.state();
    let spec = {
        let inner = state.lock().unwrap();
        if inner.zoom_armed.is_some() {
            return;
        }
        inner.zoom_spec.clone()
    };
    let Some(spec) = spec else { return };
    let sc = match Shortcut::from_str(&spec) {
        Ok(sc) => sc,
        Err(e) => {
            eprintln!("qacut: zoom hotkey {spec} is not valid ({e})");
            return;
        }
    };
    if let Err(e) = app.global_shortcut().register(sc) {
        eprintln!("qacut: zoom hotkey {spec} is taken by something else ({e})");
        return;
    }
    let mut inner = state.lock().unwrap();
    inner.hotkeys.push((sc.to_string(), trigger_zoom_mark));
    inner.zoom_armed = Some(sc);
}

/// Releases the zoom chord when the recording ends.
fn disarm_zoom_key(app: &AppHandle) {
    let state: State<Shared> = app.state();
    let sc = state.lock().unwrap().zoom_armed.take();
    let Some(sc) = sc else { return };
    let _ = app.global_shortcut().unregister(sc);
    let key = sc.to_string();
    state.lock().unwrap().hotkeys.retain(|(s, _)| *s != key);
}

/// The tray menu, built from settings so accelerator labels and toggles
/// are always current. Three tools in one tray: QACut Basic (quick shots), QACut
/// Docs (bundles) and QACut Studio; disabled items serve as headers.
fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let st = studio::settings::Settings::load(&base_dir(app));
    let hk = &st.hotkeys;
    let acc = |s: &str| if s.trim().is_empty() { None } else { Some(s.trim().to_string()) };

    let head_qacut = MenuItem::with_id(app, "h1", "QACut Basic", false, None::<&str>)?;
    let head_docs = MenuItem::with_id(app, "h4", "QACut Bundles", false, None::<&str>)?;
    let quick_i = MenuItem::with_id(app, "quick", "Quick shot", true, acc(&hk.quick))?;
    let quick_finish_i =
        MenuItem::with_id(app, "quick_finish", "Copy quick batch for agent", true, acc(&hk.quick_finish))?;
    let capture_i = MenuItem::with_id(app, "capture", "Capture", true, acc(&hk.capture))?;
    let record_i = MenuItem::with_id(app, "record", "Auto-capture start / stop", true, acc(&hk.record))?;
    let group_i = MenuItem::with_id(app, "group", "New group", true, acc(&hk.group))?;
    let peek_i = MenuItem::with_id(app, "peek", "View / edit bundle", true, acc(&hk.peek))?;
    let finish_i = MenuItem::with_id(app, "finish", "Finish bundle and copy for agent", true, acc(&hk.finish))?;
    let folder_i = MenuItem::with_id(app, "folder", "Open QACut folder", true, None::<&str>)?;

    let head_studio = MenuItem::with_id(app, "h2", "QACut Studio", false, None::<&str>)?;
    let open_studio_i = MenuItem::with_id(app, "open_studio", "Open Studio", true, None::<&str>)?;
    let studio_i = MenuItem::with_id(app, "studio", "Record start / stop", true, acc(&hk.studio))?;
    let zoom_i = MenuItem::with_id(app, "zoom", "Zoom start / end (while recording)", true, acc(&hk.zoom))?;
    let head_inputs = MenuItem::with_id(app, "h3", "Enable inputs", false, None::<&str>)?;
    let keys_i = CheckMenuItem::with_id(app, "st_keys", "Capture keystrokes", true, st.keystrokes, None::<&str>)?;
    let mic_i = CheckMenuItem::with_id(app, "st_mic", "Microphone", true, st.mic, None::<&str>)?;
    let cam_i = CheckMenuItem::with_id(app, "st_cam", "Camera", true, st.camera, None::<&str>)?;
    let studio_folder_i = MenuItem::with_id(app, "studio_folder", "Open Studio folder", true, None::<&str>)?;

    let shortcuts_i = MenuItem::with_id(app, "shortcuts", "Keyboard shortcuts...", true, None::<&str>)?;
    let prompts_i = MenuItem::with_id(app, "prompts", "Prompt library...", true, None::<&str>)?;
    let update_i = MenuItem::with_id(app, "update", "Check for updates...", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit QACut", true, None::<&str>)?;
    let sep_quick = PredefinedMenuItem::separator(app)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep_inputs = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &head_qacut, &quick_i, &quick_finish_i,
            &sep_quick,
            &head_docs, &capture_i, &record_i, &group_i, &peek_i, &finish_i, &folder_i,
            &sep1,
            &head_studio, &open_studio_i, &studio_i, &zoom_i,
            &sep_inputs,
            &head_inputs, &keys_i, &mic_i, &cam_i, &studio_folder_i,
            &sep2,
            &shortcuts_i, &prompts_i, &update_i, &quit_i,
        ],
    )
}

fn refresh_tray_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main") {
        match build_tray_menu(app) {
            Ok(menu) => {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    eprintln!("qacut: could not update the tray menu: {e}");
                }
            }
            Err(e) => eprintln!("qacut: could not build the tray menu: {e}"),
        }
    }
}

fn trigger_prompts(app: &AppHandle) {
    if let Err(e) = overlay::open_prompts(app, None) {
        eprintln!("qacut: could not open the prompt library: {e}");
    }
}

#[tauri::command]
async fn open_prompt_library(app: AppHandle) -> Result<(), String> {
    overlay::open_prompts(&app, None).map_err(|e| e.to_string())
}

/// Asks GitHub for a newer release and offers to install it. `quiet` is
/// the start-up check: nothing is shown unless there is an update.
fn check_for_updates(app: &AppHandle, quiet: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    use tauri_plugin_updater::UpdaterExt;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let current = app.package_info().version.to_string();
        let checked = match app.updater() {
            Ok(u) => u.check().await.map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        match checked {
            Ok(Some(update)) => {
                let mut notes = update.body.clone().unwrap_or_default().trim().to_string();
                if notes.len() > 700 {
                    notes.truncate(700);
                    notes.push_str("...");
                }
                let install = app
                    .dialog()
                    .message(format!(
                        "QACut {} is available; you have {current}.\n\n{notes}\n\nInstall it now? QACut closes, the installer runs, and it starts again.",
                        update.version
                    ))
                    .title("Update available")
                    .kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Later".into()))
                    .blocking_show();
                if install {
                    match update.download_and_install(|_, _| {}, || {}).await {
                        Ok(()) => app.restart(),
                        Err(e) => {
                            app.dialog()
                                .message(format!("The update could not be installed: {e}"))
                                .title("Update failed")
                                .kind(MessageDialogKind::Error)
                                .blocking_show();
                        }
                    }
                }
            }
            Ok(None) if !quiet => {
                app.dialog()
                    .message(format!("QACut {current} is the latest version."))
                    .title("No update")
                    .kind(MessageDialogKind::Info)
                    .blocking_show();
            }
            Err(e) if !quiet => {
                app.dialog()
                    .message(format!("Could not check for updates: {e}"))
                    .title("Check for updates")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
            }
            _ => {}
        }
    });
}

fn trigger_shortcuts(app: &AppHandle) {
    if let Err(e) = overlay::open_peek(app, Some("shortcuts")) {
        eprintln!("qacut: could not open bundle window: {e}");
    }
}

/// Puts the current session away: unsaved work is written out, a session
/// with no shots is deleted rather than left as an empty folder.
fn stash_session(app: &AppHandle, inner: &mut Inner) -> Result<(), String> {
    let dirty = inner.dirty;
    if let Some(session) = inner.session.as_mut() {
        if session.shot_count() == 0 {
            let _ = std::fs::remove_dir_all(&session.root);
        } else if dirty {
            export::write_bundle(session, &brand_dir(app)).map_err(|e| e.to_string())?;
        }
    }
    inner.session = None;
    inner.pending = None;
    inner.last_export = None;
    inner.dirty = false;
    inner.finished = false;
    Ok(())
}

/// Closes the current session and starts a fresh one, so the bundle window
/// has something to name straight away.
fn do_new_bundle(app: &AppHandle) -> Result<(), String> {
    overlay::close_note(app);
    let state: State<Shared> = app.state();
    {
        let mut inner = state.lock().unwrap();
        stash_session(app, &mut inner)?;
        ensure_session(app, &mut inner)?;
    }
    let _ = app.emit("session-changed", ());
    Ok(())
}

/// Reopens a bundle from disk as the live session.
fn do_open_bundle(app: &AppHandle, path: &str) -> Result<(), String> {
    overlay::close_note(app);
    let loaded = Session::load(std::path::Path::new(path)).map_err(|e| e.to_string())?;
    let state: State<Shared> = app.state();
    {
        let mut inner = state.lock().unwrap();
        if inner.session.as_ref().map(|s| s.root == loaded.root).unwrap_or(false) {
            return Ok(());
        }
        stash_session(app, &mut inner)?;
        inner.session = Some(loaded);
    }
    let _ = app.emit("session-changed", ());
    Ok(())
}

fn do_finish(app: &AppHandle, action: &str) -> Result<Export, String> {
    let state: State<Shared> = app.state();
    let mut result = {
        let mut inner = state.lock().unwrap();
        let session = inner
            .session
            .as_mut()
            .ok_or_else(|| "nothing captured yet".to_string())?;
        let mut ex = export::write_bundle(session, &brand_dir(app)).map_err(|e| e.to_string())?;
        if action == "zip" {
            let zp = export::write_zip(session).map_err(|e| e.to_string())?;
            ex.zip_path = Some(zp.to_string_lossy().to_string());
        }
        inner.dirty = false;
        inner.finished = true;
        inner.last_export = Some(ex.clone());
        ex
    };

    let prompt_for = |target: Target| -> Result<String, String> {
        let (mut purpose, doc_format, name, include_brand, prompt_id) = state
            .lock()
            .unwrap()
            .session
            .as_ref()
            .map(|s| (s.purpose, s.doc_format, s.title(), s.include_brand, s.prompt_id.clone()))
            .unwrap_or((Purpose::Fix, DocFormat::Markdown, String::new(), false, None));
        let mut custom = load_custom_prompt(app);
        if purpose == Purpose::Saved {
            let prompts = Prompts::load(app);
            let saved = prompt_id
                .as_deref()
                .and_then(|id| prompts.saved(id))
                .ok_or_else(|| "that saved prompt is gone; pick another".to_string())?;
            custom = saved.template.clone();
            purpose = Purpose::Custom;
        }
        if purpose == Purpose::Custom && custom.trim().is_empty() {
            return Err("write a custom prompt first".into());
        }
        let brand = include_brand && !BrandKit::load(&brand_dir(app)).is_empty();
        Ok(agent_prompt(&result.root, &name, purpose, doc_format, &custom, brand, target, &Prompts::load(app)))
    };

    match action {
        // Chat hand-off: reveal the archive ready to drag in, and put the
        // matching prompt on the clipboard.
        "zip" => {
            let zp = result.zip_path.clone().unwrap_or_default();
            let prompt = prompt_for(Target::Chat)?;
            app.clipboard().write_text(prompt).map_err(|e| e.to_string())?;
            let _ = app.opener().reveal_item_in_dir(&zp);
            result.zip_path = Some(zp);
        }
        "chatprompt" => {
            let prompt = prompt_for(Target::Chat)?;
            app.clipboard().write_text(prompt).map_err(|e| e.to_string())?;
        }
        "markdown" => {
            app.clipboard()
                .write_text(result.markdown.clone())
                .map_err(|e| e.to_string())?;
        }
        "prompt" => {
            let prompt = prompt_for(Target::Cli)?;
            app.clipboard().write_text(prompt).map_err(|e| e.to_string())?;
        }
        "open" => {
            app.opener()
                .open_path(result.root.clone(), None::<&str>)
                .map_err(|e| e.to_string())?;
        }
        _ => {
            app.clipboard()
                .write_text(result.root.clone())
                .map_err(|e| e.to_string())?;
        }
    }

    let _ = app.emit("session-changed", ());
    Ok(result)
}

fn shot_id(group: usize) -> String {
    format!("{group}-{}", chrono::Local::now().timestamp_micros())
}

// ---------------------------------------------------------------- commands
//
// Any command that opens or closes a window is `async`. Sync commands run on
// the main thread, and on Windows creating a window from there deadlocks
// (the builder waits on the event loop it is blocking).

/// The capture overlay asks for the frame belonging to its monitor.
#[tauri::command]
fn frame_for(state: State<Shared>, monitor: String) -> Option<Frame> {
    let inner = state.lock().unwrap();
    inner
        .frames
        .iter()
        .find(|(f, _)| f.monitor_id == monitor)
        .map(|(f, _)| f.clone())
}

/// Crops the selection, files it in the current group, and opens the note box.
#[tauri::command]
async fn commit_selection(
    app: AppHandle,
    state: State<'_, Shared>,
    monitor: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    overlay::close_capture(&app);

    let anchor = {
        let mut inner = state.lock().unwrap();

        let (frame, image) = inner
            .frames
            .iter()
            .find(|(f, _)| f.monitor_id == monitor)
            .map(|(f, i)| (f.clone(), i.clone()))
            .ok_or_else(|| "that monitor is no longer frozen".to_string())?;

        let session = ensure_session(&app, &mut inner)?;
        let (group, file, abs) = session.reserve_shot("png");

        let (pw, ph) = capture::crop_selection(&frame, &image, x, y, width, height, &abs)
            .map_err(|e| e.to_string())?;

        let id = shot_id(group);
        session.current().shots.push(Shot {
            id: id.clone(),
            file,
            abs_path: abs.to_string_lossy().to_string(),
            title: String::new(),
            note: String::new(),
            width: pw,
            height: ph,
            captured_at: chrono::Local::now().to_rfc3339(),
            kind: ShotKind::Image,
            duration_ms: 0,
            frames: Vec::new(),
            video: None,
            moment: None,
        });

        inner.pending = Some((group, id));
        inner.frames.clear();
        inner.dirty = true;
        inner.finished = false;

        note_anchor(&frame, x, y, height)
    };

    capture::clear_scratch();
    let _ = app.emit("session-changed", ());
    overlay::open_note(&app, "shot", Some(anchor)).map_err(|e| e.to_string())
}

/// The overlay, in record mode, hands over the region to record. A short
/// countdown runs first (the badge shows it, the record hotkey cancels it),
/// then the shot is filed with placeholder size and filled in on stop.
#[tauri::command]
async fn start_recording(
    app: AppHandle,
    state: State<'_, Shared>,
    monitor: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    overlay::close_capture(&app);

    let (frame, cancel) = {
        let mut inner = state.lock().unwrap();
        if inner.recording.is_some() || inner.countdown.is_some() {
            return Err("already recording".into());
        }
        let frame = inner
            .frames
            .iter()
            .find(|(f, _)| f.monitor_id == monitor)
            .map(|(f, _)| f.clone())
            .ok_or_else(|| "that monitor is no longer frozen".to_string())?;
        inner.frames.clear();
        let cancel = Arc::new(AtomicBool::new(false));
        inner.countdown = Some(cancel.clone());
        (frame, cancel)
    };
    capture::clear_scratch();

    if let Err(e) =
        overlay::open_rec_badge(&app, &frame, x, y, width, height, RECORD_COUNTDOWN_MS, false)
    {
        eprintln!("qacut: could not show recording overlay: {e}");
    }

    let started = std::time::Instant::now();
    while started.elapsed().as_millis() < RECORD_COUNTDOWN_MS as u128 {
        if cancel.load(Ordering::SeqCst) {
            state.lock().unwrap().countdown = None;
            overlay::close_rec_badge(&app);
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    {
        let mut inner = state.lock().unwrap();
        inner.countdown = None;
        let group = ensure_session(&app, &mut inner)?.current().index;
        let frames_dir = capture::scratch_dir().join(format!(
            "autocapture-{}",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        ));
        let rec = capture::start_recording(app.clone(), &frame, x, y, width, height, frames_dir.clone())
            .map_err(|e| e.to_string())?;
        inner.recording = Some((rec, group, frames_dir));
        inner.dirty = true;
        inner.finished = false;
    }

    let _ = app.emit("session-changed", ());
    let _ = app.emit("recording-started", ());
    Ok(())
}

#[tauri::command]
async fn stop_recording(app: AppHandle) {
    finish_recording(&app);
}

/// The overlay, in studio mode, hands over the region. Same countdown as a
/// GIF recording, then the studio capture and event recorders start.
#[tauri::command]
async fn start_studio(
    app: AppHandle,
    state: State<'_, Shared>,
    monitor: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    overlay::close_capture(&app);

    let (frame, cancel) = {
        let mut inner = state.lock().unwrap();
        if inner.recording.is_some() || inner.studio.is_some() || inner.countdown.is_some() {
            return Err("already recording".into());
        }
        let frame = inner
            .frames
            .iter()
            .find(|(f, _)| f.monitor_id == monitor)
            .map(|(f, _)| f.clone())
            .ok_or_else(|| "that monitor is no longer frozen".to_string())?;
        inner.frames.clear();
        let cancel = Arc::new(AtomicBool::new(false));
        inner.countdown = Some(cancel.clone());
        (frame, cancel)
    };
    capture::clear_scratch();

    if let Err(e) =
        overlay::open_rec_badge(&app, &frame, x, y, width, height, RECORD_COUNTDOWN_MS, true)
    {
        eprintln!("qacut: could not show recording overlay: {e}");
    }

    let started = std::time::Instant::now();
    while started.elapsed().as_millis() < RECORD_COUNTDOWN_MS as u128 {
        if cancel.load(Ordering::SeqCst) {
            state.lock().unwrap().countdown = None;
            overlay::close_rec_badge(&app);
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let settings = studio::settings::Settings::load(&base_dir(&app));
    let active = studio::begin(&base_dir(&app), &frame, x, y, width, height, settings.keystrokes);
    {
        let mut inner = state.lock().unwrap();
        inner.countdown = None;
        match active {
            Ok(a) => inner.studio = Some(a),
            Err(e) => {
                overlay::close_rec_badge(&app);
                eprintln!("qacut: studio recording could not start: {e}");
                return Err(e.to_string());
            }
        }
    }
    arm_zoom_key(&app);
    let _ = app.emit("recording-started", ());
    Ok(())
}

#[tauri::command]
async fn start_studio_from_menu(app: AppHandle) {
    trigger_studio(&app);
}

/// The overlay's microphone/camera recorder has started. Its wall-clock
/// time is mapped onto the frames' clock through the two clocks read
/// together here; the error is the IPC latency, a few milliseconds.
#[tauri::command]
fn camera_started(state: State<Shared>, at_unix_ms: f64, has_video: bool, has_audio: bool) {
    let now_q = studio::events::now_100ns();
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(at_unix_ms);
    let ts = now_q + ((at_unix_ms - now_unix) * 10_000.0) as i64;
    let mut inner = state.lock().unwrap();
    if let Some(active) = inner.studio.as_mut() {
        active.camera = Some(studio::CameraStart { ts, has_video, has_audio });
    } else if let Some(f) = inner.studio_finishing.as_mut() {
        f.camera = Some(studio::CameraStart { ts, has_video, has_audio });
    }
}

/// One MediaRecorder chunk, appended in order to camera.webm.
#[tauri::command]
fn append_camera(state: State<Shared>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    use std::io::Write as _;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let dir = {
        let inner = state.lock().unwrap();
        inner
            .studio
            .as_ref()
            .map(|a| a.dir.clone())
            .or_else(|| inner.studio_finishing.as_ref().map(|f| f.dir.clone()))
            .ok_or("no studio recording")?
    };
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("camera.webm"))
        .map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())
}

/// The overlay has flushed its last chunk (or had nothing to record).
#[tauri::command]
async fn camera_stopped(app: AppHandle) {
    finalize_studio(&app);
}

#[derive(Clone, Serialize)]
struct StudioLoad {
    project: studio::project::Project,
    events: serde_json::Value,
}

#[tauri::command]
fn list_studio_projects(app: AppHandle) -> Vec<studio::project::StudioInfo> {
    studio::project::list(&base_dir(&app))
}

#[tauri::command]
fn load_studio_project(dir: String) -> Result<StudioLoad, String> {
    let d = std::path::Path::new(&dir);
    let project = studio::project::Project::load(d).map_err(|e| e.to_string())?;
    let events = std::fs::read_to_string(d.join(&project.events))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({ "version": 1, "cursor": [], "shapes": [], "buttons": [], "keys": [], "windows": [] }));
    Ok(StudioLoad { project, events })
}

/// Saves edits and name. Naming a recording renames its folder to
/// `<timestamp>-<slug>`, like a bundle, so the Studio folder reads at a
/// glance. Returns the folder's (possibly new) path.
#[tauri::command]
fn save_studio_edits(dir: String, edits: serde_json::Value, name: String) -> Result<String, String> {
    let d = std::path::PathBuf::from(&dir);
    let mut project = studio::project::Project::load(&d).map_err(|e| e.to_string())?;
    project.edits = edits;
    project.name = name.trim().to_string();

    let slug = model::slug(&project.name);
    let stamp = project.id.clone();
    let desired = if slug.is_empty() { stamp } else { format!("{stamp}-{slug}") };
    let target = d.parent().map(|p| p.join(&desired)).unwrap_or_else(|| d.clone());
    let final_dir = if target != d && !target.exists() {
        match std::fs::rename(&d, &target) {
            Ok(()) => target,
            // A file in use (an export being written, a player open) keeps
            // the old name; the name itself is still saved.
            Err(e) => {
                eprintln!("qacut: could not rename recording folder: {e}");
                d
            }
        }
    } else {
        d
    };
    project.save(&final_dir).map_err(|e| e.to_string())?;
    Ok(final_dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn open_studio(app: AppHandle, dir: Option<String>) -> Result<(), String> {
    overlay::open_studio(&app, dir.as_deref()).map_err(|e| e.to_string())
}

// ------------------------------------------------------------- export
//
// The studio renders and encodes in the webview and streams the MP4 bytes
// here as they are produced; the muxer may write at earlier offsets to
// patch headers, so every chunk carries its position.

#[tauri::command]
fn export_open(state: State<Shared>, dir: String, name: String) -> Result<String, String> {
    let stem = model::slug(&name);
    let file_name = format!("{}.mp4", if stem.is_empty() { "export".to_string() } else { stem });
    let path = std::path::Path::new(&dir).join(file_name);
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    state.lock().unwrap().export = Some((path.clone(), file));
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn export_write(state: State<Shared>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    use std::io::{Seek, SeekFrom, Write as _};
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let offset: u64 = request
        .headers()
        .get("x-offset")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or("missing x-offset")?;
    let mut inner = state.lock().unwrap();
    let (_, file) = inner.export.as_mut().ok_or("no export in progress")?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn export_close(app: AppHandle, state: State<Shared>) -> Result<String, String> {
    let (path, file) = state.lock().unwrap().export.take().ok_or("no export in progress")?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    let _ = app.opener().reveal_item_in_dir(&path);
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn export_abort(state: State<Shared>) {
    if let Some((path, file)) = state.lock().unwrap().export.take() {
        drop(file);
        let _ = std::fs::remove_file(path);
    }
}

#[derive(Clone, Serialize)]
struct BrandImage {
    name: String,
    path: String,
}

/// Image files in the brand folder, for the studio's logo picker.
#[tauri::command]
fn list_brand_images(app: AppHandle) -> Vec<BrandImage> {
    let dir = brand_dir(&app);
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            let ext = p
                .extension()
                .map(|x| x.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "svg" | "webp" | "gif") {
                out.push(BrandImage {
                    name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    path: p.to_string_lossy().to_string(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// A file picker for a picture, copied into the brand folder so it shows
/// up in every picker and travels with the kit. None when cancelled.
#[tauri::command]
async fn pick_brand_image(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .add_filter("Pictures", &["png", "jpg", "jpeg", "webp", "gif"])
        .set_title("Choose a picture")
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let from = picked.into_path().map_err(|e| e.to_string())?;
    let dir = brand_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = from.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "picture.png".into());
    let mut to = dir.join(&name);
    let mut n = 2;
    while to.exists() && std::fs::read(&to).ok() != std::fs::read(&from).ok() {
        let stem = from.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = from.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        to = dir.join(format!("{stem}-{n}.{ext}"));
        n += 1;
    }
    if !to.exists() {
        std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
    }
    Ok(Some(to.to_string_lossy().to_string()))
}

#[tauri::command]
fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_studio_settings(app: AppHandle) -> studio::settings::Settings {
    studio::settings::Settings::load(&base_dir(&app))
}

#[tauri::command]
fn set_studio_settings(app: AppHandle, settings: studio::settings::Settings) -> Result<(), String> {
    settings.save(&base_dir(&app)).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_hotkeys(app: AppHandle) -> studio::settings::Hotkeys {
    studio::settings::Settings::load(&base_dir(&app)).hotkeys
}

/// Saves and applies new shortcuts. Returns a line per key that could not
/// be registered; the others are live immediately.
#[tauri::command]
fn set_hotkeys(app: AppHandle, hotkeys: studio::settings::Hotkeys) -> Result<Vec<String>, String> {
    let mut st = studio::settings::Settings::load(&base_dir(&app));
    st.hotkeys = hotkeys;
    st.save(&base_dir(&app)).map_err(|e| e.to_string())?;
    let problems = apply_hotkeys(&app, &st.hotkeys);
    refresh_tray_menu(&app);
    Ok(problems)
}

/// Lets a window that is about to close report why something failed.
#[tauri::command]
fn log_error(message: String) {
    eprintln!("qacut: {message}");
}

#[tauri::command]
async fn cancel_capture(app: AppHandle, state: State<'_, Shared>) -> Result<(), String> {
    overlay::close_capture(&app);
    {
        let mut inner = state.lock().unwrap();
        inner.frames.clear();
    }
    capture::clear_scratch();
    Ok(())
}

/// Commits the note for the shot that is waiting, plus the shot and group
/// names typed into the note box header. Empty values are fine.
#[tauri::command]
async fn save_note(
    app: AppHandle,
    state: State<'_, Shared>,
    note: String,
    title: String,
    group_title: String,
) -> Result<(), String> {
    {
        let mut inner = state.lock().unwrap();
        let Some((group, id)) = inner.pending.take() else {
            return Ok(());
        };
        if let Some(session) = inner.session.as_mut() {
            if let Some(shot) = session.shot_mut(group, &id) {
                shot.note = note.trim().to_string();
                shot.title = title.trim().to_string();
            }
            if let Some(g) = session.group_mut(group) {
                g.title = group_title.trim().to_string();
            }
        }
        inner.dirty = true;
        inner.finished = false;
    }
    overlay::close_note(&app);
    let _ = app.emit("session-changed", ());
    Ok(())
}

/// Discards the shot the note box was attached to, file and all.
#[tauri::command]
async fn discard_pending(app: AppHandle, state: State<'_, Shared>) -> Result<(), String> {
    {
        let mut inner = state.lock().unwrap();
        if let Some((group, id)) = inner.pending.take() {
            if let Some(session) = inner.session.as_mut() {
                session.remove_shot(group, &id);
            }
            inner.dirty = true;
            inner.finished = false;
        }
    }
    overlay::close_note(&app);
    let _ = app.emit("session-changed", ());
    Ok(())
}

/// Wraps up the current group with its name and master note and, if it has
/// shots, opens the next one.
#[tauri::command]
async fn close_group(
    app: AppHandle,
    state: State<'_, Shared>,
    title: String,
    master_note: String,
) -> Result<usize, String> {
    let index = {
        let mut inner = state.lock().unwrap();
        let session = ensure_session(&app, &mut inner)?;
        let index = session
            .close_group(&title, &master_note)
            .map_err(|e| e.to_string())?;
        inner.dirty = true;
        inner.finished = false;
        index
    };
    overlay::close_note(&app);
    let _ = app.emit("session-changed", ());
    Ok(index)
}

#[tauri::command]
fn get_session(state: State<Shared>) -> Option<Session> {
    state.lock().unwrap().session.clone()
}

#[tauri::command]
fn get_state(app: AppHandle, state: State<Shared>) -> AppState {
    let inner = state.lock().unwrap();
    AppState {
        session: inner.session.clone(),
        last_export: inner.last_export.clone(),
        dirty: inner.dirty,
        finished: inner.finished,
        custom_prompt: load_custom_prompt(&app),
        brand: BrandKit::load(&brand_dir(&app)),
    }
}

/// Saves the voice notes that get inlined into bundle.md.
#[tauri::command]
fn set_brand_notes(app: AppHandle, text: String) -> Result<(), String> {
    let dir = brand_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(export::BRAND_NOTES), text).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_include_brand(app: AppHandle, state: State<Shared>, include: bool) -> Result<(), String> {
    {
        let mut inner = state.lock().unwrap();
        let session = ensure_session(&app, &mut inner)?;
        session.include_brand = include;
        inner.dirty = true;
        inner.finished = false;
    }
    let _ = app.emit("session-changed", ());
    Ok(())
}

/// Creates the brand folder if needed and opens it, so files can be dropped in.
#[tauri::command]
fn open_brand_folder(app: AppHandle) -> Result<(), String> {
    let dir = brand_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Saves the user's prompt template. Not part of the session: it is meant to
/// be written once and reused across bundles.
#[tauri::command]
fn set_custom_prompt(app: AppHandle, text: String) -> Result<(), String> {
    let path = custom_prompt_path(&app);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// Hands the bundle off with one of the user's saved prompts.
#[tauri::command]
fn set_saved_prompt(app: AppHandle, state: State<Shared>, id: String) -> Result<(), String> {
    {
        let mut inner = state.lock().unwrap();
        let session = ensure_session(&app, &mut inner)?;
        session.purpose = Purpose::Saved;
        session.prompt_id = Some(id);
        inner.dirty = true;
        inner.finished = false;
    }
    let _ = app.emit("session-changed", ());
    Ok(())
}

/// Points new captures at an existing group.
#[tauri::command]
fn set_current_group(app: AppHandle, state: State<Shared>, group: usize) -> Result<(), String> {
    {
        let mut inner = state.lock().unwrap();
        let session = inner.session.as_mut().ok_or("nothing captured yet")?;
        if !session.set_current(group) {
            return Err("no such group".into());
        }
        inner.finished = false;
    }
    let _ = app.emit("session-changed", ());
    Ok(())
}

/// Labels the bundle and renames its folder to match.
#[tauri::command]
fn rename_bundle(app: AppHandle, state: State<Shared>, name: String) -> Result<(), String> {
    {
        let mut inner = state.lock().unwrap();
        let session = ensure_session(&app, &mut inner)?;
        session.rename(&name).map_err(|e| e.to_string())?;
        let root = session.root.to_string_lossy().to_string();
        if let Some(ex) = inner.last_export.as_mut() {
            ex.root = root;
        }
        inner.dirty = true;
        inner.finished = false;
    }
    let _ = app.emit("session-changed", ());
    Ok(())
}

#[tauri::command]
async fn new_bundle(app: AppHandle) -> Result<(), String> {
    do_new_bundle(&app)
}

#[tauri::command]
fn list_bundles(app: AppHandle) -> Vec<BundleInfo> {
    Session::list(&base_dir(&app))
}

#[tauri::command]
async fn open_bundle(app: AppHandle, path: String) -> Result<(), String> {
    do_open_bundle(&app, &path)
}

#[tauri::command]
fn set_doc_format(app: AppHandle, state: State<Shared>, format: String) -> Result<(), String> {
    let f = DocFormat::parse(&format).ok_or("unknown format")?;
    {
        let mut inner = state.lock().unwrap();
        let session = ensure_session(&app, &mut inner)?;
        session.doc_format = f;
        inner.dirty = true;
        inner.finished = false;
    }
    let _ = app.emit("session-changed", ());
    Ok(())
}

#[tauri::command]
fn set_purpose(app: AppHandle, state: State<Shared>, purpose: String) -> Result<(), String> {
    let p = Purpose::parse(&purpose).ok_or("unknown purpose")?;
    {
        let mut inner = state.lock().unwrap();
        let session = ensure_session(&app, &mut inner)?;
        session.purpose = p;
        inner.dirty = true;
        inner.finished = false;
    }
    let _ = app.emit("session-changed", ());
    Ok(())
}

#[tauri::command]
fn set_shot_note(
    app: AppHandle,
    state: State<Shared>,
    group: usize,
    shot: String,
    note: String,
    title: String,
) {
    {
        let mut inner = state.lock().unwrap();
        if let Some(session) = inner.session.as_mut() {
            if let Some(s) = session.shot_mut(group, &shot) {
                s.note = note.trim().to_string();
                s.title = title.trim().to_string();
            }
        }
        inner.dirty = true;
        inner.finished = false;
    }
    let _ = app.emit("session-changed", ());
}

#[tauri::command]
fn set_group_note(
    app: AppHandle,
    state: State<Shared>,
    group: usize,
    title: String,
    master_note: String,
) {
    {
        let mut inner = state.lock().unwrap();
        if let Some(session) = inner.session.as_mut() {
            if let Some(g) = session.group_mut(group) {
                g.title = title.trim().to_string();
                g.master_note = master_note.trim().to_string();
            }
        }
        inner.dirty = true;
        inner.finished = false;
    }
    let _ = app.emit("session-changed", ());
}

/// Reorders within a group or moves to another; the folder is laid out to
/// match on the next finish.
#[tauri::command]
fn move_shot(
    app: AppHandle,
    state: State<Shared>,
    group: usize,
    shot: String,
    to_group: usize,
    to_index: usize,
) -> Result<(), String> {
    {
        let mut inner = state.lock().unwrap();
        let session = inner.session.as_mut().ok_or("nothing captured yet")?;
        if !session.move_shot(group, &shot, to_group, to_index) {
            return Err("no such shot or group".into());
        }
        inner.dirty = true;
        inner.finished = false;
    }
    let _ = app.emit("session-changed", ());
    Ok(())
}

// ------------------------------------------------------------- markup

#[derive(Clone, Serialize)]
struct Markup {
    /// The untouched image to draw over: the .orig.png if an edit was saved
    /// before, else the file itself.
    original: String,
    marks: serde_json::Value,
}

/// Opens the markup editor on a PNG (a shot or a recording's still).
#[tauri::command]
async fn edit_shot(app: AppHandle, path: String, label: String) -> Result<(), String> {
    let (w, h) = image::image_dimensions(&path).map_err(|e| e.to_string())?;
    overlay::open_editor(&app, &path, &label, w, h).map_err(|e| e.to_string())
}

/// Opens the editor on a shot in review mode: markup plus note, with
/// arrows to walk the rest of the bundle.
#[tauri::command]
async fn review_shot(app: AppHandle, state: State<'_, Shared>, group: usize, shot: String) -> Result<(), String> {
    let path = {
        let inner = state.lock().unwrap();
        let session = inner.session.as_ref().ok_or("nothing captured yet")?;
        session
            .groups
            .iter()
            .find(|g| g.index == group)
            .and_then(|g| g.shots.iter().find(|s| s.id == shot))
            .map(|s| s.abs_path.clone())
            .ok_or("no such shot")?
    };
    let (w, h) = image::image_dimensions(&path).map_err(|e| e.to_string())?;
    overlay::open_review(&app, group, &shot, w, h).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_markup(path: String) -> Result<Markup, String> {
    let png = std::path::Path::new(&path);
    if !png.exists() {
        return Err("that image is gone".into());
    }
    let [orig, marks, _] = model::sidecars(png);
    let original = if orig.exists() { orig } else { png.to_path_buf() };
    let marks = std::fs::read_to_string(marks)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
    Ok(Markup {
        original: original.to_string_lossy().to_string(),
        marks,
    })
}

/// Writes the annotated PNG over the file, keeping the untouched original
/// and the marks beside it so the edit can be reopened.
#[tauri::command]
async fn save_markup(
    app: AppHandle,
    path: String,
    png_base64: String,
    marks: String,
) -> Result<(), String> {
    use base64::Engine as _;
    let png = std::path::Path::new(&path);
    let [orig, marks_path, _] = model::sidecars(png);
    if !orig.exists() {
        std::fs::copy(png, &orig).map_err(|e| e.to_string())?;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    std::fs::write(png, bytes).map_err(|e| e.to_string())?;
    std::fs::write(&marks_path, &marks).map_err(|e| e.to_string())?;

    // If this is a recording's still and its click mark was moved (or
    // removed), the "click at x,y" in bundle.md follows.
    let click = serde_json::from_str::<serde_json::Value>(&marks)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .and_then(|items| {
            items
                .iter()
                .find(|m| m.get("kind").and_then(|k| k.as_str()) == Some("click"))
                .and_then(|m| {
                    Some((
                        m.get("x")?.as_f64()?.round() as u32,
                        m.get("y")?.as_f64()?.round() as u32,
                    ))
                })
        });
    {
        let state: State<Shared> = app.state();
        let mut inner = state.lock().unwrap();
        if let Some(session) = inner.session.as_mut() {
            'find: for g in &mut session.groups {
                for shot in &mut g.shots {
                    let dir = std::path::Path::new(&shot.abs_path)
                        .parent()
                        .map(std::path::Path::to_path_buf)
                        .unwrap_or_default();
                    if std::path::Path::new(&shot.abs_path) == png {
                        if let Some(m) = shot.moment.as_mut() {
                            m.x = click.map(|c| c.0);
                            m.y = click.map(|c| c.1);
                        }
                        break 'find;
                    }
                    for f in &mut shot.frames {
                        if dir.join(&f.file) == png {
                            f.x = click.map(|c| c.0);
                            f.y = click.map(|c| c.1);
                            break 'find;
                        }
                    }
                }
            }
        }
        inner.dirty = true;
        inner.finished = false;
    }
    let _ = app.emit("markup-saved", path);
    let _ = app.emit("session-changed", ());
    Ok(())
}

/// The file behind the note box that is open right now: a quick shot, or
/// the bundle shot waiting for its note.
fn pending_path(inner: &Inner) -> Option<String> {
    if let Some(p) = &inner.quick_pending {
        return Some(p.to_string_lossy().to_string());
    }
    let (group, id) = inner.pending.as_ref()?;
    let session = inner.session.as_ref()?;
    session
        .groups
        .iter()
        .find(|g| g.index == *group)?
        .shots
        .iter()
        .find(|s| s.id == *id)
        .map(|s| s.abs_path.clone())
}

#[tauri::command]
fn pending_shot_path(state: State<Shared>) -> Option<String> {
    pending_path(&state.lock().unwrap())
}

/// Opens the markup editor on the shot the note box is attached to, while
/// it is fresh. The note box steps aside and comes back when the editor
/// closes.
#[tauri::command]
async fn edit_pending(app: AppHandle, state: State<'_, Shared>) -> Result<(), String> {
    let path = pending_path(&state.lock().unwrap()).ok_or("nothing is waiting for a note")?;
    let (w, h) = image::image_dimensions(&path).map_err(|e| e.to_string())?;
    overlay::open_editor_over_note(&app, &path, "Edit this shot", w, h).map_err(|e| e.to_string())
}

/// Drops one still from a recording so a bad frame never reaches the agent.
#[tauri::command]
fn remove_frame(
    app: AppHandle,
    state: State<Shared>,
    group: usize,
    shot: String,
    file: String,
) -> Result<(), String> {
    {
        let mut inner = state.lock().unwrap();
        let session = inner.session.as_mut().ok_or("nothing captured yet")?;
        if !session.remove_frame(group, &shot, &file) {
            return Err("no such frame".into());
        }
        inner.dirty = true;
        inner.finished = false;
    }
    let _ = app.emit("session-changed", ());
    Ok(())
}

#[tauri::command]
fn delete_shot(app: AppHandle, state: State<Shared>, group: usize, shot: String) {
    {
        let mut inner = state.lock().unwrap();
        if let Some(session) = inner.session.as_mut() {
            session.remove_shot(group, &shot);
        }
        inner.dirty = true;
        inner.finished = false;
    }
    let _ = app.emit("session-changed", ());
}

#[tauri::command]
async fn finish(app: AppHandle, action: String) -> Result<Export, String> {
    do_finish(&app, &action)
}

/// Writes a finished process document from the bundle, no agent involved,
/// and shows it in the file manager. `format` is "html" or "markdown".
#[tauri::command]
async fn export_document(app: AppHandle, state: State<'_, Shared>, format: String) -> Result<String, String> {
    let fmt = DocFormat::parse(&format).ok_or("unknown format")?;
    let path = {
        let mut inner = state.lock().unwrap();
        let session = inner.session.as_mut().ok_or_else(|| "nothing captured yet".to_string())?;
        let p = export::write_document(session, &brand_dir(&app), fmt).map_err(|e| e.to_string())?;
        inner.dirty = false;
        p
    };
    let _ = app.opener().reveal_item_in_dir(&path);
    let _ = app.emit("session-changed", ());
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Where the note box goes: the middle of the monitor the shot came from,
/// so it never sits on top of what was just captured.
fn note_anchor(frame: &Frame, _x: f64, _y: f64, _height: f64) -> (f64, f64) {
    (
        frame.x as f64 + frame.width as f64 / 2.0,
        frame.y as f64 + frame.height as f64 / 2.0,
    )
}

/// The overlay, in quick mode, hands over the region. The shot is written
/// under ~/QACut/Quick on its own and opens in the editor, where Copy, Copy
/// for agent, Add to batch or Discard decides what becomes of it.
#[tauri::command]
async fn commit_quick(
    app: AppHandle,
    state: State<'_, Shared>,
    monitor: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    overlay::close_capture(&app);

    let abs = {
        let mut inner = state.lock().unwrap();
        let (frame, image) = inner
            .frames
            .iter()
            .find(|(f, _)| f.monitor_id == monitor)
            .map(|(f, i)| (f.clone(), i.clone()))
            .ok_or_else(|| "that monitor is no longer frozen".to_string())?;

        let abs = quick_single_path(&app);
        capture::crop_selection(&frame, &image, x, y, width, height, &abs).map_err(|e| e.to_string())?;

        inner.quick_pending = Some(abs.clone());
        inner.frames.clear();
        abs
    };

    capture::clear_scratch();
    let (w, h) = image::image_dimensions(&abs).map_err(|e| e.to_string())?;
    overlay::open_quick_editor(&app, &abs.to_string_lossy(), w, h).map_err(|e| e.to_string())
}

/// The whole batch as one paste: an entry per shot, with a line naming the
/// folder first when there is more than one. Closing the batch is the
/// caller's job.
fn quick_batch_text(dir: &std::path::Path, prompts: &Prompts) -> String {
    let pngs = quick_pngs(dir);
    if pngs.len() == 1 {
        let n = std::fs::read_to_string(pngs[0].with_extension("md")).unwrap_or_default();
        return quick_entry(&pngs[0], &n, prompts);
    }
    let entries = pngs
        .iter()
        .map(|p| {
            let n = std::fs::read_to_string(p.with_extension("md")).unwrap_or_default();
            quick_entry(p, &n, prompts)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    prompts
        .resolved()
        .quick_batch
        .replace("{count}", &pngs.len().to_string())
        .replace("{dir}", &dir.display().to_string())
        .replace("{entries}", &entries)
        .trim()
        .to_string()
}

/// Hotkey and tray: copy the open quick batch for an agent and close it.
/// Does nothing when there is no batch.
fn trigger_quick_finish(app: &AppHandle) {
    let state: State<Shared> = app.state();
    let dir = state.lock().unwrap().quick_batch.take();
    let Some(dir) = dir else {
        eprintln!("qacut: no quick batch to finish");
        return;
    };
    if let Err(e) = app.clipboard().write_text(quick_batch_text(&dir, &Prompts::load(app))) {
        eprintln!("qacut: could not copy the quick batch: {e}");
    }
}

#[tauri::command]
async fn quick_finish(app: AppHandle) {
    trigger_quick_finish(&app);
}

/// One clipboard entry for a quick shot: the path, then the note if any.
fn quick_entry(png: &std::path::Path, note: &str, prompts: &Prompts) -> String {
    prompts
        .resolved()
        .quick_entry
        .replace("{path}", &png.display().to_string())
        .replace("{note}", note.trim())
        .trim()
        .to_string()
}

/// A saved quick prompt wraps the hand-off text: `{shots}` where it says,
/// or appended after it.
fn wrap_quick(app: &AppHandle, text: String, prompt: Option<&str>) -> String {
    match prompt.and_then(|id| Prompts::load(app).saved(id).cloned()) {
        Some(p) if p.template.contains("{shots}") => p.template.replace("{shots}", &text).trim().to_string(),
        Some(p) => format!("{}\n\n{}", p.template.trim(), text),
        None => text,
    }
}

fn quick_note_path(png: &std::path::Path) -> std::path::PathBuf {
    png.with_extension("md")
}

fn read_quick_note(png: &std::path::Path) -> String {
    std::fs::read_to_string(quick_note_path(png)).unwrap_or_default().trim().to_string()
}

/// The note beside a quick shot; an empty note means no file.
fn write_quick_note(png: &std::path::Path, note: &str) -> Result<(), String> {
    let p = quick_note_path(png);
    if note.trim().is_empty() {
        let _ = std::fs::remove_file(p);
        Ok(())
    } else {
        std::fs::write(p, format!("{}\n", note.trim())).map_err(|e| e.to_string())
    }
}

/// The shot, its untouched original, its marks and its note.
fn remove_quick_files(png: &std::path::Path) {
    let [orig, marks, _] = model::sidecars(png);
    for p in [png.to_path_buf(), orig, marks, quick_note_path(png)] {
        let _ = std::fs::remove_file(p);
    }
}

fn move_quick_files(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| e.to_string())?;
    let [orig_a, marks_a, _] = model::sidecars(from);
    let [orig_b, marks_b, _] = model::sidecars(to);
    for (a, b) in [(orig_a, orig_b), (marks_a, marks_b), (quick_note_path(from), quick_note_path(to))] {
        if a.exists() {
            let _ = std::fs::rename(a, b);
        }
    }
    Ok(())
}

/// notes.md: the batch's index, rebuilt from what the folder holds.
fn write_batch_index(dir: &std::path::Path) {
    let mut body = format!("# Quick batch {}\n", dir.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default());
    for p in quick_pngs(dir) {
        let name = p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
        let note = read_quick_note(&p);
        body.push_str(&format!("\n## {name}\n\n{}\n", if note.is_empty() { "(no note)" } else { note.as_str() }));
    }
    let _ = std::fs::write(dir.join("notes.md"), body);
}

#[derive(Serialize)]
struct QuickShotInfo {
    path: String,
    name: String,
    note: String,
}

#[derive(Serialize)]
struct QuickBatchInfo {
    dir: Option<String>,
    shots: Vec<QuickShotInfo>,
}

fn batch_info(inner: &Inner) -> QuickBatchInfo {
    match &inner.quick_batch {
        Some(d) if d.is_dir() => QuickBatchInfo {
            dir: Some(d.to_string_lossy().to_string()),
            shots: quick_pngs(d)
                .into_iter()
                .map(|p| QuickShotInfo {
                    name: p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
                    note: read_quick_note(&p),
                    path: p.to_string_lossy().to_string(),
                })
                .collect(),
        },
        _ => QuickBatchInfo { dir: None, shots: vec![] },
    }
}

fn in_batch(inner: &Inner, png: &std::path::Path) -> bool {
    matches!(&inner.quick_batch, Some(d) if png.parent() == Some(d.as_path()))
}

/// The shot is no longer waiting for a decision.
fn settle_quick(inner: &mut Inner, png: &std::path::Path) {
    if inner.quick_pending.as_deref() == Some(png) {
        inner.quick_pending = None;
    }
}

/// Copy, for a person: the marked-up picture, with the note printed under
/// it when there is one, and nothing else on the clipboard (a chat pastes
/// text in preference to an image). The shot stays on disk as it is.
#[tauri::command]
async fn quick_copy(
    app: AppHandle,
    state: State<'_, Shared>,
    path: String,
    note: String,
    png_base64: String,
) -> Result<(), String> {
    use base64::Engine as _;
    let p = std::path::PathBuf::from(&path);
    write_quick_note(&p, &note)?;
    let png = base64::engine::general_purpose::STANDARD.decode(png_base64).map_err(|e| e.to_string())?;
    set_clipboard("", Some(&png))?;
    {
        let mut inner = state.lock().unwrap();
        if in_batch(&inner, &p) {
            if let Some(d) = inner.quick_batch.clone() {
                write_batch_index(&d);
            }
        }
        settle_quick(&mut inner, &p);
    }
    overlay::close_note(&app);
    Ok(())
}

/// Copy for agent: the path and the note as text, wrapped in a saved
/// prompt if one was picked.
#[tauri::command]
async fn quick_copy_agent(
    app: AppHandle,
    state: State<'_, Shared>,
    path: String,
    note: String,
    prompt: Option<String>,
) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    write_quick_note(&p, &note)?;
    let text = wrap_quick(&app, quick_entry(&p, &note, &Prompts::load(&app)), prompt.as_deref());
    set_clipboard(&text, None)?;
    {
        let mut inner = state.lock().unwrap();
        if in_batch(&inner, &p) {
            if let Some(d) = inner.quick_batch.clone() {
                write_batch_index(&d);
            }
        }
        settle_quick(&mut inner, &p);
    }
    overlay::close_note(&app);
    Ok(text)
}

/// Add to batch: the shot moves into the open batch folder (started if
/// there is none) as the next NN.png. For a shot already in the batch this
/// just saves its note.
#[tauri::command]
fn quick_add_to_batch(app: AppHandle, state: State<Shared>, path: String, note: String) -> Result<QuickBatchInfo, String> {
    let mut inner = state.lock().unwrap();
    let p = std::path::PathBuf::from(&path);
    let dest = if in_batch(&inner, &p) {
        p.clone()
    } else {
        let dir = quick_batch_dir(&app, &mut inner);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let d = dir.join(format!("{:02}.png", quick_next(&dir)));
        move_quick_files(&p, &d)?;
        d
    };
    write_quick_note(&dest, &note)?;
    if let Some(d) = inner.quick_batch.clone() {
        write_batch_index(&d);
    }
    settle_quick(&mut inner, &p);
    Ok(batch_info(&inner))
}

#[tauri::command]
fn quick_batch(state: State<Shared>) -> QuickBatchInfo {
    batch_info(&state.lock().unwrap())
}

#[tauri::command]
fn quick_note(path: String) -> String {
    read_quick_note(std::path::Path::new(&path))
}

/// Drops one shot from the batch; an emptied batch is closed and its
/// folder removed.
#[tauri::command]
fn quick_batch_remove(state: State<Shared>, path: String) -> QuickBatchInfo {
    let mut inner = state.lock().unwrap();
    let p = std::path::PathBuf::from(&path);
    remove_quick_files(&p);
    settle_quick(&mut inner, &p);
    if let Some(d) = inner.quick_batch.clone() {
        if quick_pngs(&d).is_empty() {
            let _ = std::fs::remove_dir_all(&d);
            inner.quick_batch = None;
        } else {
            write_batch_index(&d);
        }
    }
    batch_info(&inner)
}

#[tauri::command]
fn quick_batch_discard(state: State<Shared>) {
    let mut inner = state.lock().unwrap();
    if let Some(d) = inner.quick_batch.take() {
        let _ = std::fs::remove_dir_all(&d);
    }
    if let Some(p) = inner.quick_pending.clone() {
        if !p.exists() {
            inner.quick_pending = None;
        }
    }
}

/// Copy batch for agent: every shot's path and note in one paste, then the
/// batch closes so the next Add to batch starts a fresh one.
#[tauri::command]
async fn quick_batch_copy_agent(app: AppHandle, state: State<'_, Shared>, prompt: Option<String>) -> Result<String, String> {
    let dir = state.lock().unwrap().quick_batch.take().ok_or("no batch is open")?;
    let text = wrap_quick(&app, quick_batch_text(&dir, &Prompts::load(&app)), prompt.as_deref());
    set_clipboard(&text, None)?;
    Ok(text)
}

/// A picture alone on the clipboard, from the editor's canvas.
#[tauri::command]
fn copy_png(png_base64: String) -> Result<(), String> {
    use base64::Engine as _;
    let png = base64::engine::general_purpose::STANDARD.decode(png_base64).map_err(|e| e.to_string())?;
    set_clipboard("", Some(&png))
}

/// Throws the shot away: the file, its original, its marks and its note.
#[tauri::command]
async fn discard_quick(app: AppHandle, state: State<'_, Shared>, path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    remove_quick_files(&p);
    {
        let mut inner = state.lock().unwrap();
        settle_quick(&mut inner, &p);
        if in_batch(&inner, &p) {
            if let Some(d) = inner.quick_batch.clone() {
                write_batch_index(&d);
            }
        }
    }
    overlay::close_note(&app);
    Ok(())
}

/// Puts a PNG on the clipboard as an image, so a marked-up quick shot can
/// be pasted straight into a chat or an email.
/// Text and, when given, an image on the clipboard at once, so a terminal
/// pastes the text and a chat pastes the picture. CF_DIB is what Office and
/// Paint read; the registered PNG format is what browsers, Teams and Slack
/// prefer, and it keeps the exact pixels.
fn set_clipboard(text: &str, png: Option<&[u8]>) -> Result<(), String> {
    use clipboard_win::{formats, Clipboard, Setter};
    let _open = Clipboard::new_attempts(10).map_err(|e| e.to_string())?;
    clipboard_win::empty().map_err(|e| e.to_string())?;
    if !text.is_empty() {
        formats::Unicode.write_clipboard(&text).map_err(|e| e.to_string())?;
    }
    if let Some(png) = png {
        // The crate's image setters clear the clipboard first, which would
        // drop the text; the raw non-clearing writes keep every format.
        // A CF_DIB is a BMP file without its 14-byte file header.
        let rgb = image::load_from_memory(png).map_err(|e| e.to_string())?.to_rgb8();
        let mut bmp = std::io::Cursor::new(Vec::new());
        rgb.write_to(&mut bmp, image::ImageFormat::Bmp).map_err(|e| e.to_string())?;
        let bmp = bmp.into_inner();
        clipboard_win::raw::set_without_clear(formats::CF_DIB, &bmp[14..]).map_err(|e| e.to_string())?;
        if let Some(id) = clipboard_win::register_format("PNG") {
            clipboard_win::raw::set_without_clear(id.get(), png).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn copy_image(app: AppHandle, path: String) -> Result<(), String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let img = tauri::image::Image::from_bytes(&bytes).map_err(|e| e.to_string())?;
    app.clipboard().write_image(&img).map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_quick(app: AppHandle) {
    trigger_quick(&app);
}

#[tauri::command]
async fn start_capture(app: AppHandle) {
    trigger_capture(&app);
}

#[tauri::command]
async fn start_group(app: AppHandle) {
    trigger_group(&app);
}

#[tauri::command]
async fn start_record(app: AppHandle) {
    trigger_record(&app);
}

#[tauri::command]
fn open_base_folder(app: AppHandle) -> Result<(), String> {
    let dir = base_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Same as the tray's Quit: let a running recording finish its file first.
#[tauri::command]
async fn quit(app: AppHandle) {
    let state: State<Shared> = app.state();
    let (rec, st) = {
        let mut inner = state.lock().unwrap();
        (inner.recording.take(), inner.studio.take())
    };
    if let Some((rec, _, _)) = rec {
        let _ = rec.stop();
    }
    if let Some(active) = st {
        if let Ok(f) = active.stop() {
            let _ = f.finalize();
        }
    }
    capture::clear_scratch();
    app.exit(0);
}

// ------------------------------------------------------------------- boot

fn main() {
    tauri::Builder::default()
        .manage(Shared::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let pressed = shortcut.to_string();
                    let state: State<Shared> = app.state();
                    let action = state
                        .lock()
                        .unwrap()
                        .hotkeys
                        .iter()
                        .find(|(spec, _)| *spec == pressed)
                        .map(|(_, a)| *a);
                    if let Some(a) = action {
                        off_main(app, a);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            frame_for,
            commit_selection,
            commit_quick,
            quick_copy,
            quick_copy_agent,
            quick_add_to_batch,
            quick_batch,
            quick_note,
            quick_batch_remove,
            quick_batch_discard,
            quick_batch_copy_agent,
            copy_png,
            discard_quick,
            start_quick,
            quick_finish,
            copy_image,
            start_recording,
            stop_recording,
            start_studio,
            start_studio_from_menu,
            camera_started,
            append_camera,
            camera_stopped,
            list_studio_projects,
            load_studio_project,
            save_studio_edits,
            open_studio,
            export_open,
            export_write,
            export_close,
            export_abort,
            reveal_path,
            list_brand_images,
            pick_brand_image,
            get_studio_settings,
            set_studio_settings,
            get_hotkeys,
            set_hotkeys,
            get_prompts,
            set_prompts,
            set_saved_prompt,
            open_prompt_library,
            log_error,
            cancel_capture,
            save_note,
            discard_pending,
            pending_shot_path,
            edit_pending,
            review_shot,
            close_group,
            get_session,
            get_state,
            set_current_group,
            rename_bundle,
            new_bundle,
            list_bundles,
            open_bundle,
            set_purpose,
            set_doc_format,
            set_custom_prompt,
            set_brand_notes,
            set_include_brand,
            open_brand_folder,
            set_shot_note,
            set_group_note,
            delete_shot,
            move_shot,
            edit_shot,
            load_markup,
            save_markup,
            remove_frame,
            finish,
            export_document,
            copy_text,
            open_path,
            start_capture,
            start_group,
            start_record,
            open_base_folder,
            quit,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = studio::settings::Settings::load(&base_dir(&handle));
            apply_hotkeys(&handle, &settings.hotkeys);
            // Dev only: drive the app from request files to make screenshots.
            if let Ok(dir) = std::env::var("QACUT_DRIVE_DIR") {
                drive::start(handle.clone(), std::path::PathBuf::from(dir));
            }
            let menu = build_tray_menu(&handle)?;
            // A quiet look for a newer release once the app has settled.
            if !cfg!(debug_assertions) {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(20));
                    check_for_updates(&h, true);
                });
            }

            // A trimmed copy of the mark rather than the app icon, whose
            // margins cost a third of the glyph at menubar size.
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .tooltip("QACut")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quick" => off_main(app, trigger_quick),
                    "quick_finish" => off_main(app, trigger_quick_finish),
                    "capture" => off_main(app, trigger_capture),
                    "record" => off_main(app, trigger_record),
                    "studio" => off_main(app, trigger_studio),
                    "open_studio" => off_main(app, trigger_open_studio),
                    "zoom" => off_main(app, trigger_zoom_mark),
                    "st_keys" | "st_mic" | "st_cam" => {
                        // Flip the setting and rebuild the menu from it.
                        let mut s = studio::settings::Settings::load(&base_dir(app));
                        match event.id().as_ref() {
                            "st_keys" => s.keystrokes = !s.keystrokes,
                            "st_mic" => s.mic = !s.mic,
                            _ => s.camera = !s.camera,
                        }
                        if let Err(e) = s.save(&base_dir(app)) {
                            eprintln!("qacut: could not save settings: {e}");
                        }
                        refresh_tray_menu(app);
                    }
                    "shortcuts" => off_main(app, trigger_shortcuts),
                    "prompts" => off_main(app, trigger_prompts),
                    "update" => check_for_updates(app, false),
                    "group" => off_main(app, trigger_group),
                    "peek" => off_main(app, trigger_peek),
                    "finish" => off_main(app, trigger_finish),
                    "folder" => {
                        let dir = base_dir(app);
                        let _ = std::fs::create_dir_all(&dir);
                        let _ = app.opener().open_path(dir.to_string_lossy().to_string(), None::<&str>);
                    }
                    "studio_folder" => {
                        let dir = studio::project::studio_dir(&base_dir(app));
                        let _ = std::fs::create_dir_all(&dir);
                        let _ = app.opener().open_path(dir.to_string_lossy().to_string(), None::<&str>);
                    }
                    "quit" => {
                        // Let a running recording write its trailer first.
                        let state: State<Shared> = app.state();
                        let (rec, st) = {
                            let mut inner = state.lock().unwrap();
                            (inner.recording.take(), inner.studio.take())
                        };
                        if let Some((rec, _, _)) = rec {
                            let _ = rec.stop();
                        }
                        if let Some(active) = st {
                            if let Ok(f) = active.stop() {
                                let _ = f.finalize();
                            }
                        }
                        capture::clear_scratch();
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // The brand folder exists from the start so there is somewhere
            // obvious to drop files before the first bundle window opens.
            let _ = std::fs::create_dir_all(brand_dir(&handle));

            // No visible window on launch. The tray is the app.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start QACut")
        .run(|_app, event| {
            // `code` is None when the last window closed and Some when Quit
            // (or a restart) asked for it. Only the former should be swallowed;
            // the tray is the app, so closing overlays must not end it.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_prompt_fills_placeholders_and_always_names_the_folder() {
        let filled = fill_custom_prompt("Review {name} at {root}.", "C:/b", "Sprint 4", Target::Cli);
        assert_eq!(filled, "Review Sprint 4 at C:/b.");

        let appended = fill_custom_prompt("Fix everything you see.", "C:/b", "x", Target::Cli);
        assert!(appended.starts_with("Fix everything you see."));
        assert!(appended.ends_with("The bundle is at C:/b. Start with bundle.md."));

        assert_eq!(
            fill_custom_prompt("", "C:/b", "x", Target::Cli),
            "The bundle is at C:/b. Start with bundle.md."
        );

        // For chat the path is never mentioned; the upload is.
        let chat = fill_custom_prompt("Look at {root}.", "C:/b", "x", Target::Chat);
        assert_eq!(chat, "Look at the attached ZIP.");
        let chat = fill_custom_prompt("Go.", "C:/b", "x", Target::Chat);
        assert!(chat.ends_with("The bundle is the attached ZIP. Unzip it and start with bundle.md."));
    }

    #[test]
    fn built_in_prompts_switch_between_folder_and_zip() {
        let cli = agent_prompt("C:/b", "n", Purpose::Fix, DocFormat::Markdown, "", false, Target::Cli, &Prompts::default());
        assert!(cli.starts_with("Work through the QA bundle at C:/b. "));
        let chat = agent_prompt("C:/b", "n", Purpose::Fix, DocFormat::Markdown, "", true, Target::Chat, &Prompts::default());
        assert!(chat.starts_with("Work through the QA bundle in the attached ZIP. Unzip it first. "));
        assert!(!chat.contains("C:/b"));
        assert!(chat.ends_with("match them in anything you produce."));
        let doc = agent_prompt("C:/b", "n", Purpose::Document, DocFormat::Markdown, "", false, Target::Chat, &Prompts::default());
        assert!(doc.starts_with("Using the QA bundle in the attached ZIP. Unzip it first. write a step-by-step"));
        assert!(doc.contains("process.md"));
        let page = agent_prompt("C:/b", "n", Purpose::Document, DocFormat::Html, "", false, Target::Cli, &Prompts::default());
        assert!(page.contains("process.html"));
        assert!(page.contains("one step per screenshot"));
        assert!(!page.contains("<video>"));
        // An override wins, and its placeholders are filled.
        let mine = Prompts { fix: "Fix {name} at {location}.".into(), ..Default::default() };
        let cli = agent_prompt("C:/b", "n", Purpose::Fix, DocFormat::Markdown, "", false, Target::Cli, &mine);
        assert_eq!(cli, "Fix n at the QA bundle at C:/b.");
        let p = Prompts { quick_entry: "See {path}: {note}".into(), ..Default::default() };
        assert_eq!(quick_entry(std::path::Path::new("C:/q/01.png"), " clipped ", &p), "See C:/q/01.png: clipped");
        assert_eq!(quick_entry(std::path::Path::new("C:/q/01.png"), "", &Prompts::default()), "C:/q/01.png");
    }
}

