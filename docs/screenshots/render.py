"""Renders the docs screenshots in assets/images/prism-cli/ from the demo fixture.

    (cd editor-extension && npm ci && npm run build)
    python3 docs/screenshots/render.py [out_dir]

Needs node, prism-cli on PATH, Python Playwright with Chromium, and Pillow.
The extension panel is its real panel.js and panel.css with VS Code theme
variables filled in; the app page is its real renderModel() with a small DOM
createElement in place of React.
All data comes from fixtures/dashboard.json and is made up.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EXT = ROOT / "editor-extension"
APP = ROOT / "kirocrew-app"
WIDTH = 1280
COLORS = 256

sys.path.insert(0, str(APP))
from scripts import page_model as pm  # noqa: E402

# VS Code's Dark Modern and Light Modern values for the variables panel.css reads.
VSCODE = {
    "dark": {
        "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', Ubuntu, sans-serif", "font-size": "13px",
        "editor-font-family": "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
        "foreground": "#cccccc", "editor-background": "#1f1f1f", "descriptionForeground": "#9d9d9d",
        "button-foreground": "#ffffff", "button-background": "#0078d4", "button-hoverBackground": "#026ec1",
        "button-secondaryForeground": "#cccccc", "button-secondaryBackground": "#313131", "button-secondaryHoverBackground": "#3c3c3c",
        "button-border": "#ffffff12", "focusBorder": "#0078d4", "textLink-foreground": "#4daafc", "textLink-activeForeground": "#4daafc",
        "panel-border": "#2b2b2b", "widget-border": "#313131", "sideBar-background": "#181818",
        "testing-iconPassed": "#73c991", "editorWarning-foreground": "#cca700", "editorError-foreground": "#f14c4c", "editorInfo-foreground": "#3794ff",
        "badge-foreground": "#f8f8f8", "badge-background": "#616161", "textBlockQuote-background": "#2b2b2b", "textCodeBlock-background": "#2b2b2b",
    },
    "light": {
        "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', Ubuntu, sans-serif", "font-size": "13px",
        "editor-font-family": "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
        "foreground": "#3b3b3b", "editor-background": "#ffffff", "descriptionForeground": "#717171",
        "button-foreground": "#ffffff", "button-background": "#005fb8", "button-hoverBackground": "#0258a8",
        "button-secondaryForeground": "#3b3b3b", "button-secondaryBackground": "#e5e5e5", "button-secondaryHoverBackground": "#cccccc",
        "button-border": "#0000001a", "focusBorder": "#005fb8", "textLink-foreground": "#005fb8", "textLink-activeForeground": "#005fb8",
        "panel-border": "#e5e5e5", "widget-border": "#e5e5e5", "sideBar-background": "#f8f8f8",
        "testing-iconPassed": "#388a34", "editorWarning-foreground": "#bf8803", "editorError-foreground": "#e51400", "editorInfo-foreground": "#1a85ff",
        "badge-foreground": "#3b3b3b", "badge-background": "#cccccc", "textBlockQuote-background": "#f8f8f8", "textCodeBlock-background": "#f0f0f0",
    },
}

# Kiro Crew dashboard theme variables that ui/index.mjs reads.
CREW = {
    "dark": {"bg": "#111318", "text": "#d7dae0", "text-strong": "#f2f4f8", "muted": "#8b919c", "card": "#181b22", "border": "#3d4452",
             "bg-elevated": "#20242d", "ok": "#3fb950", "warn": "#d29922", "danger": "#f85149", "danger-text": "#ff7b72"},
    "light": {"bg": "#f6f7f9", "text": "#24292f", "text-strong": "#111418", "muted": "#5f6670", "card": "#ffffff", "border": "#c3c9d1",
              "bg-elevated": "#f0f2f5", "ok": "#1a7f37", "warn": "#9a6700", "danger": "#cf222e", "danger-text": "#a40e26"},
}


def css_vars(prefix: str, theme: dict) -> str:
    return ":root{" + "".join(f"--{prefix}{k}:{v};" for k, v in theme.items()) + "}"


def panel_page(theme: str) -> str:
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<style>{css_vars('vscode-', VSCODE[theme])}</style>
<link rel="stylesheet" href="{(EXT / 'media/panel.css').as_uri()}">
<script>window.acquireVsCodeApi = () => ({{ postMessage() {{}} }});</script>
</head><body><main id="app" hidden></main><p id="loading">Loading</p>
<script src="{(EXT / 'media/panel.js').as_uri()}"></script></body></html>"""


APP_HARNESS = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>%s
html,body{margin:0;background:var(--bg);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
#root{width:%dpx}</style></head><body><div id="root"></div>
<script type="module">
import { renderModel } from '%s';
const data = window.__DATA__;
// A DOM createElement in place of React's: style objects, text children, srcDoc.
function h(tag, props, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || k === 'key' || typeof v === 'function') continue;
    if (k === 'style') Object.assign(e.style, v);
    else if (k === 'srcDoc') e.srcdoc = v;
    else if (k === 'referrerPolicy') e.referrerPolicy = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const ui = { now: data.now, report: data.report, loading: false, copied: '' };
document.getElementById('root').append(renderModel(h, data.model, ui));
const d = document.querySelector('details'); if (d) d.open = true;
const f = document.querySelector('iframe');
if (f) { f.style.height = data.frameHeight + 'px'; f.addEventListener('load', () => { window.__ready = true; }); } else { window.__ready = true; }
</script></body></html>"""


def app_page(theme: str, data: dict) -> str:
    # "</" escaped so no value can close the script element.
    blob = json.dumps(data).replace("</", "<\\/")
    return (APP_HARNESS % (css_vars("", CREW[theme]), WIDTH, (APP / "ui/index.mjs").as_uri())).replace(
        "<body>", f"<body><script>window.__DATA__ = {blob};</script>", 1)


def optimize(path: Path) -> None:
    """256-colour palette PNG: these are flat UI shots, so it keeps them well under 250 KB."""
    img = Image.open(path).convert("RGB")
    img.quantize(colors=COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(path, optimize=True)


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "assets/images/prism-cli"
    out.mkdir(parents=True, exist_ok=True)
    data = json.loads(subprocess.run(["node", str(HERE / "models.mjs")], check=True, capture_output=True, text=True).stdout)
    fixture = data["fixture"]
    commits = {r["path"]: data["commits"].get(r["path"]) for r in fixture["repos"]}
    app_model, targets = pm.build_model(fixture, commits, "1.9.0", {
        "lastRunAt": "2026-11-12T17:00:00.000Z", "lastNotifiedAt": "2026-11-12T17:00:00.000Z",
        "lastMessage": "PRISM daily digest\n- checkout-service: new high finding (command-injection in src/lookup.ts:3)"})
    i = next(n for n, t in enumerate(targets) if t["name"] == "checkout-service")
    plan = pm.report_plan(targets[i], "/dev/null")
    report = {"index": i, "repo": "checkout-service", "note": plan["primaryNote"], "html": pm.with_report_csp(data["reportHtml"])}

    shots = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--allow-file-access-from-files"])  # file:// module import of ui/index.mjs
        for theme in ("dark", "light"):
            ctx = browser.new_context(viewport={"width": WIDTH, "height": 900}, color_scheme=theme, timezone_id="America/Los_Angeles", locale="en-US")
            page = ctx.new_page()

            def load(html):
                # A file:// page, so it may load panel.js, panel.css and index.mjs from the repo.
                harness = out / ".harness.html"
                harness.write_text(html, encoding="utf-8")
                page.goto(harness.as_uri(), wait_until="load")
                harness.unlink()

            def panel(model, name):
                load(panel_page(theme))
                page.evaluate("m => window.postMessage({ type: 'model', model: m }, '*')", model)
                page.wait_for_selector("#app:not([hidden])")
                if model["mode"] == "machine":
                    page.evaluate("document.querySelector('details').open = true")
                page.screenshot(path=str(out / name), full_page=True)
                shots.append(name)

            panel(data["repoModel"], f"editor-extension-panel-{theme}.png")
            panel(data["machineModel"], f"editor-extension-machine-mode-{theme}.png")

            for name, rep in ((f"kirocrew-app-page-{theme}.png", None), (f"kirocrew-app-report-{theme}.png", report)):
                load(app_page(theme, {"model": app_model, "report": rep, "now": data["now"], "frameHeight": 760}))
                page.wait_for_function("window.__ready === true")
                el = page.locator("#root > div")
                if rep:
                    # The report view: from the expanded repo row down to the end of the report frame.
                    # A viewport as tall as the page, not full_page: resizing for full_page blanked the sandboxed frame.
                    page.set_viewport_size({"width": WIDTH, "height": page.evaluate("document.documentElement.scrollHeight")})
                    page.wait_for_timeout(500)
                    box, end = page.locator("li:has(iframe)").bounding_box(), page.locator("iframe").bounding_box()
                    page.screenshot(path=str(out / name),
                                    clip={"x": 0, "y": box["y"], "width": el.bounding_box()["width"], "height": end["y"] + end["height"] - box["y"] + 16})
                    page.set_viewport_size({"width": WIDTH, "height": 900})
                else:
                    el.screenshot(path=str(out / name))
                shots.append(name)
            ctx.close()
        browser.close()
    for name in shots:
        optimize(out / name)
        print(f"{name}\t{(out / name).stat().st_size // 1024} KB\t{Image.open(out / name).size}")


if __name__ == "__main__":
    main()
