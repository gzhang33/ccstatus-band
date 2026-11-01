export type Row = {
  /** Decode rate over the row's own decode windows. */
  rate: number | null
  /** Mean wait before each call's first generated chunk. */
  ttftMs: number | null
  /** The slowest of those waits. */
  ttftMaxMs: number | null
  /** Generated tokens. */
  out: number | null
  /** Uncached prompt tokens. */
  input: number | null
  /** Share of the prompt served from the cache, in percent. */
  hit: number | null
  /** Which prompt of the session this was, counting from 1. */
  turn: number | null
  /** Model calls the prompt made that returned usage. */
  calls: number | null
  /** input + cache read + cache write + out. */
  total: number | null
  /** Wall time spent waiting on model calls: prefill, queueing, generation. */
  modelMs: number | null
  /** Wall time spent running tool calls between them. */
  toolMs: number | null
}

export type Band = {
  /** This prompt: live while it runs, then its final numbers. */
  live: Row | null
  /** The prompt before it. */
  last: Row | null
  /** Every finished prompt, plus this one while it runs. */
  sess: Row
  /** Whether `live` is still streaming. */
  streaming: boolean
}

export type Tally = {
  out: number
  ms: number
  modelMs: number
  toolMs: number
  input: number
  cached: number
  written: number
  /** Summed waits, and how many waits were actually measured. */
  ttftMs: number
  ttftSamples: number
  ttftMaxMs: number
  calls: number
  prompts: number
}

/** A finished prompt, kept for the live and last rows. */
export type Snap = {
  out: number
  ms: number
  modelMs: number
  toolMs: number
  input: number
  cached: number
  written: number
  /** Summed waits, and how many waits were actually measured. */
  ttftMs: number
  ttftSamples: number
  ttftMaxMs: number
  calls: number
  turn: number
}

/** Counts summed so far for the prompt in progress, one entry per call. */
export type Cur = {
  turnId: string
  out: number
  ms: number
  modelMs: number
  toolMs: number
  input: number
  cached: number
  written: number
  /** Summed waits, and how many waits were actually measured. */
  ttftMs: number
  ttftSamples: number
  ttftMaxMs: number
  calls: number
  /** When its last call stopped, for the tool time the next one follows. */
  endedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'ccstatus-band': {
      band: Band | null
      tally: Tally | null
      cur: Cur | null
      recent: Snap | null
      prev: Snap | null
    }
  }
}
