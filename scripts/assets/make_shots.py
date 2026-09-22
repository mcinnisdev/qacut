"""Produce the site's and docs' screenshots with QACut itself.

Run the app in drive mode first:

    set QACUT_DRIVE_DIR=%TEMP%\\qacut-drive
    npm run tauri dev

Then:

    python scripts/assets/make_shots.py [--studio=<recording folder name>]

The subject app is the fixture HTML under scripts/assets/fixtures, rendered
with headless Chrome at 1440x900 and cropped to regions, so every capture
looks like a real app and no real data appears. For the recording badge and
the capture overlay the fixture is opened in a real Chrome app window and
the screen region behind QACut's overlay is captured. Positions are
logical pixels; the primary screen here is 1536x960 at 125% scaling.

Output lands under site/public/media/<section>/ with the names in
notes/asset_list.csv. The user's own ~/QACut/prompts.json is set aside
for the run (two sample prompts are needed for the pictures) and put back.
"""
import json, os, pathlib, shutil, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
SITE = ROOT / "site"
MEDIA = SITE / "public" / "media"
FIX = ROOT / "scripts" / "assets" / "fixtures"
TMP = pathlib.Path(os.environ.get("TEMP", "/tmp")) / "qacut-fixtures"
DRIVE = pathlib.Path(os.environ.get("QACUT_DRIVE_DIR", str(pathlib.Path(os.environ.get("TEMP", "/tmp")) / "qacut-drive")))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
HOME = pathlib.Path.home()
PROMPTS = HOME / "QACut" / "prompts.json"
DOCS, UC, HOMEDIR = MEDIA / "docs", MEDIA / "use-cases", MEDIA / "home"

seq = int(time.time()) % 100000


def req(action, timeout=30, **kw):
    """Write one request and wait for its answer."""
    global seq
    seq += 1
    name = f"{seq:06d}"
    body = {"action": action, **kw}
    p = DRIVE / f"{name}.json"
    p.write_text(json.dumps(body), encoding="utf-8")
    done = DRIVE / f"{name}.done.json"
    t0 = time.time()
    while not done.exists():
        if time.time() - t0 > timeout:
            raise SystemExit(f"drive: no answer to {action} {kw} after {timeout}s; is the app running with QACUT_DRIVE_DIR={DRIVE}?")
        time.sleep(0.1)
    time.sleep(0.05)
    r = json.loads(done.read_text(encoding="utf-8"))
    done.unlink()
    if not r.get("ok"):
        raise SystemExit(f"drive: {action} failed: {r.get('error')}")
    shown = {k: v for k, v in kw.items() if k not in ("png", "marks", "js")}
    print(f"  {action} {shown} -> {r.get('result')}")
    return r.get("result")


def render(html, out, w=1440, h=900, crop=None):
    """Headless Chrome screenshot of a fixture page, optionally cropped to
    (x, y, cw, ch) by wrapping it in an offset iframe."""
    out.parent.mkdir(parents=True, exist_ok=True)
    src = FIX / html
    if crop:
        x, y, cw, ch = crop
        wrap = TMP / f"crop-{out.stem}.html"
        wrap.parent.mkdir(parents=True, exist_ok=True)
        wrap.write_text(
            f'<html><body style="margin:0;overflow:hidden;width:{cw}px;height:{ch}px">'
            f'<iframe src="file:///{src.as_posix()}" style="border:0;width:{w}px;height:{h}px;margin:{-y}px 0 0 {-x}px"></iframe>'
            f"</body></html>",
            encoding="utf-8",
        )
        target, ww, hh = wrap, cw, ch
    else:
        target, ww, hh = src, w, h
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
         f"--window-size={ww},{hh}", f"--screenshot={out}", f"file:///{target.as_posix()}"],
        check=True, capture_output=True,
    )
    return out


def render_url(path, out, w, h):
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--window-size={w},{h}", f"--screenshot={out}",
         f"file:///{pathlib.Path(path).as_posix()}"],
        check=True, capture_output=True,
    )


def app_window(html, x, y, w, h):
    """A real Chrome window on a fixture page, for QACut to overlay."""
    prof = TMP / "chrome-profile"
    p = subprocess.Popen(
        [CHROME, f"--app=file:///{(FIX / html).as_posix()}", f"--window-position={x},{y}", f"--window-size={w},{h}",
         f"--user-data-dir={prof}", "--no-first-run", "--no-default-browser-check"],
    )
    time.sleep(2.5)
    return p


def kill(p):
    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
    time.sleep(0.5)


def shot(label, out, delay=800):
    out = pathlib.Path(out)
    req("shot", label=label, out=str(out), delay_ms=delay)
    return out


def region(x, y, w, h, out, delay=800):
    out = pathlib.Path(out)
    req("region", x=x, y=y, w=w, h=h, out=str(out), delay_ms=delay)
    return out


def copy(src, *dests):
    for d in dests:
        pathlib.Path(d).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(src, d)


def close_all():
    for l in ["edit", "note", "peek", "prompts", "brands", "studio", "rec", "capture-"]:
        req("close", label=l)
    time.sleep(0.4)


def js_set(id_, text):
    return f"document.getElementById({json.dumps(id_)}).value = {json.dumps(text)};"


def marks(*ms):
    return json.dumps(list(ms))


def arrow(x1, y1, x2, y2):
    return {"kind": "arrow", "x1": x1, "y1": y1, "x2": x2, "y2": y2}


def blur(x, y, w, h):
    return {"kind": "blur", "x": x, "y": y, "w": w, "h": h}


def step(x, y, n):
    return {"kind": "step", "x": x, "y": y, "n": n}


# ---------------------------------------------------------------- fixtures

def fixtures():
    print("fixtures")
    f = {}
    f["settings"] = render("settings.html", TMP / "settings.png")
    f["billing"] = render("billing.html", TMP / "billing.png")
    f["onedrive"] = render("onedrive.html", TMP / "onedrive.png")
    # Regions of the pages, as a person would drag them.
    f["save"] = render("settings.html", TMP / "settings-save.png", crop=(232 + 48, 560, 700, 260))
    f["toggle"] = render("settings.html", TMP / "settings-toggle.png", crop=(232 + 48, 470, 700, 200))
    f["timezone"] = render("settings.html", TMP / "settings-timezone.png", crop=(232 + 48, 330, 700, 150))
    f["profile"] = render("settings.html", TMP / "settings-profile.png", crop=(232 + 48, 130, 760, 400))
    f["invoices"] = render("billing.html", TMP / "billing-invoices.png", crop=(232 + 48, 420, 760, 260))
    f["card"] = render("billing.html", TMP / "billing-card.png", crop=(232 + 48, 250, 760, 160))
    f["plan"] = render("billing.html", TMP / "billing-plan.png", crop=(232 + 48, 130, 760, 110))
    f["od-account"] = render("onedrive.html", TMP / "onedrive-account.png", crop=(340, 170, 760, 560))
    return f


# ---------------------------------------------------------------- prompts

SAMPLE_PROMPTS = {
    "custom": [
        {
            "id": "ask-for-a-diff",
            "name": "Ask for a diff",
            "kind": "quick",
            "template": "Look at each screenshot and its note, then propose the change as a diff before touching anything. Explain any note you are unsure about.\n\n{shots}",
        },
        {
            "id": "tailwind-refactor",
            "name": "Tailwind refactor",
            "kind": "bundle",
            "template": "Work through the QA bundle at {location}. Fix each noted issue, but move any inline styles you touch to Tailwind utility classes while you are there. Keep a list of what you changed per screenshot.",
        },
    ]
}


class SamplePrompts:
    """Two sample prompts in ~/QACut/prompts.json for the run; the user's file is put back after."""

    def __enter__(self):
        self.backup = PROMPTS.read_bytes() if PROMPTS.exists() else None
        PROMPTS.parent.mkdir(parents=True, exist_ok=True)
        PROMPTS.write_text(json.dumps(SAMPLE_PROMPTS, indent=2), encoding="utf-8")
        return self

    def __exit__(self, *a):
        if self.backup is None:
            PROMPTS.unlink(missing_ok=True)
        else:
            PROMPTS.write_bytes(self.backup)


# ---------------------------------------------------------------- bundles

def settings_bundle(f):
    """The 'Settings review' bundle: two groups, six shots, notes, markup.
    Returns after the first shot so a fresh 'Group 1 / Shot 1' note can be
    taken; call `settings_bundle_rest` to add the other five."""
    print("settings bundle")
    req("new_bundle", name="Settings review")
    req("add_shot", png=str(f["save"]), title="Save button", note="Clipped at 125% scaling; the label wraps and the right edge is cut off.",
        marks=marks(arrow(360, 40, 108, 108)))


def settings_bundle_rest(f):
    req("add_shot", png=str(f["toggle"]), title="Weekly summary toggle", note="Animates but the state never saves; reload and it is off again.")
    req("add_shot", png=str(f["timezone"]), title="Time zone label", note="Label sits 18px right of the others in this section.",
        marks=marks(arrow(330, 30, 90, 78)))
    req("close_group", title="Account settings", master_note="Everything on this page is a bit off since the spacing pass.")
    req("add_shot", png=str(f["invoices"]), title="Invoice status", note="Past due should be red, not orange, to match the dashboard.",
        marks=marks(step(60, 118, 1), step(60, 160, 2), step(60, 203, 3)))
    req("add_shot", png=str(f["card"]), title="Card row", note="The cardholder name should not be shown here.",
        marks=marks(blur(300, 62, 150, 26)))
    req("add_shot", png=str(f["plan"]), title="Change plan", note="Opens the old plan picker; should go to the new pricing page.")
    req("close_group", title="Billing", master_note="Three small things on the billing page.")


def onedrive_bundle(f):
    """An auto-captured process: stills with moments and click rings."""
    print("onedrive bundle")
    req("new_bundle", name="Unlink OneDrive from this computer")
    steps = [
        (0, "start", None, "Open OneDrive settings from the tray."),
        (2800, "click", (95, 205), "Choose the Account tab."),
        (5100, "interval", None, ""),
        (6400, "click", (480, 470), "Click Unlink this PC."),
        (8900, "click", (390, 300), "Confirm. Syncing stops on this computer; the files stay in OneDrive."),
        (10400, "end", None, ""),
    ]
    for at, ev, xy, note in steps:
        moment = {"at_ms": at, "event": ev, "x": xy[0] if xy else None, "y": xy[1] if xy else None}
        ms = marks({"kind": "click", "x": xy[0], "y": xy[1]}) if xy else None
        req("add_shot", png=str(f["od-account"]), note=note, moment=moment, marks=ms)
    req("close_group", title="Unlink", master_note="The whole process from the tray icon to the confirmation.")


# ---------------------------------------------------------------- shots

BRAND = str(FIX / "brand")


def bundles(f):
    print("note box")
    settings_bundle(f)
    req("note", group=1, shot=1)
    shot("note", DOCS / "getting-started-note.png")
    req("eval", label="note", js=js_set("group-title", "Account settings") + js_set("shot-title", "Save button")
        + js_set("note", "Clipped at 125% scaling; the label wraps and the right edge is cut off."))
    shot("note", UC / "organize-and-export-1.png")
    close_all()
    settings_bundle_rest(f)

    print("bundle window")
    req("peek")
    req("resize", label="peek", w=1100, h=760)
    p = shot("peek", DOCS / "bundle-window.png")
    copy(p, UC / "organize-and-export-2.png", UC / "task-list-for-agents-1.png")
    req("peek", focus="shortcuts")
    req("resize", label="peek", w=1100, h=820)
    shot("peek", DOCS / "shortcuts-dialog.png")
    close_all()

    print("brand panel")
    req("peek")
    req("resize", label="peek", w=1100, h=760)
    req("eval", label="peek", js="""
        for (const id of ["bundles", "custom", "shortcuts"]) { const e = document.getElementById(id); if (e) e.hidden = true; }
        document.getElementById("brand").hidden = false;
        document.getElementById("brand-include").checked = true;
    """ + js_set("brand-notes", "Northwind is a small-business accounting app. Plain words, second person, no exclamation marks. "
                 "Say \"workspace\", never \"tenant\". Screenshots are fine; do not describe what the reader can see."))
    p = shot("peek", DOCS / "brand-panel.png")
    copy(p, UC / "agent-with-brand-kit-2.png")
    close_all()

    print("review windows")
    req("review", group=1, shot=1)
    req("resize", label="edit", w=1200, h=760)
    shot("edit", DOCS / "bundle-review-markup.png")
    close_all()
    req("review", group=1, shot=3)
    req("resize", label="edit", w=1200, h=760)
    shot("edit", UC / "task-list-for-agents-2.png")
    close_all()
    req("review", group=2, shot=1)
    req("resize", label="edit", w=1200, h=760)
    shot("edit", UC / "organize-and-export-3.png")
    close_all()

    print("export doc")
    path = req("export_doc", format="html", brand=BRAND)
    render_url(path, DOCS / "bundle-export.png", 1400, 1000)
    copy(DOCS / "bundle-export.png", UC / "organize-and-export-4.png")

    print("auto-capture bundle")
    onedrive_bundle(f)
    req("peek")
    req("resize", label="peek", w=1100, h=760)
    p = shot("peek", DOCS / "bundle-autocapture.png")
    copy(p, UC / "automated-process-capture-2.png")
    close_all()
    req("review", group=1, shot=2)
    req("resize", label="edit", w=1200, h=760)
    p = shot("edit", DOCS / "bundle-review.png")
    copy(p, UC / "automated-process-capture-3.png")
    close_all()
    path = req("export_doc", format="html", brand=BRAND)
    render_url(path, HOMEDIR / "spot-export-doc.png", 1400, 1000)
    copy(HOMEDIR / "spot-export-doc.png", UC / "automated-process-capture-4.png")


def quick(f):
    print("quick shots")
    def one(png, out, ms=None, note=None, js="", then="quick-discard"):
        """Opens a quick shot, captures the window, then presses `then`."""
        req("quick", png=str(png), marks=ms)
        req("resize", label="edit", w=1200, h=760)
        time.sleep(0.6)
        if note:
            req("eval", label="edit", js=js_set("quick-note", note) + js)
        elif js:
            req("eval", label="edit", js=js)
        p = shot("edit", out)
        req("eval", label="edit", js=f'document.getElementById("{then}").click();')
        time.sleep(1.5)
        close_all()
        return p

    one(f["profile"], UC / "copy-and-paste-1.png")
    one(f["profile"], UC / "mark-up-and-paste-1.png", ms=marks(arrow(330, 230, 120, 283)))
    one(f["profile"], UC / "mark-up-and-paste-2.png",
        ms=marks(arrow(330, 230, 120, 283), blur(240, 140, 200, 26), {"kind": "text", "x": 300, "y": 300, "text": "this label"}))
    p = one(f["save"], DOCS / "quick-window.png", ms=marks(arrow(360, 40, 108, 108)),
            note="Save button is clipped at 125% scaling.", then="quick-batch")
    copy(p, UC / "agent-feedback-loops-1.png")
    one(f["toggle"], UC / "agent-feedback-loops-3.png", note="Toggle never saves.", then="quick-batch")
    p = one(f["timezone"], DOCS / "quick-batch.png", ms=marks({"kind": "text", "x": 380, "y": 60, "text": "should line up"}),
            js='document.getElementById("quick-show-batch").click();', then="quick-batch")
    copy(p, UC / "agent-feedback-loops-3.png")
    req("quick_batch_discard")



def brands():
    print("brands window")
    req("brands")
    req("resize", label="brands", w=1040, h=760)
    time.sleep(1.5)
    shot("brands", DOCS / "brands-window.png")
    close_all()


def prompts():
    print("prompt library")
    req("prompts")
    req("resize", label="prompts", w=1040, h=680)
    shot("prompts", DOCS / "prompts-library.png")
    req("eval", label="prompts", js='document.querySelectorAll(".lib-item")[2].click();')
    shot("prompts", HOMEDIR / "spot-prompts.png")
    close_all()
    req("prompts", select="ask-for-a-diff")
    req("resize", label="prompts", w=1040, h=680)
    shot("prompts", DOCS / "prompts-mine.png")
    close_all()


def overlays():
    print("recording badge")
    chrome = app_window("settings.html", 60, 40, 1400, 880)
    try:
        req("badge", x=200, y=130, w=1100, h=640, studio=False, countdown_ms=3000)
        region(150, 90, 1200, 720, DOCS / "badge-countdown.png", delay=800)
        req("emit", event="recording-started")
        p = region(150, 90, 1200, 720, DOCS / "badge-recording.png", delay=3600)
        copy(p, UC / "automated-process-capture-1.png")
        close_all()
    finally:
        kill(chrome)

    print("capture overlay")
    chrome = app_window("onedrive.html", 0, 0, 1536, 912)
    try:
        req("overlay", mode="shot")
        region(0, 0, 1536, 922, DOCS / "capture-overlay.png", delay=1200)
        req("cancel_overlay")
        time.sleep(0.6)
        req("overlay", mode="record")
        time.sleep(1.0)
        req("eval", label="capture-", js="""
            const ev = (t, x, y) => document.body.dispatchEvent(new MouseEvent(t, {bubbles: true, clientX: x, clientY: y, button: 0}));
            ev("mousedown", 366, 172); ev("mousemove", 900, 500); ev("mousemove", 1170, 772); ev("mouseup", 1170, 772);
        """)
        region(0, 0, 1536, 922, UC / "polished-screen-recordings-1.png", delay=900)
        req("cancel_overlay")
    finally:
        kill(chrome)


def studio(dir_name):
    print("studio")
    d = HOME / "QACut" / "Studio" / dir_name
    req("studio", dir=str(d))
    time.sleep(2.5)
    req("resize", label="studio", w=1360, h=860)
    shot("studio", DOCS / "studio-overview.png", delay=2500)
    copy(DOCS / "studio-overview.png", HOMEDIR / "spot-studio.png")
    close_all()


if __name__ == "__main__":
    DRIVE.mkdir(parents=True, exist_ok=True)
    for d in (DOCS, UC, HOMEDIR):
        d.mkdir(parents=True, exist_ok=True)
    f = fixtures()
    with SamplePrompts():
        close_all()
        bundles(f)
        quick(f)
        prompts()
        brands()
        overlays()
        if len(sys.argv) > 1 and sys.argv[1].startswith("--studio="):
            studio(sys.argv[1].split("=", 1)[1])
    print("done ->", MEDIA)
