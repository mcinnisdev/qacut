// The prompt library: a window for every text QACut puts on the clipboard
// and for the prompts the user adds. Built-ins can be rewritten and reset;
// the user's own have a name and a kind (quick shot or bundle) and are
// picked from the quick shot window or the bundle window's purpose menu.
// Nothing is written until Save; the preview fills the placeholders with
// sample values so the shape can be checked before it is used.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type BuiltinKey = "quick_entry" | "quick_batch" | "fix" | "document" | "deliverable_markdown" | "deliverable_html";

interface CustomPrompt {
  id: string;
  name: string;
  kind: "quick" | "bundle";
  template: string;
}

type Prompts = Record<BuiltinKey, string> & { custom: CustomPrompt[] };

interface BuiltinInfo {
  key: BuiltinKey;
  name: string;
  about: string;
  placeholders: [string, string][];
}

const SAMPLE: Record<string, string> = {
  "{path}": "C:\\Users\\nick\\QACut\\Quick\\2026-09-19_101512\\01.png",
  "{note}": "The save button is clipped at 125% scaling.",
  "{count}": "3",
  "{dir}": "C:\\Users\\nick\\QACut\\Quick\\2026-09-19_101512",
  "{entries}":
    "C:\\Users\\nick\\QACut\\Quick\\2026-09-19_101512\\01.png\nThe save button is clipped at 125% scaling.\n\nC:\\Users\\nick\\QACut\\Quick\\2026-09-19_101512\\02.png\nThis toggle never saves.",
  "{shots}":
    "C:\\Users\\nick\\QACut\\Quick\\2026-09-19_101512\\01.png\nThe save button is clipped at 125% scaling.",
  "{location}": "the QA bundle at C:\\Users\\nick\\QACut\\2026-09-19_143022-settings-review",
  "{root}": "C:\\Users\\nick\\QACut\\2026-09-19_143022-settings-review",
  "{name}": "Settings review",
  "{deliverable}": "(the Markdown or web page deliverable text)",
};

const BUILTINS: BuiltinInfo[] = [
  {
    key: "quick_entry",
    name: "Quick shot: one shot",
    about: "What Ctrl+Enter copies for a single quick shot.",
    placeholders: [["{path}", "the screenshot's path"], ["{note}", "your note"]],
  },
  {
    key: "quick_batch",
    name: "Quick shot: a batch",
    about: "What Ctrl+Enter copies when the batch has more than one shot.",
    placeholders: [["{count}", "how many"], ["{dir}", "the batch folder"], ["{entries}", "one 'one shot' entry per shot"]],
  },
  {
    key: "fix",
    name: "Bundle: Fix issues",
    about: "The agent prompt for a bundle whose purpose is Fix issues.",
    placeholders: [["{location}", "the folder path, or 'the attached ZIP'"], ["{root}", "the folder path"], ["{name}", "the bundle name"]],
  },
  {
    key: "document",
    name: "Bundle: Write process doc",
    about: "The agent prompt for a bundle whose purpose is Write process doc.",
    placeholders: [["{location}", "the folder path, or 'the attached ZIP'"], ["{deliverable}", "the Markdown or web page text below"], ["{root}", "the folder path"], ["{name}", "the bundle name"]],
  },
  {
    key: "deliverable_markdown",
    name: "Process doc as Markdown",
    about: "What {deliverable} becomes when the document format is Markdown.",
    placeholders: [],
  },
  {
    key: "deliverable_html",
    name: "Process doc as web page",
    about: "What {deliverable} becomes when the document format is a web page.",
    placeholders: [],
  },
];

const KIND_PLACEHOLDERS: Record<"quick" | "bundle", [string, string][]> = {
  quick: [["{shots}", "the shots' paths and notes; left out, they are appended"]],
  bundle: [["{root}", "the folder path; left out, it is appended"], ["{name}", "the bundle name"]],
};

const KIND_ABOUT: Record<"quick" | "bundle", string> = {
  quick: "Picked from \"Agent hand-off\" in the quick shot window. Wraps the shots you hand off.",
  bundle: "Picked from the purpose menu in the bundle window. The whole instruction for the bundle.",
};

type Selection = { type: "builtin"; key: BuiltinKey } | { type: "custom"; id: string };

const listBuiltin = document.getElementById("list-builtin") as HTMLDivElement;
const listCustom = document.getElementById("list-custom") as HTMLDivElement;
const customFields = document.getElementById("custom-fields") as HTMLDivElement;
const nameEl = document.getElementById("name") as HTMLInputElement;
const kindEl = document.getElementById("kind") as HTMLSelectElement;
const about = document.getElementById("about") as HTMLParagraphElement;
const placeholders = document.getElementById("placeholders") as HTMLDivElement;
const template = document.getElementById("template") as HTMLTextAreaElement;
const preview = document.getElementById("preview") as HTMLPreElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const resetBtn = document.getElementById("reset") as HTMLButtonElement;
const duplicateBtn = document.getElementById("duplicate") as HTMLButtonElement;
const deleteBtn = document.getElementById("delete") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;

let defaults: Prompts | null = null;
let current: Prompts | null = null;
let selected: Selection = { type: "builtin", key: "quick_entry" };
let dirty = false;

function status(text: string, hold = false) {
  statusEl.textContent = text;
  if (!hold) {
    window.setTimeout(() => {
      if (statusEl.textContent === text) statusEl.textContent = "";
    }, 2500);
  }
}

function resolvedBuiltin(key: BuiltinKey): string {
  if (!current || !defaults) return "";
  return current[key].trim() ? current[key] : defaults[key];
}

function customById(id: string): CustomPrompt | undefined {
  return current?.custom.find((p) => p.id === id);
}

function setDirty(d: boolean) {
  dirty = d;
  saveBtn.textContent = d ? "Save changes" : "Saved";
  saveBtn.disabled = !d;
}

// ------------------------------------------------------------- list

function renderList() {
  listBuiltin.replaceChildren();
  listCustom.replaceChildren();
  if (!current || !defaults) return;
  for (const b of BUILTINS) {
    const item = document.createElement("button");
    item.className = "lib-item";
    item.classList.toggle("on", selected.type === "builtin" && selected.key === b.key);
    const name = document.createElement("span");
    name.textContent = b.name;
    item.append(name);
    if (current[b.key].trim()) {
      const tag = document.createElement("i");
      tag.textContent = "edited";
      item.append(tag);
    }
    item.addEventListener("click", () => select({ type: "builtin", key: b.key }));
    listBuiltin.append(item);
  }
  if (current.custom.length === 0) {
    const empty = document.createElement("div");
    empty.className = "lib-empty";
    empty.textContent = "None yet. New adds one.";
    listCustom.append(empty);
  }
  for (const p of current.custom) {
    const item = document.createElement("button");
    item.className = "lib-item";
    item.classList.toggle("on", selected.type === "custom" && selected.id === p.id);
    const name = document.createElement("span");
    name.textContent = p.name.trim() || "Untitled prompt";
    const tag = document.createElement("i");
    tag.textContent = p.kind === "quick" ? "quick shot" : "bundle";
    item.append(name, tag);
    item.addEventListener("click", () => select({ type: "custom", id: p.id }));
    listCustom.append(item);
  }
}

// ----------------------------------------------------------- editor

function renderPlaceholders(list: [string, string][]) {
  placeholders.replaceChildren();
  if (list.length === 0) return;
  const lead = document.createElement("span");
  lead.className = "lib-ph-lead";
  lead.textContent = "Filled in:";
  placeholders.append(lead);
  for (const [ph, what] of list) {
    const chip = document.createElement("button");
    chip.className = "lib-ph";
    chip.type = "button";
    chip.title = `${what}. Click to insert at the cursor.`;
    chip.textContent = ph;
    chip.addEventListener("click", () => {
      const s = template.selectionStart;
      const e = template.selectionEnd;
      template.setRangeText(ph, s, e, "end");
      template.focus();
      onEdit();
    });
    placeholders.append(chip);
  }
}

function renderPreview() {
  let text = template.value;
  if (selected.type === "custom") {
    const p = customById(selected.id);
    if (p?.kind === "quick" || (p === undefined && kindEl.value === "quick")) {
      text = text.includes("{shots}") ? text : `${text.trim()}\n\n{shots}`;
    } else if (!text.includes("{root}")) {
      text = `${text.trim()}\n\nThe bundle is at {root}. Start with bundle.md.`;
    }
  }
  for (const [ph, val] of Object.entries(SAMPLE)) text = text.split(ph).join(val);
  preview.textContent = text.trim();
}

function select(sel: Selection) {
  if (dirty && !confirm("Discard unsaved changes to this prompt?")) return;
  selected = sel;
  renderList();
  if (!current || !defaults) return;
  if (sel.type === "builtin") {
    const info = BUILTINS.find((b) => b.key === sel.key)!;
    customFields.hidden = true;
    about.textContent = info.about;
    renderPlaceholders(info.placeholders);
    template.value = resolvedBuiltin(sel.key);
    resetBtn.hidden = !current[sel.key].trim();
    duplicateBtn.hidden = !(sel.key === "fix" || sel.key === "document");
    deleteBtn.hidden = true;
  } else {
    const p = customById(sel.id);
    if (!p) return;
    customFields.hidden = false;
    nameEl.value = p.name;
    kindEl.value = p.kind;
    about.textContent = KIND_ABOUT[p.kind];
    renderPlaceholders(KIND_PLACEHOLDERS[p.kind]);
    template.value = p.template;
    resetBtn.hidden = true;
    duplicateBtn.hidden = true;
    deleteBtn.hidden = false;
  }
  setDirty(false);
  renderPreview();
}

function onEdit() {
  setDirty(true);
  if (selected.type === "builtin") {
    resetBtn.hidden = !defaults || template.value.trim() === defaults[selected.key].trim();
  } else {
    about.textContent = KIND_ABOUT[kindEl.value as "quick" | "bundle"];
    renderPlaceholders(KIND_PLACEHOLDERS[kindEl.value as "quick" | "bundle"]);
  }
  renderPreview();
}

// ------------------------------------------------------------ actions

async function save() {
  if (!current || !defaults) return;
  if (selected.type === "builtin") {
    // A built-in left at its default is stored empty, so a better default
    // in a later release reaches it.
    current[selected.key] = template.value.trim() === defaults[selected.key].trim() ? "" : template.value;
  } else {
    const p = customById(selected.id);
    if (!p) return;
    p.name = nameEl.value.trim();
    p.kind = kindEl.value as "quick" | "bundle";
    p.template = template.value;
  }
  try {
    await invoke("set_prompts", { prompts: current });
    setDirty(false);
    renderList();
    status("Saved");
  } catch (err) {
    status(String(err), true);
  }
}

function addPrompt(seed?: Partial<CustomPrompt>) {
  if (!current) return;
  if (dirty && !confirm("Discard unsaved changes to this prompt?")) return;
  const p: CustomPrompt = {
    id: `p_${Date.now().toString(36)}`,
    name: seed?.name ?? "",
    kind: seed?.kind ?? "quick",
    template: seed?.template ?? "",
  };
  current.custom.push(p);
  dirty = false;
  select({ type: "custom", id: p.id });
  setDirty(true);
  nameEl.focus();
}

async function deletePrompt() {
  if (!current || selected.type !== "custom") return;
  const p = customById(selected.id);
  if (!p) return;
  if (!confirm(`Delete "${p.name.trim() || "Untitled prompt"}"?`)) return;
  current.custom = current.custom.filter((x) => x.id !== p.id);
  dirty = false;
  try {
    await invoke("set_prompts", { prompts: current });
    status("Deleted");
  } catch (err) {
    status(String(err), true);
  }
  select({ type: "builtin", key: "quick_entry" });
}

saveBtn.addEventListener("click", () => void save());
resetBtn.addEventListener("click", () => {
  if (!defaults || selected.type !== "builtin") return;
  template.value = defaults[selected.key];
  onEdit();
});
duplicateBtn.addEventListener("click", () => {
  const sel = selected;
  if (sel.type !== "builtin") return;
  const info = BUILTINS.find((b) => b.key === sel.key)!;
  addPrompt({ name: `My ${info.name.replace("Bundle: ", "").toLowerCase()}`, kind: "bundle", template: template.value });
});
deleteBtn.addEventListener("click", () => void deletePrompt());
(document.getElementById("add") as HTMLButtonElement).addEventListener("click", () => addPrompt());
(document.getElementById("close") as HTMLButtonElement).addEventListener("click", () => void close());
template.addEventListener("input", onEdit);
nameEl.addEventListener("input", onEdit);
kindEl.addEventListener("change", onEdit);

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

async function boot() {
  try {
    const set = await invoke<{ defaults: Prompts; current: Prompts }>("get_prompts");
    defaults = set.defaults;
    current = set.current;
    current.custom = current.custom ?? [];
  } catch (err) {
    status(`Could not load prompts: ${String(err)}`, true);
    return;
  }
  const focus = new URLSearchParams(location.search).get("select");
  if (focus && customById(focus)) selected = { type: "custom", id: focus };
  select(selected);
}

void boot();
