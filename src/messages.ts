/**
 * OpenAI 请求 → Qoder `agent_chat_generation` 请求体。
 *
 * Qoder 网关说「半个 OpenAI」：**出站**（网关 → 我们）的 SSE delta 就是 OpenAI 形状
 * （`choices[].delta.{role,content,reasoning_content,tool_calls}`），但**入站**的
 * 请求体是它自己的一套（`chat_context` / `model_config` / `business` / `session_id` …），
 * 消息也不是 `{role, content}` 而是带 `contents` parts 的结构。
 *
 * 模板取自 dingminhua/dsh-connect-qoder（MIT）的 `src/messages.ts`，其来源是
 * fengyinxia/qoder2api 的 `baseprompt.json`（MINIMAL 变体，实测可用：不带系统
 * 提示词，messages 完全由调用方替换）。
 *
 * @module dsh-router-qoder/messages
 */

/** 请求体模板（字段名与上游逐字一致，别重命名）。 */
export interface QoderChatTemplate {
  request_id: string
  request_set_id: string
  chat_record_id: string
  stream: boolean
  chat_task: string
  chat_context: {
    extra: {
      modelConfig: { is_reasoning: boolean; key: string }
      originalContent: { type: string; text: string }
    }
    text: { type: string; text: string }
  }
  session_id: string
  source: number
  version: string
  aliyun_user_type: string
  session_type: string
  agent_id: string
  task_id: string
  model_config: { key: string; is_vl: boolean; is_reasoning: boolean; source: string }
  /**
   * 思考强度档位（`low` / `high` / `max` …）。
   *
   * 实测自官方客户端：档位在这个**顶层**字段上，同时还会写一份到
   * `parameters.reasoning_effort`。官方两个都写，所以我们也两个都写 ——
   * 只写一个可能被网关忽略（各区域行为不完全一致）。
   */
  reasoningEffort?: string
  parameters?: Record<string, unknown>
  messages: unknown[]
  business: { id: string; name: string; begin_at: number }
  [key: string]: unknown
}

/**
 * 一份全新的请求体。**每个请求都要新建**（ID 字段必须各自唯一，复用会被上游
 * 当成重复请求）。
 */
export function createChatBodyTemplate(): QoderChatTemplate {
  return {
    request_id: '',
    request_set_id: '',
    chat_record_id: '',
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      extra: {
        modelConfig: { is_reasoning: false, key: 'lite' },
        originalContent: { type: 'text', text: '' },
      },
      text: { type: 'text', text: '' },
    },
    session_id: '',
    source: 1,
    version: '3',
    aliyun_user_type: 'personal_standard',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    model_config: { key: 'lite', is_vl: false, is_reasoning: false, source: 'system' },
    messages: [],
    business: { id: '', name: 'hi', begin_at: 0 },
  }
}

/** 模型 key / 图像能力 / 用户类型三处一起改（漏一处就会被网关当成别的模型）。 */
export function applyModelKey(body: QoderChatTemplate, key: string, userType: string, isVl: boolean): void {
  body.model_config.key = key
  body.model_config.is_vl = isVl
  body.chat_context.extra.modelConfig.key = key
  body.aliyun_user_type = userType
}

/** 一条转换后的入站消息。 */
interface QoderMessage {
  role: string
  content?: string
  contents?: Array<{ type?: string; text?: string; image_url?: { url?: string } }>
  tool_calls?: unknown[]
  name?: string
  tool_call_id?: string
  reasoning_content_signature?: string
  response_meta?: Record<string, unknown>
}

/**
 * 每条消息都要带的「假回执」。
 *
 * 上游把消息当成**历史回执**读：缺 `response_meta` / `reasoning_content_signature`
 * 的 assistant 消息会被当成格式异常的记录。这里给一份全零的合法骨架，与官方
 * 客户端的形状一致。
 */
function blankResponseMeta(): Record<string, unknown> {
  return {
    id: '',
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
    },
  }
}

function structuredMessage(role: string, text: string): QoderMessage {
  return { role, content: text, response_meta: blankResponseMeta(), reasoning_content_signature: '' }
}

function userMessage(text: string, images: string[] = []): QoderMessage {
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } })
  if (text.trim()) parts.push({ type: 'text', text })
  if (parts.length === 0) parts.push({ type: 'text', text: '' })
  return {
    role: 'user',
    content: '',
    contents: parts,
    response_meta: blankResponseMeta(),
    reasoning_content_signature: '',
  }
}

function toolMessage(message: Record<string, unknown>, text: string): QoderMessage {
  const out = structuredMessage('tool', text)
  if (typeof message.name === 'string') out.name = message.name
  if (typeof message.tool_call_id === 'string') out.tool_call_id = message.tool_call_id
  return out
}

/** 取一条 OpenAI 消息的纯文本（content 字符串 / parts 数组 / value 字段）。 */
export function normalizeMessageText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content as unknown[]) {
      if (typeof part === 'string') {
        parts.push(part)
        continue
      }
      if (part !== null && typeof part === 'object') {
        const p = part as Record<string, unknown>
        if (typeof p.text === 'string') parts.push(p.text)
        else if (typeof p.value === 'string') parts.push(p.value)
      }
    }
    return parts.join('')
  }
  return ''
}

/** user 消息里的图片 URL（只认 `image_url.url` part）。 */
export function extractMessageImages(message: Record<string, unknown>): string[] {
  if (message.role !== 'user') return []
  const content = message.content
  if (!Array.isArray(content)) return []
  const urls: string[] = []
  for (const part of content as unknown[]) {
    if (part === null || typeof part !== 'object') continue
    const iu = (part as Record<string, unknown>).image_url
    if (iu !== null && typeof iu === 'object') {
      const url = (iu as Record<string, unknown>).url
      if (typeof url === 'string') urls.push(url)
    }
  }
  return urls
}

const TOOL_CALLS_TEXT_RE = /Tool calls:\s*(\[[\s\S]*?\])/

/** 从文本里认回 `Tool calls: [...]`（有的宿主把 tool_calls 渲染成了文本）。 */
export function parseToolCallsText(text: string | null | undefined): unknown[] | undefined {
  if (!text) return undefined
  const m = TOOL_CALLS_TEXT_RE.exec(text)
  if (!m?.[1]) return undefined
  try {
    const parsed = JSON.parse(m[1]) as unknown
    if (Array.isArray(parsed) && parsed.every((item) => item !== null && typeof item === 'object')) {
      return normalizeToolCalls(parsed)
    }
  } catch {
    return undefined
  }
  return undefined
}

/** `{id, name, input}` 形状 → OpenAI 的 `{id, type, function:{name, arguments}}`。 */
function normalizeToolCalls(raw: unknown[]): unknown[] {
  return raw.map((tc) => {
    if (tc !== null && typeof tc === 'object' && !('function' in tc)) {
      const r = tc as Record<string, unknown>
      if (r.id && r.name && r.input) {
        return { id: r.id, type: 'function', function: { name: r.name, arguments: JSON.stringify(r.input) } }
      }
    }
    return tc
  })
}

/**
 * 这条 assistant 消息后面有没有**真的** tool 结果。
 *
 * 只有「有回执」的 tool_calls 才能结构化下发：网关要求 assistant 的 tool_calls
 * 与 tool 消息配对出现，一条没有回执的 tool_calls 会被判成断链（与 OpenAI 的
 * 422 同类）。没有回执时改渲染成文本，模型仍然读得到。
 */
function hasResolvedToolResponse(messages: Array<Record<string, unknown>>, assistantIndex: number): boolean {
  const message = messages[assistantIndex]
  if (message === undefined || message.role !== 'assistant') return false
  const tc = message.tool_calls
  if (!(Array.isArray(tc) && tc.length > 0) && !parseToolCallsText(normalizeMessageText(message))) return false
  for (let i = assistantIndex + 1; i < messages.length; i += 1) {
    const next = messages[i]
    if (next?.role === 'tool') return true
    if (next !== undefined && (next.role === 'assistant' || next.role === 'user' || next.role === 'system')) return false
  }
  return false
}

function renderToolCalls(toolCalls: unknown[]): string {
  return `Tool calls:\n${JSON.stringify(toolCalls)}`
}

function renderToolResult(message: Record<string, unknown>, text: string): string {
  const name = typeof message.name === 'string' ? message.name : ''
  const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
  let out = 'Tool result'
  if (name) out += ` (${name})`
  if (toolCallId) out += ` [${toolCallId}]`
  if (text.trim()) out += `:\n${text}`
  return out
}

/**
 * 一条 OpenAI 消息 → Qoder 消息。`null` = 这条不携带任何内容（跳过）。
 *
 * `toolsEnabled` 表示这个请求带了 tools；`allowStructuredToolCalls` 表示这条
 * assistant 的 tool_calls 有配对回执、可以结构化下发（见
 * {@link hasResolvedToolResponse}）。
 */
export function convertIncomingMessage(
  message: Record<string, unknown>,
  toolsEnabled: boolean,
  allowStructuredToolCalls: boolean,
): QoderMessage | null {
  const role = typeof message.role === 'string' ? message.role : 'user'
  const text = normalizeMessageText(message)

  let structuredToolCalls: unknown[] | undefined
  if (toolsEnabled && allowStructuredToolCalls) {
    const tc = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? message.tool_calls
      : parseToolCallsText(text)
    if (tc) structuredToolCalls = tc
  }

  if (role === 'assistant' && structuredToolCalls) {
    const out = structuredMessage('assistant', text)
    out.tool_calls = structuredToolCalls
    return out
  }

  if (role === 'tool') {
    if (toolsEnabled) return toolMessage(message, text)
    // 没有 tools 通道时，把结果渲染成 user 话术：不渲染就是**丢**了工具结果
    return structuredMessage('user', renderToolResult(message, text))
  }

  let finalText = text
  if (role === 'assistant' && !toolsEnabled && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    finalText = [text, renderToolCalls(message.tool_calls)].filter(Boolean).join('\n\n')
  }

  const images = role === 'user' ? extractMessageImages(message) : []
  if (!finalText.trim() && images.length === 0) return null

  if (role === 'user') {
    // 图片走真实 parts 时，去掉文本里的 `[image] <url>` 兜底占位（否则同一张图两遍）
    const cleaned = images.length > 0
      ? finalText.split('\n\n').filter((s) => !s.trim().startsWith('[image] ')).join('\n\n')
      : finalText
    return userMessage(cleaned, images)
  }

  return structuredMessage(role, finalText)
}

/** OpenAI messages → Qoder messages。 */
export function buildQoderMessages(
  incoming: Array<Record<string, unknown>>,
  prompt: string,
  toolsEnabled: boolean,
): QoderMessage[] {
  const rebuilt: QoderMessage[] = []
  for (let i = 0; i < incoming.length; i += 1) {
    const allowStructured = toolsEnabled && hasResolvedToolResponse(incoming, i)
    const converted = convertIncomingMessage(incoming[i]!, toolsEnabled, allowStructured)
    if (converted !== null) rebuilt.push(converted)
  }
  if (rebuilt.length === 0 && prompt.trim()) rebuilt.push(userMessage(prompt))
  return rebuilt
}

/** 最后一条 user 消息的纯文本（`business.name` 用它，官方客户端也这么填）。 */
export function extractLatestUserPrompt(messages: Array<Record<string, unknown>>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role === 'user') {
      const text = normalizeMessageText(m)
      if (text.trim()) return text
    }
  }
  return ''
}

/** 深拷贝（模板必须逐请求独立，否则并发请求会互相改对方的 ID）。 */
export function deepClone<T>(value: T): T {
  return structuredClone(value)
}
