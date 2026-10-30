# ccstatus-band

**English** · [中文](README.zh-CN.md)

A mod for the Claude Code desktop app that draws a small table in the band above the prompt: how fast the model is writing right now, what the last turn cost, and what the session has spent so far.

![The band above the prompt](assets/band.png)

```
     tok/s · out ·   in ·   hit · total
live  ~96 · 726
last   58 · 16.8k · 138k · 97.3%
sess   55 · 726 · 138k · 97.3% · 5.0M
```

Same field, same column, on every row, so the eye reads one column down instead of hunting: each value is right-aligned on the widest in its column, and the row that comes and goes keeps its place.

## What each row means

| Row | Field | Meaning |
| --- | --- | --- |
| `live` | `tok/s` | Decode rate of the reply streaming right now, **estimated** from the characters received (see the note below) |
| | `out` | Estimated tokens of that reply so far |
| `last` | `tok/s` | Decode rate of the turn just finished: output tokens over the time spent generating them, tool runs excluded |
| | `out` | Tokens the model generated in that turn |
| | `in` | Prompt tokens that were **not** served from the prompt cache |
| | `hit` | Share of the turn's prompt tokens that came from the cache |
| `sess` | `tok/s` | Session-wide decode rate: all output tokens over all generation time |
| | `out` | All output tokens this session |
| | `in` | All uncached prompt tokens this session |
| | `hit` | Session cache hit rate |
| | `total` | Everything the session carried: uncached input + cache reads + cache writes + output |

`live` is the only estimated number. The API reports a response's token counts once, in its last chunk, so mid-stream there is nothing to count; the band counts CJK characters as one token and everything else as a quarter, then replaces the estimate with the API's own numbers when the response ends. It is good enough to watch, not to reconcile against a bill.

## Where the numbers come from

Everything else is the API's own accounting, read from the engine's `turn.step` and `turn.complete` events:

- **Per request, not per turn.** A turn is usually several requests (answer → tool → answer). Some gateways report only the last request's usage at `turn.complete`; the band sums every request's `stop` chunk instead, so `last` is the whole turn.
- **Subagents are excluded.** Their steps run their own loop; folding their tokens into the session rate would make it meaningless.
- **Uncounted turns are skipped.** A gateway that answers a turn with an all-zero usage object leaves the band showing the previous numbers rather than `0 tok/s`.

## Install

The app loads any folder under `~/.claude/skills/` that has a `.claude-plugin/plugin.json` and a `hooks/hooks.json`:

```bash
git clone https://github.com/gzhang33/ccstatus-band.git ~/.claude/skills/ccstatus-band
```

Restart the session (or start a new one) and the band appears above the prompt. To remove it, delete the folder.

Or install it from this repository's marketplace:

```
/plugin marketplace add gzhang33/ccstatus-band
/plugin install ccstatus-band --marketplace gzhang33/ccstatus-band
```

Requires a Claude Code build that supports mods (`turn.step` / `turn.complete` / the `AbovePrompt` render target) — 2.1.x and later of the desktop app.

## Develop

```bash
claude plugin validate .      # manifest + hooks module, the way the engine reads them
claude plugin test .          # the tests in tests/, against the real hook engine
```

The layout:

- `hooks/register.tsx` — the whole mod: rate accounting, the per-turn sum, the table
- `types/index.d.ts` — the shape of what it keeps in `$.state`
- `tests/band.test.tsx` — decode-rate accounting, live estimate, uncounted turns, row layout

## Limitations

- A field wider than its column (a `10.5M` total against a `5.0M` session) pushes that column one character right for the rest of the session.
- `live` disappears at the end of each response — a tool run is not a decode window — and the `last` row keeps its place meanwhile.
- No cost figure: it needs a price table per model, and this one is used behind several gateways.

## License

MIT — see [LICENSE](LICENSE).
