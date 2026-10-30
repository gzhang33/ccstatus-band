export type TurnStat = {
  tokPerSec: number
  hitPct: number
  /** Uncached input tokens of the turn. */
  input: number
  /** Generated tokens of the turn. */
  out: number
  seconds: number
}

export type SessionStat = {
  tokPerSec: number
  hitPct: number
  input: number
  out: number
  /** Every token the session carried: input, cache read, cache write, output. */
  total: number
  turns: number
}

/** The response streaming right now; counted from characters, not by the API. */
export type LiveStat = {
  tokPerSec: number
  out: number
  seconds: number
}

export type Band = {
  live: LiveStat | null
  last: TurnStat
  session: SessionStat
}

export type Tally = {
  out: number
  ms: number
  input: number
  cached: number
  written: number
  turns: number
}

/** Counts summed so far for the turn in progress, one entry per request. */
export type Cur = {
  turnId: string
  out: number
  ms: number
  input: number
  cached: number
  written: number
  /** Wait before this step's first generated chunk, in ms. */
  ttftMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'ccstatus-band': { band: Band | null; tally: Tally | null; cur: Cur | null }
  }
}
