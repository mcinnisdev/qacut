//! User settings, persisted in `~/QACut/settings.json`: the studio's
//! recording toggles (all off by default, each a toggle in the tray) and
//! the global shortcuts.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// One global shortcut per action, in the global-shortcut parser's
/// spelling ("CommandOrControl+Shift+2"). Empty disables the action's key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Hotkeys {
    pub quick: String,
    /// Finish the quick batch from anywhere. Empty by default: any chord
    /// worth having here (Ctrl+Enter) is one other apps rely on.
    pub quick_finish: String,
    pub capture: String,
    pub record: String,
    pub studio: String,
    pub zoom: String,
    pub group: String,
    pub peek: String,
    pub finish: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Hotkeys {
            quick: "CommandOrControl+Shift+1".into(),
            quick_finish: String::new(),
            capture: "CommandOrControl+Shift+2".into(),
            record: "CommandOrControl+Shift+3".into(),
            studio: "CommandOrControl+Shift+R".into(),
            // Only registered while a Studio recording runs, so it does not
            // take Ctrl+Space away from editors the rest of the time.
            zoom: "CommandOrControl+Space".into(),
            group: "CommandOrControl+Shift+G".into(),
            peek: "CommandOrControl+Shift+Q".into(),
            finish: "CommandOrControl+Shift+Enter".into(),
        }
    }
}

impl Hotkeys {
    /// The defaults before 2.1 moved auto-capture to 3, Studio to R and zoom
    /// to Ctrl+Space. A settings file still on exactly these is upgraded.
    pub fn legacy() -> Self {
        Hotkeys {
            quick: "CommandOrControl+Shift+1".into(),
            quick_finish: String::new(),
            capture: "CommandOrControl+Shift+2".into(),
            record: "CommandOrControl+Shift+R".into(),
            studio: "CommandOrControl+Shift+3".into(),
            zoom: "CommandOrControl+Shift+Z".into(),
            group: "CommandOrControl+Shift+G".into(),
            peek: "CommandOrControl+Shift+Q".into(),
            finish: "CommandOrControl+Shift+Enter".into(),
        }
    }

    /// (action id, spec) pairs, for registration and the menu.
    pub fn entries(&self) -> [(&'static str, &str); 9] {
        [
            ("quick", &self.quick),
            ("quick_finish", &self.quick_finish),
            ("capture", &self.capture),
            ("record", &self.record),
            ("studio", &self.studio),
            ("zoom", &self.zoom),
            ("group", &self.group),
            ("peek", &self.peek),
            ("finish", &self.finish),
        ]
    }
}

/// How a screenshot is dressed when it is copied for a person or placed in
/// an exported document: a background (one of the studio's gradients, or a
/// picture from the brand folder) with padding, rounded corners and a
/// shadow. "none" leaves the shot as it is. Files on disk are never framed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ShotFrame {
    /// "none", a gradient name, "image", or "brand" (the editor's pick of a
    /// brand's preset, see `brand`).
    pub style: String,
    pub image: Option<String>,
    pub padding: f64,
    pub radius: f64,
    pub shadow: bool,
    /// For style "brand": which brand's preset.
    pub brand: Option<String>,
    /// For a picture: how much of the picture's width the shot takes, so
    /// the picture is placed behind the shot rather than cropped to it.
    pub fit_scale: f64,
    /// For a picture that still has to be cropped (a tall shot): which part
    /// to keep, "center", "top" or "bottom".
    pub anchor: String,
}

impl Default for ShotFrame {
    fn default() -> Self {
        ShotFrame {
            style: "none".into(),
            image: None,
            padding: 0.06,
            radius: 14.0,
            shadow: true,
            brand: None,
            fit_scale: 0.8,
            anchor: "center".into(),
        }
    }
}

impl ShotFrame {
    /// The gradient's two colours, for the styles that are gradients.
    pub fn gradient(&self) -> Option<(&'static str, &'static str)> {
        Some(match self.style.as_str() {
            "midnight" => ("#141a2b", "#2a1f4d"),
            "sunset" => ("#3a1c3f", "#c2503a"),
            "ocean" => ("#0d2b3e", "#1e6f8c"),
            "slate" => ("#2b2f36", "#4a515b"),
            "plain" => ("#1b1e23", "#1b1e23"),
            _ => return None,
        })
    }

    pub fn is_none(&self) -> bool {
        self.style == "none" || (self.style == "image" && self.image.is_none())
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// How copied and exported screenshots are framed.
    pub shot_frame: ShotFrame,
    /// The brand whose folder, notes and looks are in use.
    pub active_brand: String,
    /// Record key presses through a low-level hook so shortcuts can be shown.
    pub keystrokes: bool,
    /// Record narration from the default microphone.
    pub mic: bool,
    /// Record the webcam for a picture-in-picture bubble.
    pub camera: bool,
    pub hotkeys: Hotkeys,
}

impl Settings {
    pub fn load(base: &Path) -> Settings {
        let mut s: Settings = std::fs::read_to_string(base.join("settings.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        if s.hotkeys == Hotkeys::legacy() {
            s.hotkeys = Hotkeys::default();
        }
        s
    }

    pub fn save(&self, base: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(base)?;
        std::fs::write(
            base.join("settings.json"),
            serde_json::to_string_pretty(self).unwrap_or_default(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_settings_file_on_the_old_defaults_moves_to_the_new_ones() {
        let dir = std::env::temp_dir().join(format!("qacut-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = Settings { hotkeys: Hotkeys::legacy(), ..Default::default() };
        old.save(&dir).unwrap();
        assert_eq!(Settings::load(&dir).hotkeys, Hotkeys::default());

        let mut custom = Hotkeys::legacy();
        custom.capture = "CommandOrControl+Alt+2".into();
        Settings { hotkeys: custom.clone(), ..Default::default() }.save(&dir).unwrap();
        assert_eq!(Settings::load(&dir).hotkeys, custom);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
