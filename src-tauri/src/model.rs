use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Turns a title into a directory-safe suffix: "Settings page" -> "settings-page".
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for ch in title.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= 40 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShotKind {
    #[default]
    Image,
    Recording,
}

/// One still saved beside a recording so it can be read without playing.
/// Stills are taken at the start, at every click or Enter, and at the end,
/// so each one marks an action; the interval kind is the fallback for a
/// recording with no clicks.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KeyFrame {
    /// Relative to the group directory, e.g. "03-frames/02.png".
    pub file: String,
    pub at_ms: u64,
    /// "start", "click", "right-click", "middle-click", "enter", "end" or
    /// "interval".
    #[serde(default)]
    pub event: String,
    /// Where the click landed, in the still's own pixels. Absent for
    /// non-click events and for clicks outside the recorded region.
    #[serde(default)]
    pub x: Option<u32>,
    #[serde(default)]
    pub y: Option<u32>,
}

impl KeyFrame {
    /// How the frame is described in bundle.md: "3 s, click at 412,188".
    pub fn label(&self) -> String {
        let secs = (self.at_ms as f64 / 1000.0).round() as u64;
        let mut s = format!("{secs} s");
        if !self.event.is_empty() {
            s.push_str(", ");
            s.push_str(&self.event);
        }
        if let (Some(x), Some(y)) = (self.x, self.y) {
            s.push_str(&format!(" at {x},{y}"));
        }
        s
    }
}

/// When an auto-captured shot was taken and what caused it, so bundle.md can
/// say "auto-captured at 3 s, click at 412,188".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Moment {
    pub at_ms: u64,
    /// "start", "click", "right-click", "middle-click", "enter", "end" or
    /// "interval".
    pub event: String,
    /// Where the click landed, in the shot's own pixels.
    #[serde(default)]
    pub x: Option<u32>,
    #[serde(default)]
    pub y: Option<u32>,
}

impl Moment {
    pub fn label(&self) -> String {
        KeyFrame {
            file: String::new(),
            at_ms: self.at_ms,
            event: self.event.clone(),
            x: self.x,
            y: self.y,
        }
        .label()
    }
}

/// What the bundle is for. Changes the prompt handed to the agent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Purpose {
    /// Screenshots of things that are wrong; the agent fixes them.
    #[default]
    Fix,
    /// Screenshots and recordings of a workflow; the agent writes it up.
    Document,
    /// The user's own prompt template, kept in `~/QACut/custom-prompt.txt`.
    Custom,
    /// One of the user's saved prompts, named by `Session::prompt_id`.
    Saved,
}

impl Purpose {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "fix" => Some(Purpose::Fix),
            "document" => Some(Purpose::Document),
            "custom" => Some(Purpose::Custom),
            "saved" => Some(Purpose::Saved),
            _ => None,
        }
    }
}

/// A single captured region (still or recording) plus the note the user
/// typed for it. Fields added since the first release default when an older
/// manifest is reopened.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Shot {
    pub id: String,
    /// File name relative to the group directory, e.g. "03.png".
    pub file: String,
    /// Absolute path, handed to the webview via convertFileSrc for thumbnails.
    pub abs_path: String,
    /// Optional short name; the number is the handle when this is empty.
    #[serde(default)]
    pub title: String,
    pub note: String,
    pub width: u32,
    pub height: u32,
    pub captured_at: String,
    #[serde(default)]
    pub kind: ShotKind,
    /// Recording only: length in milliseconds.
    #[serde(default)]
    pub duration_ms: u64,
    /// Recording only: stills at regular intervals, oldest first.
    #[serde(default)]
    pub frames: Vec<KeyFrame>,
    /// Recording only: the MP4 beside the GIF, relative to the group
    /// directory, when the encoder was available.
    #[serde(default)]
    pub video: Option<String>,
    /// Set on a still that auto-capture took: when, and on what action.
    #[serde(default)]
    pub moment: Option<Moment>,
}

/// Files that travel with a shot's main file: the markup editor's untouched
/// original and marks JSON beside an annotated PNG, the MP4 beside a
/// recording's GIF, and the shot's own frame tweaks.
pub fn sidecars(file: &Path) -> [PathBuf; 4] {
    let stem = file
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    [
        file.with_file_name(format!("{stem}.orig.png")),
        file.with_file_name(format!("{stem}.marks.json")),
        file.with_file_name(format!("{stem}.mp4")),
        file.with_file_name(format!("{stem}.frame.json")),
    ]
}

/// What the agent is asked to produce for a "document" bundle.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocFormat {
    /// A markdown file next to the folder's images.
    #[default]
    Markdown,
    /// One self-contained HTML page with the clips playing inline.
    Html,
}

impl DocFormat {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "markdown" => Some(DocFormat::Markdown),
            "html" => Some(DocFormat::Html),
            _ => None,
        }
    }
}

impl Shot {
    /// The directory a recording's key frames live in, next to the GIF.
    pub fn frames_dir(&self) -> Option<PathBuf> {
        if self.kind != ShotKind::Recording {
            return None;
        }
        let p = Path::new(&self.abs_path);
        let stem = p.file_stem()?.to_string_lossy().to_string();
        Some(p.with_file_name(format!("{stem}-frames")))
    }
}

/// A run of shots that share a heading and a master note.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Group {
    /// 1-based, stable for the life of the session.
    pub index: usize,
    pub title: String,
    pub master_note: String,
    /// Directory name under the session root. "01" while capturing,
    /// renamed to "01-settings-page" at export.
    pub dir: String,
    pub shots: Vec<Shot>,
}

impl Group {
    fn new(index: usize) -> Self {
        Group {
            index,
            title: String::new(),
            master_note: String::new(),
            dir: format!("{index:02}"),
            shots: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.shots.is_empty() && self.title.is_empty() && self.master_note.is_empty()
    }

    pub fn heading(&self) -> String {
        if self.title.trim().is_empty() {
            format!("Group {}", self.index)
        } else {
            self.title.trim().to_string()
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    /// Timestamp the session started, also the folder name's prefix.
    pub id: String,
    /// Optional label the user gave the bundle. Appended to the folder name
    /// as a slug and used as the bundle title.
    #[serde(default)]
    pub name: String,
    pub started_at: String,
    pub root: PathBuf,
    /// Index of the group new shots go into. Usually the newest, but the
    /// user can point it back at an earlier group.
    #[serde(default)]
    pub current: usize,
    #[serde(default)]
    pub purpose: Purpose,
    /// Which saved prompt, when the purpose is `Saved`.
    #[serde(default)]
    pub prompt_id: Option<String>,
    #[serde(default)]
    pub doc_format: DocFormat,
    /// Whether the brand kit in `~/QACut/brand/` is copied into this bundle.
    #[serde(default = "default_true")]
    pub include_brand: bool,
    pub groups: Vec<Group>,
}

fn default_true() -> bool {
    true
}

/// A bundle on disk, as listed for "Open bundle".
#[derive(Clone, Debug, Serialize)]
pub struct BundleInfo {
    pub path: String,
    pub id: String,
    pub name: String,
    pub started_at: String,
    pub groups: usize,
    pub shots: usize,
}

impl Session {
    /// Creates `<base>/<timestamp>/01/` on disk and returns the session.
    pub fn start(base: &Path) -> std::io::Result<Self> {
        let now = chrono::Local::now();
        let id = now.format("%Y-%m-%d_%H%M%S").to_string();
        let root = base.join(&id);
        std::fs::create_dir_all(&root)?;

        let first = Group::new(1);
        std::fs::create_dir_all(root.join(&first.dir))?;

        Ok(Session {
            id,
            name: String::new(),
            started_at: now.to_rfc3339(),
            root,
            current: 1,
            purpose: Purpose::Fix,
            prompt_id: None,
            doc_format: DocFormat::Markdown,
            include_brand: true,
            groups: vec![first],
        })
    }

    /// Reopens a bundle from its folder. Paths are rebuilt from the folder
    /// so a bundle that was moved still works, and gaps left by older
    /// manifests are filled in.
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(dir.join("manifest.json"))?;
        let mut s: Session = serde_json::from_str(&text)?;
        s.root = dir.to_path_buf();
        if s.groups.is_empty() {
            s.groups.push(Group::new(1));
        }
        for g in &mut s.groups {
            for shot in &mut g.shots {
                shot.abs_path = s
                    .root
                    .join(&g.dir)
                    .join(&shot.file)
                    .to_string_lossy()
                    .to_string();
            }
        }
        if !s.groups.iter().any(|g| g.index == s.current) {
            s.current = s.groups.last().map(|g| g.index).unwrap_or(1);
        }
        Ok(s)
    }

    /// Every bundle under `base`, newest first. Folders without a manifest
    /// (the brand kit, anything the user dropped in) are skipped.
    pub fn list(base: &Path) -> Vec<BundleInfo> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(base) else { return out };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.join("manifest.json").exists() {
                continue;
            }
            if let Ok(s) = Session::load(&path) {
                out.push(BundleInfo {
                    path: path.to_string_lossy().to_string(),
                    id: s.id.clone(),
                    name: s.name.clone(),
                    started_at: s.started_at.clone(),
                    groups: s.groups.iter().filter(|g| !g.is_empty()).count(),
                    shots: s.shot_count(),
                });
            }
        }
        out.sort_by(|a, b| b.id.cmp(&a.id));
        out
    }

    /// What the bundle is called in headings: the user's label, else the id.
    pub fn title(&self) -> String {
        if self.name.trim().is_empty() {
            self.id.clone()
        } else {
            self.name.trim().to_string()
        }
    }

    /// The folder name the session should have for its current label.
    fn dir_name(&self) -> String {
        let s = slug(&self.name);
        if s.is_empty() {
            self.id.clone()
        } else {
            format!("{}-{s}", self.id)
        }
    }

    /// Relabels the bundle and renames its folder on disk to match.
    pub fn rename(&mut self, name: &str) -> std::io::Result<()> {
        self.name = name.trim().to_string();
        let desired = self.dir_name();
        let Some(parent) = self.root.parent().map(Path::to_path_buf) else {
            return Ok(());
        };
        let to = parent.join(&desired);
        if to == self.root {
            return Ok(());
        }
        std::fs::rename(&self.root, &to)?;
        self.root = to;
        for g in &mut self.groups {
            for shot in &mut g.shots {
                shot.abs_path = self
                    .root
                    .join(&g.dir)
                    .join(&shot.file)
                    .to_string_lossy()
                    .to_string();
            }
        }
        Ok(())
    }

    pub fn current(&mut self) -> &mut Group {
        let idx = self.current;
        let pos = self
            .groups
            .iter()
            .position(|g| g.index == idx)
            .unwrap_or(self.groups.len() - 1);
        &mut self.groups[pos]
    }

    /// Points new captures at an existing group. Returns false if there is
    /// no such group.
    pub fn set_current(&mut self, index: usize) -> bool {
        if self.groups.iter().any(|g| g.index == index) {
            self.current = index;
            true
        } else {
            false
        }
    }

    pub fn shot_count(&self) -> usize {
        self.groups.iter().map(|g| g.shots.len()).sum()
    }

    /// Wraps up the current group: stores its title and master note, then,
    /// if it holds any shots, opens a fresh untitled group for what comes
    /// next. A group with no shots is just titled in place. Returns the
    /// index of the group new captures now go into.
    pub fn close_group(&mut self, title: &str, master_note: &str) -> std::io::Result<usize> {
        let g = self.current();
        g.title = title.trim().to_string();
        g.master_note = master_note.trim().to_string();
        if g.shots.is_empty() {
            return Ok(g.index);
        }

        let next = Group::new(self.groups.len() + 1);
        std::fs::create_dir_all(self.root.join(&next.dir))?;
        let index = next.index;
        self.groups.push(next);
        self.current = index;
        Ok(index)
    }

    /// Reserves the next `NN.<ext>` in the current group and returns
    /// (group index, file name, absolute path). Numbers only ever go up, so
    /// deleting a shot never lets a later one overwrite an existing file.
    pub fn reserve_shot(&mut self, ext: &str) -> (usize, String, PathBuf) {
        let root = self.root.clone();
        let g = self.current();
        let highest = g
            .shots
            .iter()
            .filter_map(|s| s.file.split('.').next()?.parse::<usize>().ok())
            .max()
            .unwrap_or(0);
        let file = format!("{:02}.{ext}", highest + 1);
        let abs = root.join(&g.dir).join(&file);
        (g.index, file, abs)
    }

    pub fn group_mut(&mut self, index: usize) -> Option<&mut Group> {
        self.groups.iter_mut().find(|g| g.index == index)
    }

    pub fn shot_mut(&mut self, group: usize, shot_id: &str) -> Option<&mut Shot> {
        self.group_mut(group)?
            .shots
            .iter_mut()
            .find(|s| s.id == shot_id)
    }

    /// Moves a shot to `to` at position `to_index` (clamped to the end).
    /// Only the session changes; files stay where they are until export
    /// lays the folder out to match, so paths the bundle window is showing
    /// stay valid.
    pub fn move_shot(&mut self, from: usize, shot_id: &str, to: usize, to_index: usize) -> bool {
        if !self.groups.iter().any(|g| g.index == to) {
            return false;
        }
        let Some(src) = self.group_mut(from) else { return false };
        let Some(pos) = src.shots.iter().position(|s| s.id == shot_id) else {
            return false;
        };
        let shot = src.shots.remove(pos);
        let dst = self.group_mut(to).expect("checked above");
        let idx = to_index.min(dst.shots.len());
        dst.shots.insert(idx, shot);
        true
    }

    /// Removes a shot and deletes its file. Remaining files keep their
    /// original names; numbering gaps are harmless and renaming mid-session
    /// would invalidate paths the peek window is already showing.
    pub fn remove_shot(&mut self, group: usize, shot_id: &str) {
        let Some(g) = self.group_mut(group) else { return };
        if let Some(pos) = g.shots.iter().position(|s| s.id == shot_id) {
            let shot = g.shots.remove(pos);
            let _ = std::fs::remove_file(&shot.abs_path);
            for side in sidecars(Path::new(&shot.abs_path)) {
                let _ = std::fs::remove_file(side);
            }
            if let Some(dir) = shot.frames_dir() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    /// Drops one still from a recording and deletes its files. Returns
    /// false if there is no such frame.
    pub fn remove_frame(&mut self, group: usize, shot_id: &str, file: &str) -> bool {
        let Some(shot) = self.shot_mut(group, shot_id) else { return false };
        let Some(pos) = shot.frames.iter().position(|f| f.file == file) else {
            return false;
        };
        let frame = shot.frames.remove(pos);
        let group_dir = Path::new(&shot.abs_path)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let path = group_dir.join(&frame.file);
        let _ = std::fs::remove_file(&path);
        for side in sidecars(&path) {
            let _ = std::fs::remove_file(side);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shot(file: &str, abs: &Path) -> Shot {
        Shot {
            id: file.to_string(),
            file: file.to_string(),
            abs_path: abs.to_string_lossy().to_string(),
            title: String::new(),
            note: String::new(),
            width: 1,
            height: 1,
            captured_at: String::new(),
            kind: ShotKind::Image,
            duration_ms: 0,
            frames: Vec::new(),
            video: None,
            moment: None,
        }
    }

    fn temp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qacut-test-{tag}-{}",
            chrono::Local::now().timestamp_micros()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn slugs_are_directory_safe() {
        assert_eq!(slug("Settings page"), "settings-page");
        assert_eq!(slug("  Billing / Invoices!! "), "billing-invoices");
        assert_eq!(slug(""), "");
        assert_eq!(slug("---"), "");
    }

    #[test]
    fn shot_numbers_never_reuse_a_file() {
        let base = temp_base("numbers");
        let mut s = Session::start(&base).unwrap();
        for _ in 0..3 {
            let (_, file, abs) = s.reserve_shot("png");
            std::fs::write(&abs, b"png").unwrap();
            s.current().shots.push(shot(&file, &abs));
        }
        s.remove_shot(1, "02.png");
        let (_, next, _) = s.reserve_shot("gif");
        assert_eq!(next, "04.gif");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn rename_moves_the_folder_and_updates_paths() {
        let base = temp_base("rename");
        let mut s = Session::start(&base).unwrap();
        let (_, file, abs) = s.reserve_shot("png");
        std::fs::write(&abs, b"png").unwrap();
        s.current().shots.push(shot(&file, &abs));

        s.rename("Settings review").unwrap();
        assert!(s.root.ends_with(format!("{}-settings-review", s.id)));
        assert!(Path::new(&s.groups[0].shots[0].abs_path).exists());

        // Clearing the label moves it back.
        s.rename("").unwrap();
        assert!(s.root.ends_with(&s.id));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn current_group_can_point_backwards() {
        let base = temp_base("current");
        let mut s = Session::start(&base).unwrap();
        s.current().shots.push(shot("01.png", Path::new("")));
        let second = s.close_group("Billing", "Whole page").unwrap();
        assert_eq!(second, 2);
        assert_eq!(s.groups[0].title, "Billing");
        assert_eq!(s.groups[0].master_note, "Whole page");
        assert_eq!(s.current().index, 2);
        assert!(s.set_current(1));
        assert_eq!(s.reserve_shot("png").0, 1);
        assert!(!s.set_current(9));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn shots_move_within_and_between_groups() {
        let base = temp_base("move");
        let mut s = Session::start(&base).unwrap();
        for f in ["a", "b", "c"] {
            s.current().shots.push(shot(f, Path::new("")));
        }
        s.close_group("One", "").unwrap();
        s.current().shots.push(shot("d", Path::new("")));

        // c to the front of group 1.
        assert!(s.move_shot(1, "c", 1, 0));
        let ids: Vec<_> = s.groups[0].shots.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["c", "a", "b"]);

        // a into group 2, after d (index past the end clamps).
        assert!(s.move_shot(1, "a", 2, 99));
        let ids: Vec<_> = s.groups[1].shots.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["d", "a"]);

        assert!(!s.move_shot(1, "nope", 2, 0));
        assert!(!s.move_shot(1, "b", 7, 0));
        std::fs::remove_dir_all(base).unwrap();
    }
}

#[cfg(test)]
mod recording_tests {
    use super::*;

    #[test]
    fn removing_a_recording_takes_its_frames_too() {
        let base = std::env::temp_dir().join(format!(
            "qacut-test-rec-{}",
            chrono::Local::now().timestamp_micros()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let mut s = Session::start(&base).unwrap();
        let (_, file, abs) = s.reserve_shot("gif");
        std::fs::write(&abs, b"gif").unwrap();
        let mut sh = Shot {
            id: "r".into(),
            file,
            abs_path: abs.to_string_lossy().to_string(),
            title: String::new(),
            note: String::new(),
            width: 1,
            height: 1,
            captured_at: String::new(),
            kind: ShotKind::Recording,
            duration_ms: 1000,
            frames: Vec::new(),
            video: None,
            moment: None,
        };
        let dir = sh.frames_dir().unwrap();
        assert!(dir.ends_with("01-frames"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("01.png"), b"png").unwrap();
        sh.frames.push(KeyFrame {
            file: "01-frames/01.png".into(),
            at_ms: 0,
            event: "start".into(),
            x: None,
            y: None,
        });
        s.current().shots.push(sh);

        s.remove_shot(1, "r");
        assert!(!abs.exists());
        assert!(!dir.exists());
        std::fs::remove_dir_all(base).unwrap();
    }
}

#[cfg(test)]
mod reopen_tests {
    use super::*;

    #[test]
    fn a_bundle_reopens_from_its_manifest_even_after_a_move() {
        let base = std::env::temp_dir().join(format!(
            "qacut-test-reopen-{}",
            chrono::Local::now().timestamp_micros()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let mut s = Session::start(&base).unwrap();
        s.name = "Onboarding".into();
        let (_, file, abs) = s.reserve_shot("png");
        std::fs::write(&abs, b"png").unwrap();
        s.current().shots.push(Shot {
            id: "a".into(),
            file,
            abs_path: abs.to_string_lossy().to_string(),
            title: String::new(),
            note: "first".into(),
            width: 1,
            height: 1,
            captured_at: String::new(),
            kind: ShotKind::Image,
            duration_ms: 0,
            frames: Vec::new(),
            video: None,
            moment: None,
        });
        std::fs::write(
            s.root.join("manifest.json"),
            serde_json::to_string(&s).unwrap(),
        )
        .unwrap();

        // Move the folder, then reopen it from the new place.
        let moved = base.join("elsewhere");
        std::fs::rename(&s.root, &moved).unwrap();
        let r = Session::load(&moved).unwrap();
        assert_eq!(r.name, "Onboarding");
        assert_eq!(r.groups[0].shots[0].note, "first");
        assert!(Path::new(&r.groups[0].shots[0].abs_path).exists());
        assert_eq!(r.current, 1);

        // An older manifest without the newer fields still loads.
        let old = r#"{"id":"2020-01-01_000000","started_at":"","root":"","groups":[{"index":1,"title":"","master_note":"","dir":"01","shots":[{"id":"s","file":"01.png","abs_path":"","note":"n","width":1,"height":1,"captured_at":""}]}]}"#;
        let dir = base.join("old");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.json"), old).unwrap();
        let o = Session::load(&dir).unwrap();
        assert!(o.include_brand);
        assert_eq!(o.purpose, Purpose::Fix);
        assert_eq!(o.groups[0].shots[0].kind, ShotKind::Image);
        assert_eq!(o.current, 1);

        let listed = Session::list(&base);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].name, "Onboarding");
        std::fs::remove_dir_all(base).unwrap();
    }
}
