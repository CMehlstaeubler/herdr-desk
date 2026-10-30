// Desk: each agent's open questions and worklist, posted with the `desk` CLI
// (./desk, linked onto PATH) as one JSON file per terminal in ~/.config/herdr-app/desk.
// Answers go back as one prompt typed into the agent's terminal (`hc send`), so
// the agent never polls. Notes are the person's own, one markdown file per
// terminal in ~/.config/herdr-app/desk-notes. Files of terminals that are gone are deleted.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Editor, EditorState } from "gpui-base";
import { agents, terminals, focused, readTextFile, writeTextFile, appHome, theme, hc, run, watchFolder, settings } from "herdr";
import * as fs from "fs/promises";

const dir = () => `${appHome()}/desk`;
const notesDir = () => `${appHome()}/desk-notes`;
const noteFile = (terminal) => `${notesDir()}/${terminal.replace("/", "_")}.md`;
const MARK = { open: "·", doing: "▶", done: "✓", skipped: "–" };
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

// Writes the note (empty: deletes it); passing what is on disk makes it a plain overwrite.
async function saveNote(id, text) {
  if (text.trim()) {
    await fs.mkdir(notesDir(), { recursive: true });
    await writeTextFile(noteFile(id), text, await readTextFile(noteFile(id)).catch(() => null));
  } else await fs.unlink(noteFile(id)).catch(() => {});
}

export default class Desk extends View {
  init(_props, cx) {
    this.files = new Map(); // terminal -> { path, raw, data }
    this.inputs = new Map(); // `${terminal}:${id}` -> InputState
    this.error = null;
    this.current = null; // the agent you're on; kept while focus is in this panel
    this.noteFor = null; this.note = null; this.noteDirty = false; this.noteGen = 0;
    this.notePending = Promise.resolve();
    cx.timer.every(800, (cx) => this.flushNote(cx));
    this.reload(cx);
    cx.spawn(async (cx) => {
      await fs.mkdir(dir(), { recursive: true }).catch(() => {});
      for (;;) {
        try { await watchFolder(dir()); } catch { return; }
        this.reload(cx);
      }
    });
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      const names = (await fs.readdir(dir()).catch(() => [])).filter((n) => n.endsWith(".json") && !n.startsWith("."));
      const live = new Set(terminals().map((t) => t.address));
      const next = new Map();
      for (const name of names) {
        const path = `${dir()}/${name}`;
        const raw = await readTextFile(path).catch(() => null);
        if (raw === null) continue;
        let data;
        try { data = JSON.parse(raw); } catch { continue; }
        if (live.size > 0 && !live.has(data.terminal)) { await fs.unlink(path).catch(() => {}); continue; }
        next.set(data.terminal, { path, raw, data });
        for (const q of data.questions ?? []) {
          const key = `${data.terminal}:${q.id}`;
          if (this.inputs.has(key)) continue;
          const input = InputState.new({ placeholder: q.rec ? `Enter = ${clip(q.rec, 40)}` : "Answer…" });
          input.on("submit", (_e, cx) => this.send(data.terminal, cx));
          this.inputs.set(key, input);
        }
      }
      this.files = next;
      if (live.size > 0) {
        for (const name of await fs.readdir(notesDir()).catch(() => [])) {
          if (name.endsWith(".md") && !live.has(name.slice(0, -3).replace("_", "/"))) await fs.unlink(`${notesDir()}/${name}`).catch(() => {});
        }
      }
      cx.notify();
    });
  }

  // Saves run one after another, so an older save never lands after a newer one.
  flushNote(cx) {
    if (!this.noteDirty || !this.note || !this.noteFor) return;
    this.noteDirty = false;
    const id = this.noteFor, text = this.note.value(), prev = this.notePending;
    this.notePending = (async () => {
      await prev;
      try { await saveNote(id, text); }
      catch (e) { if (this.noteFor === id) this.noteDirty = true; this.error = `Note not saved: ${e.message ?? e}`; }
    })();
    cx.spawn(async (cx) => { await this.notePending; cx.notify(); });
  }

  openNote(id, cx) {
    this.flushNote(cx);
    this.note?.release(); this.note = null; this.noteFor = id; this.noteDirty = false;
    if (!id) return;
    const gen = ++this.noteGen;
    cx.spawn(async (cx) => {
      await this.notePending;
      let text;
      try { text = (await readTextFile(noteFile(id))) ?? ""; }
      catch (e) { this.error = `Cannot read note: ${e.message ?? e}`; cx.notify(); return; }
      if (this.noteGen !== gen) return;
      this.note = EditorState.new({ language: "md", value: text, line_numbers: false, folding: false, soft_wrap: true,
        font_family: settings().font_family, font_size: 12 });
      this.note.on("change", () => { this.noteDirty = true; });
      cx.notify();
    });
  }

  async close() {
    await this.notePending;
    if (this.noteDirty && this.note && this.noteFor) await saveNote(this.noteFor, this.note.value());
  }

  // Rewrites a terminal's file from what is on disk now; retried when the CLI wrote in between.
  async change(terminal, edit) {
    const file = this.files.get(terminal);
    if (!file) return;
    for (let tries = 0; tries < 3; tries++) {
      const raw = await readTextFile(file.path);
      if (raw === null) return;
      const data = JSON.parse(raw);
      edit(data);
      try { await writeTextFile(file.path, JSON.stringify(data, null, 1), raw); return; } catch {}
    }
    throw new Error("the file kept changing");
  }

  // Answered questions (typed, or empty with a recommendation) go out as one prompt.
  send(terminal, cx) {
    const qs = this.files.get(terminal)?.data.questions ?? [];
    const answered = [];
    for (const q of qs) {
      const typed = this.inputs.get(`${terminal}:${q.id}`)?.value().trim() ?? "";
      const answer = typed || (q.rec ? `${q.rec} (your recommendation)` : "");
      if (answer) answered.push({ q, answer });
    }
    if (answered.length === 0) return;
    const text = "Desk answers: " + answered.map(({ q, answer }) => `Q${q.id} "${clip(q.text, 80)}": ${answer}`).join(" | ");
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["send", terminal, text.replace(/\s+/g, " ")]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `hc send exited ${r.code}`);
        const ids = new Set(answered.map(({ q }) => q.id));
        await this.change(terminal, (d) => { d.questions = d.questions.filter((q) => !ids.has(q.id)); });
        for (const id of ids) this.inputs.get(`${terminal}:${id}`)?.release();
        for (const id of ids) this.inputs.delete(`${terminal}:${id}`);
        this.error = null;
      } catch (e) {
        this.error = `Could not send: ${e.message ?? e}`;
      }
      cx.notify();
    });
  }

  dismiss(terminal, id, cx) {
    cx.spawn(async (cx) => {
      try { await this.change(terminal, (d) => { d.questions = d.questions.filter((q) => q.id !== id); }); }
      catch (e) { this.error = `Could not save: ${e.message ?? e}`; cx.notify(); }
    });
  }

  // The person's own tick: open/doing -> done, done/skipped -> open.
  toggle(terminal, n, cx) {
    cx.spawn(async (cx) => {
      try {
        await this.change(terminal, (d) => {
          const item = d.list.find((i) => i.n === n);
          if (item) item.status = item.status === "done" || item.status === "skipped" ? "open" : "done";
        });
      } catch (e) { this.error = `Could not save: ${e.message ?? e}`; cx.notify(); }
    });
  }

  agentCard(file, t, current) {
    const { terminal, questions = [] } = file.data;
    const list = terminal === current ? file.data.list ?? [] : [];
    const a = agents().find((x) => x.address === terminal);
    const term = terminals().find((x) => x.address === terminal);
    const title = a ? `${a.space_name} · ${a.title || a.tab_name}` : term?.where ?? terminal;
    const status = a?.status ?? term?.status ?? "unknown";
    const ready = questions.some((q) => (this.inputs.get(`${terminal}:${q.id}`)?.value().trim() ?? "") || q.rec);

    const header = h_flex().id(`h-${terminal}`).gap(8).items_center().cursor_pointer()
      .on_click(() => run("agent.focus", { terminal }))
      .child(div().size(8).rounded(4).flex_none().bg(t[status] ?? t.dim))
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(title))
      .child(div().text_size(11).text_color(t.dim).child(terminal));

    const qRows = questions.map((q) => {
      const input = this.inputs.get(`${terminal}:${q.id}`);
      return v_flex().gap(4)
        .child(h_flex().gap(6).items_start()
          .child(div().flex_none().text_color(t.blocked).font_semibold().child(`Q${q.id}`))
          .child(div().flex_1().min_w(0).child(q.text))
          .child(div().id(`x-${terminal}-${q.id}`).flex_none().px(4).rounded(4).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.dismiss(terminal, q.id, cx)).child("×")))
        .when(Boolean(q.rec), (el) => el.child(div().pl(22).text_size(11).text_color(t.muted).child(`Rec: ${q.rec}`)))
        .when(Boolean(input), (el) => el.child(div().id(`in-${terminal}-${q.id}`).ml(22).h(28).px(8).flex().items_center()
          .rounded(6).border_1().border_color(t.input).bg(t.background).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(input).h_full().w_full().text_size(12).text_color(t.foreground))));
    });

    const send = div().id(`send-${terminal}`).px(10).h(26).rounded(6).flex().items_center().justify_center()
      .text_size(12).font_semibold()
      .when(ready, (el) => el.bg(t.solid).text_color(t.solid_foreground).cursor_pointer()
        .on_click((_e, cx) => this.send(terminal, cx)))
      .when(!ready, (el) => el.bg(t.raised).text_color(t.dim))
      .child("Send answers");

    const items = list.map((i) => h_flex().id(`i-${terminal}-${i.n}`).gap(6).items_start().cursor_pointer()
      .hover((s) => s.bg(t.hover)).rounded(4).px(2)
      .on_click((_e, cx) => this.toggle(terminal, i.n, cx))
      .child(div().w(12).flex_none().text_color(i.status === "doing" ? t.working : i.status === "done" ? t.done : t.dim).child(MARK[i.status] ?? "·"))
      .child(div().flex_1().min_w(0)
        .text_color(i.status === "done" || i.status === "skipped" ? t.dim : i.status === "doing" ? t.foreground : t.muted)
        .when(i.status === "doing", (el) => el.font_semibold())
        .child(`${i.n}. ${i.text}`)));

    const done = list.filter((i) => i.status === "done" || i.status === "skipped").length;
    return v_flex().gap(8).p(10).rounded(8).bg(t.surface).border_1().border_color(t.border)
      .child(header)
      .when(questions.length > 0, (el) => el.children(qRows).child(h_flex().justify_end().child(send)))
      .when(list.length > 0, (el) => el
        .child(div().text_size(11).text_color(t.dim).child(`Worklist ${done}/${list.length}`))
        .child(v_flex().gap(2).children(items)));
  }

  render(cx) {
    const t = theme();
    // Everything shows for the agent you're on only.
    this.current = focused()?.terminal ?? agents().find((a) => a.focused)?.address ?? this.current;
    const current = this.current;
    if (current !== this.noteFor) this.openNote(current, cx);
    const here = agents().find((a) => a.address === current);
    const cards = [...this.files.values()]
      .filter((f) => f.data.terminal === current && (f.data.questions?.length ?? 0) + (f.data.list?.length ?? 0) > 0);
    const open = cards.reduce((n, f) => n + (f.data.questions?.length ?? 0), 0);

    return v_flex().id("desk").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Desk"))
        .child(div().flex_1())
        .when(open > 0, (el) => el.child(div().px(6).h(18).rounded(5).bg(t.blocked + "26").text_color(t.blocked)
          .text_size(11).font_semibold().flex().items_center().child(`${open} open`))))
      .when(Boolean(this.error), (el) => el.child(div().px(12).py(6).text_size(11).text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("desk-list").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
        .when(cards.length === 0, (el) => el.child(div().text_color(t.dim).child("No questions or worklist from this agent.")))
        .children(cards.map((f) => this.agentCard(f, t, current))))
      .when(Boolean(current), (el) => el.child(v_flex().h(220).flex_none().border_t(1).border_color(t.border)
        .child(h_flex().h(30).flex_none().px(12).gap(8).items_center()
          .child(div().font_semibold().child("Notes"))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim)
            .child(here ? `${here.space_name} · ${here.title || here.tab_name}` : current)))
        .child(this.note ? Editor.new(this.note).flex_1().min_h(0).px(6).pb(6)
          : div().px(12).text_color(t.dim).child("Loading note…"))));
  }
}
