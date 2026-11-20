# herdr-files-plus — Recipe

What each mod draws, how it behaves, and the Herdr APIs it uses. Mods marked
**(clone)** are `mod.clone`s of the named shipped mod — the base behavior is
Herdr's; the additions are this pack's.

## files-plus (clone of `files`)

**The panel.** Herdr's lazy file browser (per-machine tree, git status marks,
expand-on-click folders, watchFolder refresh) plus:

- **Header, 42px**: "Files" label, then the address bar, then four 26px tool
  buttons (new file, new folder, show-hidden toggle, refresh).
- **Address bar**: breadcrumb segments of the browse root (`›` separators,
  last segment bold). More than three ancestors collapse into a `…` chip +
  the last three (an `h_flex` paints overflowing children past its border,
  so the bar also clips). Click an ancestor to set the root there; click the
  last segment, the `…`, or the trailing space to type a path — the
  `InputState` selects the whole root, Enter pre-checks the path with
  `directory()` before moving (a typo lands on an error line, not a dead
  root), blur cancels. `..` row at the top of the tree goes to the parent.
- **Icons**: rows get a full-color `image()` icon from `mods/files-plus/icons/`
  (a vendored subset of vscode-icons, MIT). Resolution order: exact filename
  (`package.json`, `Dockerfile`, `.gitignore`…) → pattern rules (`.env*`,
  `*.test.*`, `*.d.ts`, tool configs, `Dockerfile.*`) → extension →
  `default_file.svg`. Known folder names (`src`, `node_modules`, `.git`…)
  get `folder_<name>[_open].svg`, others `folder_default[_open].svg`.
- **File open**: a row click only fires on `click_count === 2` (single click
  is inert; folders still toggle on single click and ignore the second).
  The file opens in a floating **editor window** — `openOverlay({mod:
  "files-plus", kind: "window", key: "files-plus:<machine>:<abs path>",
  width: 0.72, height: 0.8})` — not inline. `key` means the same file reuses
  its window and its dropped position; different files get their own.
- **The editor window** is the same mod: opened with props
  `{file, root, on, term}` it runs a copy that skips `location()` tracking,
  refresh and its 10 s timer, and renders only the editor. Header, 40px:
  file icon, name (`·unsaved`/`·saving…` markers), the absolute path dimmed
  (drag area), then the mode buttons, Save and Close. The window drags by
  any press that isn't stopped — the buttons row, editor body and footer
  bar call `stop_propagation()` on left mouse-down so editing and clicking
  don't move it. Closing with a dirty buffer asks once ("Discard changes
  and close?"). The file loads straight into edit mode; over 400 KB it
  stays read-only.
- **Maximize**: the `□` button reopens the window's own `key` at 0.98 share —
  there is no overlay-resize command, and a same-key `openOverlay` replaces
  the window *with a new copy*, so the live buffer is first stashed under
  `shared("files-plus.buf:<key>")` and the replacement restores it (skipped
  if the file changed on disk meanwhile). `props.fs` tells the new copy
  which size it is; toggling back reopens at 0.72/0.8.
- **Markdown preview** (`.md/.markdown/.mdx/.mdown/.mkd`): three header
  buttons — source, source+preview split, preview — rendering with
  `gpui-base`'s `TextView.markdown(id, text)` (rich markdown incl. code
  fences, selectable + scrollable; **it lives in `gpui-base`, not
  `gpui-kit`**). The preview text is `editCode.value()` so unsaved edits
  preview live; the `Editor` keeps its `EditorState` while unmounted, so
  switching back loses nothing. No live-WYSIWYG mode — `Editor` is plain
  text.
- **Save**: local machine → `writeTextFile(path, text, original)` (optimistic
  concurrency: fails if the file changed since read). Remote → the pane's
  terminal channel: write a local temp file, `hc put <machine>/<term> tmp`,
  parse the JSON `{"bytes","path"}` it prints, `mv` the landed file over the
  target. No terminal → base64 in 6144-char `>>` appends (4-char boundary so
  each chunk decodes alone), refused past ~800 KB. A successful save writes
  `shared("files-plus.refresh")` so every panel copy reloads its marks.
- **Drag-and-drop upload**: `on_drop` on the root element gives local paths.
  Same machine → `cp -R`/`Copy-Item`. Remote file → `hc put` + `mv`.
  Remote folder → zip/`tar czf` locally, `hc put`, unpack (`unzip`/`tar`/
  `python3 -m zipfile`), delete the archive. No terminal → files ≤ ~60 KB
  go as base64, folders are refused. Per-item errors collect into one
  `notify` summary; the panel then refreshes via the shared hook.
- **Command**: `files-plus.open:<path>` (only the panel copy polls
  `nextCommand`) opens that file's editor window — bindable, scriptable via
  `herdr-app do files-plus.open:src/index.ts`. `do` ignores `--argv` for mod
  commands, so the path must ride in the name as `name:value` shorthand.
- **Shared hooks other mods write**: `files-plus.refresh` (reload entries +
  marks), `files-plus.show {path}` (open that file's editor window),
  `files-plus.open {path, preview}` (expand folders to the path, optionally
  open it), `files-plus.showHidden` (persisted toggle).

## files-menu

**The right-click menu**, a 230px popup at the pointer (`kind:"popup"`).
Keyboard ↑/↓/Enter/Esc works; mouse works. Opened by files-plus with props
`{path, name, dir, root, on, term, parent}` (or `{bg:true}` for empty space).

Items (files get "Open", dirs add "Open terminal here" via `hc send cd`):
Download, Copy path, Move to parent, Move to…, Rename, Permissions (POSIX
only — hidden on local-Windows targets), Delete, Refresh, New folder,
New file, Upload file here, Upload folder here (needs a terminal).

- Read-only ops (open, download, copy path, cd) **don't** touch the tree.
  Only `moveUp`, `uploadFile`, `uploadFolder` and `refresh` write
  `files-plus.refresh` — `ask()`-style ops get their reload from
  files-prompt itself, so there's no double flash.
- `ask()`-ops hand their input spec to files-prompt as an `sh -c` /
  `powershell -Command` argv with `"{input}"` placeholders; the menu closes
  itself first so the dialog isn't stacked.
- **Download**: remote file → `base64` stdout → temp `.b64` → decode to the
  picked folder; remote folder → `tar czf … | base64` → `.tgz`; local dir →
  `Copy-Item`.
- **Upload**: OS file dialog → `hc put` + `mv` (the same channel as
  drag-drop); folder → zip → put → unzip remotely; no terminal → ≤ 60 KB
  base64 fallback.
- Failed ops reopen files-prompt as a confirm dialog showing the error.

## files-prompt

**One dialog for everything**: `{title, label, value, placeholder, hint,
body, confirmOnly, confirmLabel, exec:{cmd,args,cwd,on}, refresh}`. Text
input (unless `confirmOnly`), `{input}` substitution inside any arg, Enter
submits, Esc cancels, non-zero exit prints stderr inline and stays open,
`refresh` writes `files-plus.refresh` on success. Buttons Cancel / OK.

## pane-plus (clone of `pane`)

The shipped pane header plus a **focus mode**: the zoom button hides the
visible `sidebar`, `tabs`, `status`, `panel` blocks (`layout.hide`, recorded
in `shared("pane-plus.fs")`) and fires `pane.zoom`; clicking again restores
each hidden id and unzooms. `panes()[].zoomed` is checked first — `pane.zoom`
is a toggle and a blind send reverses it.

Commands (`nextCommand` loop, bindable): `pane-plus.fullscreen` = the same
focus toggle; `pane-plus.unfullscreen` = one-way escape hatch that only ever
*leaves* an OS fullscreen (`window.toggle_fullscreen()` when
`is_fullscreen()`), for a window stuck fullscreen with no UI exit.

## status-plus (clone of `workspace-status`)

The shipped status row plus machine metrics for the active space's machine
(sampled by `exec` on that machine): `Cpu N%`, `Temp N°C` when the sensor
exists, `RAM used/total GB`. Upstream's singular/plural fix
(`1 agent`, `1 needs you`) is included.

## agents-plus (clone of `agents`)

The shipped Agents list plus a **machine filter that follows space-folders'**
header chevron pick (`shared("space-folders.machine")`, persisted as
`localStorage["spaces.machine"]`): a remote pick shows only that machine's
agents, `""` (this computer) only local ones. An agent's machine comes from
its address — `dev-us/t3` is remote, `t4b` is local — the same split the
shipped row uses for its machine badge. A pick naming a machine that went
away falls back to this computer (`machines()` records can lack `.name`, so
the machine set filters to non-empty strings before checking membership).
The only other change is `openOverlay`'s sort menu pointing at
`agents-plus` instead of `agents`.

## Cross-cutting

- `hc put` prints `{"bytes":N,"path":"..."}` — the path must be `JSON.parse`d;
  taking the last line verbatim breaks `mv`. Older builds print the bare path.
- File *content* never rides `exec` argv: on Windows the args land on the
  `hc` command line and `os error 206` kills anything past tens of KB.
  Everything big goes through `hc put` or chunked base64.
- `openOverlay` mid-render is suspect — hook-driven opens go through
  `cx.spawn`.
- `Editor`/`EditorState` from `gpui-base`; `font_size` follows
  `settings().font_size ?? 12` (older builds may lack the key).

## Used APIs

`spaces, machines, panes, focused, exec, hc, readTextFile, writeTextFile, watchFolder,
theme, settings, window, openOverlay, closeOverlay, props, shared, setShared,
notify, layout, run, nextCommand, pickFolder, home, agents` — plus
`View/div/svg/image` (gpui-kit) and `v_flex/h_flex/Editor/EditorState/
Input/InputState` (gpui-base).
