# forge-cloud

A copy of [system-factory](https://github.com/hoangtrankim/system-factory) at commit 7533f22, the starting point for running the factory from a Claude session with a GitHub merge gate. Design: https://claude.ai/artifact/3gwwibvZYS5D5bXYvMxdqX

## How forge-cloud runs

Two parts, so that no Claude session ever merges its own work:

- **A Claude session dispatches.** In the target repo, the `forge-loop` skill (installed by `forge init` into `.claude/skills/`) runs `forge steps` to find the next agent step, starts that `factory-*` agent as a subagent with the printed prompt, checks with `forge show N` that the ticket moved, and repeats. It never merges.
- **A GitHub gate merges.** `forge init` also installs `.github/workflows/forge-gate.yml`. On label changes, ticket comments, finished CI runs and once an hour, it runs `forge merge-gate` as the forge-bot GitHub App. That command runs the rule steps only, never an agent: it merges a PR whose head is the reviewed commit once every check is green and the QA note names that commit, posting the `factory/review` status first. It also marks merged tickets done, sends changed PRs back to review, and brings `main` into PRs behind it.

Set `reviewStatus: gate` in `factory.config.yml` (what `forge init` writes): the reviewer's pass then only records the reviewed commit, and the gate posts the required `factory/review` status just before it merges. A cloud session cannot write commit statuses.

The reviewer and security stay read-only as subagents: `forge init` adds a `forge guard` PreToolUse hook on Bash to the project's `.claude/settings.json`, which fires inside every subagent and picks the role from the subagent's type (`factory-reviewer`, `factory-security`). Their agent files also carry `forge guard --role <role>` in their frontmatter. The session loop never runs those two as general-purpose subagents, since a guard can't tell them apart from any other.

### Set up a repo

1. Create a GitHub App (forge-bot) with repository permissions Contents: read and write, Pull requests: read and write, Issues: read and write, Commit statuses: read and write, Checks: read, Metadata: read. Install it on the target repo.
2. Add two repo secrets: `FORGE_BOT_APP_ID` and `FORGE_BOT_PRIVATE_KEY`.
3. Run `forge init` in the repo and commit what it writes. Branch protection can keep requiring `test` and `factory/review`.
4. To run the factory, ask a Claude session in the repo to "run the factory".

### Watch it: the Forge pane

`plugins/forge-panel` is a Claude Code mod that shows a **Forge** pane beside the chat: open tickets per state, the factory agents running now (role, ticket, model, minutes) and the last few that finished. Install it once, then open a Claude Code session in the target repo (Claude Code in a terminal, the desktop app or claude.ai/code) and say "run the factory". Each agent shows as a subagent in the chat, and the pane keeps the overview.

```
/plugin install forge-panel --marketplace hoangtrankim/forge-cloud
```

Details: [plugins/forge-panel/README.md](plugins/forge-panel/README.md).

## The original system-factory README

An autonomous spec-to-PR workflow built on Claude Code. You agree a spec with the Grill. After that, agents split it into tickets, then design, test, build, review and QA each ticket, with one PR per ticket. Nobody reviews the PRs by hand: rules in code, a security gate for risky work, blind acceptance tests and CI decide.

The idea comes from [Kiln](https://github.com/thuongdinh/kiln-software-factory): **judgement lives in prompts, rules live in code, state lives in the tracker.** Agents never edit labels themselves. They call the `forge` CLI, which refuses any move the rules don't allow.

The command is called `forge`. The agents (`factory-*`), the labels (`factory:*`), `factory.config.yml` and the log folder keep the `factory` name.

Design doc: https://claude.ai/artifact/Kqw238YaXngzZFgXsEv4fn

## Status

| Phase | What | State |
| --- | --- | --- |
| 1 | Rules CLI, labels, GitHub tracker adapter, unit tests | done |
| 2 | Agent prompts: Grill, Planner, Designer, QA test writer, Builder, Security, Reviewer, QA reporter | done, tuned by two dry runs on [todo-app](https://github.com/hoangtrankim/todo-app) |
| 3 | CI gate, branch protection, auto-merge, then the merge queue | CI gate, branch protection and auto-merge done; merge queue later |
| 4 | `forge dispatch`: the loop that runs the agents, plus JSONL logs | done |
| 5 | Parallel slots, then retro and lessons from the logs | later |

## The workflow

```
 you + Grill          Planner           per ticket (one PR each)                                   you
 ───────────    ───────────────    ─────────────────────────────────────────────────────────    ─────
 idea → spec ─▶ spec → tickets ─▶ Designer → QA writer → Builder → [Security] → Reviewer → QA ─▶ merge
 (AC-1, AC-2…)  (covers, blockers,  design    blind       PR        risky      read-only   CI      │
                 priority, risky)   note      tests                 only       review    evidence  ▼
                                                                                         ticket done
                                       ◀────── send-back with a typed reason (round +1) ──────┘
 Planner again: when every ticket is done, files review follow-ups as tickets or closes the spec
```

1. **Grill** (`/factory-grill` in Claude Code). It questions you one at a time, each with a suggested default, until every behaviour is testable. It writes the spec with numbered `AC-n` criteria and files it as a GitHub issue labelled `type:spec`.
2. **Plan.** The planner splits the spec into PR-sized tickets. Each ticket names the criteria it covers, its components (from `factory.config.yml`), its priority and its blockers. Tickets touching the same component block each other so they never run at once. Risky tickets are marked `risky` (see below).
3. **Design.** The designer writes a short design note on the ticket covering the public interface, test setup, files, approach and risks. The public interface names every control's role and accessible name, plus each route's status codes.
4. **Blind tests.** The QA writer reads only the spec and the design note's public interface (`forge interface N`), never the code. It writes acceptance tests under `tests/acceptance/`, pushes them to branch `ticket-N`, and marks the ticket `tests-ready`. The builder can never change these tests.
5. **Build.** In its own worktree on top of those tests, the builder makes them pass and adds its own tests. It opens the PR with `forge pr`. If an acceptance test is wrong, it sends the ticket back to the QA writer (`flawed-test`) rather than working around it.
6. **Security gate** (risky tickets only). A read-only security reviewer passes or fails the PR. A fail sends it back and costs a round. It also writes a risk note for the owner's weekly digest.
7. **Review.** A read-only reviewer checks the PR against the spec, the design note, the ticket's components and the acceptance-test commits, a fixed list of quality rules, and runs the tests. Blocking findings send the ticket back with a typed reason. Minor ones become **Follow-ups**. A pass covers one commit only (see [the review gate](#the-review-gate)).
8. **QA.** The QA reporter reads CI on the PR's head commit and posts per-test evidence on the ticket. Red CI sends the ticket back.
9. **Merge.** The dispatcher merges the PR itself once the reviewed commit is green and the QA evidence is posted (see [auto-merge](#auto-merge)), then marks the ticket done, which unblocks the next one. Nobody needs to review the PR.
10. **Close.** When every ticket is done, the planner files the real follow-ups as new tickets, or closes the spec.

A ticket sent back 3 times goes to `needs-human`. So does any question an agent cannot answer. Agents never guess past a gap in the spec.

**Risky** means login or sessions, permissions or one user reaching another's data, payments, secrets, personal data, or bulk or irreversible deletion. A user deleting one of their own items is not risky. Risky tickets still merge without a human, but only after the security gate, and the merge note on the ticket asks the owner to look at it afterwards.

## Run it

The runner is one machine (the Mac mini) with Node 22+, `git`, the GitHub CLI and Claude Code, all signed in.

```sh
# once: the forge CLI (the repo is private, so link it from a clone)
git clone https://github.com/hoangtrankim/system-factory && cd system-factory
npm ci && npm run build && npm link

# once per target repo
cd ~/path/to/your-app
forge init --repo owner/name        # agents + grill skill into .claude/, and factory.config.yml
forge setup                         # create the labels
```

Then, for each piece of work:

1. In Claude Code in the target repo, run `/factory-grill` and agree the spec.
2. In a terminal in the same repo, run `forge dispatch --watch`.
3. That's it: green, reviewed PRs merge on their own. Look at what `Waiting on a human` lists, and at the risky tickets' merge notes.

Check `forge dispatch --dry-run` at any time to see what would run next. `forge list --all` shows every ticket.

A step-by-step runbook for todo-app: https://claude.ai/artifact/CYF2fR38JET9qbkC4C5k9N

## The dispatcher

`forge dispatch` reads the tickets, picks the next step from the routing table in `src/router.ts`, and runs that agent as its own process: `claude -p --agent factory-<role>`, given only the ticket number. It then reads the tickets again. The first matching rule wins:

1. A spec with uncovered criteria → planner (split).
2. `in-qa` with a merged PR (merged by hand) → the dispatcher marks it done.
3. `in-qa` whose PR head is not the reviewed commit → back to `in-review` (no round spent).
4. `in-qa` at the reviewed commit, but the PR is behind `main` → the dispatcher merges `main` into the PR and sends it back to `in-review` (no round spent).
5. `in-qa` at the reviewed commit, every check green, QA note posted for that commit → the dispatcher merges it and marks it done.
6. `in-qa` with CI finished and no QA note for the head SHA → qa-reporter.
7. Risky `in-review` without a passed gate → security.
8. Other `in-review` → reviewer.
9. `building` (a send-back, or a build that stopped) → builder.
10. `designed` with tests ready and blockers done → builder.
11. `designed` without tests → qa-writer.
12. `planned` → designer.
13. A spec whose tickets are all done → planner (close or file follow-ups).

Finishing work comes before starting new work, and within a rule the lowest priority number goes first.

The dispatcher runs one agent at a time and posts "Started `factory-<role>`" on the ticket before each run. If a run changes nothing, it skips that agent on that ticket until the ticket changes. If a run fails because `claude` is not logged in, the dispatcher stops instead (run `claude auth login`, then start it again). A lock file stops a second dispatcher on the same repo.

| Flag | Effect |
| --- | --- |
| `--dry-run` | print the next step only |
| `--max-runs N` | stop after N agent runs (default 25; ignored with `--watch`) |
| `--watch [--interval S]` | never stop; when idle, check again every S seconds (default 300) for merges and new specs |

### Auto-merge

Merging is a rule, not a judgement, so no agent does it. Once the qa-reporter has posted its evidence for the PR's head commit, the dispatcher runs the same check as `forge merge N --as owner`:

- the ticket is `in-qa` and its PR is open;
- the PR head is the commit the reviewer passed (`Reviewed: <sha>`);
- every check on that commit has finished and passed.

Then it merges over REST (`PUT /pulls/N/merge`) pinned to that commit, so a push that lands in between makes GitHub refuse the merge instead of merging unreviewed code. Branch protection checks again on GitHub's side (required `test` and `factory/review`, branch up to date). On success the ticket moves to `done` with a note naming the commit; a risky ticket's note asks the owner to look at it afterwards. If GitHub refuses (a conflict, a missing required check), the ticket goes to `needs-human` with GitHub's reason.

A PR that is behind `main` (another ticket merged first, and branch protection wants branches up to date) is not merged as it is. The dispatcher calls `PUT /pulls/N/update-branch`, pinned to the reviewed commit, and moves the ticket back to `in-review`. The merge commit is new code to the reviewer and to CI, so it goes through review, checks and QA again before it can merge, without costing a round. If `main` does not merge cleanly, the ticket goes to `needs-human`.

This needs no repo setting: it is not GitHub's "auto-merge" button, which needs GraphQL and waits for checks. Here the checks have already finished when the merge runs. `mergeMethod` in `factory.config.yml` picks `merge` (default), `squash` or `rebase`, and the repo must allow that method.

### The guard hook

The reviewer and the security reviewer keep `Bash` so they can run `forge`, git and the tests, but the dispatcher runs them with a Claude Code `PreToolUse` hook, `forge guard` (`src/guard.ts`). It checks every command before it runs and blocks anything outside a read-only list: no `git push`, `commit`, `checkout` or `reset`, no `forge --as` another role, no writes outside `/tmp/factory`, `npm` only inside a throwaway worktree under `/tmp/factory`, `curl` only to localhost, and no `$( )`, backticks or `&`. A blocked command is refused with the reason, and unreadable input is refused too. The runner passes the hook with `--settings` and sets `FACTORY_ROLE`, so the target repo's own settings are untouched. Other roles are not guarded yet.

### Logs

Logs record facts, not transcripts. They go to `~/.factory/logs/<owner>/<repo>/`, or `FACTORY_LOG_DIR` if set, and the phase 5 retro will read them:

- `events.jsonl` has every ticket change made through the CLI, including the agents' own: moves, gates, notes, rounds, escalations.
- `runs.jsonl` has one line per agent run: ticket, agent, rule, exit code, duration, cost, turns, session id, whether it changed anything, and its one-line summary.

`forge report` turns them into the end-of-day **reviewer report**: reviews, pass rate, send-backs by reason, re-reviews after a push, tickets done and their rounds, reviewer run time and cost, and **escapes**, meaning PRs the reviewer passed that QA or the owner sent back later. Escapes only count mistakes someone found; a planted-bug benchmark comes with the retro agent. To get it every evening on the runner machine, add a cron line such as `55 23 * * * cd ~/todo-app && forge report > ~/.factory/reports/$(date +\%F).md`.

## Agents

Each role is a Claude Code subagent in `agents/`, and the Grill is a skill in `skills/`. `forge init` copies them into a project's `.claude/` folder. Every agent:

- changes tickets only through `forge ... --as <its role>`;
- reads `lessons/<role>.md` if it exists;
- writes its notes to `/tmp/factory/<role>-<N>.md`;
- ends with a one-line report.

| Agent | Picks up | Does | Tools |
| --- | --- | --- | --- |
| Grill (skill) | an idea from the owner | grills the owner one question at a time, writes the spec, files it | main session |
| `factory-planner` | a new spec, a blocked ticket, a finished spec | splits the spec into tickets; corrects them before building (`forge edit`); files follow-ups; closes the spec | read only |
| `factory-designer` | `planned` | design note: public interface with test setup, files, approach, risks (must / should) | read + temp files |
| `factory-qa-writer` | `designed` without tests | blind acceptance tests and the test setup they need, pushed to `ticket-N` | no `Grep` or `Edit`; never reads app code |
| `factory-builder` | ready tickets and send-backs | builds in a worktree, opens the PR; never touches `tests/acceptance/` | full |
| `factory-security` | risky tickets in `in-review` | security gate pass or fail, plus a risk note | read only, opus |
| `factory-reviewer` | `in-review` (after security on risky) | fresh review against spec, design and scope; runs the tests; blocking findings or follow-ups | read only, opus |
| `factory-qa-reporter` | `in-qa` with CI finished | per-test evidence from CI; red CI goes back | read only |

Read-only agents still have `Bash`, so they can run `forge`, `git` and tests. The prompts forbid writes. Guard hooks that block writes mechanically come later.

### Patterns catalog

Each app repository can keep a short catalog of its house design patterns in `docs/patterns.md`: what each pattern is, where it lives, and when to use it. The designer names the patterns a ticket uses in a **Patterns** section of its design note. The designer never edits the repository, so when a ticket needs a new pattern or a change to one, it writes the full entry in the note and the builder adds it to the catalog in the ticket's PR. The builder follows the named patterns, and the reviewer sends a PR back as `design` when it ignores or bypasses them, or as `scope-creep` when it edits the catalog without the note asking. Write the first version by hand from the code the repository already has.

The contract test in `src/agents.test.ts` keeps the prompts honest. It checks that each agent acts only as its own role, names only real states and send-back reasons, never uses GraphQL `gh` commands, keeps the flawed-test path, and wires the patterns catalog through the designer, builder and reviewer.

## Ticket lifecycle

```
planned -> designed -> building -> in-review -> in-qa -> done
              ^           ^            |           |
              |           +-- send back (round +1) +
              +-- flawed-test send-back (round +1)
side states: blocked, needs-human
```

| Move | Who | The CLI checks first |
| --- | --- | --- |
| planned → designed | designer | |
| designed → building | builder | blind QA tests are marked ready, every `Blocked by` ticket is done |
| building → in-review | builder | a PR is given |
| in-review → in-qa | reviewer | a `risky` ticket has passed the security gate; `--sha` is the PR's current head commit |
| in-qa → in-review | system (the dispatcher) | the PR has commits the reviewer did not pass; no round is spent |
| in-qa → done | system (the dispatcher) | the PR is linked; the dispatcher does this after it merges the PR, or once the owner has |
| in-review → building | reviewer, security | a send-back reason; round + 1 |
| in-qa → building | qa-reporter, system | a send-back reason; round + 1 |
| building / in-review → designed | builder, reviewer | reason `flawed-test` only; round + 1, tests-ready cleared, so the QA writer fixes the test |
| any → blocked | any agent, owner | a reason |
| any → needs-human | any agent, owner, system | a reason |
| blocked / needs-human → planned | planner, owner | |

The send-back that reaches `maxRounds` (default 3) goes to `needs-human` instead. Send-back reasons: `spec-gap`, `wrong-behavior`, `missing-test`, `failing-check`, `scope-creep`, `design`, `quality`, `unmarked-risk`, `flawed-test`.

### The review gate

A review covers one commit. Passing a review (`forge move N in-qa --as reviewer --sha <sha>`) is refused unless `<sha>` is the PR's head right now. On success the CLI records `Reviewed: <sha>` on the ticket and sets a commit status, `factory/review`, to success on that commit. Commit statuses belong to one commit, so any later push starts without one. Make `factory/review` a required status check in the target repo's branch protection, and only reviewed code can merge. The dispatcher also sends an `in-qa` ticket whose PR head is not the reviewed commit back to `in-review`, so the new commits get reviewed, without costing a round.

Only the grill or owner file specs. Only the planner or owner file tickets, edit them before building and close specs. Only the qa-writer marks tests ready, and only the builder opens a ticket's PR, from branch `ticket-N`.

## How a ticket is stored

| Field | On GitHub |
| --- | --- |
| State | `factory:<state>` label |
| Type | `type:spec` label (none means a build ticket) |
| Priority | `priority:p0` … `priority:p3` (none means p2) |
| Round | `round:N` |
| Flags | `risky`, `qa:tests-ready` |
| Components | `component:<name>` |
| Gate results | `gate:security:pass` or `:fail`, cleared on every send-back |
| Links | body lines `Spec: #1`, `Covers: AC-1, AC-2`, `Blocked by: #3`, `PR: #12` |
| Reviewed commit | body line `Reviewed: <sha>`, cleared on any move after the pass |
| Design note, reviews, evidence | comments on the ticket, each starting with the role that wrote it |

All ticket access goes through the `Tracker` interface in `src/tracker/tracker.ts`, so a Jira adapter can replace GitHub Issues later. PRs and CI go through `CodeHost` in `src/codehost.ts`. Every GitHub call uses the REST API (`gh api`), never GraphQL, so it also works on networks that block GraphQL.

## CLI reference

Commands that change something need `--as <role>`. A refused change exits with code 2 and says why. `--note-file` works anywhere `--note` does.

```sh
forge init [dir] [--force]                 # install agents, grill skill, factory.config.yml
forge setup                                # create the labels
forge list [--state S] [--type spec|build] [--all]
forge show N [--comments [--from role,role]]
forge next                                 # tickets a builder may start now
forge spec-status S                        # criteria, uncovered, open tickets

forge create --as grill --type spec --title T --body-file F
forge create --as planner --spec S --title T --covers AC-1,AC-2 --component ui [--blocked-by 2] [--priority p1] [--risky]
forge edit N --as planner [--risky | --not-risky] [--component C] [--covers ...] [--blocked-by ...]
forge move N <state> --as R [--reason R] [--note-file F] [--pr P] [--sha SHA]   # a reviewer pass needs --sha
forge tests-ready N --as qa-writer --note-file F
forge gate N security pass|fail --as security [--reason R] --note-file F
forge note N --as R --note-file F
forge evidence N <file> --as qa-reporter   # upload, print the link
forge close-spec S --as planner
forge report [--date YYYY-MM-DD | --days N]   # reviewer report from the logs (default: today)

forge interface N                          # the design note's Public interface only
forge pr N --as builder --body-file F      # open or find the PR for branch ticket-N
forge diff N                               # the PR's diff
forge checks N                             # CI on the PR head, and whether it is merged; exit 3 failed, 4 pending
forge merge N --as owner                   # merge the reviewed, green PR now and mark the ticket done
forge dispatch [--dry-run] [--max-runs N] [--watch [--interval S]]
```

The repo comes from `--repo`, then `FACTORY_REPO`, then `repo:` in `factory.config.yml`, then the `origin` remote.

## factory.config.yml

```yaml
repo: owner/name
base: main          # branch PRs target
maxRounds: 3        # send-backs before needs-human
components:         # name -> paths it owns; tickets use these names, the reviewer checks PR scope
  ui: ["public/**"]
  api: ["server.js", "lib/**"]
claudeArgs:         # optional: flags for each agent run (default below)
  ["--permission-mode", "acceptEdits", "--allowedTools", "Bash"]
```

`forge init --force` rewrites this file from the template, so keep a copy when you reinstall the agents.

## Development

```sh
npm test          # unit tests, including the agent-prompt contract test
npm run typecheck
npm run build     # dist/, used by the linked `forge` command
```
