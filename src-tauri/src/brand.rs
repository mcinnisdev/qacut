//! Brands. Each is a folder under ~/QACut/brands: the files an agent or the
//! studio may use (logo, backgrounds, style guides), voice notes in
//! brand.md, and brand.json for the looks QACut applies itself: the frame
//! a copied or exported screenshot sits on, and the studio's frame. One
//! brand is active; it is what "the brand folder" means everywhere else.

use crate::studio::settings::{Settings, ShotFrame};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub const BRAND_JSON: &str = "brand.json";

/// The studio's frame defaults for a brand: applied to a recording the
/// first time it opens, and on demand.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StudioLook {
    pub background: String,
    /// A picture in the brand folder, when background is "image".
    pub image: Option<String>,
    pub padding: f64,
    pub radius: f64,
    pub shadow: bool,
    pub logo_corner: String,
    pub logo_size: f64,
}

impl Default for StudioLook {
    fn default() -> Self {
        StudioLook {
            background: "midnight".into(),
            image: None,
            padding: 0.06,
            radius: 14.0,
            shadow: true,
            logo_corner: "tl".into(),
            logo_size: 0.5,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Brand {
    pub name: String,
    /// The logo's file name in the brand folder.
    pub logo: Option<String>,
    /// The screenshot frame; `image` is a file name in the brand folder.
    pub shot_frame: ShotFrame,
    pub studio: StudioLook,
}

impl Default for Brand {
    fn default() -> Self {
        Brand {
            name: "Brand".into(),
            logo: None,
            shot_frame: ShotFrame { style: "midnight".into(), ..ShotFrame::default() },
            studio: StudioLook::default(),
        }
    }
}

/// Everything the brands window shows for one brand.
#[derive(Clone, Serialize)]
pub struct BrandInfo {
    pub slug: String,
    pub dir: String,
    pub active: bool,
    /// Image files in the folder, by name.
    pub images: Vec<String>,
    /// Every file in the folder except the notes and brand.json.
    pub files: Vec<String>,
    pub notes: String,
    pub brand: Brand,
}

/// The studio look with the paths made absolute, for the studio window.
#[derive(Clone, Serialize)]
pub struct StudioLookOut {
    pub name: String,
    pub background: String,
    pub image: Option<String>,
    pub padding: f64,
    pub radius: f64,
    pub shadow: bool,
    pub logo: Option<String>,
    pub logo_corner: String,
    pub logo_size: f64,
}

pub fn root(app: &AppHandle) -> PathBuf {
    crate::base_dir(app).join("brands")
}

fn slugify(name: &str) -> String {
    let mut s = String::new();
    let mut dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !s.is_empty() {
            s.push('-');
            dash = true;
        }
    }
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() {
        "brand".into()
    } else {
        s
    }
}

fn unique_slug(root: &Path, base: &str) -> String {
    let mut slug = base.to_string();
    let mut n = 2;
    while root.join(&slug).exists() {
        slug = format!("{base}-{n}");
        n += 1;
    }
    slug
}

/// A name for a folder that predates brand.json: the first heading in
/// brand.md, minus "brand kit", else "Default".
fn name_from_notes(dir: &Path) -> String {
    std::fs::read_to_string(dir.join(crate::export::BRAND_NOTES))
        .ok()
        .and_then(|t| t.lines().find(|l| l.starts_with("# ")).map(|l| l[2..].trim().to_string()))
        .map(|h| {
            let lower = h.to_lowercase();
            let cut = lower.find(" brand kit").or_else(|| lower.find(" brand")).unwrap_or(h.len());
            h[..cut].trim().to_string()
        })
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Default".into())
}

/// The single ~/QACut/brand folder of earlier versions becomes the first
/// brand, named from its notes, and is made active.
pub fn migrate(app: &AppHandle) {
    let base = crate::base_dir(app);
    let old = base.join("brand");
    let root = root(app);
    if !old.is_dir() || root.is_dir() {
        return;
    }
    let _ = std::fs::create_dir_all(&root);
    let name = name_from_notes(&old);
    let slug = unique_slug(&root, &slugify(&name));
    let dest = root.join(&slug);
    if std::fs::rename(&old, &dest).is_err() {
        return;
    }
    let mut b = load(&dest);
    b.name = name;
    let _ = save_json(&dest, &b);
    let mut st = Settings::load(&base);
    st.active_brand = slug;
    let _ = st.save(&base);
}

pub fn list_slugs(app: &AppHandle) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(root(app))
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// The active brand's slug; the first brand if the setting is stale, and a
/// "Default" brand made on the spot if there are none.
pub fn active_slug(app: &AppHandle) -> String {
    let base = crate::base_dir(app);
    let root = root(app);
    let _ = std::fs::create_dir_all(&root);
    let mut st = Settings::load(&base);
    if !st.active_brand.is_empty() && root.join(&st.active_brand).is_dir() {
        return st.active_brand;
    }
    let slug = match list_slugs(app).into_iter().next() {
        Some(s) => s,
        None => {
            let dir = root.join("default");
            let _ = std::fs::create_dir_all(&dir);
            let _ = save_json(&dir, &Brand { name: "Default".into(), ..Brand::default() });
            "default".into()
        }
    };
    st.active_brand = slug.clone();
    let _ = st.save(&base);
    slug
}

pub fn active_dir(app: &AppHandle) -> PathBuf {
    root(app).join(active_slug(app))
}

pub fn load(dir: &Path) -> Brand {
    std::fs::read_to_string(dir.join(BRAND_JSON))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| Brand { name: name_from_notes(dir), ..Brand::default() })
}

pub fn save_json(dir: &Path, brand: &Brand) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(BRAND_JSON), serde_json::to_string_pretty(brand).unwrap_or_default())
}

fn is_image(p: &Path) -> bool {
    matches!(
        p.extension().map(|x| x.to_string_lossy().to_lowercase()).as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "svg")
    )
}

fn files_in(dir: &Path) -> (Vec<String>, Vec<String>) {
    let mut images = Vec::new();
    let mut files = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name == BRAND_JSON || name == crate::export::BRAND_NOTES {
                continue;
            }
            if is_image(&p) {
                images.push(name.clone());
            }
            files.push(name);
        }
    }
    images.sort();
    files.sort();
    (images, files)
}

pub fn info(app: &AppHandle, slug: &str) -> Option<BrandInfo> {
    let dir = root(app).join(slug);
    if !dir.is_dir() {
        return None;
    }
    let (images, files) = files_in(&dir);
    Some(BrandInfo {
        slug: slug.to_string(),
        dir: dir.to_string_lossy().to_string(),
        active: active_slug(app) == slug,
        images,
        files,
        notes: std::fs::read_to_string(dir.join(crate::export::BRAND_NOTES)).unwrap_or_default(),
        brand: load(&dir),
    })
}

/// The frame a copied or exported screenshot gets: what the editor's Frame
/// pick says, with a brand's preset resolved and its picture made absolute.
pub fn resolve_shot_frame(app: &AppHandle) -> ShotFrame {
    let pick = Settings::load(&crate::base_dir(app)).shot_frame;
    if pick.style != "brand" {
        return ShotFrame { image: None, ..pick };
    }
    let slug = pick.brand.clone().unwrap_or_else(|| active_slug(app));
    let dir = root(app).join(&slug);
    let mut f = load(&dir).shot_frame;
    f.brand = Some(slug);
    if f.style == "image" {
        f.image = f.image.as_deref().map(|n| dir.join(n).to_string_lossy().to_string()).filter(|p| Path::new(p).is_file());
        if f.image.is_none() {
            f.style = "midnight".into();
        }
    } else {
        f.image = None;
    }
    f
}

pub fn studio_look(app: &AppHandle) -> StudioLookOut {
    let dir = active_dir(app);
    let b = load(&dir);
    let abs = |n: &Option<String>| n.as_deref().map(|n| dir.join(n)).filter(|p| p.is_file()).map(|p| p.to_string_lossy().to_string());
    StudioLookOut {
        name: b.name.clone(),
        background: b.studio.background.clone(),
        image: abs(&b.studio.image),
        padding: b.studio.padding,
        radius: b.studio.radius,
        shadow: b.studio.shadow,
        logo: abs(&b.logo),
        logo_corner: b.studio.logo_corner.clone(),
        logo_size: b.studio.logo_size,
    }
}

// ------------------------------------------------------------- commands

#[tauri::command]
pub fn list_brands(app: AppHandle) -> Vec<BrandInfo> {
    let _ = active_slug(&app);
    list_slugs(&app).iter().filter_map(|s| info(&app, s)).collect()
}

#[tauri::command]
pub fn get_brand(app: AppHandle, slug: String) -> Result<BrandInfo, String> {
    info(&app, &slug).ok_or_else(|| format!("no brand {slug}"))
}

#[tauri::command]
pub fn save_brand(app: AppHandle, slug: String, brand: Brand, notes: String) -> Result<BrandInfo, String> {
    let dir = root(&app).join(&slug);
    if !dir.is_dir() {
        return Err(format!("no brand {slug}"));
    }
    save_json(&dir, &brand).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(crate::export::BRAND_NOTES), notes).map_err(|e| e.to_string())?;
    let _ = app.emit_all_brands();
    info(&app, &slug).ok_or_else(|| "brand vanished".into())
}

#[tauri::command]
pub fn create_brand(app: AppHandle, name: String) -> Result<BrandInfo, String> {
    let root = root(&app);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let name = if name.trim().is_empty() { "New brand".to_string() } else { name.trim().to_string() };
    let slug = unique_slug(&root, &slugify(&name));
    let dir = root.join(&slug);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    save_json(&dir, &Brand { name, ..Brand::default() }).map_err(|e| e.to_string())?;
    let _ = app.emit_all_brands();
    info(&app, &slug).ok_or_else(|| "brand vanished".into())
}

#[tauri::command]
pub fn delete_brand(app: AppHandle, slug: String) -> Result<(), String> {
    if list_slugs(&app).len() <= 1 {
        return Err("Keep at least one brand.".into());
    }
    let dir = root(&app).join(&slug);
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = crate::base_dir(&app);
    let mut st = Settings::load(&base);
    if st.active_brand == slug {
        st.active_brand.clear();
        let _ = st.save(&base);
        let _ = active_slug(&app);
    }
    let _ = app.emit_all_brands();
    Ok(())
}

#[tauri::command]
pub fn set_active_brand(app: AppHandle, slug: String) -> Result<(), String> {
    if !root(&app).join(&slug).is_dir() {
        return Err(format!("no brand {slug}"));
    }
    let base = crate::base_dir(&app);
    let mut st = Settings::load(&base);
    st.active_brand = slug;
    st.save(&base).map_err(|e| e.to_string())?;
    let _ = app.emit_all_brands();
    Ok(())
}

/// A file picker; the file is copied into the brand's folder. Returns the
/// file name, or None when cancelled.
#[tauri::command]
pub async fn pick_brand_file(app: AppHandle, slug: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let dir = root(&app).join(&slug);
    if !dir.is_dir() {
        return Err(format!("no brand {slug}"));
    }
    let picked = app
        .dialog()
        .file()
        .add_filter("Pictures", &["png", "jpg", "jpeg", "webp", "gif", "svg"])
        .add_filter("Any file", &["*"])
        .set_title("Add a file to the brand")
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let from = picked.into_path().map_err(|e| e.to_string())?;
    let name = from.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let to = dir.join(&name);
    if !to.exists() || std::fs::read(&to).ok() != std::fs::read(&from).ok() {
        std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
    }
    let _ = app.emit_all_brands();
    Ok(Some(name))
}

#[tauri::command]
pub fn brand_studio_look(app: AppHandle) -> StudioLookOut {
    studio_look(&app)
}

#[tauri::command]
pub fn open_brand_dir(app: AppHandle, slug: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = root(&app).join(&slug);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy().to_string(), None::<&str>).map_err(|e| e.to_string())
}

/// Every window that shows brand state re-reads it on this event.
trait EmitBrands {
    fn emit_all_brands(&self) -> tauri::Result<()>;
}

impl EmitBrands for AppHandle {
    fn emit_all_brands(&self) -> tauri::Result<()> {
        use tauri::Emitter;
        self.emit("brands-changed", ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_plain() {
        assert_eq!(slugify("Castle Rock Sky"), "castle-rock-sky");
        assert_eq!(slugify("  Acme, Inc.  "), "acme-inc");
        assert_eq!(slugify("***"), "brand");
    }

    #[test]
    fn name_comes_from_the_notes_heading() {
        let dir = std::env::temp_dir().join(format!("qacut-brand-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(crate::export::BRAND_NOTES), "# Castle Rock Sky brand kit\n\nText.\n").unwrap();
        assert_eq!(name_from_notes(&dir), "Castle Rock Sky");
        std::fs::write(dir.join(crate::export::BRAND_NOTES), "no heading\n").unwrap();
        assert_eq!(name_from_notes(&dir), "Default");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
