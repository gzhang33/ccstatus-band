import { test, expect, mock } from 'claude-code/testing'

// `find({ text })` matches the whole shown text by inclusion only for short
// strings; row text is read here instead, as the joined display of one node.
const rowTexts = async (ui: any) =>
  (await ui.findAll({ type: 'Text' })).map((el: any) => el.text as string)

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
}

const usage = (o: {
  output_tokens: number
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}) => ({ model: 'test-model', ...o })

const step = async ($: any, turnId: string, index: number, agentId?: string) => {
  const e = agentId
    ? { turnId, index, model: 'm', messageCount: 3, agentId }
    : { turnId, index, model: 'm', messageCount: 3 }
  for await (const _ of $.turn.step(e)) void _
}

test('band rates decode windows, not turn wall time', { timeoutMs: 15000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })

  let decodeMs = 2000

  // A step emits its first chunk, then decodes for `decodeMs`, then stops.
  on('turn.step', async function* ($, e) {
    // One request of the turn: the band sums these, not turn.complete's usage.
    const cost = usage({
      output_tokens: 200,
      input_tokens: 500,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 500,
    })
    yield { kind: 'text', index: 0, text: 'x' }
    await clock.advance(decodeMs)
    yield { kind: 'stop', stopReason: 'end_turn', usage: cost }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'x',
      toolUses: [],
      stopReason: 'end_turn',
      usage: cost,
    }
  })

  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))

  // Turn 1: two main steps (400 tokens over 4 s) plus a subagent step that
  // must not count toward the main loop's rate.
  await step($, 't1', 0)
  await step($, 't1', 1)
  await step($, 't1', 2, 'agent-x')
  await $.turn.complete({
    answer: 'ok',
    durationMs: 9000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: usage({
      output_tokens: 400,
      input_tokens: 1000,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 1000,
    }),
  })

  const ui1 = await $.ui.mount({
    plugin: 'ccstatus-band',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: PROPS,
  })

  expect(await rowTexts(ui1)).toEqual([
    '     tok/s · out · in ·   hit · total',
    'live  ~0.0 ·   0',
    'last   199 · 400 · 1k · 80.0%',
    'sess   199 · 400 · 1k · 80.0% ·   10k',
  ])

  // Turn 2: 200 tokens over 1 s.
  decodeMs = 1000
  await step($, 't2', 0)
  await $.turn.complete({
    answer: 'ok',
    durationMs: 3000,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
    usage: usage({
      output_tokens: 200,
      input_tokens: 0,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0,
    }),
  })

  const ui2 = await $.ui.mount({
    plugin: 'ccstatus-band',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: PROPS,
  })

  expect(await rowTexts(ui2)).toEqual([
    '     tok/s · out ·   in ·   hit · total',
    'live  ~0.0 ·   0',
    'last   199 · 200 ·  500 · 80.0%',
    'sess   199 · 600 · 1.5k · 80.0% ·   16k',
  ])
})

test('an all-zero usage turn leaves the band alone', { timeoutMs: 15000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })

  on('turn.step', async function* ($, e) {
    const cost = usage({
      output_tokens: 100,
      input_tokens: 900,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    yield { kind: 'text', index: 0, text: 'x' }
    await clock.advance(1000)
    yield { kind: 'stop', stopReason: 'end_turn', usage: cost }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'x',
      toolUses: [],
      stopReason: 'end_turn',
      usage: cost,
    }
  })

  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))

  await step($, 't1', 0)
  await $.turn.complete({
    answer: 'ok',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: usage({
      output_tokens: 100,
      input_tokens: 900,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }),
  })
  // The gateway answers some turns with a usage object of all zeros.
  await $.turn.complete({
    answer: 'ok',
    durationMs: 0,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
    usage: usage({
      output_tokens: 0,
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }),
  })

  const ui = await $.ui.mount({
    plugin: 'ccstatus-band',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: PROPS,
  })

  expect((await rowTexts(ui)).slice(1)).toEqual([
    'live  ~0.0 ·   0',
    'last   100 · 100 · 900 · 0.0%',
    'sess   100 · 100 · 900 · 0.0% ·    1k',
  ])
  // Three rows, stacked: an idle live row above, never a fourth child beside them.
  const tree = (await ui.drawn()) as any
  expect(tree.props.flexDirection).toBe('column')
  // A header row and three data rows; the live row never drops out.
  expect(tree.children).toHaveLength(4)
})

test('band estimates a live rate while a response streams', { timeoutMs: 15000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  let mode: 'idle' | 'stream' = 'idle'

  on('turn.step', async function* ($, e) {
    const cost = usage({
      output_tokens: 6,
      input_tokens: 100,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    })
    yield { kind: 'text', index: 0, text: 'x' }
    await clock.advance(1000)
    if (mode === 'stream') {
      yield { kind: 'text', index: 0, text: '中文测试a' }
      await gate
    }
    yield { kind: 'stop', stopReason: 'end_turn', usage: cost }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'x',
      toolUses: [],
      stopReason: 'end_turn',
      usage: cost,
    }
  })

  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))

  // One finished turn, so the band exists and has something to redraw.
  await step($, 't1', 0)
  await $.turn.complete({
    answer: 'ok',
    durationMs: 2000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: usage({
      output_tokens: 6,
      input_tokens: 100,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    }),
  })

  mode = 'stream'
  const it = $.turn.step({ turnId: 't2', index: 0, model: 'm', messageCount: 1 })[
    Symbol.asyncIterator
  ]()
  await it.next()
  await it.next()

  const ui = await $.ui.mount({
    plugin: 'ccstatus-band',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: PROPS,
  })

  // One ASCII character already streamed plus 4 CJK and one more ASCII: 4.5
  // estimated tokens over 1 s.
  // The rows below keep their place while the live row streams above them.
  expect((await rowTexts(ui)).slice(1)).toEqual([
    'live  ~4.5 ·   5',
    'last   6.0 ·   6 · 100 · 90.0%',
    'sess   6.0 ·   6 · 100 · 90.0% ·    1k',
  ])

  release()
  await it.next()
  await it.return?.()
})
