# Desk — a Herdr mod

**Your agents ask, you answer in a box, they carry on.** Desk is a panel for [Herdr](https://herdr.dev) that shows the agent you're on: the decisions it's waiting on you for (each with its recommendation), the worklist it's working through, and a notes area for your own ideas about that agent.

![Desk next to a Claude Code agent: two questions with recommendations, a worklist, notes](preview.png)

## Why

When you run many agents at once, their questions get buried in the scrollback and you lose track of what each one is doing. Desk gives each agent one place for both, without costing the agent anything:

- **Almost no tokens.** Agents post with a tiny `desk` shell command that prints `ok`. No MCP server, no tool schemas in every session, no polling. In the demo above, the agent posted its whole plan and both questions with **one shell command**.
- **Answers flow back by themselves.** Type an answer, or press Enter to accept the agent's recommendation. Desk types `Desk answers: Q1 …: … | Q2 …: …` into the agent's terminal, and it continues.
- **Any agent.** Claude Code, Codex, pi, or anything else that runs in a Herdr terminal and can run a shell command.

![After answering: the agent built it and ticked off all five steps](screenshots/answered.png)

## What's on the panel

| | |
|---|---|
| **Questions** | Each with the agent's recommendation and an answer box. Empty + Enter = accept the recommendation. `×` drops a question. |
| **Worklist** | `✓` done, `▶` in progress, `·` open. Click an item to tick it yourself. |
| **Notes** | Your own scratchpad per agent, saved automatically. The agent never sees it. |

Everything follows the agent you're on: switch agents and the Desk switches with you.

<img src="screenshots/panel.png" alt="The Desk panel close up" width="320">

## Install

The easy way, in Herdr, ask any agent:

```
Read ~/.config/herdr-app/AGENTS.md, then add this mod: herdr.dev/mods/CMehlstaeubler/desk
```

Or by hand:

```sh
git clone https://github.com/CMehlstaeubler/herdr-desk
cp -r herdr-desk/mods/desk ~/.config/herdr-app/mods/
ln -s ~/.config/herdr-app/mods/desk/desk ~/.local/bin/desk   # any folder on your PATH
herdr-app check ~/.config/herdr-app/mods/desk
```

Then tell your agents about it. Add this to their instructions (Claude Code: `~/.claude/CLAUDE.md`, Codex: `~/.codex/AGENTS.md`):

```markdown
## Herdr desk
Inside Herdr (`$HC_TERMINAL_ID` set), post to the person's Desk panel with the `desk` CLI; it prints `ok`, don't read it back.
- A question that blocks you on their decision: also `desk ask "Question?" --rec "your pick"` (several in one call). Their answers arrive as a prompt starting "Desk answers:".
- Work of 3+ steps: `desk list "Step" ...` once, then `desk doing N` / `desk done N` as you go. No other updates.
```

Agents that were already running pick it up after a restart.

## The CLI

```sh
desk ask "Question?" --rec "your pick" ["Another?" …]
desk list "Step" "Step" …        # replace the worklist
desk add "Step" …                # append
desk doing 3                     # one item in progress at a time
desk done 1 2   |   desk skip 4
desk clear [questions|list]
desk show                        # print the state
```

Python 3, standard library only. Outside Herdr it does nothing and still prints `ok`, so the instructions are safe everywhere.

## How it works

`desk` writes one JSON file per terminal (`$HC_TERMINAL_ID`) to `~/.config/herdr-app/desk/`. The panel watches that folder and draws the file of the agent you're on. Sending answers runs `hc send <terminal> "Desk answers: …"`. Notes live in `~/.config/herdr-app/desk-notes/`. Files of terminals that are gone are cleaned up.

The mod runs `hc send` (it types into your agents' terminals) and writes only under `~/.config/herdr-app/`. No network.

## Limits

- Agents on other machines (`hc machine`) write their files there, so they don't show yet.
- An agent that posts a question and ends its turn shows as *done*, not *blocked*: you see its questions when you go to it.

[RECIPE.md](RECIPE.md) is the full brief to rebuild Desk from scratch.

## License

MIT, see [LICENSE](LICENSE).
