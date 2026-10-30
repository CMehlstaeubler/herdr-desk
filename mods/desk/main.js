// Desk: each agent's open questions and worklist, posted with the `desk` CLI
// (./desk, linked onto PATH) as one JSON file per terminal in ~/.config/herdr-app/desk.
// Answers go back as one prompt typed into the agent's terminal (`hc send`), so
// the agent never polls. Notes are the person's own, one markdown file per
// terminal in ~/.config/herdr-app/desk-notes. Files of terminals that are gone are deleted.
// Prompts are one-click buttons that type a prompt or /skill into the agent you're on;
// they live in ~/.config/herdr-app/desk-prompts/prompts.json ([{ label, text }]), shared by all agents.
// For a Claude Code agent the header shows how full its context is, read from the last
// main-loop usage in its transcript (~/.claude/projects/<cwd>/<session>.jsonl), against
// the context window: ~/.config/herdr-app/desk.json { "contextWindow": 1000000 } when your
// plan has a 1M window; otherwise 200k, or 1M once an agent is past 200k.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Editor, EditorState } from "gpui-base";
import { agents, terminals, focused, readTextFile, writeTextFile, appHome, home, theme, hc, exec, run, watchFolder, settings } from "herdr";
import * as fs from "fs/promises";

const dir = () => `${appHome()}/desk`;
const notesDir = () => `${appHome()}/desk-notes`;
const noteFile = (terminal) => `${notesDir()}/${terminal.replace("/", "_")}.md`;
const promptsDir = () => `${appHome()}/desk-prompts`;
const promptsFile = () => `${promptsDir()}/prompts.json`;
const SEED = [
  { label: "continue", text: "continue" },
  { label: "/compact", text: "/compact" },
  { label: "What's left?", text: "What's left? One line per open item." },
];
const NOTES_MIN = 120;
const CTX_EVERY = 20_000;
const settingsFile = () => `${appHome()}/desk.json`;
const windowOf = (configured, used) => configured || (used > 200_000 ? 1_000_000 : 200_000);
const kTokens = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
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
    // The bottom part (prompts + notes) is as tall as the person dragged it.
    this.bottomH = Number(localStorage.getItem("bottomH")) || 300;
    this.drag = null; this.height = 0;
    // The form adds a button (editing = null) or edits button number `editing`.
    this.prompts = []; this.adding = false; this.editing = null;
    this.labelInput = InputState.new({ placeholder: "e.g. Ship it" });
    this.promptInput = InputState.new({ placeholder: "e.g. /review or a sentence" });
    this.labelInput.on("submit", (_e, cx) => this.savePrompt(cx));
    this.promptInput.on("submit", (_e, cx) => this.savePrompt(cx));
    this.loadPrompts(cx);
    // A hand edit of prompts.json shows at once. Its own folder: watching the app folder,
    // which Herdr writes all the time, stalls the mod's other tasks.
    cx.spawn(async (cx) => {
      await fs.mkdir(promptsDir(), { recursive: true }).catch(() => {});
      for (;;) {
        try { await watchFolder(promptsDir()); } catch { return; }
        this.loadPrompts(cx);
      }
    });
    this.ctx = new Map(); // terminal -> { used, window, model } of its last main-loop turn
    this.contextWindow = null; // from desk.json, when set
    cx.spawn(async () => {
      try { this.contextWindow = Number(JSON.parse((await readTextFile(settingsFile())) ?? "{}").contextWindow) || null; } catch {}
    });
    this.transcripts = new Map(); // `${terminal}:${pid}` -> transcript path or null
    cx.timer.every(CTX_EVERY, (cx) => this.measure(this.current, cx));
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

  // The terminal's Claude Code transcript: its process -> its session file -> the project log.
  async transcript(terminal) {
    let pid;
    try { pid = JSON.parse((await hc(["get", terminal])).stdout).foreground?.pid; } catch { return null; }
    if (!pid) return null;
    const key = `${terminal}:${pid}`;
    if (this.transcripts.has(key)) return this.transcripts.get(key);
    let path = null;
    try {
      const s = JSON.parse((await readTextFile(`${home()}/.claude/sessions/${pid}.json`)) ?? "null");
      if (s?.sessionId && s.cwd) path = `${home()}/.claude/projects/${s.cwd.replace(/[^A-Za-z0-9]/g, "-")}/${s.sessionId}.jsonl`;
    } catch {}
    this.transcripts.set(key, path);
    return path;
  }

  // Reads the last main-loop usage from the transcript's tail (the files run to 100s of MB).
  measure(terminal, cx) {
    if (!terminal || !agents().some((a) => a.address === terminal && a.app === "claude-code")) return;
    cx.spawn(async (cx) => {
      const path = await this.transcript(terminal);
      if (!path) return;
      const r = await exec("tail", ["-c", "400000", path]).catch(() => null);
      const lines = (r?.stdout ?? "").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"usage"')) continue;
        let d;
        try { d = JSON.parse(lines[i]); } catch { continue; }
        const u = d.message?.usage;
        if (d.type !== "assistant" || d.isSidechain || !u) continue;
        const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        this.ctx.set(terminal, { used, window: windowOf(this.contextWindow, used), model: d.message.model });
        cx.notify();
        return;
      }
    });
  }

  // How full the agent's context is: a bar and the numbers, amber from 70 %, red from 85 %.
  gauge(t, terminal) {
    const c = this.ctx.get(terminal);
    if (!c) return null;
    const pct = Math.min(100, Math.round((c.used / c.window) * 100));
    const color = pct >= 85 ? t.blocked : pct >= 70 ? t.working : t.muted;
    return h_flex().gap(6).items_center().flex_none()
      .child(div().w(54).h(5).rounded(3).bg(t.raised).overflow_hidden()
        .child(div().h_full().w(Math.max(2, Math.round(54 * pct / 100))).rounded(3).bg(color)))
      .child(div().text_size(11).text_color(pct >= 70 ? color : t.dim).child(`${kTokens(c.used)} · ${pct}%`));
  }

  loadPrompts(cx) {
    cx.spawn(async (cx) => {
      const raw = await readTextFile(promptsFile()).catch(() => null);
      if (raw === null) { await this.savePrompts(SEED); this.prompts = SEED; }
      else { try { this.prompts = JSON.parse(raw); } catch { this.error = "desk-prompts.json is not valid JSON"; } }
      cx.notify();
    });
  }

  async savePrompts(list) {
    await fs.mkdir(promptsDir(), { recursive: true });
    await writeTextFile(promptsFile(), JSON.stringify(list, null, 1) + "\n", await readTextFile(promptsFile()).catch(() => null));
  }

  // Opens the form empty (add) or filled with button i (edit).
  openForm(i, cx) {
    const p = i === null ? null : this.prompts[i];
    this.adding = true; this.editing = i;
    this.labelInput.set_value(p?.label ?? "");
    this.promptInput.set_value(p?.text ?? "");
    (p ? this.labelInput : this.promptInput).focus();
    cx.notify();
  }

  closeForm(cx) {
    this.adding = false; this.editing = null;
    this.labelInput.set_value(""); this.promptInput.set_value("");
    cx.notify();
  }

  // Enter in either field saves. Without a label the prompt names its button.
  savePrompt(cx) {
    const text = this.promptInput.value().trim();
    if (!text) return;
    const item = { label: this.labelInput.value().trim() || clip(text, 24), text };
    const next = this.editing === null ? [...this.prompts, item] : this.prompts.map((p, k) => (k === this.editing ? item : p));
    this.writePrompts(next, cx);
  }

  removePrompt(i, cx) {
    this.writePrompts(this.prompts.filter((_, k) => k !== i), cx);
  }

  writePrompts(next, cx) {
    cx.spawn(async (cx) => {
      try { await this.savePrompts(next); this.prompts = next; this.closeForm(cx); }
      catch (e) { this.error = `Could not save the prompts: ${e.message ?? e}`; cx.notify(); }
    });
  }

  // A caption above its input, so the form says what goes where.
  field(t, id, caption, input) {
    return v_flex().gap(3).w_full()
      .child(div().text_size(10.5).font_semibold().text_color(t.muted).child(caption))
      .child(div().id(id).h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.input)
        .bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(input).h_full().w_full().text_size(12).text_color(t.foreground)));
  }

  // Label, then prompt, each full width; then Save (and Delete when editing). Enter saves too.
  promptForm(t) {
    const editing = this.editing !== null;
    const button = (id, label, fg, bg, onClick) => div().id(id).px(10).h(24).rounded(6).flex().items_center().cursor_pointer()
      .text_size(11.5).font_semibold().bg(bg).text_color(fg).on_click(onClick).child(label);
    return v_flex().mx(12).mb(8).p(8).gap(6).rounded(8).bg(t.surface).border_1().border_color(t.border)
      .child(div().text_size(11).font_semibold().child(editing ? "Edit button" : "New button"))
      .child(this.field(t, "prompt-label", "Label (on the button)", this.labelInput))
      .child(this.field(t, "prompt-text", "Prompt (sent to the agent)", this.promptInput))
      .child(div().text_size(10.5).text_color(t.dim).child("Enter saves · empty label = the prompt's first words"))
      .child(h_flex().gap(6).items_center()
        .when(editing, (el) => el.child(button("prompt-delete", "Delete", t.blocked, t.blocked + "22", (_e, cx) => this.removePrompt(this.editing, cx))))
        .child(div().flex_1())
        .child(button("prompt-cancel", "Cancel", t.muted, t.raised, (_e, cx) => this.closeForm(cx)))
        .child(button("prompt-save", editing ? "Save" : "Add", t.solid_foreground, t.solid, (_e, cx) => this.savePrompt(cx))));
  }

  // Types the prompt into the agent and presses Enter.
  usePrompt(p, cx) {
    const terminal = this.current;
    if (!terminal) return;
    cx.spawn(async (cx) => {
      const r = await hc(["send", terminal, p.text]).catch((e) => ({ code: 1, stderr: String(e) }));
      this.error = r.code === 0 ? null : `Could not send: ${(r.stderr || "").trim() || `hc exited ${r.code}`}`;
      this.flash = r.code === 0 ? p.label : null;
      cx.notify();
    });
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

  endDrag() {
    if (!this.drag) return;
    this.drag = null;
    localStorage.setItem("bottomH", String(this.bottomH));
  }

  render(cx) {
    const t = theme();
    // Everything shows for the agent you're on only.
    this.current = focused()?.terminal ?? agents().find((a) => a.focused)?.address ?? this.current;
    const current = this.current;
    if (current !== this.noteFor) { this.openNote(current, cx); this.measure(current, cx); }
    const here = agents().find((a) => a.address === current);
    const cards = [...this.files.values()]
      .filter((f) => f.data.terminal === current && (f.data.questions?.length ?? 0) + (f.data.list?.length ?? 0) > 0);
    const open = cards.reduce((n, f) => n + (f.data.questions?.length ?? 0), 0);

    return v_flex().id("desk").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .on_size_change((size, cx) => { this.height = size.height; cx.notify(); })
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        const max = Math.max(NOTES_MIN, (this.height || 800) - 140);
        this.bottomH = Math.round(Math.min(max, Math.max(NOTES_MIN, this.drag.h - (e.position.y - this.drag.y))));
        cx.notify();
      })
      .on_mouse_up("left", () => this.endDrag())
      .on_hover((hovered) => { if (!hovered) this.endDrag(); })
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Desk"))
        .child(div().flex_1())
        .when(Boolean(this.gauge(t, current)), (el) => el.child(this.gauge(t, current)))
        .when(open > 0, (el) => el.child(div().px(6).h(18).rounded(5).bg(t.blocked + "26").text_color(t.blocked)
          .text_size(11).font_semibold().flex().items_center().child(`${open} open`))))
      .when(Boolean(this.error), (el) => el.child(div().px(12).py(6).text_size(11).text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("desk-list").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
        .when(cards.length === 0, (el) => el.child(div().text_color(t.dim).child("No questions or worklist from this agent.")))
        .children(cards.map((f) => this.agentCard(f, t, current))))
      .when(Boolean(current), (el) => el
        // The divider: drag it to share the height between the cards and the bottom part.
        .child(div().id("desk-split").h(6).flex_none().cursor_row_resize().border_b(1).border_color(t.border)
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (e, cx) => { this.drag = { y: e.position.y, h: this.bottomH }; cx.stop_propagation(); }))
        .child(v_flex().h(this.bottomH).flex_none()
          .child(h_flex().h(30).flex_none().px(12).gap(8).items_center()
            .child(div().font_semibold().child("Prompts"))
            .child(div().flex_1().text_size(11).text_color(t.dim).truncate().child(this.flash ? `sent “${this.flash}”` : "click to send · right-click to edit"))
            .child(div().id("prompt-add").size(22).rounded(5).flex().items_center().justify_center().cursor_pointer()
              .text_color(this.adding ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => (this.adding ? this.closeForm(cx) : this.openForm(null, cx))).child(this.adding ? "×" : "+")))
          .when(this.adding, (el) => el.child(this.promptForm(t)))
          .child(h_flex().flex_none().flex_wrap().px(12).pb(8).gap(6)
            .children(this.prompts.map((p, i) => div().id(`prompt-${i}`).px(9).h(24).rounded(6).flex().items_center()
              .bg(t.raised).border_1().border_color(t.border).text_size(11.5).cursor_pointer()
              .hover((s) => s.bg(t.hover).border_color(t.input))
              .on_click((_e, cx) => this.usePrompt(p, cx))
              .on_mouse_down("right", (_e, cx) => this.openForm(i, cx))
              .when(this.editing === i, (el) => el.border_color(t.accent))
              .child(p.label))))
          .child(v_flex().flex_1().min_h(0).border_t(1).border_color(t.border)
            .child(h_flex().h(30).flex_none().px(12).gap(8).items_center()
              .child(div().font_semibold().child("Notes"))
              .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim)
                .child(here ? `${here.space_name} · ${here.title || here.tab_name}` : current)))
            .child(this.note ? Editor.new(this.note).flex_1().min_h(0).px(6).pb(6)
              : div().px(12).text_color(t.dim).child("Loading note…")))));
  }
}
