//! Input and context events recorded beside a source, on the same clock as
//! its frames (QueryPerformanceCounter, which is what Windows.Graphics.Capture
//! stamps frames with). The studio draws the cursor, click effects and
//! keystroke badges from these and proposes zooms from them.

use anyhow::Result;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use super::project::Rect;

/// Cursor sampling period. 120 Hz is enough to smooth from.
const CURSOR_POLL: Duration = Duration::from_millis(8);
/// How often the foreground window title is checked.
const WINDOW_EVERY: u32 = 12; // polls, so ~100 ms

/// The clock frames are stamped with, in 100 ns units.
pub fn now_100ns() -> i64 {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Performance::{
            QueryPerformanceCounter, QueryPerformanceFrequency,
        };
        let mut c = 0i64;
        let mut f = 0i64;
        QueryPerformanceCounter(&mut c);
        QueryPerformanceFrequency(&mut f);
        if f > 0 {
            return ((c as i128) * 10_000_000 / (f as i128)) as i64;
        }
        0
    }
    #[cfg(not(windows))]
    {
        0
    }
}

/// (t, "start" or "end", cursor x, cursor y) in screen coordinates.
pub type ZoomMark = (i64, &'static str, i32, i32);

#[derive(Clone, Debug, Serialize)]
pub struct KeyEvent {
    pub t: i64,
    pub vk: u32,
    pub key: String,
    pub down: bool,
    pub mods: String,
}

/// Everything recorded, with absolute timestamps and screen coordinates.
#[derive(Default)]
pub struct Events {
    pub cursor: Vec<(i64, i32, i32)>,
    pub shapes: Vec<(i64, String)>,
    pub buttons: Vec<(i64, &'static str, &'static str, i32, i32)>,
    pub keys: Vec<KeyEvent>,
    pub windows: Vec<(i64, String)>,
    /// Zoom marks the operator made with the hotkey: (t, "start" or "end",
    /// cursor x, cursor y in screen coordinates).
    pub zooms: Vec<ZoomMark>,
}

/// The written form: times in milliseconds from the first frame, positions
/// in physical pixels relative to the monitor.
#[derive(Serialize)]
pub struct EventsOut {
    pub version: u32,
    pub clock: &'static str,
    pub cursor: Vec<(f64, i32, i32)>,
    pub shapes: Vec<(f64, String)>,
    pub buttons: Vec<(f64, &'static str, &'static str, i32, i32)>,
    pub keys: Vec<KeyOut>,
    pub windows: Vec<(f64, String)>,
    pub zooms: Vec<(f64, &'static str, i32, i32)>,
}

#[derive(Serialize)]
pub struct KeyOut {
    pub t: f64,
    pub key: String,
    pub down: bool,
    pub mods: String,
}

impl Events {
    pub fn relative_to(self, first_ts: i64, monitor: &Rect) -> EventsOut {
        let ms = |t: i64| ((t - first_ts) as f64 / 10_000.0 * 10.0).round() / 10.0;
        EventsOut {
            version: 1,
            clock: "ms since first source frame",
            cursor: self
                .cursor
                .into_iter()
                .map(|(t, x, y)| (ms(t), x - monitor.x, y - monitor.y))
                .collect(),
            shapes: self.shapes.into_iter().map(|(t, s)| (ms(t), s)).collect(),
            buttons: self
                .buttons
                .into_iter()
                .map(|(t, b, a, x, y)| (ms(t), b, a, x - monitor.x, y - monitor.y))
                .collect(),
            keys: self
                .keys
                .into_iter()
                .map(|k| KeyOut {
                    t: ms(k.t),
                    key: k.key,
                    down: k.down,
                    mods: k.mods,
                })
                .collect(),
            windows: self.windows.into_iter().map(|(t, w)| (ms(t), w)).collect(),
            zooms: self
                .zooms
                .into_iter()
                .map(|(t, a, x, y)| (ms(t), a, x - monitor.x, y - monitor.y))
                .collect(),
        }
    }
}

pub struct EventRecorder {
    stop: Arc<AtomicBool>,
    poll: JoinHandle<Events>,
    hook: Option<hook::HookThread>,
    zooms: Arc<Mutex<Vec<ZoomMark>>>,
    zoomed: bool,
}

impl EventRecorder {
    pub fn start(keystrokes: bool) -> Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let poll = std::thread::spawn(move || poll_loop(flag));
        let hook = if keystrokes { hook::HookThread::start()? } else { None };
        Ok(EventRecorder {
            stop,
            poll,
            hook,
            zooms: Arc::new(Mutex::new(Vec::new())),
            zoomed: false,
        })
    }

    /// The zoom hotkey: alternates "zoom in here" and "zoom out", at the
    /// cursor's position now. Returns whether a zoom is now in progress.
    pub fn mark_zoom(&mut self) -> bool {
        let (x, y) = cursor_pos();
        self.zoomed = !self.zoomed;
        let action = if self.zoomed { "start" } else { "end" };
        self.zooms.lock().unwrap().push((now_100ns(), action, x, y));
        self.zoomed
    }

    pub fn stop(self) -> Events {
        self.stop.store(true, Ordering::SeqCst);
        let mut events = self.poll.join().unwrap_or_default();
        if let Some(h) = self.hook {
            events.keys = h.stop();
        }
        events.zooms = std::mem::take(&mut *self.zooms.lock().unwrap());
        events
    }
}

#[cfg(windows)]
fn cursor_pos() -> (i32, i32) {
    let mut p = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
    if unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p) } != 0 {
        (p.x, p.y)
    } else {
        (0, 0)
    }
}

#[cfg(not(windows))]
fn cursor_pos() -> (i32, i32) {
    (0, 0)
}

#[cfg(windows)]
fn poll_loop(stop: Arc<AtomicBool>) -> Events {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorInfo, GetCursorPos, GetForegroundWindow, GetWindowTextW, CURSORINFO,
    };

    let mut ev = Events::default();
    let shapes = cursors::table();
    let mut last_pos: Option<(i32, i32)> = None;
    let mut last_shape = String::new();
    // None until the first sample, so the window the recording started on
        // is always logged, even one with no title.
        let mut last_title: Option<String> = None;
    let mut buttons = [false; 3];
    let mut tick: u32 = 0;
    let mut since_sample = 0u32;

    while !stop.load(Ordering::SeqCst) {
        let t = now_100ns();
        let mut p = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
        let (x, y) = if unsafe { GetCursorPos(&mut p) } != 0 {
            (p.x, p.y)
        } else {
            last_pos.unwrap_or((0, 0))
        };
        // Sample on movement, and at least every 100 ms so a still cursor
        // still has a position at every moment.
        since_sample += 1;
        if last_pos != Some((x, y)) || since_sample >= WINDOW_EVERY {
            ev.cursor.push((t, x, y));
            last_pos = Some((x, y));
            since_sample = 0;
        }

        let mut info: CURSORINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<CURSORINFO>() as u32;
        if unsafe { GetCursorInfo(&mut info) } != 0 {
            let name = if info.flags == 0 {
                "hidden"
            } else {
                shapes
                    .iter()
                    .find(|(h, _)| *h == info.hCursor as isize)
                    .map(|(_, n)| *n)
                    .unwrap_or("other")
            };
            if name != last_shape {
                ev.shapes.push((t, name.to_string()));
                last_shape = name.to_string();
            }
        }

        for (i, (vk, name)) in [(VK_LBUTTON, "left"), (VK_RBUTTON, "right"), (VK_MBUTTON, "middle")]
            .iter()
            .enumerate()
        {
            let down = unsafe { GetAsyncKeyState(*vk as i32) } as u16 & 0x8000 != 0;
            if down != buttons[i] {
                ev.buttons.push((t, name, if down { "down" } else { "up" }, x, y));
                buttons[i] = down;
            }
        }

        tick += 1;
        if tick % WINDOW_EVERY == 0 {
            let hwnd = unsafe { GetForegroundWindow() };
            if !hwnd.is_null() {
                let mut buf = [0u16; 256];
                let n = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
                let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
                if last_title.as_deref() != Some(title.as_str()) {
                    ev.windows.push((t, title.clone()));
                    last_title = Some(title);
                }
            }
        }

        std::thread::sleep(CURSOR_POLL);
    }
    ev
}

#[cfg(not(windows))]
fn poll_loop(stop: Arc<AtomicBool>) -> Events {
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(CURSOR_POLL);
    }
    Events::default()
}

#[cfg(windows)]
mod cursors {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    /// System cursor handles are stable for the life of the process, so
    /// the table is built once and compared by handle.
    pub fn table() -> Vec<(isize, &'static str)> {
        let ids: [(*const u16, &str); 13] = [
            (IDC_ARROW, "arrow"),
            (IDC_IBEAM, "text"),
            (IDC_HAND, "hand"),
            (IDC_WAIT, "wait"),
            (IDC_APPSTARTING, "busy"),
            (IDC_CROSS, "cross"),
            (IDC_NO, "no"),
            (IDC_SIZEALL, "move"),
            (IDC_SIZENS, "resize-ns"),
            (IDC_SIZEWE, "resize-we"),
            (IDC_SIZENWSE, "resize-nwse"),
            (IDC_SIZENESW, "resize-nesw"),
            (IDC_UPARROW, "up"),
        ];
        ids.iter()
            .filter_map(|(id, name)| {
                let h = unsafe { LoadCursorW(std::ptr::null_mut(), *id) };
                (!h.is_null()).then_some((h as isize, *name))
            })
            .collect()
    }
}

/// Names for virtual keys, as a keystroke badge would show them.
pub fn key_name(vk: u32) -> String {
    match vk {
        0x30..=0x39 | 0x41..=0x5A => (vk as u8 as char).to_string(),
        0x70..=0x87 => format!("F{}", vk - 0x6F),
        0x60..=0x69 => format!("Num{}", vk - 0x60),
        0x0D => "Enter".into(),
        0x1B => "Esc".into(),
        0x09 => "Tab".into(),
        0x20 => "Space".into(),
        0x08 => "Backspace".into(),
        0x2E => "Delete".into(),
        0x2D => "Insert".into(),
        0x24 => "Home".into(),
        0x23 => "End".into(),
        0x21 => "PageUp".into(),
        0x22 => "PageDown".into(),
        0x25 => "Left".into(),
        0x26 => "Up".into(),
        0x27 => "Right".into(),
        0x28 => "Down".into(),
        0x10 | 0xA0 | 0xA1 => "Shift".into(),
        0x11 | 0xA2 | 0xA3 => "Ctrl".into(),
        0x12 | 0xA4 | 0xA5 => "Alt".into(),
        0x5B | 0x5C => "Win".into(),
        0x14 => "CapsLock".into(),
        0x2C => "PrintScreen".into(),
        0xBA => ";".into(),
        0xBB => "=".into(),
        0xBC => ",".into(),
        0xBD => "-".into(),
        0xBE => ".".into(),
        0xBF => "/".into(),
        0xC0 => "`".into(),
        0xDB => "[".into(),
        0xDC => "\\".into(),
        0xDD => "]".into(),
        0xDE => "'".into(),
        _ => format!("VK{vk}"),
    }
}

#[cfg(windows)]
mod hook {
    use super::*;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    static TX: Mutex<Option<mpsc::Sender<KeyEvent>>> = Mutex::new(None);
    /// Keys currently held, so auto-repeat (a stream of key-down messages
    /// while a key stays pressed) is recorded once, as one press.
    static HELD: Mutex<Vec<u32>> = Mutex::new(Vec::new());

    unsafe extern "system" fn hook_proc(code: i32, wparam: usize, lparam: isize) -> isize {
        if code >= 0 {
            let msg = wparam as u32;
            let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if down || up {
                let k = &*(lparam as *const KBDLLHOOKSTRUCT);
                // Injected keys are QACut's own or another tool's; skip.
                let repeat = {
                    let mut held = HELD.lock().unwrap();
                    let was = held.contains(&k.vkCode);
                    if down && !was {
                        held.push(k.vkCode);
                    } else if up {
                        held.retain(|v| *v != k.vkCode);
                    }
                    down && was
                };
                if k.flags & 0x10 == 0 && !repeat {
                    let is_down = |vk: i32| GetAsyncKeyState(vk) as u16 & 0x8000 != 0;
                    let mut mods = Vec::new();
                    if is_down(0x11) { mods.push("Ctrl"); }
                    if is_down(0x10) { mods.push("Shift"); }
                    if is_down(0x12) { mods.push("Alt"); }
                    if is_down(0x5B) || is_down(0x5C) { mods.push("Win"); }
                    let ev = KeyEvent {
                        t: now_100ns(),
                        vk: k.vkCode,
                        key: key_name(k.vkCode),
                        down,
                        mods: mods.join("+"),
                    };
                    if let Some(tx) = TX.lock().unwrap().as_ref() {
                        let _ = tx.send(ev);
                    }
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    pub struct HookThread {
        thread_id: u32,
        handle: JoinHandle<()>,
        rx: mpsc::Receiver<KeyEvent>,
    }

    impl HookThread {
        pub fn start() -> Result<Option<Self>> {
            let (tx, rx) = mpsc::channel();
            *TX.lock().unwrap() = Some(tx);
            let (ready_tx, ready_rx) = mpsc::channel::<u32>();
            let handle = std::thread::spawn(move || unsafe {
                let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), std::ptr::null_mut(), 0);
                if hook.is_null() {
                    let _ = ready_tx.send(0);
                    return;
                }
                let _ = ready_tx.send(windows_sys::Win32::System::Threading::GetCurrentThreadId());
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                UnhookWindowsHookEx(hook);
            });
            let thread_id = ready_rx.recv().unwrap_or(0);
            if thread_id == 0 {
                *TX.lock().unwrap() = None;
                eprintln!("qacut: keyboard hook could not be installed; keystrokes not recorded");
                return Ok(None);
            }
            Ok(Some(HookThread { thread_id, handle, rx }))
        }

        pub fn stop(self) -> Vec<KeyEvent> {
            unsafe {
                PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
            }
            let _ = self.handle.join();
            *TX.lock().unwrap() = None;
            HELD.lock().unwrap().clear();
            self.rx.try_iter().collect()
        }
    }
}

#[cfg(not(windows))]
mod hook {
    use super::*;
    pub struct HookThread;
    impl HookThread {
        pub fn start() -> Result<Option<Self>> {
            Ok(None)
        }
        pub fn stop(self) -> Vec<KeyEvent> {
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_become_milliseconds_from_the_first_frame() {
        let mut ev = Events::default();
        ev.cursor.push((1_000_000, 1930, 210)); // 0.1 s before the first frame
        ev.cursor.push((2_000_000, 1940, 220));
        ev.buttons.push((2_500_000, "left", "down", 1940, 220));
        ev.zooms.push((3_000_000, "start", 2000, 300));
        let out = ev.relative_to(2_000_000, &Rect { x: 1920, y: 0, width: 1920, height: 1200 });
        assert_eq!(out.zooms[0], (100.0, "start", 80, 300));
        assert_eq!(out.cursor[0], (-100.0, 10, 210));
        assert_eq!(out.cursor[1], (0.0, 20, 220));
        assert_eq!(out.buttons[0], (50.0, "left", "down", 20, 220));
    }

    #[test]
    fn key_names_read_like_a_badge() {
        assert_eq!(key_name(0x41), "A");
        assert_eq!(key_name(0x0D), "Enter");
        assert_eq!(key_name(0x74), "F5");
        assert_eq!(key_name(0xA2), "Ctrl");
        assert_eq!(key_name(0xFF), "VK255");
    }
}
