# forge-panel

A Claude Code mod that puts a **Forge** pane beside the chat while a session runs the factory (the `forge-loop` skill):

- **Needs you**: tickets waiting on you (`needs-human`, `blocked`), in a red box; a green tick when nothing is.
- **Pipeline**: a progress bar for the work in hand (open tickets, done tickets of open specs, and specs not split yet), with `47% · 1 of 5 done`: the share of pipeline steps behind it. Below it every state in order, `spec › planned › designed › building › review › qa › done`, each in its own colour with its count.
- **Tickets by state**: each open ticket by title, with a six-step bar showing how far it has come (`▰▰▰▱▱▱` is building), as a link to its issue, with its round when it was sent back, `⚠ risky`, and its priority in the planner's words (`core`, `main flow`, `secondary`, `polish`; specs show none).
- **Running now**: each factory agent running, with its role, ticket, model, minutes and step (`step 4 of 6`).
- **Recently finished / done**: the last agents that finished (✓ or ✗) and the last three done tickets.
- A one-line hint on what to do next when no agent runs.

Tickets come from `forge list --all --json` in the session's folder (refreshed every minute and whenever a factory agent finishes). It counts `factory-<role>` subagents and general-purpose subagents told to follow `.claude/agents/factory-<role>.md`. Colours are theme colours, so they follow light and dark mode.

`/forge` opens the pane again if you closed it.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install forge-panel --marketplace hoangtrankim/forge-cloud
```

Answer `y` to add the marketplace, then pick the user scope. In the desktop app: click + next to the prompt box, then Plugins, Add marketplace `hoangtrankim/forge-cloud`, then Add plugin.

It needs `forge` on the PATH (see the forge-cloud README) and a folder with `factory.config.yml`.

## Develop

`claude plugin validate plugins/forge-panel` and `claude plugin test plugins/forge-panel`.
