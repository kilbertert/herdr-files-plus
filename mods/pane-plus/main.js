// pane-plus — shipped "pane" header + a pane "focus mode":
// the zoom button hides the layout chrome (sidebar / tab bar / status /
// panel) and zooms the pane, so the terminal fills the app window — like
// a maximized pane, not an OS fullscreen. Click again restores both.
// Everything else is the shipped mod verbatim; assets reuse mods/pane/*.svg.
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-plus" } } } }

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, nextCommand, writeTextFile, shared, setShared } from "herdr";

// Chrome blocks around the tab's pane area; hidden while focus mode is on.
const CHROME = ["sidebar", "tabs", "status", "panel"];
const FS_KEY = "pane-plus.fs";

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        // `pane-plus.probe` writes the window API surface to %TEMP% — a
        // headless check, no visual effect.
        if (c === "probe") {
          let s;
          try { s = `shared=${JSON.stringify(shared(FS_KEY))}`; } catch (e) { s = `shared err ${e}`; }
          try { s += ` panes=${JSON.stringify(panes().map(p => ({ pane: p.pane, zoomed: p.zoomed, focused: p.focused })))}`; } catch (e) { s += ` panes err`; }
          try { await writeTextFile("C:/Users/q1234/AppData/Local/Temp/pane-plus-probe.txt", s); } catch {}
        }
        // `pane-plus.fullscreen` = the zoom button's focus mode, bindable
        // from keys.json; targets the focused pane.
        if (c === "fullscreen") this.toggleFs(panes().find(p => p.focused)?.pane);
        // `pane-plus.unfullscreen` — one-way escape hatch: only leaves an OS
        // fullscreen, never enters one. Left over from the OS-fullscreen
        // experiment; also fixes a window stuck fullscreen with no way back.
        if (c === "unfullscreen") {
          try { if (window.is_fullscreen()) window.toggle_fullscreen(); } catch {}
        }
      }
    });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  toggleFs(pane) {
    const s = shared(FS_KEY);
    if (s?.on) {
      // Restore: show what we hid, unzoom only if still zoomed (pane.zoom is
      // a toggle — firing it on an unzoomed pane would zoom it in).
      for (const id of s.hidden ?? []) run("layout.show", { id });
      const stillZoomed = s.pane ? panes().find(p => p.pane === s.pane)?.zoomed : panes().some(p => p.zoomed);
      if (stillZoomed !== false) run("pane.zoom", s.pane ? { pane: s.pane } : {});
      setShared(FS_KEY, null);
      return;
    }
    // Enter: hide every visible chrome block, then zoom this pane unless it
    // already is (zoom toggles, so an already-zoomed pane must be left alone).
    const root = layout();
    const hidden = CHROME.filter(id => { const n = findNode(root, id); return n && !n.hidden; });
    for (const id of hidden) run("layout.hide", { id });
    const target = panes().find(p => p.pane === pane);
    if (!target?.zoomed) run("pane.zoom", { pane });
    setShared(FS_KEY, { on: true, pane, hidden });
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = p.name || ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    const fsOn = shared(FS_KEY)?.on === true;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        // Focus mode: hide the chrome, zoom this pane; same button undoes it.
        .child(div().id(`ph-z-${pane}`).p(3).rounded(4).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleFs(pane); })
          .child(svg(`mods/pane/${fsOn ? "unzoom" : "zoom"}.svg`).size(14)))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
