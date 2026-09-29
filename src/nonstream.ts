/**
 * 把上游的 SSE 分片聚合成一个非流式的 `chat.completion`。
 *
 * ## 为什么需要
 *
 * trae 上游只会发 SSE。代理原先把流**原样透传**，于是不管客户端有没有写
 * `"stream": false`，拿到的都是 `Content-Type: text/event-stream` + `data: ` 前缀。
 * 严格按 OpenAI 规范实现的客户端会解析失败。
 *
 * ## 上游实际发什么（实测抓的，不是照规范猜的）
 *
 *   顶层字段:     id, object, created, model, choices, usage
 *   choices 字段: index, delta, finish_reason
 *   delta 字段:   reasoning_content, content, tool_calls
 *   usage:        515 个分片里只有 1 个带
 *   末行:         data: [DONE]
 *
 * 工具调用时 `delta.tool_calls[].function.arguments` 是**切碎的 JSON 字符串片段**，
 * 且 `index` 是分片自己的序号，与它在数组里的位置无关——必须按 index 归并。
 * 只取最后一片会得到 `ty":"北` 这种半截，客户端 parse 直接炸。
 */

interface SseDelta {
  role?: unknown
  content?: unknown
  reasoning_content?: unknown
  tool_calls?: unknown
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 迭代 SSE 里所有能解析的 data: 分片。`[DONE]` 与坏行跳过，不中断。 */
function* dataChunks(sseText: string): Generator<Record<string, unknown>> {
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    let parsed: unknown
    try { parsed = JSON.parse(payload) } catch { continue }
    if (isObj(parsed)) yield parsed
  }
}

/**
 * 聚合成一个 `chat.completion`。返回 null 表示**没有任何可用分片**，
 * 由调用方决定降级策略（本代理选择回落到流式透传，而不是给一个空回答）。
 */
export function aggregateSseToCompletion(sseText: string): Record<string, unknown> | null {
  let id = ''
  let created: unknown
  let model = ''
  let usage: unknown
  let finishReason: unknown = null
  let role = ''
  let content = ''
  let reasoning = ''
  let sawContent = false
  let sawReasoning = false
  const toolCalls = new Map<number, {
    id: string; type: string; name: string; args: string
  }>()

  for (const chunk of dataChunks(sseText)) {
    if (typeof chunk['id'] === 'string' && id === '') id = chunk['id']
    if (typeof chunk['model'] === 'string' && model === '') model = chunk['model']
    if (created === undefined && typeof chunk['created'] === 'number') created = chunk['created']
    // usage 只在其中一个分片里带，**不能**只取最后一片（末片是 [DONE]）
    if (isObj(chunk['usage'])) usage = chunk['usage']

    const choices = Array.isArray(chunk['choices']) ? chunk['choices'] : []
    for (const c of choices) {
      if (!isObj(c)) continue
      if (c['finish_reason'] !== null && c['finish_reason'] !== undefined) finishReason = c['finish_reason']
      const delta = c['delta'] as SseDelta | undefined
      if (!isObj(delta)) continue

      if (typeof delta.role === 'string' && role === '') role = delta.role
      if (typeof delta.content === 'string' && delta.content !== '') { content += delta.content; sawContent = true }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
        reasoning += delta.reasoning_content
        sawReasoning = true
      }

      if (!Array.isArray(delta.tool_calls)) continue
      for (const raw of delta.tool_calls) {
        if (!isObj(raw)) continue
        // index 缺失时退化成数组位置——上游给了就用它的
        const key = typeof raw['index'] === 'number' ? raw['index'] : toolCalls.size
        const cur = toolCalls.get(key) ?? { id: '', type: '', name: '', args: '' }
        if (typeof raw['id'] === 'string' && raw['id'] !== '') cur.id = raw['id']
        if (typeof raw['type'] === 'string' && raw['type'] !== '') cur.type = raw['type']
        const fn = raw['function']
        if (isObj(fn)) {
          if (typeof fn['name'] === 'string' && fn['name'] !== '') cur.name = fn['name']
          if (typeof fn['arguments'] === 'string') cur.args += fn['arguments']
        }
        toolCalls.set(key, cur)
      }
    }
  }

  // 一个分片都没解析出来：交给调用方降级，别造一个空壳回答
  if (id === '' && model === '' && !sawContent && !sawReasoning && toolCalls.size === 0) return null

  const hasTools = toolCalls.size > 0
  const message: Record<string, unknown> = { role: role === '' ? 'assistant' : role }
  // content 字段**总是**存在（严格 SDK 会直接读 .content，缺字段会 AttributeError）。
  // null 的语义是「这一轮改用 tool_calls」；空串才是「模型没吐出内容」。
  // 早先写成 sawContent ? content : null，被测试当场判错——那是把两件事混成一件。
  message['content'] = hasTools ? null : content
  if (sawReasoning) message['reasoning_content'] = reasoning
  if (hasTools) {
    message['tool_calls'] = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => ({
        id: t.id,
        type: t.type === '' ? 'function' : t.type,
        function: { name: t.name, arguments: t.args },
      }))
  }

  const out: Record<string, unknown> = {
    id: id === '' ? 'chatcmpl-local' : id,
    object: 'chat.completion',
    created: typeof created === 'number' ? created : Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? 'stop' }],
  }
  if (usage !== undefined) out['usage'] = usage
  return out
}
