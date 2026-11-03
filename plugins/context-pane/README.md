# context-pane

A Claude Code mod that puts a **Context** pane beside the chat, for the numbers the app's own Context list leaves out:

- **Context window**: how full it is, as a bar with `11% · 107k / 1M`.
- **Cache · last response**: of the input the last request was answered over, how much was **read from cache** (cheap), **written to cache** (a little dearer than plain input) and **not cached** (full price), as one bar and three rows, with the cache hit rate and the output tokens.
- **Cache · this session**: the same, summed over every turn since the session started.
- A one-line verdict: warm, partly reused, or a miss (first request, a change near the top of the prompt, or over 5 minutes idle).

It refreshes after every turn. `/context-cache` opens the pane again and answers with the same numbers as text.

## Install

```
/plugin install context-pane --marketplace hoangtrankim/forge-cloud
```

## Develop

`claude plugin validate plugins/context-pane` and `claude plugin test plugins/context-pane`.
