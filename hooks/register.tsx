import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Band, Cur, LiveStat, Tally } from '../types'

const band = atom({ plugin: 'ccstatus-band', key: 'band' } as const, null)
const tally = atom({ plugin: 'ccstatus-band', key: 'tally' } as const, null)
const cur = atom({ plugin: 'ccstatus-band', key: 'cur' } as const, null)
let seq = 0

// Decode-only throughput, the way inference benchmarks report it: generated
// tokens over the span from the first generated chunk to the stop chunk, so
// prefill (TTFT) and tool execution stay out of the rate.
const rate = (tokens: number, ms: number) => (ms >= 100 ? (tokens / ms) * 1000 : 0)
// Whole-percent rounding collapses every real hit above 99.5 to "100"; keep a
// decimal so a 163k-token prompt with 300 uncached tokens still reads 99.8.
const pct = (cached: number, denom: number) => (denom > 0 ? (cached / denom) * 100 : 0)
const fmtRate = (v: number) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1))
const fmtTokens = (v: number) => {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  // 1500 rounded to "2k" reads 33% wrong; keep a decimal until 10k, where the
  // rounding error stops mattering.
  if (v >= 10000) return `${Math.round(v / 1000)}k`
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(v))
}

// Left- or right-pads a cell to its column's width, so every row and every
// redraw puts the same field in the same place.
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const cell = (v: string, w: number) => v.padStart(w)

// One row: its cells, already padded to their columns, joined by the divider.
const line = (cells: string[]) => cells.join(' · ')
const pctF = (v: number) => v.toFixed(1)

// Nothing in a streamed chunk counts tokens: each response reports its counts
// once, at its stop chunk, and that is the last thing to arrive. So the live
// rate counts CJK characters as one token and everything else as a quarter,
// and the stop chunk replaces the estimate with the API's own numbers.
// ponytail: rough tokenizer; swap in a real one only if the live figure ever
// needs to be exact.
const CJK = /[　-鿿가-힯＀-￯]/
const est = (s: string) => {
  let n = 0
  for (const ch of s) n += CJK.test(ch) ? 1 : 0.25
  return n
}

/** A turn with nothing counted yet. */
const ZERO_TURN: TurnStat = { tokPerSec: 0, hitPct: 0, input: 0, out: 0, total: 0, turn: 0, ttftMs: 0, seconds: 0 }
const ZERO_SESS: SessionStat = { tokPerSec: 0, hitPct: 0, input: 0, out: 0, total: 0, turns: 0, ttftMs: 0 }

/**
 * The band from the finished turns plus the one still running. `open` is that
 * turn so far, `extra` the reply streaming now, whose counts the API reports
 * only at its stop; both rows therefore move with the answer instead of
 * appearing when the turn ends.
 */
const bandOf = (
  done: Partial<Tally> | null,
  open: Cur | null,
  extra: { out: number; ms: number; ttftMs: number },
  live: LiveStat | null,
): Band => {
  const t = {
    out: done?.out ?? 0,
    ms: done?.ms ?? 0,
    input: done?.input ?? 0,
    cached: done?.cached ?? 0,
    written: done?.written ?? 0,
    ttftMs: done?.ttftMs ?? 0,
    turns: done?.turns ?? 0,
  }
  const c = {
    out: (open?.out ?? 0) + extra.out,
    ms: (open?.ms ?? 0) + extra.ms,
    input: open?.input ?? 0,
    cached: open?.cached ?? 0,
    written: open?.written ?? 0,
    // The turn's first wait: an earlier step's, else this reply's once it starts.
    ttftMs: open?.ttftMs || extra.ttftMs,
  }
  const prompt = c.input + c.cached + c.written
  // A streaming reply is a turn running even before its first step is counted.
  const running = open !== null || live !== null
  const turns = t.turns + (running ? 1 : 0)

  return {
    live,
    last: {
      tokPerSec: rate(c.out, c.ms),
      hitPct: pct(c.cached, prompt),
      input: c.input,
      out: c.out,
      total: prompt + c.out,
      turn: running ? turns : t.turns,
      ttftMs: c.ttftMs,
      seconds: c.ms / 1000,
    },
    session: {
      tokPerSec: rate(t.out + c.out, t.ms + c.ms),
      hitPct: pct(t.cached + c.cached, t.input + t.cached + t.written + prompt),
      input: t.input + c.input,
      out: t.out + c.out,
      total: t.input + t.cached + t.written + t.out + prompt + c.out,
      turns,
      ttftMs: t.ttftMs + c.ttftMs,
    },
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    seq = -1
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // A subagent's steps are its own loop; the band reports the main one.
    if (e.agentId) {
      yield* next(e)
      return
    }

    let first = 0
    let last = 0
    let streamed = 0
    // First show is immediate, so the live row appears with the first chunk.
    let shownAt = -1e15
    // The wait before the first generated chunk, in ms: prefill and the
    // gateway's queueing, which no streaming chunk can show while they last.
    // The host's clock: two reads per step, and it is the one the tests drive.
    const askedAt = await $.clock.now()
    let ttftMs = 0
    // Whether a step of this turn is already counting it.
    const curTurn = (await read($, cur))?.turnId === e.turnId
    const done = (await read($, tally)) as Partial<Tally> | null
    // The turn so far: earlier steps of this turn, then each one as it ends.
    let open = curTurn ? ((await read($, cur)) as Cur) : null
    // This one response's counts, as its stop chunk reports them.
    let out = 0
    let input = 0
    let cached = 0
    let written = 0

    for await (const c of next(e)) {
      // Local clock: a host round trip per chunk would be more traffic than the
      // tokens it measures. ponytail: assumes host and plugin share a clock;
      // a monotonic source matters only if the band ever runs over a host bridge.
      const now = Date.now()

      // The first generated block: everything before it was prefill (the
      // prompt being read) or the gateway queueing the request, and neither is
      // a decode window, so `last` reports that wait on its own.
      if (!first && (c.kind === 'text' || c.kind === 'thinking' || c.kind === 'tool')) {
        first = now
        ttftMs = Math.max(0, (await $.clock.now()) - askedAt)
        // The session's first step has no turn open yet: count from its first
        // chunk, so its rate is not measured from the day's epoch. ponytail:
        // keyed on the step index, since a hook cannot tell a stale turn id
        // from this one while only writing; reset on session start.
        if (!curTurn && seq !== e.index) {
          seq = e.index
          await update($, cur, () => ({
            turnId: e.turnId,
            out: 0,
            ms: 0,
            input: 0,
            cached: 0,
            written: 0,
            ttftMs: 0,
          }))
        }
      }

      if (c.kind === 'text' || c.kind === 'thinking') streamed += est(c.text)
      else if (c.kind === 'input') streamed += est(c.json)

      if (c.kind === 'stop') {
        last = now
        out = c.usage?.output_tokens ?? 0
        input = c.usage?.input_tokens ?? 0
        cached = c.usage?.cache_read_input_tokens ?? 0
        written = c.usage?.cache_creation_input_tokens ?? 0
      } else if (first && now - shownAt >= 250) {
        shownAt = now
        const live: LiveStat = {
          tokPerSec: rate(streamed, now - first),
          out: streamed,
          seconds: (now - first) / 1000,
        }
        // The reply on screen counts toward both rows as it arrives.
        const now2 = bandOf(done, open, { out: streamed, ms: now - first, ttftMs }, live)
        await update($, band, () => now2)
      }

      yield c
    }

    // A tool run or the next step is not a decode window; only that row clears.
    // Written even with no band yet, so the first turn's rows exist by the time
    // its first chunk streams.
    await update($, band, () => bandOf(done, open, { out: 0, ms: 0, ttftMs }, null))

    if (!first || !last) {
      return
    }

    // A turn is several requests, and `turn.complete.usage` reports only the
    // last of them, so the turn's counts are summed here, where each request
    // states its own.
    const prev = await read($, cur)
    const base: Cur = {
      turnId: e.turnId,
      out: prev?.turnId === e.turnId ? prev.out : 0,
      ms: prev?.turnId === e.turnId ? prev.ms : 0,
      input: prev?.turnId === e.turnId ? prev.input : 0,
      cached: prev?.turnId === e.turnId ? prev.cached : 0,
      written: prev?.turnId === e.turnId ? prev.written : 0,
      // The wait the person noticed is the turn's first one.
      ttftMs: prev?.turnId === e.turnId && prev.ttftMs > 0 ? prev.ttftMs : ttftMs,
    }

    open = {
      turnId: e.turnId,
      out: base.out + out,
      ms: base.ms + Math.max(0, last - first),
      input: base.input + input,
      cached: base.cached + cached,
      written: base.written + written,
      ttftMs: base.ttftMs,
    }

    await update($, cur, () => open as Cur)
    await update($, band, () => bandOf(done, open, { out: 0, ms: 0, ttftMs: 0 }, null))
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      return next(e)
    }

    const step = await read($, cur)
    const mine = step?.turnId === e.turnId ? step : null
    const usage = e.usage
    // No step heard (an interrupt, a step this hook was not above): the turn's
    // own report is all there is, and it covers its last request alone.
    const turn: Cur = mine ?? {
      turnId: e.turnId,
      out: usage?.output_tokens ?? 0,
      ms: 0,
      input: usage?.input_tokens ?? 0,
      cached: usage?.cache_read_input_tokens ?? 0,
      written: usage?.cache_creation_input_tokens ?? 0,
    }
    const denom = (turn.input ?? 0) + (turn.cached ?? 0) + (turn.written ?? 0)

    // This gateway answers some turns with nothing counted; taken at face value
    // such a turn would draw "0 tok/s" over the real one.
    if ((turn.out ?? 0) + denom === 0) {
      return next(e)
    }

    // Values written by the earlier band shape carry none of these counters.
    const prev = (await read($, tally)) as Partial<Tally> | null
    const sum: Tally = {
      out: (prev?.out ?? 0) + (turn.out ?? 0),
      ms: (prev?.ms ?? 0) + (turn.ms ?? 0),
      input: (prev?.input ?? 0) + (turn.input ?? 0),
      cached: (prev?.cached ?? 0) + (turn.cached ?? 0),
      written: (prev?.written ?? 0) + (turn.written ?? 0),
      ttftMs: (prev?.ttftMs ?? 0) + (turn.ttftMs ?? 0),
      turns: (prev?.turns ?? 0) + 1,
    }
    const shown: Band = {
      live: null,
      // No decode window (interrupt, API error): keep the last band that had one.
      last:
        (turn.ms ?? 0) > 0
          ? {
              tokPerSec: rate(turn.out ?? 0, turn.ms ?? 0),
              hitPct: pct(turn.cached ?? 0, denom),
              input: turn.input ?? 0,
              out: turn.out ?? 0,
              total: denom + (turn.out ?? 0),
              turn: sum.turns,
              ttftMs: turn.ttftMs ?? 0,
              seconds: (turn.ms ?? 0) / 1000,
            }
          : ((await read($, band))?.last ?? {
              tokPerSec: 0,
              hitPct: pct(turn.cached ?? 0, denom),
              input: turn.input ?? 0,
              out: turn.out ?? 0,
              total: denom + (turn.out ?? 0),
              turn: sum.turns,
              ttftMs: turn.ttftMs ?? 0,
              seconds: 0,
            }),
      session: {
        tokPerSec: rate(sum.out, sum.ms),
        hitPct: pct(sum.cached, sum.input + sum.cached + sum.written),
        input: sum.input,
        out: sum.out,
        total: sum.input + sum.cached + sum.written + sum.out,
        turns: sum.turns,
        ttftMs: sum.ttftMs,
      },
    }

    await update($, tally, () => sum)
    await update($, band, () => shown)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, band)

    if (e.props.hasSurvey || shown === null) {
      return next(e)
    }

    // Values written by the earlier band shape lack live and the token totals.
    const live = shown.live ?? null
    const num = (v: number | undefined) => v ?? 0
    const mainLoop = shown.last ?? ZERO_TURN
    const sess = shown.session ?? ZERO_SESS

    const { Box, Text } = $.ui.resolve(e)

    // Four rows of one table: a header, then live / last / sess. Each column
    // sizes to the widest cell it holds and right-aligns the rest, so a value
    // sits in the same place on every row and every redraw.
    // A row with no value for a column keeps that column's width, with a dash
    // in it: the columns after it must not slide left.
    const col = (name: string, a: string, b: string, c: string) => {
      const w = Math.max(name.length, a.length, b.length, c.length)
      const at = (v: string) => (v ? cell(v, w) : '—'.padStart(w))
      return [cell(name, w), at(a), at(b), at(c)]
    }
    const cols = [
      col("tok/s", live ? `~${fmtRate(num(live.tokPerSec))}` : "", fmtRate(num(mainLoop.tokPerSec)), fmtRate(num(sess.tokPerSec))),
      // Seconds to the first generated chunk; the session shows its average.
      col(
        "ttft",
        live && mainLoop.ttftMs ? `${(num(mainLoop.ttftMs) / 1000).toFixed(1)}s` : "",
        mainLoop.turn ? `${(num(mainLoop.ttftMs) / 1000).toFixed(1)}s` : "—",
        sess.turns ? `${(num(sess.ttftMs) / num(sess.turns) / 1000).toFixed(1)}s` : "—",
      ),
      col("out", live ? fmtTokens(num(live.out)) : "", fmtTokens(num(mainLoop.out)), fmtTokens(num(sess.out))),
      col("in", "", fmtTokens(num(mainLoop.input)), fmtTokens(num(sess.input))),
      col("hit", "", `${pctF(num(mainLoop.hitPct))}%`, `${pctF(num(sess.hitPct))}%`),
      // The turn in progress counts from the session's finished ones.
      col("turn", live ? String(num(mainLoop.turn)) : "", String(num(mainLoop.turn)), String(num(sess.turns))),
      col("total", "", fmtTokens(num(mainLoop.total)), fmtTokens(num(sess.total))),
    ] as const

    // Only sess stays dim: live is the value the person is watching, and dim
    // text on the band's background reads as blank.
    // `mono` is what makes the padding line up: the desktop's body face is
    // proportional, where a column of spaces is not a column of anything.
    // `tabular` pins digit widths, so a value that ticks does not shift.
    const row = (label: string, i: number, blank = false) => (
      <Text mono tabular dimColor={label === "sess"}>
        {(pad(label, 5) + (blank ? "" : line(cols.map(c => c[i])))).trimEnd()}
      </Text>
    )

    return (
      <Box flexDirection="column">
        <Text mono tabular dimColor>
          {pad("", 5)}
          {cols.map(c => c[0]).join(" · ")}
        </Text>
        {row("live", 1, live === null)}
        {row("last", 2)}
        {row("sess", 3)}
      </Box>
    )
  })
}
