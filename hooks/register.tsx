import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Band, Cur, Row, Snap, Tally } from '../types'

const band = atom({ plugin: 'ccstatus-band', key: 'band' } as const, null)
const tally = atom({ plugin: 'ccstatus-band', key: 'tally' } as const, null)
const cur = atom({ plugin: 'ccstatus-band', key: 'cur' } as const, null)
const recent = atom({ plugin: 'ccstatus-band', key: 'recent' } as const, null)
const prev = atom({ plugin: 'ccstatus-band', key: 'prev' } as const, null)
let seq = 0

// Decode-only throughput, the way inference benchmarks report it: generated
// tokens over the span from the first generated chunk to the stop chunk, so
// prefill (TTFT) and tool execution stay out of the rate. Under 100ms the span
// is too short to mean anything and is left at zero.
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

// Nothing in a streamed chunk counts tokens: each call reports its counts once,
// at its stop chunk, and that is the last thing to arrive. So the live rate
// counts CJK characters as one token and everything else as a quarter, and the
// stop chunk replaces the estimate with the API's own numbers.
// ponytail: rough tokenizer; swap in a real one only if the live figure ever
// needs to be exact.
const CJK = /[　-鿿가-힯＀-￯]/
const est = (s: string) => {
  let n = 0
  for (const ch of s) n += CJK.test(ch) ? 1 : 0.25
  return n
}

const ZERO_TALLY: Tally = {
  out: 0,
  ms: 0,
  input: 0,
  cached: 0,
  written: 0,
  ttftMs: 0,
  calls: 0,
  prompts: 0,
}

/** A finished prompt as a row. */
const rowOf = (s: Snap): Row => ({
  rate: rate(s.out, s.ms),
  // A zero wait is not a measurement: the clock did not separate the request
  // from its first chunk.
  ttftMs: s.ttftMs > 0 ? s.ttftMs : null,
  out: s.out,
  input: s.input,
  hit: pct(s.cached, s.input + s.cached + s.written),
  turn: s.turn,
  calls: s.calls,
  total: s.input + s.cached + s.written + s.out,
})

/**
 * The three rows: this prompt (live while it runs, otherwise its final
 * numbers), the prompt before it, and every prompt so far.
 *
 * `extra` is the reply streaming now, whose counts the API reports only at its
 * stop, so the live and session rows move with the answer instead of appearing
 * when the prompt ends. A running prompt's own counts (`in`, `hit`, `total`)
 * stay unknown until its first call stops, and the row shows a dash there
 * rather than a zero.
 */
const bandOf = (
  t: Tally,
  open: Cur | null,
  recentSnap: Snap | null,
  prevSnap: Snap | null,
  extra: { out: number; ms: number; ttftMs: number },
  live: { tokPerSec: number } | null,
): Band => {
  const running = open !== null || live !== null
  const prompts = t.prompts + (running ? 1 : 0)

  const out = t.out + (open?.out ?? 0) + extra.out
  const ms = t.ms + (open?.ms ?? 0) + extra.ms
  const input = t.input + (open?.input ?? 0)
  const cached = t.cached + (open?.cached ?? 0)
  const written = t.written + (open?.written ?? 0)
  const ttft = t.ttftMs + (open?.ttftMs ?? 0) + extra.ttftMs
  const calls = t.calls + (open?.calls ?? 0)

  const sess: Row = {
    rate: rate(out, ms),
    ttftMs: ttft > 0 ? ttft / prompts : null,
    out,
    input,
    hit: pct(cached, input + cached + written),
    turn: prompts,
    calls,
    total: input + cached + written + out,
  }

  let liveRow: Row | null
  if (running) {
    // Until this prompt's first call stops, its prompt counts are unknown.
    const counted = (open?.calls ?? 0) > 0
    const promptTokens = (open?.input ?? 0) + (open?.cached ?? 0) + (open?.written ?? 0)
    liveRow = {
      rate: live ? live.tokPerSec : rate((open?.out ?? 0) + extra.out, (open?.ms ?? 0) + extra.ms),
      ttftMs: ((open?.ttftMs ?? 0) + extra.ttftMs) || null,
      out: (open?.out ?? 0) + extra.out,
      input: counted ? (open?.input ?? 0) : null,
      hit: counted ? pct(open?.cached ?? 0, promptTokens) : null,
      turn: prompts,
      calls: open?.calls ?? 0,
      total: counted ? promptTokens + (open?.out ?? 0) + extra.out : null,
    }
  } else {
    liveRow = recentSnap ? rowOf(recentSnap) : null
  }

  return {
    live: liveRow,
    last: prevSnap ? rowOf(prevSnap) : null,
    sess,
    streaming: running,
  }
}

export const register: Register = (on, options) => {
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
    const askedAt = await $.clock.now()
    let ttftMs = 0
    // Whether a call of this prompt is already counting it.
    const curTurn = (await read($, cur))?.turnId === e.turnId
    const done = ((await read($, tally)) as Tally | null) ?? ZERO_TALLY
    const recentSnap = (await read($, recent)) as Snap | null
    const prevSnap = (await read($, prev)) as Snap | null
    // The prompt so far: its earlier calls, then each one as it ends.
    let open = curTurn ? ((await read($, cur)) as Cur) : null
    // This one call's counts, as its stop chunk reports them.
    let counted = false
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
      // prompt being read) or the gateway queueing the call, and neither is a
      // decode window, so the row reports that wait on its own.
      if (!first && (c.kind === 'text' || c.kind === 'thinking' || c.kind === 'tool')) {
        first = now
        ttftMs = Math.max(0, (await $.clock.now()) - askedAt)
        // The session's first call has no prompt open yet: count from its first
        // chunk, so its rate is not measured from the day's epoch. ponytail:
        // keyed on the call's index, since a hook cannot tell a stale prompt id
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
            calls: 0,
          }))
        }
      }

      if (c.kind === 'text' || c.kind === 'thinking') streamed += est(c.text)
      else if (c.kind === 'input') streamed += est(c.json)

      if (c.kind === 'stop') {
        last = now
        counted = c.usage !== null
        out = c.usage?.output_tokens ?? 0
        input = c.usage?.input_tokens ?? 0
        cached = c.usage?.cache_read_input_tokens ?? 0
        written = c.usage?.cache_creation_input_tokens ?? 0
      } else if (first && now - shownAt >= 250) {
        shownAt = now
        const live = { tokPerSec: rate(streamed, now - first) }
        const next2 = bandOf(done, open, recentSnap, prevSnap, { out: streamed, ms: now - first, ttftMs }, live)
        await update($, band, () => next2)
      }

      yield c
    }

    // A tool run or the next call is not a decode window; only that row clears.
    // Written even with no band yet, so the rows exist with the first chunk.
    await update($, band, () =>
      bandOf(done, open, recentSnap, prevSnap, { out: 0, ms: 0, ttftMs }, null),
    )

    if (!first || !last) {
      return
    }

    // A prompt is several calls, and `turn.complete.usage` reports only the
    // last of them, so the prompt's counts are summed here, where each call
    // states its own. A call that never got its usage (an interrupt) counts as
    // neither a call nor any tokens.
    open = {
      turnId: e.turnId,
      out: (open?.out ?? 0) + out,
      ms: (open?.ms ?? 0) + Math.max(0, last - first),
      input: (open?.input ?? 0) + input,
      cached: (open?.cached ?? 0) + cached,
      written: (open?.written ?? 0) + written,
      // The wait the person noticed is the prompt's first one.
      ttftMs: open?.ttftMs || ttftMs,
      calls: (open?.calls ?? 0) + (counted ? 1 : 0),
    }

    await update($, cur, () => open as Cur)
    await update($, band, () =>
      bandOf(done, open, recentSnap, prevSnap, { out: 0, ms: 0, ttftMs: 0 }, null),
    )
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      return next(e)
    }

    const step = (await read($, cur)) as Cur | null
    const mine = step?.turnId === e.turnId ? step : null
    const usage = e.usage
    // No call heard (an interrupt, a call this hook was not above): the
    // prompt's own report is all there is, and it covers its last call alone.
    const prompt: Cur = mine ?? {
      turnId: e.turnId,
      out: usage?.output_tokens ?? 0,
      ms: 0,
      input: usage?.input_tokens ?? 0,
      cached: usage?.cache_read_input_tokens ?? 0,
      written: usage?.cache_creation_input_tokens ?? 0,
      ttftMs: 0,
      calls: usage ? 1 : 0,
    }

    // This gateway answers some prompts with nothing counted; taken at face
    // value such a prompt would draw "0 tok/s" over the real one.
    if (prompt.out + prompt.input + prompt.cached + prompt.written === 0) {
      return next(e)
    }

    const t = ((await read($, tally)) as Tally | null) ?? ZERO_TALLY
    const before = (await read($, recent)) as Snap | null
    const snap: Snap = {
      out: prompt.out,
      ms: prompt.ms,
      input: prompt.input,
      cached: prompt.cached,
      written: prompt.written,
      ttftMs: prompt.ttftMs,
      calls: prompt.calls,
      turn: t.prompts + 1,
    }
    const sum: Tally = {
      out: t.out + snap.out,
      ms: t.ms + snap.ms,
      input: t.input + snap.input,
      cached: t.cached + snap.cached,
      written: t.written + snap.written,
      ttftMs: t.ttftMs + snap.ttftMs,
      calls: t.calls + snap.calls,
      prompts: t.prompts + 1,
    }

    await update($, prev, () => before)
    await update($, recent, () => snap)
    await update($, tally, () => sum)
    await update($, band, () => bandOf(sum, null, snap, before, { out: 0, ms: 0, ttftMs: 0 }, null))

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = (await read($, band)) as Band | null

    if (e.props.hasSurvey || shown === null) {
      return next(e)
    }

    // Each column is its own switch in /config; with every one off there is
    // nothing to draw and the band steps aside.
    const enabled = (name: string) => options[`col_${name}`] !== false
    // The manifest's field name, the row field it shows, and its heading.
    const columns = (
      [
        ['rate', 'rate', 'tok/s'],
        ['ttft', 'ttftMs', 'ttft'],
        ['out', 'out', 'out'],
        ['in', 'input', 'in'],
        ['hit', 'hit', 'hit'],
        ['turn', 'turn', 'turn'],
        ['calls', 'calls', 'calls'],
        ['total', 'total', 'total'],
      ] as Array<[string, keyof Row, string]>
    ).filter(([key]) => enabled(key))

    if (columns.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    const text = (row: Row | null, key: keyof Row): string => {
      if (row === null) return ''
      const v = row[key]
      if (v === null) return ''
      if (key === 'rate') return fmtRate(v)
      if (key === 'ttftMs') return `${(v / 1000).toFixed(1)}s`
      if (key === 'hit') return `${v.toFixed(1)}%`
      if (key === 'turn' || key === 'calls') return String(v)
      return fmtTokens(v)
    }

    // A row with no value for a column keeps that column's width, with a dash
    // in it: the columns after it must not slide left.
    const widths = columns.map(([, key, name]) =>
      Math.max(name.length, ...([shown.live, shown.last, shown.sess].map(r => text(r, key).length))),
    )
    const cellsOf = (row: Row | null) =>
      columns.map(([, key], i) => {
        const v = text(row, key)
        return v ? cell(v, widths[i]) : '—'.padStart(widths[i])
      })

    const row = (label: string, at: Row | null, blank = false) => (
      <Text mono tabular dimColor={label === 'sess'}>
        {(pad(label, 5) + (blank ? '' : line(cellsOf(at)))).trimEnd()}
      </Text>
    )

    return (
      <Box flexDirection="column">
        <Text mono tabular dimColor>
          {pad('', 5)}
          {columns.map(([, , name], i) => cell(name, widths[i])).join(' · ')}
        </Text>
        {/* Before the session's first prompt there is nothing to show. */}
        {row('live', shown.live, shown.live === null)}
        {row('last', shown.last)}
        {row('sess', shown.sess)}
      </Box>
    )
  })
}
