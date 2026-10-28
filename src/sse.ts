/**
 * Qoder SSE → OpenAI SSE。
 *
 * 上游的帧是**一个信封套一层 OpenAI 形状**：
 *
 * ```text
 * data: {"headers":{…},"body":"{\"choices\":[{\"delta\":{\"content\":\"你\"}}]}","statusCodeValue":200}
 * ```
 *
 * 而 dsh-router 只接受 OpenAI SSE（它会把这个流 pipe 给客户端，也会在客户端要
 * 非流式时自己聚合）。所以这一层把信封拆开、把 delta 重新包成 OpenAI chunk，
 * 并在收尾补上 usage 与 `[DONE]`。
 *
 * 为什么要自己拼满这些字段：宿主聚合非流式响应时读的是
 * `choices[0].delta.tool_calls[].function.name` 与 `usage`，缺 `id`/`model`/
 * `created` 会让它拼出一个没有名字的工具调用（下游报 `unknown tool ""`）。
 */
import { isQoderError, parseStreamDelta, type QoderDelta, type QoderError } from './upstream.ts'

export interface SseOptions {
  /** 响应里的 `model` 字段（客户端会拿它做展示，用请求的模型 id）。 */
  model: string
  /**
   * 流已经写出若干字节之后上游才报错（Qoder 会把 provider 故障包在 200 的
   * 信封里）时回调。HTTP 状态已经发不出去了，但「这个号今天额度用尽」对**后续**
   * 请求仍然有用 —— 核心的 `onLateFailure` 正是为这种时刻准备的。
   */
  onLateError?: (error: QoderError) => void
}

/** 把一条 delta 转成 OpenAI chunk。 */
function chunkOf(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

/** delta → OpenAI `delta` 对象（只带上游真的给了的字段）。 */
function deltaPayload(delta: QoderDelta, first: boolean): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  if (first && delta.role !== '') out.role = delta.role
  if (delta.content !== '') out.content = delta.content
  if (delta.reasoningContent !== '') out.reasoning_content = delta.reasoningContent
  if (delta.toolCalls !== undefined) out.tool_calls = delta.toolCalls
  return Object.keys(out).length === 0 ? undefined : out
}

/** usage 帧：OpenAI 的最后一帧 `choices: []` + `usage`。 */
function usageFrame(
  id: string,
  created: number,
  model: string,
  delta: QoderDelta,
): string {
  const usage: Record<string, unknown> = {
    prompt_tokens: delta.inputTokens,
    completion_tokens: delta.outputTokens,
    total_tokens: delta.inputTokens + delta.outputTokens,
  }
  // cached_tokens 是 prompt_tokens 的子集，不是额外增量；上游没报就不写，
  // 别用 0 顶替「不知道」（那会让宿主的缓存命中率变成不可信的 0%）。
  if (delta.cachedTokens !== undefined) usage.prompt_tokens_details = { cached_tokens: delta.cachedTokens }
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage,
  })}\n\n`
}

/**
 * 包装上游响应体。返回的流**始终**以 `data: [DONE]\n\n` 收尾（正常与被拒都一样），
 * 这样客户端不会挂在那儿等一个永远不来的结束帧。
 */
export function toOpenAiSse(body: ReadableStream<Uint8Array>, options: SseOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const id = `chatcmpl-${globalThis.crypto.randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  return new ReadableStream<Uint8Array>({
    start: async (ctrl) => {
      const emit = (text: string): void => {
        try {
          ctrl.enqueue(encoder.encode(text))
        } catch {
          // 客户端已断开
        }
      }
      // 第一帧先声明 role：有的客户端要求 assistant 角色先到，否则不认后续 delta
      emit(chunkOf(id, created, options.model, { role: 'assistant' }))
      reader = body.getReader()
      let buffer = ''
      let sawUsage = false
      let finished = false
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed === '' || !trimmed.startsWith('data:')) continue
            const payload = trimmed.slice('data:'.length).trim()
            if (payload === '' || payload === '[DONE]') continue
            let delta: QoderDelta | undefined
            try {
              delta = parseStreamDelta(payload)
            } catch (error: unknown) {
              // 信封里的业务错误：把 OpenAI 形状的 error 帧发出去再收尾
              const qoderError = isQoderError(error) ? error : undefined
              emit(`data: ${JSON.stringify({
                error: {
                  message: error instanceof Error ? error.message : String(error),
                  type: qoderError?.kind ?? 'upstream_error',
                  code: qoderError?.code ?? null,
                },
              })}\n\n`)
              if (qoderError !== undefined) options.onLateError?.(qoderError)
              finished = true
              break
            }
            if (delta === undefined) continue
            if (delta.inputTokens > 0 || delta.outputTokens > 0) sawUsage = true
            const payloadDelta = deltaPayload(delta, true)
            if (payloadDelta !== undefined) emit(chunkOf(id, created, options.model, payloadDelta))
            if (delta.inputTokens > 0 || delta.outputTokens > 0) {
              emit(usageFrame(id, created, options.model, delta))
            }
          }
          if (finished) break
        }
        if (!finished) {
          // 正常收尾：补一帧 finish_reason（上游不保证给），再补 [DONE]
          emit(chunkOf(id, created, options.model, {}, 'stop'))
          if (!sawUsage) void sawUsage
        }
      } catch (error: unknown) {
        const qoderError = isQoderError(error) ? error : undefined
        emit(`data: ${JSON.stringify({
          error: { message: error instanceof Error ? error.message : String(error), type: qoderError?.kind ?? 'stream_error' },
        })}\n\n`)
        if (qoderError !== undefined) options.onLateError?.(qoderError)
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // 有挂起 read 时会抛，忽略
        }
        emit('data: [DONE]\n\n')
        try {
          ctrl.close()
        } catch {
          // 已取消
        }
      }
    },
    /** 取消必须往下传：不实现它，客户端断开后上游 TCP 连接会一直挂着。 */
    cancel: (reason) => reader?.cancel(reason),
  })
}
