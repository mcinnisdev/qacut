// The brands window: one brand per folder under ~/QACut/brands, with its
// files, voice notes, and the looks QACut applies for it (the frame a
// copied or exported screenshot sits on, and the studio's frame). One
// brand is active at a time; it is what bundles, exports and the studio
// use. Nothing is written until Save.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BACKGROUNDS } from "./studio/model";

interface ShotFrame {
  style: string;
  image: string | null;
  padding: number;
  radius: number;
  shadow: boolean;
  brand: string | null;
  fit_scale: number;
  anchor: string;
}
interface StudioLook {
  background: string;
  image: string | null;
  padding: number;
  radius: number;
  shadow: boolean;
  logo_corner: string;
  logo_size: number;
}
interface Brand {
  name: string;
  logo: string | null;
  shot_frame: ShotFrame;
  studio: StudioLook;
}
interface BrandInfo {
  slug: string;
  dir: string;
  active: boolean;
  images: string[];
  files: string[];
  notes: string;
  brand: Brand;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const listEl = $<HTMLDivElement>("list-brands");
const statusEl = $<HTMLSpanElement>("status");
const nameEl = $<HTMLInputElement>("name");
const notesEl = $<HTMLTextAreaElement>("notes");
const logoEl = $<HTMLSelectElement>("logo");
const sfStyle = $<HTMLSelectElement>("sf-style");
const sfImage = $<HTMLSelectElement>("sf-image");
const sfFit = $<HTMLInputElement>("sf-fit");
const sfAnchor = $<HTMLSelectElement>("sf-anchor");
const sfPad = $<HTMLInputElement>("sf-pad");
const sfRadius = $<HTMLInputElement>("sf-radius");
const sfShadow = $<HTMLInputElement>("sf-shadow");
const stBg = $<HTMLSelectElement>("st-bg");
const stImage = $<HTMLSelectElement>("st-image");
const stPad = $<HTMLInputElement>("st-pad");
const stRadius = $<HTMLInputElement>("st-radius");
const stShadow = $<HTMLInputElement>("st-shadow");
const stLogoCorner = $<HTMLSelectElement>("st-logo-corner");
const stLogoSize = $<HTMLInputElement>("st-logo-size");
const preview = $<HTMLDivElement>("sf-preview");

let brands: BrandInfo[] = [];
let current: BrandInfo | null = null;
let dirty = false;
let statusTimer = 0;

function status(text: string, bad = false) {
  statusEl.textContent = text;
  statusEl.style.color = bad ? "" : "var(--muted)";
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    if (statusEl.textContent === text) statusEl.textContent = "";
  }, 2500);
}

function renderList() {
  listEl.replaceChildren();
  for (const b of brands) {
    const item = document.createElement("button");
    item.className = "lib-item" + (current?.slug === b.slug ? " on" : "");
    const name = document.createElement("span");
    name.textContent = b.brand.name || b.slug;
    item.append(name);
    if (b.active) {
      const tag = document.createElement("i");
      tag.textContent = "active";
      item.append(tag);
    }
    item.addEventListener("click", () => void select(b.slug));
    listEl.append(item);
  }
}

function fillImages(sel: HTMLSelectElement, images: string[], value: string | null, noneText: string) {
  sel.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = images.length ? noneText : `${noneText} (no pictures in the folder yet)`;
  sel.append(none);
  for (const im of images) {
    const o = document.createElement("option");
    o.value = im;
    o.textContent = im;
    sel.append(o);
  }
  sel.value = value && images.includes(value) ? value : "";
}

function showRows() {
  const picture = sfStyle.value === "image";
  $<HTMLElement>("sf-image-row").hidden = !picture;
  $<HTMLElement>("sf-fit-row").hidden = !picture;
  $<HTMLElement>("sf-anchor-row").hidden = !picture;
  $<HTMLElement>("sf-pad-row").hidden = picture || sfStyle.value === "none";
  $<HTMLElement>("st-image-row").hidden = stBg.value !== "image";
  $<HTMLElement>("sf-fit-v").textContent = `${Math.round(Number(sfFit.value) * 100)}%`;
  $<HTMLElement>("sf-pad-v").textContent = `${Math.round(Number(sfPad.value) * 100)}%`;
  $<HTMLElement>("sf-radius-v").textContent = `${sfRadius.value}px`;
  $<HTMLElement>("st-pad-v").textContent = `${Math.round(Number(stPad.value) * 100)}%`;
  $<HTMLElement>("st-radius-v").textContent = `${stRadius.value}px`;
  $<HTMLElement>("st-logo-size-v").textContent = `${Math.round(Number(stLogoSize.value) * 100)}%`;
  renderPreview();
}

/// A small mock of the frame: the background with a grey "shot" on it.
function renderPreview() {
  const shot = preview.firstElementChild as HTMLDivElement;
  const style = sfStyle.value;
  preview.hidden = style === "none";
  if (style === "none") return;
  const g = BACKGROUNDS[style as keyof typeof BACKGROUNDS];
  if (style === "image" && current && sfImage.value) {
    const src = `${current.dir}\\${sfImage.value}`;
    preview.style.background = `#fff url("${convertFileSrc(src)}") center ${sfAnchor.value} / cover no-repeat`;
    shot.style.width = `${Number(sfFit.value) * 100}%`;
    preview.style.padding = "4%";
  } else {
    const [c1, c2] = g ?? BACKGROUNDS.midnight;
    preview.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
    shot.style.width = "";
    preview.style.padding = `${Number(sfPad.value) * 100}%`;
  }
  shot.style.borderRadius = `${Math.round(Number(sfRadius.value) / 2)}px`;
  shot.style.boxShadow = sfShadow.checked ? "0 6px 18px rgba(0,0,0,.4)" : "none";
}

function showBrand(b: BrandInfo) {
  current = b;
  nameEl.value = b.brand.name;
  notesEl.value = b.notes;
  $<HTMLElement>("active-label").textContent = b.active ? "Active: in use for bundles, exports and the studio." : "Not active.";
  $<HTMLButtonElement>("activate").hidden = b.active;
  $<HTMLElement>("files-summary").textContent = b.files.length
    ? `${b.files.length} file${b.files.length === 1 ? "" : "s"}: ${b.files.slice(0, 6).join(", ")}${b.files.length > 6 ? ", …" : ""}`
    : "No files yet. Add a logo, a background, a style guide.";
  fillImages(logoEl, b.images, b.brand.logo, "None");
  sfStyle.value = b.brand.shot_frame.style;
  if (!sfStyle.value) sfStyle.value = "none";
  fillImages(sfImage, b.images, b.brand.shot_frame.image, "Choose one");
  sfFit.value = String(b.brand.shot_frame.fit_scale);
  sfAnchor.value = b.brand.shot_frame.anchor || "center";
  sfPad.value = String(b.brand.shot_frame.padding);
  sfRadius.value = String(b.brand.shot_frame.radius);
  sfShadow.checked = b.brand.shot_frame.shadow;
  stBg.value = b.brand.studio.background;
  fillImages(stImage, b.images, b.brand.studio.image, "Choose one");
  stPad.value = String(b.brand.studio.padding);
  stRadius.value = String(b.brand.studio.radius);
  stShadow.checked = b.brand.studio.shadow;
  stLogoCorner.value = b.brand.studio.logo_corner;
  stLogoSize.value = String(b.brand.studio.logo_size);
  $<HTMLButtonElement>("delete").hidden = brands.length <= 1;
  dirty = false;
  showRows();
  renderList();
}

function collect(): Brand {
  return {
    name: nameEl.value.trim() || "Brand",
    logo: logoEl.value || null,
    shot_frame: {
      style: sfStyle.value,
      image: sfImage.value || null,
      padding: Number(sfPad.value),
      radius: Number(sfRadius.value),
      shadow: sfShadow.checked,
      brand: null,
      fit_scale: Number(sfFit.value),
      anchor: sfAnchor.value,
    },
    studio: {
      background: stBg.value,
      image: stImage.value || null,
      padding: Number(stPad.value),
      radius: Number(stRadius.value),
      shadow: stShadow.checked,
      logo_corner: stLogoCorner.value,
      logo_size: Number(stLogoSize.value),
    },
  };
}

async function reload(keep: string | null) {
  brands = await invoke<BrandInfo[]>("list_brands");
  const pick = brands.find((b) => b.slug === keep) ?? brands.find((b) => b.active) ?? brands[0];
  if (pick) showBrand(pick);
  else renderList();
}

async function select(slug: string) {
  if (current?.slug === slug) return;
  if (dirty && !confirm("Leave without saving?")) return;
  const b = brands.find((x) => x.slug === slug);
  if (b) showBrand(b);
}

async function save() {
  if (!current) return;
  try {
    const b = await invoke<BrandInfo>("save_brand", { slug: current.slug, brand: collect(), notes: notesEl.value });
    brands = brands.map((x) => (x.slug === b.slug ? b : x));
    showBrand(b);
    status("Saved");
  } catch (err) {
    status(String(err), true);
  }
}

async function activate() {
  if (!current) return;
  try {
    if (dirty) await save();
    await invoke("set_active_brand", { slug: current.slug });
    await reload(current.slug);
    status(`${current.brand.name} is the active brand`);
  } catch (err) {
    status(String(err), true);
  }
}

async function addBrand() {
  if (dirty && !confirm("Leave without saving?")) return;
  const name = prompt("Name the brand", "New brand");
  if (name === null) return;
  try {
    const b = await invoke<BrandInfo>("create_brand", { name });
    await reload(b.slug);
    nameEl.focus();
  } catch (err) {
    status(String(err), true);
  }
}

async function deleteBrand() {
  if (!current) return;
  if (!confirm(`Delete "${current.brand.name}" and everything in its folder?`)) return;
  try {
    await invoke("delete_brand", { slug: current.slug });
    current = null;
    dirty = false;
    await reload(null);
    status("Deleted");
  } catch (err) {
    status(String(err), true);
  }
}

async function addFile() {
  if (!current) return;
  try {
    const name = await invoke<string | null>("pick_brand_file", { slug: current.slug });
    if (!name) return;
    const pending = collect();
    const notes = notesEl.value;
    const wasDirty = dirty;
    await reload(current.slug);
    if (wasDirty && current) {
      // Keep the unsaved edits, with the new file available in the pickers.
      const b = current;
      showBrand({ ...b, brand: pending, notes });
      dirty = true;
    }
    status(`Added ${name}`);
  } catch (err) {
    status(String(err), true);
  }
}

function onEdit() {
  dirty = true;
  showRows();
}

for (const el of [nameEl, notesEl, logoEl, sfStyle, sfImage, sfFit, sfAnchor, sfPad, sfRadius, sfShadow, stBg, stImage, stPad, stRadius, stShadow, stLogoCorner, stLogoSize]) {
  el.addEventListener("input", onEdit);
  el.addEventListener("change", onEdit);
}
$("save").addEventListener("click", () => void save());
$("activate").addEventListener("click", () => void activate());
$("add").addEventListener("click", () => void addBrand());
$("delete").addEventListener("click", () => void deleteBrand());
$("add-file").addEventListener("click", () => void addFile());
$("open-folder").addEventListener("click", () => {
  if (current) void invoke("open_brand_dir", { slug: current.slug });
});
$("close").addEventListener("click", () => void close());

async function close() {
  if (dirty && !confirm("Close without saving?")) return;
  await getCurrentWindow().close();
}

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void save();
  } else if (e.key === "Escape") {
    e.preventDefault();
    void close();
  }
});

void listen("brands-changed", () => {
  if (!dirty) void reload(current?.slug ?? null);
});

void reload(new URLSearchParams(location.search).get("select"));
