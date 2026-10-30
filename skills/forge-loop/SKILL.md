---
name: forge-loop
description: Run the system factory from this Claude session, the way Kiln's loop does - pick each ticket's next step with forge, run that factory agent as a subagent, and repeat until nothing can move. Use when the owner says "run the factory" (or "run forge") in a repo with factory.config.yml.
---

# Run the factory

You are the dispatcher. You never write code and never judge a ticket yourself: the factory agents do the work, `forge` holds the rules, and the GitHub merge gate (`.github/workflows/forge-gate.yml`) merges. Your job is to keep tickets moving and to keep the owner informed.

## Never

- Never merge, and never run `forge merge`, `forge merge-gate` or `forge dispatch`. Merging is the gate's job. A Claude session that merges its own work is blocked, and it should be.
- Never act `--as owner` or `--as system`, and never move a ticket yourself. Agents move tickets as their own role.
- Never edit code, push, or comment on PRs yourself.

## Set up

1. Work in the target repo's checkout. Install forge from source (an npm install straight from GitHub skips the build): `git clone --depth 1 https://github.com/hoangtrankim/forge-cloud /tmp/forge-cloud && cd /tmp/forge-cloud && npm ci && npm run build && npm install -g .`, then back in the repo `forge list` must answer. If it can't reach GitHub, stop and tell the owner.
2. Check `reviewStatus: gate` is in `factory.config.yml`. Without it the reviewer's pass tries to post a commit status, which a cloud session cannot do.
3. The agents are the `factory-*` subagents in the repo's `.claude/agents/`. If they are not offered as subagent types, start a general-purpose subagent with: "Read `.claude/agents/factory-<role>.md` and follow it exactly as factory-<role>. Your task: <prompt>". Use the model the file names.

## Each tick

1. `forge steps` prints the next agent step: `factory-<role> #N (<rule>): <prompt>`.
2. Run that agent as a subagent with exactly that prompt, and wait for it. One agent at a time for now: two at once share ports and test data.
3. When it returns, `forge show N` must show the ticket moved, or a new comment from that role. An agent's own claim is not enough. If nothing changed, say so once in the checklist and skip that agent on that ticket until the ticket changes.
4. Go back to 1.

When `forge steps` says no agent can move a ticket:

- If tickets sit in `in-qa`, they wait on CI, the QA report, or the gate. Wait about 20 minutes without spinning (schedule a wake-up), then tick again.
- If a ticket is `needs-human` or `blocked`, tell the owner which one and why, with its link, and keep working on the rest.
- If nothing is in flight, the run is over.

## Keep the owner informed

Keep a checklist with one line per active ticket: its state and the agent working on it. Send a short message (under 80 words) only when a ticket merges, when one needs the owner, or when the run stops. Lead with what merged and what is next. When the owner asks about a ticket, answer from `forge show N --comments`, which holds every agent's final note.
