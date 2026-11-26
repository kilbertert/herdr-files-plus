// status-plus — shipped "workspace-status" + live stats for the active space's
// machine (CPU, temp, RAM, disk, net rates, latency). One fast sh snapshot per
// 10s poll; rates computed from the previous snapshot, so the exec round-trip
// itself is the latency figure. Stats hide where sh is unavailable.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, theme, run, window, keys, exec, focused, panes } from "herdr";

const SCRIPT = `
read _ u n s i r q t st _ </proc/stat; echo "ct=$((u+n+s+i+r+q+t+st)) ci=$i"
r=0; x=0; for d in /sys/class/net/*/statistics; do i=\${d%/statistics}; i=\${i##*/}; [ "$i" = lo ] && continue; r=$((r+$(cat $d/rx_bytes))); x=$((x+$(cat $d/tx_bytes))); done; echo "rx=$r tx=$x"
tp=0; for f in /sys/class/thermal/thermal_zone*/temp; do [ -f "$f" ] || continue; v=$(cat $f); [ "$v" -gt "$tp" ] && tp=$v; done; [ $tp -gt 0 ] && echo "temp=$((tp/1000))"
awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{printf "mem_used=%d mem_tot=%d\\n",t-a,t}' /proc/meminfo
df -P "\${1:-/}" | awk 'NR==2{print "disk_used="$3" disk_tot="$2" disk_pct="substr($5,1,length($5)-1)}'
`;

const gib = (kb) => { const g = kb / 1048576; return g >= 10 ? g.toFixed(0) : g.toFixed(1); };
const rate = (k) => k >= 1024 ? `${(k / 1024).toFixed(1)}M` : `${k}K`;

export default class StatusPlus extends View {
  init(_props, cx) {
    this.stats = null;
    this.prev = null;
    this.quota = null;
    this.sample(cx);
    cx.timer.every(10000, cx => this.sample(cx));
    this.pollQuota(cx);
    cx.timer.every(300000, cx => this.pollQuota(cx));
  }

  // Subscription quota (codex + agy) comes from subquota.py on dev-us: it
  // borrows rl-1's fresh codex token over ssh and reads the agy statusline's
  // persisted quota. Machine-independent, so always ask dev-us.
  pollQuota(cx) {
    cx.spawn(async cx => {
      try {
        const r = await exec("sh", ["-c", "python3 ~/.local/bin/subquota.py"], { on: "dev-us", timeout: 25000 });
        if (r.code === 0) this.quota = JSON.parse(r.stdout);
      } catch { /* dev-us unreachable: keep last reading */ }
      cx.notify();
    });
  }

  machine() {
    const space = spaces().find(s => s.active);
    const f = focused();
    const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
    const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
    const cwd = pane?.cwd || f?.cwd || space?.folder || null;
    return { on, cwd };
  }

  sample(cx) {
    const { on, cwd } = this.machine();
    if (on !== this.on) { this.on = on; this.prev = null; this.stats = null; }
    if (on == null && window()?.platform === "windows") { cx.notify(); return; }
    const started = Date.now();
    cx.spawn(async cx => {
      try {
        const r = await exec("sh", ["-c", SCRIPT, "status-plus", cwd || "/"], { on, timeout: 15000 });
        if (r.code !== 0) throw new Error(r.stderr);
        const kv = {};
        for (const m of r.stdout.matchAll(/(\w+)=(\d+)/g)) kv[m[1]] = Number(m[2]);
        const now = Date.now(), p = this.prev;
        const s = { rtt: now - started, temp: kv.temp, mem_used: kv.mem_used, mem_tot: kv.mem_tot,
          disk_used: kv.disk_used, disk_tot: kv.disk_tot, disk_pct: kv.disk_pct };
        if (p && kv.ct > p.ct) {
          s.cpu = Math.round((kv.ct - p.ct - (kv.ci - p.ci)) * 100 / (kv.ct - p.ct));
          const dt = (now - p.at) / 1000;
          s.down = Math.max(0, Math.round((kv.rx - p.rx) / dt / 1024));
          s.up = Math.max(0, Math.round((kv.tx - p.tx) / dt / 1024));
        }
        this.prev = { ct: kv.ct, ci: kv.ci, rx: kv.rx, tx: kv.tx, at: now };
        this.stats = s;
      } catch { this.stats = null; }
      cx.notify();
    });
  }

  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  // One subscription segment: program icon + per-window remaining percent,
  // colored per window (red <25%, yellow <50%). A window in use also shows
  // its reset countdown (↻1.9h). Zero consumption is honest 100% — the data
  // says the pool is full, and NA reads as "broken" rather than "full"
  // (user feedback). naZero keeps the NA placeholder for the claude segment
  // only, per explicit user request there. Hidden when the collector has no
  // data rather than showing a guess.
  quotaSeg(icon, entry, t, naZero) {
    if (!entry?.ok || !entry.windows?.length) return null;
    const col = (rem) => rem < 25 ? t.ansi1 : rem < 50 ? t.ansi3 : t.muted;
    const cd = (resetAt) => {
      const s = (resetAt ?? 0) - Date.now() / 1000;
      if (s <= 0) return "";
      if (s < 3600) return `↻${Math.max(1, Math.round(s / 60))}m`;
      if (s < 86400) return `↻${(s / 3600).toFixed(1)}h`;
      return `↻${(s / 86400).toFixed(1)}d`;
    };
    const txt = (w) => {
      if (!w.used && naZero) return `${w.label}·NA`;
      const rem = Math.max(0, 100 - w.used);
      return `${w.label}·${rem}%${w.used ? cd(w.reset_at) : ""}`;
    };
    return h_flex().gap(5).items_center().flex_none()
      .child(image(icon).w(13).h(13).flex_none())
      .children(entry.windows.map((w) => div().text_color(col(Math.max(0, 100 - w.used)))
        .child(txt(w))));
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const s = this.stats;
    // severity color for usage-type metrics: yellow 70+, red 90+
    const lvl = (pct) => pct >= 90 ? t.ansi1 : pct >= 70 ? t.ansi3 : t.muted;
    // two-tone stat: dim label + severity-colored value, `LABEL used·pct` mirroring
    // the quota segments' visual grammar; naked values (temp/net/rtt) carry units
    const statL = (l, v, color) => h_flex().gap(4).items_center().flex_none()
      .child(div().text_color(t.dim).child(l)).child(div().text_color(color).child(v));
    const statV = (v, color) => div().text_color(color).child(v);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .children([this.quotaSeg("icons/claude.svg", this.quota?.claude, t, true),
        this.quotaSeg("icons/codex.svg", this.quota?.codex, t),
        this.quotaSeg("icons/antigravity.svg", this.quota?.agy, t)].filter(Boolean))
      .when(Boolean(s), el => el.child(h_flex().gap(12).items_center().children([
        s.cpu != null ? statL("CPU", `${s.cpu}%`, lvl(s.cpu)) : null,
        s.temp ? statV(`${s.temp}°C`, s.temp >= 80 ? t.ansi1 : s.temp >= 60 ? t.ansi3 : t.muted) : null,
        s.mem_tot ? statL("RAM", `${gib(s.mem_used)}G·${Math.round(s.mem_used * 100 / s.mem_tot)}%`, lvl(s.mem_used * 100 / s.mem_tot)) : null,
        s.disk_tot ? statL("DISK", `${gib(s.disk_used)}G·${s.disk_pct}%`, lvl(s.disk_pct ?? 0)) : null,
        s.down != null ? statV(`↓${rate(s.down)} ↑${rate(s.up)}`, t.muted) : null,
        statV(`${s.rtt}ms`, s.rtt >= 400 ? t.ansi1 : s.rtt >= 150 ? t.ansi3 : t.muted),
      ].filter(Boolean))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
