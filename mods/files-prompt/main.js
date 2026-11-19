// files-prompt — one input or confirm dialog for files-menu / files-plus.
// props: { title, label, value, placeholder, hint, body, confirmOnly,
//          confirmLabel, exec: { cmd, args, cwd, on }, refresh }
// "{input}" inside any arg is replaced by the typed text (whole arg or embedded).
// Enter runs, Esc cancels. Non-zero exit shows stderr inline and stays open.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, exec, setShared } from "herdr";

export default class FilesPrompt extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.text = p.value ?? "";
    this.input = InputState.new({ value: this.text, placeholder: p.placeholder ?? "" });
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.busy = false; this.error = null;
  }

  async submit(cx) {
    const p = props() ?? {};
    if (this.busy) return;
    if (!p.confirmOnly && !this.text.trim() && p.exec) { this.error = "Name is required"; cx?.notify(); return; }
    this.busy = true; this.error = null; cx?.notify();
    try {
      if (p.exec) {
        const args = p.exec.args.map(a => a.includes("{input}") ? a.replaceAll("{input}", this.text) : a);
        const r = await exec(p.exec.cmd, args, { cwd: p.exec.cwd, on: p.exec.on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim());
      }
      if (p.refresh) setShared("files-plus.refresh", Date.now());
      closeOverlay(p.overlay);
    } catch (e) {
      this.error = String(e?.message ?? e);
    } finally {
      this.busy = false; cx?.notify();
    }
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const label = (text) => div().pt(14).pb(7).text_size(11.5).text_color(t.dim).child(text);
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover(s => s.opacity(0.88)).on_click((_e, cx) => action(cx)).child(text);
    return v_flex().id("files-prompt").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(p.title ?? ""))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .when(Boolean(p.body), el => el.child(div().pt(12).text_size(12.5).child(p.body)))
      .when(!p.confirmOnly && Boolean(p.label), el => el.child(label(p.label)))
      .when(!p.confirmOnly, el => el.child(Input.new(this.input).h(36).px(10).rounded(9).border_1()
        .border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground)))
      .when(Boolean(p.hint), el => el.child(div().pt(6).text_size(11.5).text_color(t.dim).child(p.hint)))
      .when(Boolean(this.error), el => el.child(div().pt(8).text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(h_flex().pt(18).gap(8).justify_end()
        .child(button("fp-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("fp-ok", this.busy ? "…" : (p.confirmLabel ?? "OK"), true, (cx) => this.submit(cx))));
  }
}
