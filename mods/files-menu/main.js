// files-menu — Netcatty-style right-click menu for files-plus rows.
// Opened as a popup with props { path, name, dir, root, on, term, parent, overlay }.
// Mutating actions end with setShared("files-plus.refresh", ts) so the panel reloads.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, openOverlay, theme, exec, hc, pickFolder, writeTextFile, setShared, window, notify } from "herdr";

const shq = (s) => `'${String(s).replace(/'/g, `'\''`)}'`;
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const abs = (p) => `${p.root}/${p.path}`;
const dirOf = (p) => p.path.includes("/") ? `${p.root}/${p.path.slice(0, p.path.lastIndexOf("/"))}` : p.root;
const refresh = () => setShared("files-plus.refresh", Date.now());
// Only direct ops that change the filesystem warrant a panel reload —
// read-only ones (copy path, download, cd, open) must not flash the tree.
// ask()-ops go through files-prompt, which writes files-plus.refresh itself.
const MUTATES = new Set(["moveUp", "uploadFile", "uploadFolder", "refresh"]);
const localWin = (p) => !p.on && window()?.platform === "windows";
const ps = (script) => exec("powershell", ["-NoProfile", "-Command", `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${script}`], { on: null });
// hc put prints {"bytes":N,"path":"..."}; older builds may print the bare path.
const landedPath = (out) => {
  const line = out.trim().split(/\r?\n/).pop() ?? "";
  try { return JSON.parse(line).path ?? line; } catch { return line; }
};

// Remote ops the menu performs directly (not through files-prompt).
function fsOp(p, kind, a, b) {
  if (localWin(p)) {
    const cmd = {
      mv: `Move-Item -Force -LiteralPath ${psq(a)} -Destination ${psq(b)}`,
      base64: `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psq(a)}))`,
    }[kind];
    return ps(cmd);
  }
  const sh = {
    mv: `mv -- ${shq(a)} ${shq(b)}`,
    base64: `base64 < ${shq(a)}`,
    tgz: `tar czf - -C ${shq(a)} ${shq(b)} | base64 -w0`,
  }[kind];
  return exec("sh", ["-c", sh], { on: p.on });
}

// ask() spec field: sh → ["script", ...extra args] run as sh -c script fm <args>;
// win → powershell -Command script where $args[i] are the same extra args.
function ask(p, spec) {
  const [script, ...args] = localWin(p) && spec.win ? spec.win : spec.sh;
  const cmd = localWin(p) && spec.win ? "powershell" : "sh";
  const execArgs = cmd === "sh" ? ["-c", script, "fm", ...args] : ["-NoProfile", "-Command", script, ...args];
  openOverlay({ mod: "files-prompt", kind: "dialog", width: 400, height: spec.confirmOnly ? 190 : 230,
    props: { ...spec, exec: { cmd, args: execArgs, on: localWin(p) ? null : p.on }, refresh: true } });
}

async function download(p) {
  const destDir = await pickFolder({ prompt: "Save to" });
  setShared("fm.dl", destDir ? `picked:${destDir}` : "cancelled");
  if (!destDir) { notify({ title: "Download", body: "No folder picked, cancelled" }); return; }
  const src = abs(p);
  if (p.dir && localWin(p)) {
    await ps(`Copy-Item -Recurse -Force -LiteralPath ${psq(src)} -Destination ${psq(destDir)}`);
    notify({ title: "Download finished", body: `${p.name} → ${destDir}` });
    return;
  }
  const r = p.dir
    ? await fsOp(p, "tgz", src.slice(0, src.length - p.name.length - 1), p.name)
    : await fsOp(p, "base64", src);
  setShared("fm.dl", `exec:code=${r.code} len=${r.stdout.length}`);
  if (r.code !== 0) throw new Error(`Remote read failed: ${r.stderr || r.stdout}`);
  if (r.stdout.length > 60_000_000) throw new Error("File too large (base64 over output limit)");
  const ext = p.dir ? ".tgz" : "";
  const tmp = `${destDir}\\.herdr-dl-${Date.now()}.b64`;
  const out = `${destDir}\\${p.name}${ext}`;
  try { await writeTextFile(tmp, r.stdout, null); }
  catch (e) { throw new Error(`Temp write failed: ${e?.message ?? e}`); }
  const w = await ps(`try { [IO.File]::WriteAllBytes(${psq(out)}, [Convert]::FromBase64String([IO.File]::ReadAllText(${psq(tmp)}))) } finally { Remove-Item -Force -LiteralPath ${psq(tmp)} }`);
  if (w.code !== 0) { setShared("fm.dl", `decode:code=${w.code} err=${w.stderr}`); throw new Error(`Write failed: ${w.stderr}`); }
  setShared("fm.dl", `done:${out}`);
  notify({ title: "Download finished", body: `${p.name}${ext} → ${destDir}` });
}

async function uploadFile(p) {
  const pick = await ps("Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; if($d.ShowDialog() -eq 'OK'){$d.FileName}");
  const local = pick.stdout.trim();
  if (pick.code !== 0 || !local) return;
  const dest = dirOf(p);
  const name = local.split(/[\\/]/).pop();
  const term = p.term ? (p.term.includes("/") ? p.term : (p.on ? `${p.on}/${p.term}` : p.term)) : null;
  if (term) {
    const put = await hc(["put", term, local]);
    const landed = put.code === 0 ? landedPath(put.stdout) : null;
    if (put.code !== 0) throw new Error(put.stderr || "hc put failed");
    if (landed && landed !== `${dest}/${name}`) {
      const r = await fsOp(p, "mv", landed, `${dest}/${name}`);
      if (r.code !== 0) throw new Error(r.stderr);
    }
    return;
  }
  // No terminal on that machine: base64 the file over (small files only — argv cap).
  const b64 = await ps(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psq(local)}))`);
  if (b64.code !== 0) throw new Error(b64.stderr);
  if (b64.stdout.length > 80_000) throw new Error("File over 60KB and no terminal on that machine to relay");
  const r = localWin(p)
    ? await ps(`[IO.File]::WriteAllBytes(${psq(`${dest}/${name}`)}, [Convert]::FromBase64String(${psq(b64.stdout.trim())}))`)
    : await exec("sh", ["-c", `printf %s ${shq(b64.stdout.trim())} | base64 -d > ${shq(`${dest}/${name}`)}`], { on: p.on });
  if (r.code !== 0) throw new Error(r.stderr);
}

async function uploadFolder(p) {
  const folder = await pickFolder({ prompt: "Upload folder" });
  if (!folder) return;
  const zip = `${folder}.zip`;
  const z = await ps(`Compress-Archive -Force -LiteralPath ${psq(folder)} -DestinationPath ${psq(zip)}`);
  if (z.code !== 0) throw new Error(z.stderr);
  const dest = dirOf(p);
  const term = p.term ? (p.term.includes("/") ? p.term : (p.on ? `${p.on}/${p.term}` : p.term)) : null;
  if (!term) throw new Error("No terminal on that machine to relay a folder upload");
  const put = await hc(["put", term, zip]);
  const landed = put.code === 0 ? landedPath(put.stdout) : null;
  if (put.code !== 0 || !landed) throw new Error(put.stderr || "hc put failed");
  const r = await exec("sh", ["-c", `cd ${shq(dest)} && (unzip -oq ${shq(landed)} || python3 -m zipfile -e ${shq(landed)} .) && rm -f ${shq(landed)}`], { on: p.on });
  await ps(`Remove-Item -Force -LiteralPath ${psq(zip)}`);
  if (r.code !== 0) throw new Error(r.stderr);
}

function items(p) {
  p = p ?? {};
  const target = abs(p);
  const win = localWin(p);
  const ops = {
    openDir: () => setShared("files-plus.open", { path: p.path, preview: false }),
    openFile: () => setShared("files-plus.show", { path: p.path }),
    cdHere: async () => {
      const term = p.term ? (p.term.includes("/") ? p.term : (p.on ? `${p.on}/${p.term}` : p.term)) : null;
      if (!term) throw new Error("No terminal available in this space");
      await hc(["send", term, `cd ${shq(target)}`]);
    },
    download: () => download(p),
    copyPath: () => ps(`Set-Clipboard -Value ${psq(target)}`),
    moveUp: async () => {
      const parent = target.slice(0, target.lastIndexOf("/")) || "/";
      const grand = parent.slice(0, parent.lastIndexOf("/")) || "/";
      const to = grand === "/" ? `/${p.name}` : `${grand}/${p.name}`;
      if (to === target) return;
      const r = await fsOp(p, "mv", target, to);
      if (r.code !== 0) throw new Error(r.stderr);
    },
    moveTo: () => ask(p, { title: "Move to…", label: "Destination path", value: dirOf(p), confirmLabel: "Move",
      sh: ['mv -- "$1" "$2/$3"', target, "{input}", p.name],
      win: [`Move-Item -Force -LiteralPath $args[0] -Destination (Join-Path $args[1] $args[2])`, target, "{input}", p.name] }),
    rename: () => ask(p, { title: "Rename", label: "New name", value: p.name, confirmLabel: "Rename",
      sh: ['mv -- "$1" "$2/$3"', target, dirOf(p), "{input}"],
      win: [`Rename-Item -LiteralPath $args[0] -NewName $args[1]`, target, "{input}"] }),
    chmod: () => ask(p, { title: "Permissions", label: "Octal mode", placeholder: "644", hint: "e.g. 644 / 755", confirmLabel: "Apply",
      sh: ['chmod -- "$2" "$1"', target, "{input}"] }),
    remove: () => ask(p, { title: "Delete", confirmOnly: true, body: `Delete ${p.name}? This cannot be undone.`, confirmLabel: "Delete",
      sh: ['rm -rf -- "$1"', target],
      win: [`Remove-Item -Recurse -Force -LiteralPath $args[0]`, target] }),
    refresh: () => {},
    newDir: () => ask(p, { title: "New folder", label: "Name", hint: `In ${dirOf(p)}`, confirmLabel: "Create",
      sh: ['mkdir -- "$1/$2"', dirOf(p), "{input}"],
      win: [`New-Item -ItemType Directory -Force -Path (Join-Path $args[0] $args[1])`, dirOf(p), "{input}"] }),
    newFile: () => ask(p, { title: "New file", label: "Name", hint: `In ${dirOf(p)}`, confirmLabel: "Create",
      sh: [': > "$1/$2"', dirOf(p), "{input}"],
      win: [`New-Item -ItemType File -Force -Path (Join-Path $args[0] $args[1])`, dirOf(p), "{input}"] }),
    uploadFile: () => uploadFile(p),
    uploadFolder: () => uploadFolder(p),
  };
  const A = (label, icon, key, enabled = true) => enabled ? [label, icon, key, ops[key]] : null;
  const sep = "sep";
  if (p.bg || !p.path) return [
    A("Refresh", "refresh", "refresh"),
    A("New folder", "folder-plus", "newDir"),
    A("New file", "file-plus", "newFile"), sep,
    A("Upload file here", "upload", "uploadFile"),
    A("Upload folder here", "upload", "uploadFolder", Boolean(p.term)),
  ].filter(Boolean);
  const head = p.dir
    ? [A("Open", "folder", "openDir"), A("Open terminal here", "terminal", "cdHere", Boolean(p.term)), A("Download", "download", "download"), A("Copy path", "clipboard", "copyPath")]
    : [A("Open", "file", "openFile"), A("Download", "download", "download"), A("Copy path", "clipboard", "copyPath")];
  return [...head, sep,
    A("Move to parent", "arrow-up", "moveUp"),
    A("Move to…", "move", "moveTo"),
    A("Rename", "square-pen", "rename"),
    A("Permissions", "key", "chmod", !win),
    A("Delete", "trash", "remove"), sep,
    A("Refresh", "refresh", "refresh"),
    A("New folder", "folder-plus", "newDir"),
    A("New file", "file-plus", "newFile"), sep,
    A("Upload file here", "upload", "uploadFile"),
    A("Upload folder here", "upload", "uploadFolder", Boolean(p.term)),
  ].filter(Boolean);
}

const ICON = { "square-pen": "mods/workspace-chrome/square-pen.svg", terminal: "mods/workspace-chrome/terminal.svg" };
const icon = (name) => ICON[name] ?? `mods/files-menu/${name}.svg`;

export default class FilesMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  async choose(i, cx) {
    const it = items(props()).filter(x => x !== "sep")[i];
    if (!it) return;
    // ask-ops hand off to the files-prompt dialog: close the menu first.
    // Direct ops must run while this view is alive — API calls die with the overlay.
    const handsOff = ["moveTo", "rename", "chmod", "remove", "newDir", "newFile"].includes(it[2]);
    if (handsOff) closeOverlay(props()?.overlay);
    try {
      await it[3]();
      if (MUTATES.has(it[2])) refresh();
    } catch (e) {
      openOverlay({ mod: "files-prompt", kind: "dialog", width: 400, height: 190,
        props: { title: "Operation failed", confirmOnly: true, body: String(e?.message ?? e), confirmLabel: "OK" } });
    }
    if (!handsOff) closeOverlay(props()?.overlay);
  }

  render(cx) {
    const t = theme();
    const list = items(props());
    const actionable = list.filter(x => x !== "sep");
    let ai = -1;
    return v_flex()
      .id("files-menu")
      .track_focus(this.handle)
      .w(230)
      .max_h(480)
      .overflow_y_scrollbar()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % actionable.length;
        else if (e.key === "up") this.at = (this.at + actionable.length - 1) % actionable.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) => {
          if (it === "sep") return div().id(`fs-${i}`).mx(7).my(4).h(1).bg(t.border);
          ai += 1;
          const idx = ai;
          return h_flex()
            .id(`fm-${i}`)
            .h(30)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .text_color(t.foreground)
            .when(idx === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(idx, cx))
            .child(svg(icon(it[1])).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().child(it[0]));
        }),
      );
  }
}
