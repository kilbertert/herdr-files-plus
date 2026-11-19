// files-plus — shipped "files" panel + Netcatty-style toolbar and right-click menu.
// Adds: new file / new folder / show-hidden toggle / refresh buttons,
// a files-menu popup on right-click, and shared() hooks the menu writes back to.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, hc, readTextFile, writeTextFile, watchFolder, theme, settings, window, openOverlay, closeOverlay, shared, setShared, notify, props, nextCommand } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id, term: f?.terminal ?? null };
}
const key = () => JSON.stringify(location());
// Parent of a browsed path; null at a filesystem root ("/" or "C:\").
const parentOf = p => {
  if (!p) return null;
  const dir = p.replace(/[\\/]+$/, "");
  const i = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
  if (i < 0) return null;
  if (i === 0) return dir[0] === "/" ? "/" : null;
  const up = dir.slice(0, i);
  return /^[A-Za-z]:$/.test(up) ? `${up}\\` : up;
};
const nameOf = p => {
  if (!p) return "";
  const dir = p.replace(/[\\/]+$/, "");
  if (dir === "") return "/";
  if (/^[A-Za-z]:$/.test(dir)) return `${dir}\\`;
  return dir.split(/[\\/]/).pop();
};
// Root may end with a separator ("/" or "C:\") — never double it.
const join = (root, p) => !p ? root : `${/[/\\]$/.test(root) ? root : `${root}/`}${p}`;
// Typed paths keep "C:\" rooted: strip trailing separators, restore the two roots.
const normalize = p => {
  const d = p.replace(/[\\/]+$/, "") || "/";
  return /^[A-Za-z]:$/.test(d) ? `${d}\\` : d;
};
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
// VS Code–style file icons (vendored vscode-icons, MIT, icons/*.svg, full
// color via image()). name → icon basename; unknown types keep file.svg.
const NAME_ICON = {
  "package.json": "npm", "package-lock.json": "npm", ".npmrc": "npm",
  "tsconfig.json": "tsconfig", "jsconfig.json": "tsconfig",
  "yarn.lock": "yarn", ".yarnrc": "yarn", "pnpm-lock.yaml": "pnpm",
  "go.mod": "go", "go.sum": "go",
  "cargo.toml": "rust", "cargo.lock": "rust",
  "gemfile": "ruby", "rakefile": "ruby",
  "requirements.txt": "python", "pipfile": "python", "pipfile.lock": "python",
  "pom.xml": "maven", "build.gradle": "gradle", "build.gradle.kts": "gradle",
  "composer.json": "php",
  dockerfile: "docker", "docker-compose.yml": "docker", "docker-compose.yaml": "docker", ".dockerignore": "docker",
  "cmakelists.txt": "cmake", makefile: "config",
  jenkinsfile: "jenkins", ".gitlab-ci.yml": "gitlab",
  ".gitignore": "git", ".gitattributes": "git", ".gitmodules": "git", ".git": "git",
  ".env": "dotenv", ".eslintrc": "eslint", ".prettierrc": "prettier", ".babelrc": "babel",
  license: "license", "license.md": "license", copying: "license",
  readme: "readme", "readme.md": "readme",
  "uv.lock": "uv", "pnpm-workspace.yaml": "pnpm", "pyproject.toml": "python",
  "poetry.lock": "poetry", "pdm.lock": "pdm", "deno.json": "deno", "deno.lock": "deno", "bun.lockb": "bun",
  "biome.json": "biome", ".browserslistrc": "browserslist", "browserslist": "browserslist",
  "renovate.json": "renovate", ".codecov.yml": "codecov", "codecov.yml": "codecov", "dependabot.yml": "dependabot",
  "mise.toml": "mise", ".mise.toml": "mise", "taskfile.yml": "taskfile", "taskfile.yaml": "taskfile",
  justfile: "just", procfile: "procfile", "turbo.json": "turbo", "nx.json": "nx", "lerna.json": "lerna",
  "swcrc": "swc", ".swcrc": "swc", "dune-project": "dune", ".nycrc": "nyc", ".huskyrc": "husky",
};
const EXT_ICON = {
  js: "js", mjs: "js", cjs: "js", ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "reactts", jsx: "reactjs",
  py: "python", pyw: "python", go: "go", rs: "rust",
  c: "cpp", h: "cppheader", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cppheader",
  cs: "csharp", java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", groovy: "groovy",
  rb: "ruby", php: "php", swift: "swift", dart: "dartlang", lua: "lua",
  pl: "perl", pm: "perl", clj: "clojure", cljs: "clojure",
  ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell", jl: "julia",
  f90: "fortran", f: "fortran", m: "objectivec", mm: "objectivec",
  asm: "assembly", s: "assembly", ada: "ada", cob: "cobol",
  lisp: "lisp", scm: "lisp", pro: "prolog", sol: "solidity",
  graphql: "graphql", gql: "graphql", prisma: "prisma", r: "r", sql: "sql",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ksh: "shell",
  ps1: "powershell", psm1: "powershell", psd1: "powershell", bat: "bat", cmd: "bat",
  html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less", styl: "stylus",
  vue: "vue", svelte: "svelte", astro: "astro",
  md: "markdown", markdown: "markdown", txt: "text", org: "text", rst: "text", adoc: "asciidoc",
  doc: "word", docx: "word", pdf: "pdf", tex: "tex", rtf: "text", log: "log",
  json: "json", jsonc: "json", json5: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  ini: "config", cfg: "config", conf: "config", properties: "config", editorconfig: "config",
  env: "dotenv", xml: "xml", csv: "csv", tsv: "csv", lock: "config", sum: "config",
  sqlite: "sqlite", sqlite3: "sqlite", db: "db",
  png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image", webp: "image", ico: "image",
  bmp: "image", tif: "image", tiff: "image", avif: "image", heic: "image",
  mp4: "video", mkv: "video", mov: "video", avi: "video", webm: "video", m4v: "video", mpg: "video", mpeg: "video", wmv: "video",
  mp3: "audio", wav: "audio", flac: "audio", ogg: "audio", m4a: "audio", aac: "audio", opus: "audio",
  zip: "zip", tar: "zip", gz: "zip", tgz: "zip", bz2: "zip", xz: "zip", rar: "zip", "7z": "zip", zst: "zip", jar: "zip",
  pem: "key", key: "key", pub: "key", ppk: "key", asc: "key", gpg: "key",
  crt: "cert", cer: "cert", p12: "cert", pfx: "cert", der: "cert",
  exe: "binary", dll: "binary", so: "binary", dylib: "binary", bin: "binary", dat: "binary",
  o: "binary", a: "binary", msi: "binary", apk: "binary", dmg: "binary", iso: "binary",
  img: "binary", deb: "binary", rpm: "binary", wasm: "wasm",
  ttf: "font", otf: "font", woff: "font", woff2: "font",
  psd: "photoshop", ai: "ai", eps: "ai",
  xls: "excel", xlsx: "excel", ppt: "powerpoint", pptx: "powerpoint",
  ipynb: "jupyter", tf: "terraform", tfvars: "terraform",
  babelrc: "babel", eslintrc: "eslint", prettierrc: "prettier", npmrc: "npm",
  vim: "vim", sequelize: "sequelize", helm: "helm", nginx: "nginx", ansible: "ansible",
};
// Filename patterns beat plain extensions (same priority as vscode-icons):
// .env.*, *.test.*, *.d.ts, tool configs, Dockerfile variants, readmes.
const PATTERN_ICON = [
  [/^\.env(\..*)?$/, "dotenv"], [/^\.envrc$/, "direnv"],
  [/^dockerfile(\..*)?$/, "docker"], [/^docker-compose.*\.ya?ml$/, "docker"], [/^\.dockerignore$/, "docker"],
  [/^readme(\..*)?$/, "readme"], [/^licen[cs]e(\..*)?$/, "license"], [/^copying(\..*)?$/, "license"],
  [/\.d\.ts$/, "typescriptdef"],
  [/\.(test|spec)\.[jt]s$/, "testjs"], [/\.(test|spec)\.tsx?$/, "testts"], [/\.(test|spec)\.py$/, "test"],
  [/\.stories\.[jt]sx?$/, "storybook"], [/\.feature$/, "cucumber"], [/^\.?coverage$/, "coverage"], [/^coverage\.xml$/, "coverage"],
  [/^vite\.config\./, "vite"], [/^vitest\.config\./, "vitest"], [/^tailwind\.config\./, "tailwind"],
  [/^webpack\.config\./, "webpack"], [/^rollup\.config\./, "rollup"], [/^esbuild\.config\./, "esbuild"],
  [/^eslint\.config\./, "eslint"], [/^prettier\.config\./, "prettier"], [/^jest\.config\./, "jest"],
  [/^commitlint\.config\./, "commitlint"], [/^babel\.config\./, "babel"], [/^swcrc$/, "swc"],
  [/\.config\.[jt]s$/, "config"],
];
// Icon path for a filename, or null → caller draws default_file.
const fileIcon = (name) => {
  const lower = name.toLowerCase();
  let icon = NAME_ICON[lower];
  if (!icon) for (const [re, i] of PATTERN_ICON) if (re.test(lower)) { icon = i; break; }
  icon ??= EXT_ICON[lower.includes(".") ? lower.split(".").pop() : ""];
  return icon ? `mods/files-plus/icons/${icon}.svg` : null;
};
// Well-known folder names get their own icon (folder_<name>[_open].svg).
const FOLDER_ICON = {
  src: "src", node_modules: "node", dist: "dist", test: "test", tests: "test", __tests__: "test",
  docs: "docs", doc: "docs", ".git": "git", ".github": "github", config: "config", ".config": "config",
  scripts: "script", script: "script", docker: "docker", ".docker": "docker",
  public: "public", tools: "tools", components: "component", component: "component",
  app: "app", apps: "app", assets: "asset", asset: "asset", packages: "package", package: "package",
  bin: "binary", lib: "library", libs: "library", common: "common",
};
const folderIcon = (name, open) =>
  `mods/files-plus/icons/folder_${FOLDER_ICON[name.toLowerCase()] ?? "default"}${open ? "_open" : ""}.svg`;
// Quoting + local PowerShell for the drop-upload path (same shapes files-menu uses).
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const psRun = (script) => exec("powershell", ["-NoProfile", "-Command", `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${script}`]);
// hc put prints {"bytes":N,"path":"..."}; older builds may print the bare path.
const landedPath = (out) => {
  const line = out.trim().split(/\r?\n/).pop() ?? "";
  try { return JSON.parse(line).path ?? line; } catch { return line; }
};
// UTF-8 → base64 without assuming btoa/TextEncoder exist in the sandbox.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const b64encode = (text) => {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff) {
      c = 0x10000 + ((c - 0xd800) << 10) + (text.charCodeAt(++i) - 0xdc00);
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const tail = bytes.length - i;
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (tail > 1 ? B64[(n >> 6) & 63] : "=") + (tail > 2 ? B64[n & 63] : "=");
  }
  return out;
};

async function directory(path, on, showHidden) {
  const windowsDirectory = async () => {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") {
    const all = await windowsDirectory();
    return showHidden ? all : all.filter(e => !e.name.startsWith("."));
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return showHidden ? out : out.filter(e => !e.name.startsWith("."));
}

export default class Files extends View {
  init(_props, cx) {
    const p = props();
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.showHidden = shared("files-plus.showHidden") === true;
    this.addrEdit = false;
    this.address = InputState.new({ placeholder: "Path" });
    this.address.on("submit", (_e, cx) => {
      const v = this.address.value();
      this.addrEdit = false;
      this.goToPath(v, cx);
      cx.notify();
    });
    // Focus leaving the bar cancels the edit: restore the real root.
    this.address.on("blur", (_e, cx) => {
      if (!this.addrEdit) return;
      this.addrEdit = false;
      this.address.set_value(this.root ?? "");
      cx.notify();
    });
    // Editor-window copy (openOverlay props {file,root,on,term}; props().overlay =
    // window id): renders just that file — no tree, no location tracking.
    if (p?.file != null) {
      this.overlay = p.overlay ?? null;
      this.on = p.on ?? null;
      this.term = p.term ?? null;
      this.context = { key: `overlay:${this.overlay ?? p.file}`, cwd: p.root, on: this.on, root: p.root };
      this.root = p.root;
      this.show(p.file, cx);
      return;
    }
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    // `files-plus.open:<path>` opens that file's editor window (bindable,
    // scriptable: `herdr-app do files-plus.open:src/index.ts` — `do` drops
    // --argv for mod commands, the arg must ride in the name). Only the
    // panel copy polls — editor windows would steal commands.
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        if (c.startsWith("open:") || c.startsWith("open ")) {
          const path = c.slice(5).trim();
          if (path) this.openEditor(path);
        }
        cx.notify();
      }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && (this.overlay != null || key() === context.key);
  }

  async loadFolder(path, context) {
    const { on, root } = context;
    const entries = await directory(join(root, path), on, this.showHidden);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on, term } = location(), next = key();
    this.term = term;
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, root: this.root });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, root: saved?.root ?? cwd }; this.root = this.context.root; this.on = on;
      this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (this.address && !this.addrEdit) this.address.set_value(this.root ?? "");
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(this.root, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  // Hard refresh for the toolbar/menu: forget cached entries, keep the expanded set.
  hardRefresh(cx) {
    this.entries = new Map(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.notify();
  }

  toggleHidden(cx) {
    this.showHidden = !this.showHidden;
    setShared("files-plus.showHidden", this.showHidden);
    this.hardRefresh(cx);
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  editorState(text, readonly) {
    const t = theme(), ext = this.file?.includes(".") ? this.file.split(".").pop() : "txt";
    return EditorState.new({ language: LANG[ext] ?? ext, readonly,
      value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
      font_family: settings().font_family, font_size: settings().font_size ?? 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }

  show(path, cx) {
    this.code?.release(); this.editCode?.release();
    this.code = null; this.editCode = null; this.editing = false; this.dirty = false; this.backArmed = false;
    this.file = path; this.fileError = null; this.original = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(join(root, path), { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        this.original = text;
        this.code = this.editorState(text, true);
        // Editor windows open straight into edit mode — the pencil is gone.
        if (this.overlay != null && text.length <= 400000) this.startEdit(cx);
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  startEdit(cx) {
    if (this.editing || this.original == null) return;
    this.editing = true; this.dirty = false;
    this.editCode = this.editorState(this.original, false);
    this.editCode.on("change", (_e, cx) => { if (!this.dirty) { this.dirty = true; cx.notify(); } });
    cx.notify();
  }

  async save(cx) {
    if (!this.editing || !this.dirty) return;
    const text = this.editCode.value();
    const path = join(this.root, this.file);
    this.saving = true; this.saveError = null; cx.notify();
    try {
      if (this.on == null) {
        // Atomic with optimistic concurrency: fails if the file changed since read.
        await writeTextFile(path, text, this.original);
      } else {
        // Content can't ride exec argv — it lands on an `hc` command line on
        // Windows (os error 206 past ~tens of KB). hc put through the pane's
        // terminal is the real channel; no terminal → chunked base64 appends.
        const term = this.term ? (this.term.includes("/") ? this.term : `${this.on}/${this.term}`) : null;
        if (term) {
          const tmpName = `herdr-save-${Date.now()}.tmp`;
          const tmp = window()?.platform === "windows"
            ? `${(await psRun("$env:TEMP")).stdout.trim()}\\${tmpName}`
            : `/tmp/${tmpName}`;
          try {
            await writeTextFile(tmp, text, null);
            const put = await hc(["put", term, tmp]);
            const landed = put.code === 0 ? landedPath(put.stdout) : null;
            if (put.code !== 0 || !landed) throw new Error(put.stderr || "hc put failed");
            const r = await exec("sh", ["-c", `mv -- ${shq(landed)} ${shq(path)}`], { on: this.on });
            if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
          } finally {
            const rm = window()?.platform === "windows" ? psRun(`Remove-Item -Force -LiteralPath ${psq(tmp)}`) : exec("sh", ["-c", 'rm -f "$1"', "files-plus", tmp]);
            await rm.catch(() => {});
          }
        } else {
          const b64 = b64encode(text);
          if (b64.length > 800_000) throw new Error("File too large and no terminal on that machine to relay");
          for (let i = 0; i < b64.length; i += 6144) {
            const r = await exec("sh", ["-c", `printf %s ${shq(b64.slice(i, i + 6144))} | base64 -d ${i === 0 ? ">" : ">>"} ${shq(path)}`], { on: this.on });
            if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
          }
        }
      }
      this.original = text; this.dirty = false;
      this.code?.set_value(text);
      // The panel tree reloads its git marks off this hook.
      setShared("files-plus.refresh", Date.now());
      notify({ title: "Saved", body: this.file });
    } catch (e) {
      this.saveError = String(e?.message ?? e);
    } finally {
      this.saving = false; cx.notify();
    }
  }

  // Files open in a floating editor window (Netcatty-style), not inline.
  // `key` makes reopening the same file reuse its window and position.
  openEditor(path) {
    openOverlay({ mod: "files-plus", kind: "window", width: 0.72, height: 0.8,
      key: `files-plus:${this.on ?? "local"}:${join(this.root, path)}`,
      props: { file: path, root: this.root, on: this.on, term: this.term } });
  }

  closeEditor(cx) {
    if (this.dirty && !this.backArmed) { this.backArmed = true; cx.notify(); return; }
    if (this.overlay) closeOverlay(this.overlay);
  }

  // Move the panel's browse root. The terminal's cwd stays the starting point;
  // only the panel's view moves.
  setRoot(path, cx) {
    if (this.context) this.context.root = path;
    this.root = path;
    this.folders = new Set(); this.entries = new Map(); this.pending = new Set(); this.marks = {};
    this.show(null); this.watched = null; this.error = null; this.limited = false; this.loading = false;
    this.address?.set_value(path);
    this.refresh(cx); cx.notify();
  }

  goUp(cx) {
    const parent = parentOf(this.root);
    if (parent) this.setRoot(parent, cx);
  }

  // Typed-path navigation: list it first so a typo shows an error instead of
  // landing on a dead root.
  goToPath(text, cx) {
    const path = normalize(text.trim());
    if (!path || path === this.root) return;
    const on = this.on;
    cx.spawn(async cx => {
      try { await directory(path, on, this.showHidden); }
      catch (e) { this.error = String(e?.message ?? e); cx.notify(); return; }
      this.setRoot(path, cx);
    });
  }

  // Upload local paths dropped on the panel into the browse root. Same
  // machine copies directly; remote goes through `hc put` on the pane's
  // terminal (the channel files-menu's upload uses). Folders travel as an
  // archive; without a terminal, only files ≤ ~60KB go over, base64'd.
  dropUpload(paths, cx) {
    const dest = this.root, on = this.on, context = this.context;
    if (!paths?.length || !dest) return;
    const term = this.term ? (this.term.includes("/") ? this.term : (on ? `${on}/${this.term}` : this.term)) : null;
    const localWin = window()?.platform === "windows";
    const mv = (from, to) => exec("sh", ["-c", `mv -- ${shq(from)} ${shq(to)}`], { on });
    cx.spawn(async cx => {
      let done = 0; const failed = [];
      for (const src of paths) {
        const name = src.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
        try {
          const isDir = localWin
            ? /^true$/i.test((await psRun(`(Get-Item -LiteralPath ${psq(src)}).PSIsContainer`)).stdout.trim())
            : (await exec("sh", ["-c", 'test -d "$1"', "files-plus", src])).code === 0;
          if (!on) {
            const r = localWin
              ? await psRun(`Copy-Item -Recurse -Force -LiteralPath ${psq(src)} -Destination ${psq(dest)}`)
              : await exec("sh", ["-c", 'cp -R -- "$1" "$2/"', "files-plus", src, dest]);
            if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
          } else if (isDir) {
            if (!term) throw new Error("No terminal on that machine to relay a folder upload");
            const tmp = localWin
              ? `${(await psRun("$env:TEMP")).stdout.trim()}\\herdr-ul-${Date.now()}.zip`
              : `/tmp/herdr-ul-${Date.now()}.tgz`;
            try {
              const pack = localWin
                ? await psRun(`Compress-Archive -Force -LiteralPath ${psq(src)} -DestinationPath ${psq(tmp)}`)
                : await exec("sh", ["-c", 'tar czf "$1" -C "$2" "$3"', "files-plus", tmp, src.replace(/[/\\][^/\\]+$/, "") || "/", name]);
              if (pack.code !== 0) throw new Error(pack.stderr);
              const put = await hc(["put", term, tmp]);
              const landed = put.code === 0 ? landedPath(put.stdout) : null;
              if (put.code !== 0 || !landed) throw new Error(put.stderr || "hc put failed");
              const r = await exec("sh", ["-c", `cd ${shq(dest)} && (unzip -oq ${shq(landed)} || tar xzf ${shq(landed)} || python3 -m zipfile -e ${shq(landed)} .) && rm -f ${shq(landed)}`], { on });
              if (r.code !== 0) throw new Error(r.stderr);
            } finally {
              const rm = localWin ? psRun(`Remove-Item -Force -LiteralPath ${psq(tmp)}`) : exec("sh", ["-c", 'rm -f "$1"', "files-plus", tmp]);
              await rm.catch(() => {});
            }
          } else if (term) {
            const put = await hc(["put", term, src]);
            const landed = put.code === 0 ? landedPath(put.stdout) : null;
            if (put.code !== 0) throw new Error(put.stderr || "hc put failed");
            if (landed && landed !== `${dest}/${name}`) {
              const r = await mv(landed, `${dest}/${name}`);
              if (r.code !== 0) throw new Error(r.stderr);
            }
          } else {
            const b64 = await psRun(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${psq(src)}))`);
            if (b64.code !== 0) throw new Error(b64.stderr);
            if (b64.stdout.length > 80_000) throw new Error("File over 60KB and no terminal on that machine to relay");
            const r = await exec("sh", ["-c", `printf %s ${shq(b64.stdout.trim())} | base64 -d > ${shq(`${dest}/${name}`)}`], { on });
            if (r.code !== 0) throw new Error(r.stderr);
          }
          done++;
        } catch (e) { failed.push(`${name}: ${String(e?.message ?? e).slice(0, 120)}`); }
      }
      if (done || failed.length) setShared("files-plus.refresh", Date.now());
      notify(failed.length
        ? { title: `Uploaded ${done}, failed ${failed.length}`, body: failed.slice(0, 3).join("\n"), level: "error" }
        : { title: "Upload finished", body: `${done} → ${dest}` });
      if (this.current(context)) cx.notify();
    });
  }

  startAddressEdit(cx) {
    this.addrEdit = true;
    this.address.set_value(this.root ?? "");
    this.address.set_selected_range({ start: 0, end: (this.root ?? "").length });
    cx.notify();
    cx.timer.after(60, () => this.address.focus());
  }

  // Breadcrumb segments of the browse root; every ancestor is clickable.
  segments() {
    const dir = (this.root ?? "").replace(/[\\/]+$/, "");
    if (dir === "") return [{ label: "/", path: "/" }];
    if (/^[A-Za-z]:$/.test(dir)) return [{ label: `${dir}\\`, path: `${dir}\\` }];
    const segs = [];
    if (/^[A-Za-z]:[\\/]/.test(dir)) {
      let acc = dir.split(/[\\/]/)[0];
      segs.push({ label: `${acc}\\`, path: `${acc}\\` });
      for (const part of dir.split(/[\\/]/).slice(1)) { acc = `${acc}\\${part}`; segs.push({ label: part, path: acc }); }
    } else {
      segs.push({ label: "/", path: "/" });
      let acc = "";
      for (const part of dir.split(/[\\/]/)) { if (!part) continue; acc = `${acc}/${part}`; segs.push({ label: part, path: acc }); }
    }
    return segs;
  }

  addressBar(t) {
    const bar = h_flex().id("files-addr").flex_1().min_w(0).h(26).items_center().px(6).gap(1).rounded(6).border_1().border_color(t.border).overflow_hidden();
    if (this.addrEdit) return bar.child(Input.new(this.address).flex_1().h_full().text_size(12).text_color(t.foreground));
    const kids = [svg("mods/files-plus/folder.svg").size(12).flex_none().text_color(t.dim), div().w(4).flex_none()];
    const segs = this.segments();
    // Deeper than 3: collapse to "…" + the last three so the row stays inside
    // its box (an h_flex paints overflowing children past its border).
    const hidden = Math.max(0, segs.length - 3);
    if (hidden) kids.push(div().id("addr-more").cursor_pointer().rounded(4).px(3).py(1).text_size(12).text_color(t.dim)
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); this.startAddressEdit(cx); })
      .child("…"));
    const shown = segs.slice(hidden);
    shown.forEach((s, i) => {
      const last = i === shown.length - 1;
      if (i > 0 || hidden) kids.push(div().px(1).flex_none().text_size(11).text_color(t.dim).child("›"));
      kids.push(div().id(`addr-seg-${i}`).cursor_pointer().flex_none().rounded(4).px(3).py(1).text_size(12).text_color(last ? t.foreground : t.dim)
        .when(last, el => el.font_semibold())
        .hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); if (last) this.startAddressEdit(cx); else this.setRoot(s.path, cx); })
        .child(s.label));
    });
    kids.push(div().flex_1().min_w(8).h_full().cursor_text().on_click((_e, cx) => this.startAddressEdit(cx)));
    return bar.children(kids);
  }

  menu(path, entry, e, cx) {
    cx.stop_propagation();
    openOverlay({ mod: "files-menu", kind: "popup", at: e.position, width: 230, props: {
      path, name: entry.name, dir: entry.dir, root: this.root, on: this.on,
      term: this.term, parent: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    } });
  }

  bgMenu(e, cx) {
    if (!this.root) return;
    openOverlay({ mod: "files-menu", kind: "popup", at: e.position, width: 230, props: {
      bg: true, path: "", name: "", dir: true, root: this.root, on: this.on, term: this.term, parent: "",
    } });
  }

  newItem(dir, cx) {
    openOverlay({ mod: "files-prompt", kind: "dialog", width: 380, height: 210, props: {
      title: dir ? "New folder" : "New file", label: "Name", hint: `In ${this.root}`,
      confirmLabel: "Create", refresh: true,
      exec: { cmd: "sh", args: ["-c", dir ? 'mkdir -- "$1/$2"' : ': > "$1/$2"', "files-plus", this.root, "{input}"], on: this.on },
    } });
  }

  // Shared hooks written by files-menu / files-prompt.
  syncShared(cx) {
    const at = shared("files-plus.refresh");
    if (at && at !== this.refreshedAt) {
      this.refreshedAt = at;
      // cx.notify() is illegal during render — defer the reload to a task.
      cx.spawn(async cx => this.hardRefresh(cx));
      return;
    }
    const show = shared("files-plus.show");
    if (show && show !== this.shownAt) {
      this.shownAt = show.path ? show : null;
      // openOverlay mid-render is suspect — defer like hardRefresh does.
      if (show.path) cx.spawn(async () => this.openEditor(show.path));
    }
    const open = shared("files-plus.open");
    if (open && open !== this.openedAt) {
      this.openedAt = open;
      const parts = open.path.split("/");
      let acc = "";
      cx.spawn(async cx => {
        for (const part of parts) {
          acc = acc ? `${acc}/${part}` : part;
          if (!this.folders.has(acc)) {
            this.folders.add(acc);
            const context = this.context;
            try { await this.loadFolder(acc, context); } catch {}
            cx.notify();
          }
        }
        if (open.preview) this.openEditor(open.path);
      });
    }
  }

  toolButton(id, svgName, title, onClick, t, active) {
    return h_flex().id(id).w(26).h(26).items_center().justify_center().rounded(7).cursor_pointer()
      .when(active, el => el.bg(t.selected))
      .hover(s => s.bg(t.hover))
      .on_click(onClick)
      .child(svg(svgName).size(15).flex_none().text_color(active ? t.foreground : t.muted));
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    const parent = prefix === "" ? parentOf(this.root) : null;
    if (prefix === "" && parent) {
      out.push(h_flex().id("file-..").h(28).flex_none().pl(8).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.goUp(cx))
        .child(div().w(12).flex_none())
        .child(svg("mods/files-plus/arrow-up.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(".."))
        .child(div().text_size(11).text_color(t.dim).child(nameOf(parent) || "/")));
    }
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[join(this.root, path)], icon = entry.dir ? null : fileIcon(entry.name);
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((e, cx) => entry.dir
          ? (e.click_count === 1 ? this.toggle(path, cx) : null)
          : (e.click_count === 2 ? this.openEditor(path) : null))
        .on_mouse_down("right", (e, cx) => this.menu(path, entry, e, cx))
        .child(entry.dir ? svg(`mods/files-plus/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(entry.dir ? image(folderIcon(entry.name, open)).size(14).flex_none()
          : image(icon ?? "mods/files-plus/icons/default_file.svg").size(14).flex_none())
        .child(div().flex_1().min_w(0).truncate().when(Boolean(mark), el => el.text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked)).child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // Editor-window view (this.overlay set): one file, header + editor + close.
  // Left presses on the controls/body are stopped so they don't drag the window.
  renderEditor(cx) {
    const t = theme();
    const tool = (id, s, title, fn, active) => this.toolButton(id, s.includes("/") ? `${s}.svg` : `mods/files-plus/${s}.svg`, title, fn, t, active);
    const noDrag = el => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    return v_flex().id("files-editor").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(image(fileIcon(nameOf(this.file ?? "")) ?? "mods/files-plus/icons/default_file.svg").size(15).flex_none())
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(`${nameOf(this.file ?? "")}${this.dirty ? " ·unsaved" : ""}${this.saving ? " ·saving…" : ""}`))
        .child(div().flex_none().max_w(320).truncate().text_size(11).text_color(t.dim).child(join(this.root ?? "", this.file ?? "")))
        .child(noDrag(h_flex().flex_none().gap(4).items_center()
          .when(this.editing, el => el.child(
            tool("fe-save", "save", this.dirty ? "Save" : "Saved", (_e, cx) => this.save(cx), this.dirty)))
          .child(tool("fe-close", "mods/workspace-chrome/x", this.dirty && !this.backArmed ? "Close (unsaved changes)" : this.backArmed ? "Discard changes and close?" : "Close", (_e, cx) => this.closeEditor(cx), this.dirty)))))
      .child(noDrag(div().flex_1().min_h(0)
        .child((this.editCode ?? this.code) ? Editor.new(this.editCode ?? this.code).size_full() : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"))))
      .when(Boolean(this.saveError), el => el.child(div().px(10).py(4).text_size(11.5).text_color(t.ansi1).child(`Save failed: ${this.saveError}`)));
  }

  render(cx) {
    if (this.overlay != null) return this.renderEditor(cx);
    if (key() !== this.context?.key) this.refresh(cx);
    this.syncShared(cx);
    const t = theme();
    const tool = (id, s, title, fn, active) => this.toolButton(id, s.includes("/") ? `${s}.svg` : `mods/files-plus/${s}.svg`, title, fn, t, active);
    return v_flex().id("files-plus").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_drop((e, cx) => this.dropUpload(e.paths, cx))
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().flex_none().child("Files"))
        .child(this.addressBar(t))
        .children([
          tool("fp-newfile", "file-plus", "New file", (_e, cx) => this.newItem(false, cx)),
          tool("fp-newdir", "folder-plus", "New folder", (_e, cx) => this.newItem(true, cx)),
          tool("fp-hidden", this.showHidden ? "eye" : "eye-off", "Show hidden files", (_e, cx) => this.toggleHidden(cx), this.showHidden),
          tool("fp-refresh", "refresh", "Refresh", (_e, cx) => this.hardRefresh(cx)),
        ]))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).on_mouse_down("right", (e, cx) => this.bgMenu(e, cx)).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }
}
