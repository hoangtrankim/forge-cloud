# forge-panel

A Claude Code mod that puts a **Forge** pane beside the chat while a session runs the factory (the `forge-loop` skill):

- **Tickets**: open factory tickets per state, from `forge list --json` in the session's folder (refreshed every minute and whenever a factory agent finishes).
- **Running**: each factory agent running now, with its role, ticket, model and minutes. It counts `factory-<role>` subagents and general-purpose subagents told to follow `.claude/agents/factory-<role>.md`.
- **Finished**: the last few factory agents that finished, with a tick or a cross.

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
