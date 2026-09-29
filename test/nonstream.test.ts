import assert from 'node:assert/strict'
import { test } from 'node:test'

import { aggregateSseToCompletion } from '../src/nonstream.ts'

/**
 * `stream: false` 的支持。
 *
 * ## 问题
 *
 * trae-proxy 对 `/v1/chat/completions` **一律走流式**：不论客户端在请求体里写没写
 * `"stream": false`，响应永远是 `Content-Type: text/event-stream` 加 `data: ` 前缀。
 * 实测：
 *
 *     POST {"model":"glm-5","stream":false,...}
 *     → HTTP 200  Content-Type: text/event-stream
 *       data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...}
 *
 * 宽松的客户端能凑合解析，严格的 OpenAI 客户端直接解析失败。
 *
 * ## 上游实际发什么（实测抓的，不是猜的）
 *
 *   顶层字段:    id, object, created, model, choices, usage
 *   choices 字段: index, delta, finish_reason
 *   delta 字段:   reasoning_content, content, tool_calls
 *   usage:        515 个分片里**只有 1 个**带
 *   末行:         data: [DONE]
 *
 * 工具调用时 `delta` 里是 `tool_calls`，且 `function.arguments` 是**分片的 JSON 字符串**，
 * 必须按 index 拼接后再 parse——直接取最后一片会得到半个 JSON。
 */

const chunk = (o: object): string => `data: ${JSON.stringify(o)}\n\n`
const wrap = (chunks: string[]): string => chunks.join('') + 'data: [DONE]\n\n'

const textStream = wrap([
  chunk({ id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1790680233, model: 'glm-5',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { reasoning_content: '用户问的是' }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { reasoning_content: '那不勒斯。' }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { content: '那是' }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: { content: '意大利' }, finish_reason: null }] }),
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } }),
])

// ---------- 基础形状 ----------

test('object 必须是 chat.completion（客户端按这个判断是不是流式）', () => {
  const r = aggregateSseToCompletion(textStream)!
  assert.equal(r.object, 'chat.completion', '留成 chat.completion.chunk 的话客户端会当流式')
  assert.equal(r.id, 'chatcmpl-x')
  assert.equal(r.created, 1790680233)
  assert.equal(r.model, 'glm-5')
})

test('choices 用 message 不是 delta', () => {
  const r = aggregateSseToCompletion(textStream)!
  const c = (r.choices as Array<Record<string, unknown>>)[0]!
  assert.ok(c.message, '非流式必须给 message')
  assert.equal(c.delta, undefined, '非流式不该有 delta')
  assert.equal(c.index, 0)
  assert.equal(c.finish_reason, 'stop')
})

test('分片的 content 按顺序拼接', () => {
  const r = aggregateSseToCompletion(textStream)!
  const c = (r.choices as Array<Record<string, unknown>>)[0]!
  assert.equal((c.message as Record<string, unknown>).content, '那是意大利')
})

test('reasoning_content 单独累加（不能混进 content）', () => {
  const r = aggregateSseToCompletion(textStream)!
  const m = (r.choices as Array<Record<string, unknown>>)[0]!.message as Record<string, unknown>
  assert.equal(m.reasoning_content, '用户问的是那不勒斯。')
  assert.equal(m.content, '那是意大利', '思维链绝不能污染正文')
})

test('role 透传，缺省补 assistant', () => {
  const withRole = aggregateSseToCompletion(wrap([
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'x' }, finish_reason: null }] }),
  ]))!
  assert.equal(((withRole.choices as Array<Record<string, unknown>>)[0]!.message as Record<string, unknown>).role, 'assistant')

  const noRole = aggregateSseToCompletion(wrap([
    chunk({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] }),
  ]))!
  assert.equal(((noRole.choices as Array<Record<string, unknown>>)[0]!.message as Record<string, unknown>).role, 'assistant',
    '没有 role 分片时要补上，否则部分客户端不认')
})

test('usage 取带 usage 的那个分片（不是最后一片——末片是 [DONE]）', () => {
  const r = aggregateSseToCompletion(textStream)!
  assert.deepEqual(r.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })
})

// ---------- 工具调用 ----------

test('tool_calls 的 arguments 分片要按 index 拼成完整 JSON', () => {
  // 实测 trae 就是这么发的：arguments 被切碎，且分片的 index 与数组位置无关
  const sse = wrap([
    chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"ci' } }] }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"北' } }] }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '京"}' } }] }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  ])
  const r = aggregateSseToCompletion(sse)!
  const c = (r.choices as Array<Record<string, unknown>>)[0]!
  const tcs = (c.message as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>
  assert.equal(tcs.length, 1)
  assert.equal(tcs[0]!.id, 'call_a', 'id 只在第一片出现，后续片没有，要沿用')
  assert.equal(tcs[0]!.type, 'function')
  assert.equal((tcs[0]!.function as Record<string, unknown>).name, 'get_weather', 'name 也只出现一次')
  assert.equal((tcs[0]!.function as Record<string, unknown>).arguments, '{"city":"北京"}',
    'arguments 必须拼完整；只取最后一片会得到 "ty\":\"北" 这种半截')
  assert.equal(c.finish_reason, 'tool_calls')
})

test('并行的多个 tool_calls 按 index 分开，不能串成一坨', () => {
  const sse = wrap([
    chunk({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'call_0', type: 'function', function: { name: 'alpha', arguments: '{"a":' } },
      { index: 1, id: 'call_1', type: 'function', function: { name: 'beta', arguments: '{"b":' } },
    ] }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, function: { arguments: '1}' } },
      { index: 1, function: { arguments: '2}' } },
    ] }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  ])
  const tcs = (aggregateSseToCompletion(sse)!.choices as Array<Record<string, unknown>>)[0]!
    .message as Record<string, unknown>
  const arr = tcs.tool_calls as Array<Record<string, unknown>>
  assert.equal(arr.length, 2)
  assert.equal((arr[0]!.function as Record<string, unknown>).arguments, '{"a":1}')
  assert.equal((arr[1]!.function as Record<string, unknown>).arguments, '{"b":2}')
  assert.equal((arr[0]!.function as Record<string, unknown>).name, 'alpha')
  assert.equal((arr[1]!.function as Record<string, unknown>).name, 'beta')
})

test('工具调用时 content 应为 null 而不是空串', () => {
  // OpenAI 规范：纯 tool_calls 那一轮 content 是 null。给空串会让部分客户端
  // 以为模型返回了空内容而跳过 tool_calls。
  const sse = wrap([
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  ])
  const m = (aggregateSseToCompletion(sse)!.choices as Array<Record<string, unknown>>)[0]!.message as Record<string, unknown>
  assert.equal(m.content, null)
})

// ---------- 畸形输入不能崩 ----------

test('空/垃圾输入返回 null，让调用方走降级而不是抛', () => {
  for (const bad of ['', 'data: [DONE]\n\n', 'not sse at all', 'data: {broken\n\n', 'data: \n\n', 'data: null\n\n', 'data: 123\n\n']) {
    assert.equal(aggregateSseToCompletion(bad), null, `输入 ${JSON.stringify(bad.slice(0, 20))} 应返回 null`)
  }
})

test('部分分片坏了不能整体失败——能解析的照样聚合', () => {
  const sse = chunk({ id: 'x', choices: [{ index: 0, delta: { content: '前' }, finish_reason: null }] })
    + 'data: {这不是 JSON\n\n'
    + chunk({ choices: [{ index: 0, delta: { content: '后' }, finish_reason: 'stop' }] })
    + 'data: [DONE]\n\n'
  const m = (aggregateSseToCompletion(sse)!.choices as Array<Record<string, unknown>>)[0]!.message as Record<string, unknown>
  assert.equal(m.content, '前后', '一个坏分片不该让整段丢失')
})

test('空 content 的分片得到空串，不是 null 也不是缺字段', () => {
  // content 字段必须**始终存在**：严格 SDK 直接读 .content，缺字段会 AttributeError。
  // 而 null 的语义是「这一轮改用 tool_calls」，不能拿来表示「模型没吐内容」。
  // 用真实上游形状（首片带 id/model）——只发一个空 content 片的场景见下一条。
  const sse = wrap([
    chunk({ id: 'chatcmpl-y', object: 'chat.completion.chunk', created: 1, model: 'glm-5',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ])
  const m = (aggregateSseToCompletion(sse)!.choices as Array<Record<string, unknown>>)[0]!.message as Record<string, unknown>
  assert.ok('content' in m, 'content 字段必须存在')
  assert.equal(m.content, '', '无内容时是空串')
})

test('真的什么都没有时返回 null（让调用方降级，别造空壳回答）', () => {
  // 连 id/model 都没有、也没任何内容——聚合器无从判断这是什么，
  // 此时返回 null，由 shim 回落成流式透传，好过给客户端一个空回答。
  const sse = wrap([chunk({ choices: [{ index: 0, delta: { content: '' }, finish_reason: null }] })])
  assert.equal(aggregateSseToCompletion(sse), null)
})

test('没有任何 finish_reason 时补 stop，别让客户端一直等', () => {
  const sse = wrap([chunk({ id: 'x', choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] })])
  assert.equal((aggregateSseToCompletion(sse)!.choices as Array<Record<string, unknown>>)[0]!.finish_reason, 'stop')
})
