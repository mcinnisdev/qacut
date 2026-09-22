import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppState, BundleInfo, Export } from "./types";

const body = document.getElementById("body") as HTMLDivElement;
const count = document.getElementById("count") as HTMLSpanElement;
const bundleName = document.getElementById("bundle-name") as HTMLInputElement;
const purpose = document.getElementById("purpose") as HTMLSelectElement;
const docFormat = document.getElementById("doc-format") as HTMLSelectElement;
const custom = document.getElementById("custom") as HTMLDivElement;
const customPrompt = document.getElementById("custom-prompt") as HTMLTextAreaElement;
const menubar = document.getElementById("menubar") as HTMLElement;
const bundles = document.getElementById("bundles") as HTMLDivElement;
const bundlesList = document.getElementById("bundles-list") as HTMLDivElement;
const bundlesClose = document.getElementById("bundles-close") as HTMLButtonElement;
const brand = document.getElementById("brand") as HTMLDivElement;
const brandClose = document.getElementById("brand-close") as HTMLButtonElement;
const brandInclude = document.getElementById("brand-include") as HTMLInputElement;
const brandFiles = document.getElementById("brand-files") as HTMLSpanElement;
const brandOpen = document.getElementById("brand-open") as HTMLButtonElement;
const brandNotes = document.getElementById("brand-notes") as HTMLTextAreaElement;
const shortcuts = document.getElementById("shortcuts") as HTMLDivElement;
const shortcutRows = document.getElementById("shortcut-rows") as HTMLDivElement;

// ------------------------------------------------------------ shortcuts

interface Hotkeys {
  capture: string;
  quick: string;
  quick_finish: string;
  record: string;
  studio: string;
  zoom: string;
  group: string;
  peek: string;
  finish: string;
}

const HOTKEY_LABELS: [keyof Hotkeys, string][] = [
  ["quick", "Quick shot"],
  ["quick_finish", "Copy quick batch for agent"],
  ["capture", "Capture"],
  ["record", "Auto-capture start / stop"],
  ["group", "New group"],
  ["peek", "View / edit bundle"],
  ["finish", "Finish bundle and copy for agent"],
  ["studio", "Studio: record start / stop"],
  ["zoom", "Studio: zoom start / end (only active while recording)"],
];

let hk: Hotkeys = {
  quick: "CommandOrControl+Shift+1",
  quick_finish: "",
  capture: "CommandOrControl+Shift+2",
  record: "CommandOrControl+Shift+3",
  studio: "CommandOrControl+Shift+R",
  zoom: "CommandOrControl+Space",
  group: "CommandOrControl+Shift+G",
  peek: "CommandOrControl+Shift+Q",
  finish: "CommandOrControl+Shift+Enter",
};

/// "CommandOrControl+Shift+N" as people read it.
function keyLabel(spec: string) {
  return spec
    .replace(/CommandOrControl|CmdOrCtrl|Control/g, "Ctrl")
    .replace(/Super|Meta/g, "Win")
    .replace(/Option/g, "Alt")
    .replace(/Return/g, "Enter");
}

/// The chord a keydown represents, in the shortcut parser's spelling, or
/// null while only modifiers are held.
function chordFrom(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("CommandOrControl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (code === "Enter" || code === "NumpadEnter") key = "Enter";
  else if (code === "Space") key = "Space";
  else if (code === "Escape") key = "Escape";
  else if (code === "Tab") key = "Tab";
  else if (code === "Backspace") key = "Backspace";
  else if (code === "Delete") key = "Delete";
  else if (/^Arrow(Up|Down|Left|Right)$/.test(code)) key = code.replace("Arrow", "");
  else if (code === "Home" || code === "End" || code === "PageUp" || code === "PageDown") key = code;
  else if (code === "Minus") key = "-";
  else if (code === "Equal") key = "=";
  else if (code === "Comma") key = ",";
  else if (code === "Period") key = ".";
  else if (code === "Slash") key = "/";
  else if (code === "Backquote") key = "`";
  else if (code === "BracketLeft") key = "[";
  else if (code === "BracketRight") key = "]";
  else if (code === "Semicolon") key = ";";
  else if (code === "Quote") key = "'";
  else if (code === "Backslash") key = "\\";
  if (!key) return null;
  return [...mods, key].join("+");
}

let draft: Hotkeys = { ...hk };

// The keys that only work inside a window, for reference. Where one
// names a global shortcut it reads the live binding.
function windowKeys(): [string, [string, string][]][] {
  return [
    [
      "Quick shot window",
      [
        ["Ctrl+C", "copy the picture, with the note printed under it if you wrote one"],
        ["Ctrl+Shift+A", "copy for an agent: the path and note as text"],
        ["Ctrl+B", "add to the batch, to hand several shots to an agent at once"],
        ["Esc", "discard the shot"],
        [keyLabel(hk.quick), "take another shot"],
      ],
    ],
    [
      "Note box (bundle capture)",
      [
        ["Enter", "save"],
        ["Shift+Enter", "new line"],
        ["Esc", "keep the shot with no note"],
        ["Ctrl+E", "open the shot in the markup editor"],
      ],
    ],
    [
      "Review and markup",
      [
        ["M A H B S T", "move, arrow, highlight, blur, step counter, text label"],
        ["← →", "previous / next shot (Ctrl+← → while typing)"],
        ["Arrow keys", "nudge the selected mark; Shift for ten"],
        ["Delete", "remove the selected mark"],
        ["Ctrl+Z", "undo"],
        ["Ctrl+S", "save"],
        ["Ctrl+C", "copy the picture with the note under it"],
        ["Esc", "deselect, then close"],
      ],
    ],
    [
      "Capture overlay",
      [
        ["Esc or right-click", "cancel"],
        ["Enter", "start recording after adjusting the region"],
      ],
    ],
    [
      "Studio",
      [
        ["Space", "play / pause"],
        ["← →", "step one second; Shift for five"],
        ["I O", "video starts / ends at the playhead"],
        ["X", "cut: once at the start of a stretch, once where it resumes"],
        ["Delete", "remove the selected zoom or cut"],
        [keyLabel(hk.zoom), "zoom in here / out, while recording"],
      ],
    ],
  ];
}

function renderShortcutRef() {
  const ref = document.getElementById("shortcut-ref") as HTMLDivElement;
  ref.replaceChildren();
  for (const [group, keys] of windowKeys()) {
    const head = document.createElement("div");
    head.className = "shortcut-group";
    head.textContent = group;
    ref.append(head);
    for (const [k, what] of keys) {
      const row = document.createElement("div");
      row.className = "shortcut-ref-row";
      const key = document.createElement("kbd");
      key.textContent = k;
      const desc = document.createElement("span");
      desc.textContent = what;
      row.append(key, desc);
      ref.append(row);
    }
  }
}

function renderShortcuts() {
  renderShortcutRef();
  shortcutRows.replaceChildren();
  for (const [id, label] of HOTKEY_LABELS) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const name = document.createElement("span");
    name.textContent = label;
    const field = document.createElement("input");
    field.type = "text";
    field.readOnly = true;
    field.value = keyLabel(draft[id]);
    field.placeholder = "off";
    field.title = "Press the keys to use";
    field.addEventListener("keydown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Backspace" || e.key === "Delete") {
        draft[id] = "";
        field.value = "";
        return;
      }
      const chord = chordFrom(e);
      if (!chord) return;
      if (!/CommandOrControl|Alt/.test(chord)) {
        toast("Global shortcuts need Ctrl or Alt");
        return;
      }
      draft[id] = chord;
      field.value = keyLabel(chord);
    });
    const clear = document.createElement("button");
    clear.className = "quiet small";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => {
      draft[id] = "";
      field.value = "";
    });
    row.append(name, field, clear);
    shortcutRows.append(row);
  }
}

async function showShortcuts() {
  hk = await invoke<Hotkeys>("get_hotkeys");
  draft = { ...hk };
  renderShortcuts();
  showPanel(shortcuts);
}

async function saveShortcuts() {
  const dupes = new Set<string>();
  const seen = new Map<string, string>();
  for (const [id] of HOTKEY_LABELS) {
    const v = draft[id];
    if (!v) continue;
    if (seen.has(v)) dupes.add(keyLabel(v));
    seen.set(v, id);
  }
  if (dupes.size) {
    toast(`Used twice: ${[...dupes].join(", ")}`);
    return;
  }
  try {
    const problems = await invoke<string[]>("set_hotkeys", { hotkeys: draft });
    hk = { ...draft };
    toast(problems.length ? problems.map(keyLabel).join(". ") : "Shortcuts saved");
  } catch (err) {
    toast(String(err));
  }
}
const exported = document.getElementById("exported") as HTMLDivElement;
const exportedLabel = document.getElementById("exported-label") as HTMLElement;
const exportedPath = document.getElementById("exported-path") as HTMLElement;

function frameLabel(f: { at_ms: number; event: string; x: number | null; y: number | null }) {
  const secs = Math.round(f.at_ms / 1000);
  let s = `${secs} s`;
  if (f.event) s += `, ${f.event}`;
  if (f.x !== null && f.y !== null) s += ` at ${f.x},${f.y}`;
  return s;
}

function clock(ms: number) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Drag state for reordering shots. The DOM is rebuilt after every move, so
// nothing here has to survive a render.
let dragging: { group: number; shot: string } | null = null;

async function moveShot(group: number, shot: string, toGroup: number, toIndex: number) {
  try {
    await invoke("move_shot", { group, shot, toGroup, toIndex });
  } catch (err) {
    console.error(err);
  }
}

// Bumped on every render so edited images are refetched, not served from
// the webview's cache.
let stamp = Date.now();

function fileUrl(path: string) {
  return `${convertFileSrc(path)}?v=${stamp}`;
}

async function render() {
  stamp = Date.now();
  // Never yank the DOM out from under someone mid-sentence.
  const active = document.activeElement;
  if (
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLInputElement
  ) {
    return;
  }

  const state = await invoke<AppState>("get_state");
  const session = state.session;
  body.replaceChildren();

  // Name, purpose and brand can be set before the first capture; the
  // backend starts a session on demand.
  bundleName.value = session?.name ?? "";
  purpose.value =
    session?.purpose === "saved" && session.prompt_id ? `saved:${session.prompt_id}` : (session?.purpose ?? "fix");
  if (!purpose.value) purpose.value = "fix";
  docFormat.value = session?.doc_format ?? "markdown";
  // The format only matters for a document, and the web page variant is
  // what makes recordings pay off: clips play inline instead of stills.
  docFormat.hidden = purpose.value !== "document";
  custom.hidden = purpose.value !== "custom";
  customPrompt.value = state.custom_prompt;

  brandInclude.checked = session?.include_brand ?? true;
  brandNotes.value = state.brand.notes;
  const n = state.brand.files.length;
  brandFiles.textContent =
    n === 0 ? "no files yet" : `${n} file${n === 1 ? "" : "s"}`;
  void invoke<{ active: boolean; brand: { name: string } }[]>("list_brands")
    .then((bs) => {
      const a = bs.find((b) => b.active);
      if (a) brandFiles.textContent = `${a.brand.name} · ${brandFiles.textContent}`;
    })
    .catch(() => {});

  const shots = session?.groups.reduce((n, g) => n + g.shots.length, 0) ?? 0;
  const used = session?.groups.filter((g) => g.shots.length > 0).length ?? 0;
  count.textContent = session ? `${shots} in ${used || 1} groups` : "";

  if (state.last_export) {
    showExported(state.last_export, state.dirty, state.finished);
  } else {
    exported.style.display = "none";
  }

  if (!session || shots === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = session
      ? `Nothing captured yet. Name the bundle and its first group above if you like, then press ${keyLabel(hk.capture)}, drag a region, type what is wrong, and hit Enter.`
      : `Nothing captured yet. Press ${keyLabel(hk.capture)}, drag a region, type what is wrong, and hit Enter. Shots land in the current group until you start a new one.`;
    body.append(empty);
    if (!session) return;
  }

  for (const g of session.groups) {
    // An empty, untitled group is hidden unless it is where the next
    // capture lands, so a fresh bundle's first group can be named up front.
    const untouched = g.shots.length === 0 && !g.title && !g.master_note;
    if (untouched && g.index !== session.current) continue;

    const wrap = document.createElement("div");
    wrap.className = "group";

    // Dropping on the group itself appends to it.
    wrap.addEventListener("dragover", (e) => {
      if (!dragging) return;
      e.preventDefault();
      wrap.classList.add("drop-into");
    });
    wrap.addEventListener("dragleave", () => wrap.classList.remove("drop-into"));
    wrap.addEventListener("drop", (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      wrap.classList.remove("drop-into");
      const d = dragging;
      dragging = null;
      void moveShot(d.group, d.shot, g.index, g.shots.length);
    });

    const head = document.createElement("div");
    head.className = "group-head";

    const num = document.createElement("span");
    num.className = "group-num";
    num.textContent = String(g.index).padStart(2, "0");

    const nameInput = document.createElement("input");
    nameInput.value = g.title;
    nameInput.placeholder = `Group ${g.index}`;
    nameInput.setAttribute("aria-label", `Name for group ${g.index}`);

    // Where the next capture lands. Clicking an earlier group points new
    // shots back at it.
    const target = document.createElement("button");
    target.className = "target";
    if (g.index === session.current) {
      target.classList.add("active");
      target.textContent = "Capturing here";
      target.disabled = true;
      wrap.classList.add("current");
    } else {
      target.textContent = "Capture here";
      target.addEventListener("click", () =>
        void invoke("set_current_group", { group: g.index }),
      );
    }

    head.append(num, nameInput, target);

    const master = document.createElement("textarea");
    master.className = "master";
    master.value = g.master_note;
    master.placeholder = "Master note for this group";
    master.setAttribute("aria-label", `Master note for group ${g.index}`);

    const saveGroup = () =>
      void invoke("set_group_note", {
        group: g.index,
        title: nameInput.value,
        masterNote: master.value,
      });
    nameInput.addEventListener("change", saveGroup);
    master.addEventListener("change", saveGroup);

    wrap.append(head, master);

    g.shots.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "shot";
      row.draggable = true;

      row.addEventListener("dragstart", (e) => {
        dragging = { group: g.index, shot: s.id };
        row.classList.add("dragging");
        e.dataTransfer?.setData("text/plain", s.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        dragging = null;
        document
          .querySelectorAll(".drop-before, .drop-into")
          .forEach((el) => el.classList.remove("drop-before", "drop-into"));
      });
      // Dropping on a shot places the dragged one before it.
      row.addEventListener("dragover", (e) => {
        if (!dragging || dragging.shot === s.id) return;
        e.preventDefault();
        e.stopPropagation();
        row.classList.add("drop-before");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-before"));
      row.addEventListener("drop", (e) => {
        if (!dragging || dragging.shot === s.id) return;
        e.preventDefault();
        e.stopPropagation();
        const d = dragging;
        dragging = null;
        // Leaving a slot earlier in the same group shifts the target up one.
        const before = g.shots.findIndex((x) => x.id === d.shot);
        const idx = d.group === g.index && before !== -1 && before < i ? i - 1 : i;
        void moveShot(d.group, d.shot, g.index, idx);
      });

      const isRec = s.kind === "recording";
      const label = `${g.index}.${i + 1}`;
      const left = document.createElement("div");
      const img = document.createElement("img");
      img.src = fileUrl(s.abs_path);
      img.alt = `${isRec ? "Recording" : "Screenshot"} ${label}`;
      // The thumbnail and Edit both open the review view: the shot large,
      // markup tools, its note, and arrows to the rest of the bundle.
      img.title = isRec ? "Open" : "Review: markup, note, next and previous";
      img.addEventListener("click", () =>
        isRec
          ? void invoke("open_path", { path: s.abs_path })
          : void invoke("review_shot", { group: g.index, shot: s.id }),
      );

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = isRec
        ? `${label}  ${clock(s.duration_ms)}  ${s.width}x${s.height}${s.video ? "  GIF+MP4" : "  GIF"}`
        : `${label}  ${s.width}x${s.height}`;
      left.append(img, meta);
      if (s.moment) {
        // An auto-captured still says when it was taken and on what action,
        // so the sequence can be read and cleaned up at a glance.
        const when = document.createElement("div");
        when.className = "meta moment";
        when.textContent = `auto · ${frameLabel({ at_ms: s.moment.at_ms, event: s.moment.event, x: s.moment.x, y: s.moment.y })}`;
        left.append(when);
      }

      if (!isRec) {
        const edit = document.createElement("button");
        edit.className = "quiet small";
        edit.textContent = "Review";
        edit.title = "Open large: markup, note, and arrows to the next shot";
        edit.addEventListener("click", () =>
          void invoke("review_shot", { group: g.index, shot: s.id }),
        );
        left.append(edit);
      }

      const middle = document.createElement("div");
      middle.className = "shot-fields";

      const title = document.createElement("input");
      title.className = "shot-title";
      title.value = s.title;
      title.placeholder = `${isRec ? "Recording" : "Shot"} ${i + 1}`;
      title.setAttribute("aria-label", `Name for screenshot ${g.index}.${i + 1}`);

      const text = document.createElement("textarea");
      text.value = s.note;
      text.placeholder = "No note";
      text.setAttribute("aria-label", `Note for screenshot ${g.index}.${i + 1}`);

      const saveShot = () =>
        void invoke("set_shot_note", {
          group: g.index,
          shot: s.id,
          note: text.value,
          title: title.value,
        });
      title.addEventListener("change", saveShot);
      text.addEventListener("change", saveShot);
      middle.append(title, text);

      const side = document.createElement("div");
      side.className = "shot-side";

      const up = document.createElement("button");
      up.className = "order";
      up.textContent = "\u25b2";
      up.title = "Move up";
      up.setAttribute("aria-label", `Move ${g.index}.${i + 1} up`);
      up.disabled = i === 0;
      up.addEventListener("click", () => void moveShot(g.index, s.id, g.index, i - 1));

      const down = document.createElement("button");
      down.className = "order";
      down.textContent = "\u25bc";
      down.title = "Move down";
      down.setAttribute("aria-label", `Move ${g.index}.${i + 1} down`);
      down.disabled = i === g.shots.length - 1;
      down.addEventListener("click", () => void moveShot(g.index, s.id, g.index, i + 1));

      const del = document.createElement("button");
      del.className = "remove";
      del.textContent = "\u00d7";
      del.title = "Remove this screenshot";
      del.setAttribute("aria-label", `Remove screenshot ${g.index}.${i + 1}`);
      del.addEventListener("click", async () => {
        await invoke("delete_shot", { group: g.index, shot: s.id });
        await render();
      });

      side.append(up, down, del);
      row.append(left, middle, side);
      wrap.append(row);

      // A recording's stills, in order, so a bad one can be cut or a
      // sensitive one blurred before the bundle goes anywhere.
      if (isRec && s.frames.length > 0) {
        const strip = document.createElement("div");
        strip.className = "frames";
        const groupDir = `${session.root}/${g.dir}`;
        s.frames.forEach((f, k) => {
          const path = `${groupDir}/${f.file}`;
          const cell = document.createElement("div");
          cell.className = "frame";

          const thumb = document.createElement("img");
          thumb.src = fileUrl(path);
          thumb.alt = `Frame ${k + 1} of ${label}`;
          thumb.title = frameLabel(f);
          thumb.addEventListener("click", () =>
            void invoke("edit_shot", { path, label: `Edit ${label} frame ${k + 1}` }),
          );

          const cap = document.createElement("div");
          cap.className = "frame-cap";
          cap.textContent = frameLabel(f);

          const cut = document.createElement("button");
          cut.className = "frame-cut";
          cut.textContent = "\u00d7";
          cut.title = "Remove this frame";
          cut.setAttribute("aria-label", `Remove frame ${k + 1} of ${label}`);
          cut.addEventListener("click", () =>
            void call("remove_frame", { group: g.index, shot: s.id, file: f.file }),
          );

          cell.append(thumb, cap, cut);
          strip.append(cell);
        });
        wrap.append(strip);
      }
    });

    body.append(wrap);
  }
}

function showExported(result: Export, dirty: boolean, finished: boolean) {
  exported.style.display = "flex";
  exportedLabel.textContent = dirty
    ? "Changed since it was last written to"
    : finished
      ? "Finished. The next capture starts a new bundle; Capture here on a group adds to this one. Written to"
      : "Bundle written to";
  exportedPath.textContent = result.root;
}

type Action = "path" | "prompt" | "markdown" | "open" | "zip" | "chatprompt";

const doneText: Record<Action, string> = {
  path: "Folder path copied",
  prompt: "Agent prompt copied",
  markdown: "Markdown copied",
  open: "Folder opened",
  zip: "ZIP saved beside the bundle and chat prompt copied",
  chatprompt: "Chat prompt copied",
};

const toastEl = document.getElementById("toast") as HTMLDivElement;
let toastTimer = 0;

function toast(text: string) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 1600);
}

// Every hand-off action writes the bundle first, so what gets copied or
// opened is never stale.
// A finished process document straight from the bundle: the group is the
// section, its master note the intro, each shot a numbered step. The web
// page embeds the images so it can be sent as one file; the Markdown sits
// beside them for a docs platform. No agent in the loop unless you want
// the prose polished.
async function exportDoc(format: "html" | "markdown") {
  try {
    const path = await invoke<string>("export_document", { format });
    toast(`Document written: ${path.split(/[\\/]/).pop()}`);
  } catch (err) {
    toast(String(err));
  }
  await render();
}

async function run(action: Action) {
  try {
    const result = await invoke<Export>("finish", { action });
    showExported(result, false, true);
    toast(doneText[action]);
  } catch (err) {
    toast(String(err));
  }
}

async function call(command: string, args?: Record<string, unknown>, done?: string) {
  try {
    await invoke(command, args);
    if (done) toast(done);
  } catch (err) {
    toast(String(err));
  }
  await render();
}

// ------------------------------------------------------------ panels

function showPanel(panel: HTMLElement, focus?: HTMLElement) {
  for (const p of [bundles, brand, custom, shortcuts]) p.hidden = p !== panel;
  focus?.focus();
}

function hidePanels() {
  for (const p of [bundles, brand, custom, shortcuts]) p.hidden = true;
}

// ------------------------------------------------------------ prompts

interface CustomPrompt {
  id: string;
  name: string;
  kind: "quick" | "bundle";
  template: string;
}
type Prompts = { custom: CustomPrompt[] };

// The saved bundle prompts show up in the purpose menu, so a hand-off can
// pick one without opening the prompts panel.
let savedPrompts: CustomPrompt[] = [];

async function loadSavedPrompts() {
  try {
    const set = await invoke<{ defaults: Prompts; current: Prompts }>("get_prompts");
    savedPrompts = set.current.custom ?? [];
  } catch {
    savedPrompts = [];
  }
  fillPurposeOptions();
}

function fillPurposeOptions() {
  const keep = purpose.value;
  purpose.replaceChildren();
  const add = (value: string, label: string) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    purpose.append(o);
  };
  add("fix", "Fix issues");
  add("document", "Write process doc");
  for (const p of savedPrompts.filter((p) => p.kind === "bundle")) add(`saved:${p.id}`, p.name || "Untitled prompt");
  add("custom", "Custom prompt");
  purpose.value = keep;
  if (purpose.value !== keep) purpose.value = "fix";
}



async function showBundles() {
  const list = await invoke<BundleInfo[]>("list_bundles");
  const state = await invoke<AppState>("get_state");
  const currentRoot = state.session?.root ?? "";
  bundlesList.replaceChildren();
  if (list.length === 0) {
    const none = document.createElement("div");
    none.className = "empty";
    none.textContent = "No bundles yet.";
    bundlesList.append(none);
  }
  for (const b of list) {
    const row = document.createElement("div");
    row.className = "bundle-row";
    if (b.path === currentRoot) row.classList.add("current");

    const name = document.createElement("span");
    name.className = "bundle-name-cell";
    name.textContent = b.name || b.id;

    const meta = document.createElement("span");
    meta.className = "bundle-meta";
    const when = b.started_at.slice(0, 16).replace("T", " ");
    meta.textContent = `${when}  ${b.shots} shot${b.shots === 1 ? "" : "s"} in ${b.groups} group${b.groups === 1 ? "" : "s"}`;

    const open = document.createElement("button");
    open.className = "btn";
    open.textContent = b.path === currentRoot ? "Open now" : "Open";
    open.disabled = b.path === currentRoot;
    open.addEventListener("click", async () => {
      try {
        await invoke("open_bundle", { path: b.path });
        hidePanels();
        await render();
      } catch (err) {
        toast(String(err));
      }
    });

    row.append(name, meta, open);
    bundlesList.append(row);
  }
  showPanel(bundles);
}

// ------------------------------------------------------------ menu bar

type Item =
  | "-"
  | {
      label: string;
      keys?: string;
      run: () => void | Promise<void>;
    };

interface Menu {
  title: string;
  items: () => Item[];
}

const menus: Menu[] = [
  {
    title: "Bundle",
    items: () => [
      { label: "New bundle", run: () => call("new_bundle", undefined, "Started a new bundle") },
      { label: "Open bundle…", run: showBundles },
      { label: "Rename bundle", run: () => bundleName.focus() },
      "-",
      { label: "Finish bundle and copy for agent", keys: keyLabel(hk.finish), run: () => run("path") },
      { label: "Open bundle folder", run: () => run("open") },
      "-",
      { label: "Close window", keys: "Esc", run: () => getCurrentWindow().close() },
    ],
  },
  {
    title: "Capture",
    items: () => [
      { label: "Quick shot", keys: keyLabel(hk.quick), run: () => call("start_quick") },
      { label: "Copy quick batch for agent", keys: keyLabel(hk.quick_finish), run: () => call("quick_finish", undefined, "Quick batch copied") },
      "-",
      { label: "Capture", keys: keyLabel(hk.capture), run: () => call("start_capture") },
      { label: "Auto-capture start / stop", keys: keyLabel(hk.record), run: () => call("start_record") },
      { label: "New group", keys: keyLabel(hk.group), run: () => call("start_group") },
      "-",
      { label: "Studio recording", keys: keyLabel(hk.studio), run: () => call("start_studio_from_menu") },
    ],
  },
  {
    title: "Hand off",
    items: () => [
      { label: "Export document as web page", run: () => exportDoc("html") },
      { label: "Export document as Markdown", run: () => exportDoc("markdown") },
      "-",
      { label: "Copy agent prompt", run: () => run("prompt") },
      { label: "Copy folder path", run: () => run("path") },
      { label: "Copy markdown", run: () => run("markdown") },
      "-",
      { label: "Save ZIP for chat", run: () => run("zip") },
      { label: "Copy chat prompt", run: () => run("chatprompt") },
      "-",
      { label: "Edit custom prompt…", run: () => showPanel(custom, customPrompt) },
      { label: "Prompt library…", run: () => call("open_prompt_library") },
      { label: "Brand kit…", run: () => showPanel(brand, brandNotes) },
    ],
  },
  {
    title: "Help",
    items: () => [
      { label: "Show bundle window", keys: keyLabel(hk.peek), run: () => toast("You are looking at it") },
      { label: "Keyboard shortcuts…", run: showShortcuts },
      { label: "Open QACut folder", run: () => call("open_base_folder") },
      "-",
      { label: "Quit QACut", run: () => call("quit") },
    ],
  },
];

let openMenu: HTMLElement | null = null;

function closeMenu() {
  openMenu?.remove();
  openMenu = null;
  menubar.querySelectorAll(".open").forEach((el) => el.classList.remove("open"));
}

function openMenuFor(button: HTMLButtonElement, menu: Menu) {
  closeMenu();
  button.classList.add("open");
  const list = document.createElement("div");
  list.className = "menu";
  list.setAttribute("role", "menu");
  for (const item of menu.items()) {
    if (item === "-") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      list.append(sep);
      continue;
    }
    const row = document.createElement("button");
    row.className = "menu-item";
    row.setAttribute("role", "menuitem");
    const label = document.createElement("span");
    label.textContent = item.label;
    row.append(label);
    if (item.keys) {
      const keys = document.createElement("span");
      keys.className = "menu-keys";
      keys.textContent = item.keys;
      row.append(keys);
    }
    row.addEventListener("click", () => {
      closeMenu();
      void item.run();
    });
    list.append(row);
  }
  list.style.left = `${button.offsetLeft}px`;
  menubar.append(list);
  openMenu = list;
}

for (const menu of menus) {
  const button = document.createElement("button");
  button.className = "menu-title";
  button.textContent = menu.title;
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (button.classList.contains("open")) closeMenu();
    else openMenuFor(button, menu);
  });
  // Sliding across titles while one is open switches menus.
  button.addEventListener("mouseenter", () => {
    if (openMenu && !button.classList.contains("open")) openMenuFor(button, menu);
  });
  menubar.append(button);
}

document.addEventListener("click", (e) => {
  if (openMenu && !menubar.contains(e.target as Node)) closeMenu();
});

// ------------------------------------------------------------ controls

const copyPrompt = document.getElementById("copy-prompt") as HTMLButtonElement;
const close = document.getElementById("close") as HTMLButtonElement;

copyPrompt.addEventListener("click", () => void run("prompt"));
close.addEventListener("click", () => void getCurrentWindow().close());
bundlesClose.addEventListener("click", hidePanels);
brandClose.addEventListener("click", hidePanels);
(document.getElementById("shortcuts-close") as HTMLButtonElement).addEventListener("click", hidePanels);
void loadSavedPrompts();
void listen("prompts-changed", () => void loadSavedPrompts());
(document.getElementById("shortcuts-save") as HTMLButtonElement).addEventListener("click", () => void saveShortcuts());
(document.getElementById("shortcuts-reset") as HTMLButtonElement).addEventListener("click", () => {
  draft = {
    quick: "CommandOrControl+Shift+1",
    quick_finish: "",
    capture: "CommandOrControl+Shift+2",
    record: "CommandOrControl+Shift+3",
    studio: "CommandOrControl+Shift+R",
    zoom: "CommandOrControl+Space",
    group: "CommandOrControl+Shift+G",
    peek: "CommandOrControl+Shift+Q",
    finish: "CommandOrControl+Shift+Enter",
  };
  renderShortcuts();
});

bundleName.addEventListener("change", async () => {
  try {
    await invoke("rename_bundle", { name: bundleName.value });
  } catch (err) {
    toast(String(err));
  }
  bundleName.blur();
  await render();
});
bundleName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") bundleName.blur();
});

purpose.addEventListener("change", async () => {
  if (purpose.value.startsWith("saved:")) {
    await invoke("set_saved_prompt", { id: purpose.value.slice(6) });
  } else {
    await invoke("set_purpose", { purpose: purpose.value });
  }
  docFormat.hidden = purpose.value !== "document";
  if (purpose.value === "custom") showPanel(custom, customPrompt);
  else custom.hidden = true;
});

(document.getElementById("export-doc") as HTMLButtonElement).addEventListener("click", () => {
  // The format follows the selector when the purpose is a document;
  // otherwise the web page, since that is the one you can send as-is.
  void exportDoc(purpose.value === "document" && docFormat.value === "markdown" ? "markdown" : "html");
});
docFormat.addEventListener("change", () => {
  void invoke("set_doc_format", { format: docFormat.value });
});

customPrompt.addEventListener("change", () => {
  void invoke("set_custom_prompt", { text: customPrompt.value });
});

brandInclude.addEventListener("change", () => {
  void invoke("set_include_brand", { include: brandInclude.checked });
});
brandOpen.addEventListener("click", () => void invoke("open_brand_folder"));
(document.getElementById("brand-manage") as HTMLButtonElement).addEventListener("click", () => void invoke("open_brands", { select: null }));
brandNotes.addEventListener("change", async () => {
  await invoke("set_brand_notes", { text: brandNotes.value });
  await render();
});

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (openMenu) {
    closeMenu();
    return;
  }
  if (!bundles.hidden || !brand.hidden || !shortcuts.hidden) {
    hidePanels();
    return;
  }
  void getCurrentWindow().close();
});

void listen("session-changed", () => void render());

void invoke<Hotkeys>("get_hotkeys").then((h) => {
  hk = h;
});

void render().then(() => {
  const focus = new URLSearchParams(location.search).get("focus");
  if (focus === "name") bundleName.focus();
  if (focus === "open") void showBundles();
  if (focus === "shortcuts") void showShortcuts();
});
