# Desk

A panel on the right of the window for the agent you're on: the questions it is waiting on you for, each with an answer box and its recommendation; the worklist it is working through; and a notes area for your own ideas about that agent. Agents post with a tiny `desk` shell command that prints `ok`, so it costs them almost no tokens; your answers go back as one typed prompt, so nothing polls. Works with any agent that runs in a Herdr terminal (Claude Code, Codex, pi, …).

![Desk](preview.png)

## What you see

Top to bottom, in a 340px column docked right (`mod.json`: `place: "right"`, `size: 340`), background `chrome`, text 12.5px:

1. **Header**, 42px tall (same as the main layout's tab bar, so the bottom borders line up), `border_b` 1px `border`. "Desk" in semibold on the left; on the right, when the agent has open questions, a pill "N open": `blocked` text on `blocked` + `26` alpha, 18px tall, radius 5, 11px semibold.
2. **Error line** (only after a failed send or save): 11px, `ansi1`.
3. **Card area**, scrollable (`overflow_y_scrollbar`), padding 10. One card for the agent you're on, or the dim line "No questions or worklist from this agent." Card: `surface`, 1px `border`, radius 8, padding 10, gap 8:
   - **Agent row**: an 8px status dot in the theme color of its status (`working`, `blocked`, `done`, `idle`), the name "<space> · <terminal title or tab name>" in semibold (truncated), and the terminal address (`t1q`) in 11px `dim` on the right.
   - **Questions**: "Q<id>" in `blocked` semibold, the question text, and a dim "×" on the right. Under it, when there is one, "Rec: <recommendation>" in 11px `muted`, then an answer box: 28px tall, radius 6, 1px `input` border, `background` fill, 12px text; its placeholder is "Enter = <recommendation>" (clipped to 40 characters) or "Answer…".
   - **Send answers** button, right-aligned, 26px, radius 6, 12px semibold: `solid` / `solid_foreground` when at least one question has a typed answer or a recommendation, else `raised` / `dim`.
   - **Worklist**: "Worklist <done>/<total>" in 11px `dim`, then one row per item: a mark (`✓` in `done`, `▶` in `working`, `·` in `dim`, `–` for skipped) and "<n>. <text>". The item in progress is semibold `foreground`, open ones `muted`, done and skipped ones `dim`.
4. **Notes**, 220px tall at the bottom, `border_t` 1px `border`: a 30px header row with "Notes" in semibold and the agent's name in 11px `dim` on the right, then a markdown editor (no line numbers, no folding, soft wrap, the person's terminal font at 12px).

## How it behaves

- **Only the agent you're on.** Questions, worklist and notes all follow `focused().terminal` (falling back to the focused agent). While focus is inside the Desk itself (typing an answer or a note), the last agent stays.
- **Agents post** by running `desk` in their shell. The CLI finds its terminal through `$HC_TERMINAL_ID` (set by herdr-core in every terminal) and writes `~/.config/herdr-app/desk/<terminal>.json`. The panel watches that folder with `watchFolder`, so a post shows within a moment and nothing polls.
- **Answering:** type in a question's box, or leave it empty to accept the recommendation. Enter in any box, or **Send answers**, sends every answered question of that agent as one line typed into its terminal with `hc send`: `Desk answers: Q1 "<question, max 80 chars>": <answer> | Q2 "…": <recommendation> (your recommendation)`. The agent reads it as a normal prompt; mid-turn, Claude Code takes it as a message during the turn. Sent questions are removed from the file. A question with neither a typed answer nor a recommendation is not sent.
- **×** drops a question without answering.
- **Clicking a worklist item** ticks it: open or in progress becomes done, done or skipped becomes open (the person's override; the agent's next `desk` call can change it again).
- **Clicking the agent row** runs `agent.focus {terminal}`.
- **Notes** save on their own, at most every 0.8s, to `~/.config/herdr-app/desk-notes/<terminal>.md`; an emptied note deletes its file. Switching agents switches the note. The agent never sees notes.
- **Cleanup:** files in `desk/` and `desk-notes/` of terminals that no longer exist are deleted (only when `terminals()` is non-empty, so a slow start never wipes anything).
- No sounds, no toasts.

## Built from

- **Layout:** none. The mod docks itself on first sight via `mod.json` `{ "place": "right", "size": 340, "title": "Desk" }`.
- **`mods/desk/main.js`**, one `View`:
  - `herdr`: `agents()`, `terminals()`, `focused()`, `theme()`, `settings()`, `appHome()`, `readTextFile`, `writeTextFile` (with the text last read as `expected`; retried up to 3 times when the CLI wrote in between), `watchFolder`, `hc(["send", terminal, text])`, `run("agent.focus", { terminal })`.
  - `gpui-base`: `v_flex`, `h_flex`, `InputState` + `Input` (one per question, created when its question first loads, released after sending), `EditorState` + `Editor` (the note).
  - `fs/promises`: `readdir`, `mkdir`, `unlink`.
  - A `cx.timer.every(800)` that flushes the note; nothing else runs on a timer.
- **`mods/desk/desk`**, the CLI (Python 3, standard library only), linked onto PATH: `ln -s ~/.config/herdr-app/mods/desk/desk ~/.local/bin/desk`.
  - `desk ask "Question?" [--rec "pick"] ["Another?" …]`: `--rec` belongs to the question before it; ids count up per terminal.
  - `desk list "Topic" …` replaces the worklist; `desk add "Topic" …` appends.
  - `desk doing N` (at most one item in progress), `desk done N…`, `desk skip N…`.
  - `desk clear [questions|list]`, `desk show` (prints the state, for an agent that lost track).
  - Prints `ok` and nothing else. Outside Herdr (`$HC_TERMINAL_ID` unset) it writes nothing and prints `ok (not in Herdr: nothing shown)`. Bad input exits 2 with one line on stderr.
  - Writes atomically (temporary file + rename). File shape: `{ terminal, cwd, updated, next_q, questions: [{ id, text, rec?, at }], list: [{ n, text, status: "open"|"doing"|"done"|"skipped" }] }`.
- **The agents' instructions**: add these lines to the agent's own instructions (for Claude Code `~/.claude/CLAUDE.md`, for Codex `~/.codex/AGENTS.md`):

  ```
  ## Herdr desk
  Inside Herdr (`$HC_TERMINAL_ID` set), post to the person's Desk panel with the `desk` CLI; it prints `ok`, don't read it back.
  - A question that blocks you on their decision: also `desk ask "Question?" --rec "your pick"` (several in one call). Their answers arrive as a prompt starting "Desk answers:".
  - Work of 3+ steps: `desk list "Step" ...` once, then `desk doing N` / `desk done N` as you go. No other updates.
  ```
- No `keys.json`.

## Watch out

- **Runs programs and writes files:** the mod runs `hc send` (types into your agents' terminals) and writes under `~/.config/herdr-app/desk/` and `desk-notes/`. No network.
- Answers go out as **one line**: `hc send` pastes and presses Enter, and a newline would submit early in some agents. Whitespace in answers is collapsed.
- Keep notes **out of** the watched `desk/` folder: every note save would otherwise trigger a reload.
- `focused().terminal` is null while focus is in a mod; keep the last agent, or the Desk empties as soon as you click into an answer box.
- Create `InputState` and `EditorState` in `init` or a `cx.spawn` callback, never in `render`.
- **Agents on other machines** (`hc machine`) run the CLI there, so their files land on that machine and don't show. Only this computer's agents for now.
- Agents running before the instruction lines were added need a restart to use `desk`.
- An agent that posts a question and ends its turn shows as `done`, not `blocked`; you see its questions when you go to it.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/desk` passes and the Desk docks on the right.
- In an agent's terminal, `desk ask "Test?" --rec "Yes"` prints `ok`, and while you're on that agent the card shows Q1 with "Rec: Yes".
- Pressing Enter in the empty box types `Desk answers: Q1 "Test?": Yes (your recommendation)` into that terminal, and Q1 disappears.
- `desk list "A" "B" "C"; desk done 1; desk doing 2` shows `✓ 1. A`, `▶ 2. B` in semibold, `· 3. C`, and "Worklist 1/3".
- Switching to another agent shows that agent's card and note instead; switching back brings the first ones back.
- Text typed in Notes is still there after switching agents and back, and is in `~/.config/herdr-app/desk-notes/<terminal>.md`.
- The Desk header's bottom border lines up with the tab bar's.
