import { test, expect, mock } from 'claude-code/testing'

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

const mount = ($: any) =>
  $.ui.mount({
    plugin: 'ccstatus-band',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: PROPS,
  })

// Rows as shown, with the padding collapsed: order and content are what the
// tests are about, not the column arithmetic (which is the renderer's).
const rows = async ($: any) =>
  (await (await mount($)).findAll({ type: 'Text' })).map((el: any) =>
    (el.text as string).replace(/\s+/g, ' ').trim(),
  )

// One call: a text chunk, `ms` of decoding on the mocked clock, then its stop.
const call = (clock: any, cost: ReturnType<typeof usage> | (() => ReturnType<typeof usage>), ms: number, text = 'x') =>
  async function* (_$: any, e: any) {
    const use = typeof cost === 'function' ? cost() : cost
    yield { kind: 'text', index: 0, text }
    await clock.advance(ms)
    yield { kind: 'stop', stopReason: 'end_turn', usage: use }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: text,
      toolUses: [],
      stopReason: 'end_turn',
      usage: use,
    }
  }

const runStep = async ($: any, turnId: string, index = 0, agentId?: string) => {
  const e = agentId
    ? { turnId, index, model: 'm', messageCount: 3, agentId }
    : { turnId, index, model: 'm', messageCount: 3 }
  for await (const _ of $.turn.step(e)) void _
}

const finish = ($: any, turnId: string, cost: ReturnType<typeof usage>) =>
  $.turn.complete({
    answer: 'ok',
    durationMs: 1,
    isAborted: false,
    turnId,
    reason: 'answer',
    usage: cost,
  })

test('live is this prompt, last is the one before, sess is all', { timeoutMs: 15000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const first = usage({
    output_tokens: 400,
    input_tokens: 1000,
    cache_read_input_tokens: 8000,
    cache_creation_input_tokens: 1000,
  })
  const second = usage({
    output_tokens: 200,
    input_tokens: 500,
    cache_read_input_tokens: 4000,
    cache_creation_input_tokens: 500,
  })
  // One hook for both prompts: the hooks beneath a test are registered once.
  let cost = first
  on('turn.step', call(clock, () => cost, 1000))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))

  await runStep($, 'p1')
  await finish($, 'p1', first)

  const one = await rows($)
  expect(one[0]).toBe('tok/s · ttft · out · in · hit · calls · total')
  expect(one[1]).toMatch(/^live [\d.]+ · — · 400 · 1k · 80\.0% · 1 · 10k$/)
  expect(one[2]).toBe('last — · — · — · — · — · — · —')
  expect(one[3]).toMatch(/^sess [\d.]+ · — · 400 · 1k · 80\.0% · 1 · 10k$/)

  cost = second
  await runStep($, 'p2')
  await finish($, 'p2', second)

  const two = await rows($)
  expect(two[1]).toMatch(/^live [\d.]+ · — · 200 · 500 · 80\.0% · 1 · 5\.2k$/)
  expect(two[2]).toMatch(/^last [\d.]+ · — · 400 · 1k · 80\.0% · 1 · 10k$/)
  expect(two[3]).toMatch(/^sess [\d.]+ · — · 600 · 1\.5k · 80\.0% · 2 · 16k$/)
})

test('a running prompt shows what it knows and a dash for the rest', { timeoutMs: 15000 }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const cost = usage({
    output_tokens: 100,
    input_tokens: 900,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })

  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: '你好' }
    await gate
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

  const it = $.turn.step({ turnId: 'p1', index: 0, model: 'm', messageCount: 1 })[
    Symbol.asyncIterator
  ]()
  await it.next()

  const running = await rows($)
  // Prompt counts are unknown until this call's stop: dashes, not zeros.
  expect(running[1]).toMatch(/^live [\d.]+ · — · 2 · — · — · 0 · —$/)
  expect(running[2]).toBe('last — · — · — · — · — · — · —')
  expect(running[3]).toMatch(/^sess [\d.]+ · — · 2 · 0 · 0\.0% · 0 · 2$/)

  release()
  while (!(await it.next()).done) void 0
  await finish($, 'p1', cost)

  const done = await rows($)
  expect(done[1]).toMatch(/^live [\d.]+ · — · 100 · 900 · 0\.0% · 1 · 1k$/)
  expect(done[3]).toMatch(/^sess [\d.]+ · — · 100 · 900 · 0\.0% · 1 · 1k$/)
})

test('a prompt with nothing counted leaves the band alone', { timeoutMs: 15000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const real = usage({
    output_tokens: 100,
    input_tokens: 900,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
  const nothing = usage({
    output_tokens: 0,
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
  on('turn.step', call(clock, real, 1000))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))

  await runStep($, 'p1')
  await finish($, 'p1', real)
  // The gateway answers this one with an all-zero usage object.
  await finish($, 'p2', nothing)

  const after = await rows($)
  expect(after[1]).toMatch(/^live [\d.]+ · — · 100 · 900 · 0\.0% · 1 · 1k$/)
  expect(after[3]).toMatch(/· 1 · 1k$/)
})

test('ttft survives its prompt and shows while it streams', { timeoutMs: 15000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const cost = usage({
    output_tokens: 100,
    input_tokens: 900,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })

  on('turn.step', async function* ($, e) {
    // Prefill: the request is out, nothing has come back yet.
    await clock.advance(1200)
    yield { kind: 'text', index: 0, text: 'x' }
    await gate
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

  const it = $.turn.step({ turnId: 'p1', index: 0, model: 'm', messageCount: 1 })[
    Symbol.asyncIterator
  ]()
  await it.next()

  expect((await rows($))[1]).toMatch(/^live [\d.]+ · 1\.2s/)
  release()
  while (!(await it.next()).done) void 0
  await finish($, 'p1', cost)

  const done = await rows($)
  expect(done[1]).toMatch(/^live [\d.]+ · 1\.2s/)
  expect(done[3]).toMatch(/^sess [\d.]+ · 1\.2s/)
})

const off = (keys: string[]) =>
  Object.fromEntries(keys.map(k => [`col_${k}`, false]))

test('turn is off by default', { timeoutMs: 15000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const cost = usage({
    output_tokens: 100,
    input_tokens: 900,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
  on('turn.step', call(clock, cost, 1000))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
  await runStep($, 'p1')
  await finish($, 'p1', cost)

  expect((await rows($))[0]).toBe('tok/s · ttft · out · in · hit · calls · total')
})

test('a switched-off column leaves the table', { timeoutMs: 15000, options: off(['ttft', 'hit', 'turn', 'calls', 'total']) }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const cost = usage({
    output_tokens: 100,
    input_tokens: 900,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
  on('turn.step', call(clock, cost, 1000))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
  await runStep($, 'p1')
  await finish($, 'p1', cost)

  expect((await rows($))[0]).toBe('tok/s · out · in')
})

test('with every column off the band draws nothing', { timeoutMs: 15000, options: off(['rate', 'ttft', 'out', 'in', 'hit', 'turn', 'calls', 'total']) }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const cost = usage({
    output_tokens: 100,
    input_tokens: 900,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
  // Below the plugin: its own (empty) tree is what draws once every column is
  // off, and only what this plugin drew is looked for here.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="below" />
  })
  on('turn.step', call(clock, cost, 1000))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
  await runStep($, 'p1')
  await finish($, 'p1', cost)

  // The band stepped aside: the chain beneath drew, and it drew nothing of ours.
  const tree = (await mount($).then(ui => ui.drawn())) as any
  expect(tree.children ?? []).toEqual([])

})
