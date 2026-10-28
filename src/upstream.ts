/**
 * Qoder 上游客户端 —— cosy 签名请求、jobToken 交换、模型目录、SSE 聊天、用量、签到。
 *
 * 端点（CN / Global 各自一个网关主机，chat/models/jobToken 共用它）：
 *
 * ```text
 *         gateway            chat                     models                    jobToken
 * CN      gateway.qoder.com.cn  /algo/api/v2/service/pro/sse/agent_chat_generation   /algo/api/v2/model/list   /algo/api/v3/user/jobToken
 * Global  api1.qoder.sh         （同上）                                            （同上）                  （同上）
 * ```
 *
 * 两个区域还各有一个 `openapi` 主机（`openapi.qoder.com.cn` / `openapi.qoder.sh`），
 * 承载 `sash` 那族接口（用量 `/sash/api/v2/me/usage`、活动
 * `/sash/api/v1/me/campaigns`）。
 *
 * **两条身份链并存，不要混用**（实测，两个区域都验证过）：
 *
 * | 面 | 认什么 |
 * | --- | --- |
 * | chat / models（cosy 协议面） | `Authorization: Bearer COSY.<payload>.<sig>` + `cosy-*` 头 |
 * | usage / campaigns（sash 面） | `Authorization: Bearer <jobToken.securityOauthToken>`，**不收** cosy 头 |
 *
 * 拿错凭据的症状是「聊天正常、积分永远 401」，而令牌明明没过期 —— 所以这里是
 * 两套请求构造，不是一套加分支。
 *
 * 协议来源：dingminhua/dsh-connect-qoder（MIT）的 `src/upstream.ts`，其端点为
 * 社区多方实测（qoder2api 系列 + 官方 SDK 产物核对）。
 *
 * @module dsh-router-qoder/upstream
 */
import {
  buildPayloadB64,
  composeBearer,
  cosyEncode,
  currentRfc1123Date,
  deriveFingerprint,
  identityFromJobToken,
  newCosySession,
  pathSigFrom,
  signLegacy,
  signRequest,
  type CosyFingerprint,
  type CosySession,
} from './cosy.ts'
import {
  applyModelKey,
  buildQoderMessages,
  createChatBodyTemplate,
  deepClone,
  extractLatestUserPrompt,
} from './messages.ts'

// ---------------------------------------------------------------------------
// 区域
// ---------------------------------------------------------------------------

export type QoderRegion = 'cn' | 'global'

export interface QoderRegionConfig {
  /** 网关主机（chat / models / jobToken 共用）。 */
  gateway: string
  /** OpenAPI 主机（用量 / 活动 / 领取）。 */
  openapi: string
  /** SSE 聊天端点（含固定查询串）。 */
  chatPath: string
  /** 模型目录端点。 */
  modelsPath: string
  /** jobToken 交换端点。 */
  jobTokenPath: string
  /** 活动列表端点（签到走它 —— 路径里没有「签到」二字，见下方说明）。 */
  campaignsPath: string
  /**
   * 该区域的 sash 接口是否需要**设备风控头**（`Cosy-MachineToken/Code/Type`）。
   *
   * 国际版实测需要：活动与用量只下发给带这三个头的请求，缺了是 401 而不是 404。
   * 那三件套来自本机 Qoder 客户端的 UMID 组件 —— 本插件**不**去伪造它，拿不到
   * 就如实报「该区域需要本机 Qoder 客户端的设备组件」，而不是假装「今天没有活动」。
   */
  requiresDeviceRisk: boolean
}

const CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
const MODELS_PATH = '/algo/api/v2/model/list?Encode=1'
const JOB_TOKEN_PATH = '/algo/api/v3/user/jobToken?Encode=1'
/**
 * 每日签到走 `sash` 的**活动**接口，路径里没有「签到」二字（叫 campaigns）。
 * 照着 checkin / signin / reward 猜是猜不到的（实测猜了 13 个全 404）——
 * 注意是 **v1**，用量那套是 v2。
 */
const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns'
const USAGE_PATH = '/sash/api/v2/me/usage'
/** sash 面要求的客户端标识（参考实现如此，缺了会被拒）。 */
const SASH_CLIENT_TYPE = '10'
const SASH_USER_AGENT = 'Qoder'

export const QODER_REGIONS: Readonly<Record<QoderRegion, QoderRegionConfig>> = {
  cn: {
    gateway: 'https://gateway.qoder.com.cn',
    openapi: 'https://openapi.qoder.com.cn',
    chatPath: CHAT_PATH,
    modelsPath: MODELS_PATH,
    jobTokenPath: JOB_TOKEN_PATH,
    campaignsPath: CAMPAIGNS_PATH,
    requiresDeviceRisk: false,
  },
  global: {
    gateway: 'https://api1.qoder.sh',
    openapi: 'https://openapi.qoder.sh',
    chatPath: CHAT_PATH,
    modelsPath: MODELS_PATH,
    jobTokenPath: JOB_TOKEN_PATH,
    campaignsPath: CAMPAIGNS_PATH,
    requiresDeviceRisk: true,
  },
}

// ---------------------------------------------------------------------------
// 错误与分类
// ---------------------------------------------------------------------------

/** 上游失败的种类（供应商层再映射成 AccountState）。 */
export type QoderErrorKind =
  | 'network'          // 传输层（TLS/EOF/reset/超时）
  | 'auth'             // 401/403：凭据被拒 / 会话过期
  | 'rate-limited'     // 429
  | 'invalid-request'  // 400：请求本身不合法（原地重试无意义）
  | 'content-policy'   // 内容审核拒绝
  | 'quota-exhausted'  // 业务码表示额度/配额耗尽
  | 'transient'        // 418/5xx/排队：瞬时
  | 'unknown'

export class QoderError extends Error {
  readonly kind: QoderErrorKind
  readonly status: number
  readonly code: string | undefined
  constructor(kind: QoderErrorKind, message: string, status = 0, code?: string) {
    super(message)
    this.name = 'QoderError'
    this.kind = kind
    this.status = status
    this.code = code
  }
}

export function isQoderError(error: unknown): error is QoderError {
  return error instanceof QoderError
}

/** 我们的 `BadRequest` 之外，所有 `QoderError` 都已经带 kind，这里只做透传收口。 */
function asQoderError(error: unknown): QoderError {
  if (isQoderError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  return new QoderError('network', message, 0)
}

const CONTENT_POLICY_MARKERS = [
  'DataInspectionFailed',
  'inappropriate content',
  'input text data may contain',
  'ContentFilter',
  'SensitiveContent',
]

function isContentPolicy(detail: string): boolean {
  return CONTENT_POLICY_MARKERS.some((marker) => detail.includes(marker))
}

/** 官方码表里的「用量与配额」族 —— 等周期重置或补额度，**不是**凭据问题。 */
const QUOTA_CODES: ReadonlySet<string> = new Set([
  '110', // 达到当日用量限制
  '113', // 用量配额耗尽
  '115', // 免费用户配额
  '116', // 团队管理员 Credits 耗尽
  '117', // 团队成员 Credits 耗尽
  '118', // 个人 Credits 耗尽
  '119', // 该模型的免费额度用完
  '122', // Billing Group Credits 到顶
  '402',
  '6004',
])
/** 416 范围/结构无法满足 · 430 能力不支持 · 80411 输入过长 · 80412 媒体过多。 */
const REQUEST_CODES: ReadonlySet<string> = new Set(['416', '430', '80411', '80412'])
/** 500 请求失败 / 10408 超时 / 10500 模型服务内部错误 / 10605 排队。 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['500', '10408', '10500', '10605'])

function classifyBusinessCode(code: string): QoderErrorKind {
  if (code === '105') return 'auth' // 登录态或 Access Token 已过期
  if (QUOTA_CODES.has(code)) return 'quota-exhausted'
  if (code === '406') return 'content-policy' // 敏感内容或模型拒绝
  if (REQUEST_CODES.has(code)) return 'invalid-request'
  if (TRANSIENT_CODES.has(code)) return 'transient'
  return 'unknown'
}

function classifyHttpStatus(status: number, detail: string): QoderErrorKind {
  if (isContentPolicy(detail)) return 'content-policy'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limited'
  if (status === 400) return 'invalid-request'
  if (status === 418 || status >= 500) return 'transient'
  return 'unknown'
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** 取业务码（字符串或整数两种写法都归一成字符串）。 */
function businessCodeOf(detail: string): string | undefined {
  const parsed = parseJson(detail.trim())
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const raw = (parsed as Record<string, unknown>).code
  if (typeof raw === 'string' && raw !== '') return raw
  if (typeof raw === 'number' && Number.isInteger(raw)) return String(raw)
  return undefined
}

/**
 * 取**最深一层认识的**业务码。
 *
 * 上游的失败帧会层层套：外层 `{code:403, message:"{\"code\":\"10605\",…}"}` ——
 * 外层那个 403 是 HTTP 语义，真码（10605 排队）藏在 message 里。只看最外层就会
 * 把「排队一分钟」判成「凭据被拒」，进而把一个几分钟就自愈的号判死。
 *
 * 三条纪律：只沿 `message` 往里走（不遍历 error/data/result，否则会把外层 HTTP
 * 码当业务码）；认不出的码记下来继续找；找不到就回落 HTTP 状态分类。
 */
const MAX_CODE_NESTING = 6

export function deepestBusinessCode(detail: string): string | undefined {
  let text = detail.trim()
  let fallback: string | undefined
  for (let depth = 0; depth < MAX_CODE_NESTING; depth += 1) {
    if (!text.startsWith('{')) break
    const parsed = parseJson(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) break
    const record = parsed as Record<string, unknown>
    const code = businessCodeOf(text)
    if (code !== undefined) {
      if (classifyBusinessCode(code) !== 'unknown') return code
      if (fallback === undefined) fallback = code
    }
    const message = record.message
    if (typeof message !== 'string') break
    text = message.trim()
  }
  return fallback
}

/**
 * 一次失败的分类：**业务码优先于 HTTP 状态**。
 *
 * 实测：当日用量用尽回的是 `HTTP 403 {"code":"110","Billing daily count exceeded"}`。
 * 只看状态会判成「凭据被拒」，于是「今天用满、明天自愈」的号被要求换 PAT。
 */
export function classifyFailure(status: number, detail: string): QoderErrorKind {
  const code = deepestBusinessCode(detail)
  if (code !== undefined) {
    const byCode = classifyBusinessCode(code)
    if (byCode !== 'unknown') return byCode
  }
  return classifyHttpStatus(status, detail)
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface QoderJobToken {
  id: string
  name: string
  expireTime: number
  securityOauthToken: string
  refreshToken: string
  userType: string
}

/** 会话 + 两族令牌。 */
export interface QoderSession {
  cosy: CosySession
  fingerprint: CosyFingerprint
  jobToken: QoderJobToken
  /** 会话到期时刻（ms）；0 = 未知。 */
  expireAtMs: number
  /** sash 面专用令牌（`POST /api/v1/jobToken/exchange` 换来的 `token`）。 */
  sashToken?: string
  sashExpireAtMs?: number
}

export interface QoderModel {
  key: string
  displayName: string
  enable: boolean
  isDefault: boolean
  isVl: boolean
  isReasoning: boolean
  isFree: boolean
  priceFactor: number | undefined
  maxInputTokens: number | undefined
  maxOutputTokens: number | undefined
  /** 上游声明的思考档位（`thinking_config.efforts`）。 */
  efforts: string[]
}

/** 用量（`sash/api/v2/me/usage` 的 qoderUsage 形状）。 */
export interface QoderUsage {
  userType?: string
  expiresAt?: number
  /** 基础包。 */
  userQuota?: { total?: number; used?: number; remaining?: number }
  /** 加量包。 */
  addOnQuota?: { total?: number; used?: number; remaining?: number }
  /** 企业资源包。 */
  orgResourcePackage?: { used?: number; cap?: number; remaining?: number; available?: boolean }
  isQuotaExceeded: boolean
}

/** 一条活动（只取签到用得到的字段）。 */
export interface QoderCampaign {
  campaignId: string
  actionType: string
  claimStatus: string
  amount?: number
  validityDays?: number
  endAt?: number
}

/** 签到结果。 */
export type QoderCheckinOutcome =
  | { status: 'claimed'; amount?: number; validityDays?: number }
  | { status: 'already-claimed' }
  | { status: 'unavailable'; message: string }

/** SSE 一帧的增量。 */
export interface QoderDelta {
  role: string
  content: string
  reasoningContent: string
  toolCalls: unknown[] | undefined
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
}

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------

/** jobToken 交换请求体（PAT 与 `drt-` refresh token 二选一，整体 cosy 编码）。 */
export function jobTokenBody(credential: string): string {
  const isRefresh = credential.startsWith('drt-')
  const inner = {
    personalToken: isRefresh ? '' : credential,
    securityOauthToken: '',
    refreshToken: isRefresh ? credential : '',
    needRefresh: isRefresh,
    authInfo: {},
  }
  const outer = { payload: JSON.stringify(inner), encodeVersion: '1' }
  return cosyEncode(new TextEncoder().encode(JSON.stringify(outer)))
}

/**
 * 解析一条 SSE 帧。
 *
 * 帧形状：`data: {"headers":{…},"body":"<内层 JSON>","statusCodeValue":200}`
 * 内层：`{"choices":[{"delta":{…}}],"usage":{…}}`，或业务错误
 * `{"code":"115","message":"…"}`。
 *
 * 返回 `undefined` = 这一帧没有可消费内容（`[DONE]` 之后的空帧、心跳等）。
 */
export function parseStreamDelta(dataPayload: string): QoderDelta | undefined {
  const wrapper = parseJson(dataPayload)
  if (wrapper === null || typeof wrapper !== 'object' || Array.isArray(wrapper)) return undefined
  const w = wrapper as Record<string, unknown>

  // 信封层错误：HTTP 200 建流之后，上游把 provider 故障包在信封里投递
  const scv = w.statusCodeValue
  if (scv !== undefined && scv !== null && Number(scv) !== 200) {
    const detail = typeof w.body === 'string' ? w.body : dataPayload.slice(0, 400)
    throw new QoderError(
      classifyFailure(Number(scv), detail),
      `上游信封错误: HTTP ${scv} ${truncate(detail, 300)}`,
      Number(scv),
      deepestBusinessCode(detail),
    )
  }

  const innerStr = w.body
  if (typeof innerStr !== 'string' || innerStr === '') return undefined
  const inner = parseJson(innerStr)
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return undefined
  const payload = inner as Record<string, unknown>

  // 业务错误：{"code":"115","message":"…"}
  if (typeof payload.code === 'string' && payload.code !== '' && payload.code !== '0') {
    throw new QoderError(
      classifyBusinessCode(payload.code),
      `上游业务错误 code=${payload.code}: ${String(payload.message ?? '')}`,
      0,
      payload.code,
    )
  }

  const usage = payload.usage
  const inputTokens = readCount2(usage, 'prompt_tokens')
  const outputTokens = readCount2(usage, 'completion_tokens')
  const cachedTokens = readCachedTokens(usage)
  const tokens = cachedTokens === undefined
    ? { inputTokens, outputTokens }
    : { inputTokens, outputTokens, cachedTokens }

  const choices = Array.isArray(payload.choices) ? (payload.choices as unknown[]) : []
  for (const ch of choices) {
    if (ch === null || typeof ch !== 'object') continue
    const delta = (ch as Record<string, unknown>).delta
    if (delta === null || typeof delta !== 'object') continue
    const d = delta as Record<string, unknown>
    const role = typeof d.role === 'string' ? d.role : ''
    const content = typeof d.content === 'string' ? d.content : ''
    const reasoning = typeof d.reasoning_content === 'string' ? d.reasoning_content : ''
    const toolCalls = Array.isArray(d.tool_calls) && d.tool_calls.length > 0 ? (d.tool_calls as unknown[]) : undefined
    if (role !== '' || content !== '' || reasoning !== '' || toolCalls !== undefined) {
      return { role, content, reasoningContent: reasoning, toolCalls, ...tokens }
    }
  }
  if (inputTokens > 0 || outputTokens > 0) {
    return { role: '', content: '', reasoningContent: '', toolCalls: undefined, ...tokens }
  }
  return undefined
}

function readCount2(usage: unknown, key: string): number {
  if (usage === null || typeof usage !== 'object') return 0
  const v = (usage as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * 读缓存命中的输入 token 数。三种拼法（OpenAI / DeepSeek / Kimi）取**第一个存在**
 * 的那个，不相加。
 *
 * 它是 `prompt_tokens` 的**子集**，不是额外增量 —— 加进去就把命中的前缀算两遍。
 * 返回 `undefined` 表示上游这帧没报，**不要**折成 0：那会让「没报」和「命中 0」
 * 变成同一个数字，百分比就不可信了。
 */
function readCachedTokens(usage: unknown): number | undefined {
  if (usage === null || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  const details = record.prompt_tokens_details
  if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
    const fromDetails = readNonNegative((details as Record<string, unknown>).cached_tokens)
    if (fromDetails !== undefined) return fromDetails
  }
  const fromHit = readNonNegative(record.prompt_cache_hit_tokens)
  if (fromHit !== undefined) return fromHit
  return readNonNegative(record.cached_tokens)
}

function readNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 解析用量响应（兼容 `qoderUsage` 内层与平铺两种形状）。 */
export function parseUsage(data: Record<string, unknown>): QoderUsage | undefined {
  const inner = data.qoderUsage
  const source = inner !== null && typeof inner === 'object' && !Array.isArray(inner)
    ? inner as Record<string, unknown>
    : data
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const bucket = (value: unknown): { total?: number; used?: number; remaining?: number } | undefined => {
    if (value === null || typeof value !== 'object') return undefined
    const v = value as Record<string, unknown>
    return { total: num(v.total), used: num(v.used), remaining: num(v.remaining) }
  }
  const out: QoderUsage = { isQuotaExceeded: source.isQuotaExceeded === true }
  const userType = source.userType
  if (typeof userType === 'string') out.userType = userType
  const expiresAt = num(source.expiresAt)
  if (expiresAt !== undefined) out.expiresAt = expiresAt
  const userQuota = bucket(source.userQuota)
  if (userQuota !== undefined) out.userQuota = userQuota
  const addOn = bucket(source.addOnQuota)
  if (addOn !== undefined) out.addOnQuota = addOn
  const org = source.orgResourcePackage
  if (org !== null && typeof org === 'object') {
    const o = org as Record<string, unknown>
    out.orgResourcePackage = { used: num(o.used), cap: num(o.cap), remaining: num(o.remaining), available: o.available === true }
  }
  return out
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

const DEFAULT_HEADERS: Record<string, string> = {
  'cosy-data-policy': 'agree',
  'content-type': 'application/json',
  'cosy-clienttype': '5',
  'login-version': 'v2',
  'user-agent': 'Go-http-client/2.0',
  'cosy-scene': 'assistant',
  'cosy-business-product': 'ide',
  'cosy-business-type': 'agent',
}

export interface QoderClientOptions {
  log?: (message: string) => void
  fetch?: typeof fetch
}

/**
 * 一个区域的 Qoder 客户端。
 *
 * 会话按**凭据**缓存（账号池里多个 PAT 各有各的 cosy 会话，用一个字段会互相覆盖）。
 */
export class QoderClient {
  readonly region: QoderRegion
  readonly config: QoderRegionConfig
  private readonly log: (message: string) => void
  private readonly fetchImpl: typeof fetch
  private readonly sessions = new Map<string, QoderSession>()

  constructor(region: QoderRegion, options: QoderClientOptions = {}) {
    this.region = region
    this.config = QODER_REGIONS[region]
    this.log = options.log ?? (() => {})
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  /** 会话是否还可用（提前 5 分钟视为过期，给续期留时间）。 */
  private sessionValid(credential: string, now = Date.now()): boolean {
    const s = this.sessions.get(credential)
    if (s === undefined) return false
    return s.expireAtMs - now > 5 * 60_000
  }

  /** 丢掉某个凭据的会话（凭据换掉 / 被判失效时用）。 */
  forget(credential: string): void {
    this.sessions.delete(credential)
  }

  /**
   * 用 PAT（`pt-…`）或 refresh token（`drt-…`）换 jobToken，并建立 cosy 会话。
   *
   * 这一步用**旧式签名**（`date` + `signature: md5("cosy&<secret>&<date>")`）而不是
   * chat 那套 Bearer，头里还要带设备指纹三件套。指纹以凭据为种子派生：这时候
   * 还没拿到 uid，但同一凭据必须得到同一个指纹。
   */
  async exchangeJobToken(credential: string): Promise<QoderJobToken> {
    const fingerprint = deriveFingerprint('', credential)
    const body = jobTokenBody(credential)
    const date = currentRfc1123Date()
    const url = `${this.config.gateway}${this.config.jobTokenPath}`
    let resp: Response
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'cosy-machinetoken': fingerprint.machineToken,
          'cosy-machinetype': fingerprint.machineType,
          'login-version': 'v2',
          appcode: 'cosy',
          accept: 'application/json',
          'accept-encoding': 'identity',
          'cosy-version': '0.1.43',
          'cosy-clienttype': '5',
          date,
          signature: signLegacy(date),
          'content-type': 'application/json',
          'cosy-machineid': fingerprint.machineId,
          'user-agent': 'Go-http-client/2.0',
        },
        body,
      })
    } catch (error: unknown) {
      throw asQoderError(error)
    }
    const text = await resp.text()
    if (resp.status !== 200) {
      throw new QoderError(
        classifyFailure(resp.status, text),
        `jobToken 交换失败: HTTP ${resp.status} ${truncate(text, 200)}`,
        resp.status,
        deepestBusinessCode(text),
      )
    }
    const data = parseJson(text)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new QoderError('unknown', `jobToken 响应不是 JSON: ${truncate(text, 200)}`, resp.status)
    }
    const raw = data as Record<string, unknown>
    const jobToken: QoderJobToken = {
      id: String(raw.id ?? ''),
      name: String(raw.name ?? ''),
      expireTime: Number(raw.expireTime ?? 0),
      securityOauthToken: String(raw.securityOauthToken ?? ''),
      refreshToken: String(raw.refreshToken ?? ''),
      userType: String(raw.userType ?? 'personal_standard'),
    }
    if (jobToken.id === '' && jobToken.securityOauthToken === '') {
      throw new QoderError('auth', `jobToken 交换响应缺少身份字段: ${truncate(text, 200)}`, resp.status)
    }
    const session: QoderSession = {
      cosy: newCosySession(identityFromJobToken(raw), fingerprint),
      fingerprint,
      jobToken,
      expireAtMs: jobToken.expireTime > 0 ? jobToken.expireTime : 0,
    }
    // sash 那一族顺手换一枚，且**必须 await**：不等它落地，紧接着的第一次积分/
    // 签到会读到空令牌而 401 —— 那个 401 与「真被拒」长得一模一样（实测第一次
    // 401、第二次 200），排查极贵。多一次往返换「第一次就对」。
    await this.refreshSashToken(credential, session)
    this.sessions.set(credential, session)
    this.log(`[${this.region}] jobToken ok: ${jobToken.name || jobToken.id}`)
    return jobToken
  }

  /**
   * 换 sash 面专用令牌（`POST {openapi}/api/v1/jobToken/exchange`）。
   *
   * **不抛**：换不到就让 sash 面回落到 `securityOauthToken`（国内版两族等价）；
   * 这一支失败只该让「积分/签到读不到」，不该把 chat 一起拖挂 —— 两条链路。
   *
   * body 的键是 `personal_token`：`personal_access_token` 那种拼写上游回 400。
   */
  private async refreshSashToken(credential: string, session: QoderSession): Promise<void> {
    try {
      const resp = await this.fetchImpl(`${this.config.openapi}/api/v1/jobToken/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ personal_token: credential }),
      })
      const text = await resp.text()
      if (resp.status !== 200) {
        this.log(`[${this.region}] sash 令牌交换失败 HTTP ${resp.status}（回落到旧令牌）`)
        return
      }
      const data = parseJson(text)
      const raw = data !== null && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {}
      // 上游在这点上有过三种拼写，全试
      const token = typeof raw.token === 'string' && raw.token !== ''
        ? raw.token
        : typeof raw.job_token === 'string' && raw.job_token !== ''
          ? raw.job_token
          : typeof raw.jobToken === 'string' && raw.jobToken !== '' ? raw.jobToken : ''
      if (token === '') {
        this.log(`[${this.region}] sash 令牌响应里没有 token 字段`)
        return
      }
      session.sashToken = token
      const expiry = typeof raw.expires_at === 'string' ? Date.parse(raw.expires_at) : Number.NaN
      session.sashExpireAtMs = Number.isFinite(expiry) ? expiry : 0
    } catch (error: unknown) {
      this.log(`[${this.region}] sash 令牌交换异常（回落到旧令牌）: ${String((error as Error)?.message ?? error).slice(0, 120)}`)
    }
  }

  /** 确保有可用会话（过期才重新交换）。 */
  async ensureSession(credential: string): Promise<QoderSession> {
    if (this.sessionValid(credential)) return this.sessions.get(credential)!
    await this.exchangeJobToken(credential)
    return this.sessions.get(credential)!
  }

  /** 用一次真实交换验证 PAT，返回账号显示名（`addApiKey` 用它）。 */
  async verifyCredential(credential: string): Promise<{ id: string; name: string; userType: string }> {
    const jobToken = await this.exchangeJobToken(credential)
    return { id: jobToken.id, name: jobToken.name, userType: jobToken.userType }
  }

  /**
   * cosy 协议面的 GET（models 用）：与 chat 同一套 Bearer，body 为空串参与签名。
   */
  private async cosyGet(session: QoderSession, url: string): Promise<Record<string, unknown>> {
    const pathSig = pathSigFrom(url)
    const payloadB64 = buildPayloadB64(session.cosy.info)
    const date = String(Math.floor(Date.now() / 1000))
    const sig = signRequest(payloadB64, session.cosy.cosyKey, date, '', pathSig)
    let resp: Response
    try {
      resp = await this.fetchImpl(url, {
        headers: {
          ...DEFAULT_HEADERS,
          'cosy-machinetype': session.cosy.machineType,
          'cosy-date': date,
          'cosy-user': session.cosy.identity.uid,
          'cosy-key': session.cosy.cosyKey,
          accept: 'application/json',
          authorization: composeBearer(payloadB64, sig),
          'cosy-version': '0.1.43',
          'cosy-machineid': session.cosy.machineId,
          'cosy-machinetoken': session.cosy.machineToken,
        },
      })
    } catch (error: unknown) {
      throw asQoderError(error)
    }
    const text = await resp.text()
    if (resp.status !== 200) {
      throw new QoderError(
        classifyFailure(resp.status, text),
        `models 请求失败: HTTP ${resp.status} ${truncate(text, 200)}`,
        resp.status,
        deepestBusinessCode(text),
      )
    }
    const data = parseJson(text)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new QoderError('unknown', `models 响应不是 JSON: ${truncate(text, 200)}`, resp.status)
    }
    return data as Record<string, unknown>
  }

  /**
   * 模型目录。响应 `{chat:[{key, display_name, enable, is_vl, price_factor, …}], …}`。
   *
   * 过滤掉上游的 `auto`：它是该区的**默认路由**（请求时才决定解析成哪个模型），
   * 价格与上下文都由别人临时决定，不是可以选择、也可以如实描述的模型。
   */
  async fetchModels(credential: string): Promise<QoderModel[]> {
    const session = await this.ensureSession(credential)
    const data = await this.cosyGet(session, `${this.config.gateway}${this.config.modelsPath}`)
    const rows = Array.isArray(data.chat) ? (data.chat as unknown[]) : []
    const out: QoderModel[] = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const raw = row as Record<string, unknown>
      const key = typeof raw.key === 'string' ? raw.key : ''
      const displayName = typeof raw.display_name === 'string' ? raw.display_name : ''
      if (key === '' || displayName === '') continue
      if (key.toLowerCase() === 'auto') continue
      const thinking = raw.thinking_config
      const efforts: string[] = []
      if (thinking !== null && typeof thinking === 'object') {
        const list = (thinking as Record<string, unknown>).efforts
        if (Array.isArray(list)) {
          for (const e of list) if (typeof e === 'string' && e !== '') efforts.push(e)
        }
      }
      out.push({
        key,
        displayName,
        enable: raw.enable !== false,
        isDefault: raw.is_default === true,
        isVl: raw.is_vl === true,
        isReasoning: raw.is_reasoning === true,
        isFree: raw.is_free === true,
        priceFactor: typeof raw.price_factor === 'number' ? raw.price_factor : undefined,
        maxInputTokens: typeof raw.max_input_tokens === 'number' ? raw.max_input_tokens : undefined,
        maxOutputTokens: typeof raw.max_output_tokens === 'number' ? raw.max_output_tokens : undefined,
        efforts,
      })
    }
    return out
  }

  /**
   * 建一条聊天 SSE 流（**原样**返回上游响应体，交给 sse.ts 转 OpenAI 格式）。
   *
   * 请求体是 Qoder 私有模板（见 messages.ts），签名的 body 段是**cosy 编码后的
   * 密文**而不是原文 —— 这是最容易搞错的一处：签原文会得到 `Signature invalid`。
   */
  async openChat(
    credential: string,
    modelKey: string,
    incoming: Array<Record<string, unknown>>,
    options: { tools?: unknown[]; reasoningEffort?: string; isVl?: boolean; signal?: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>> {
    const session = await this.ensureSession(credential)
    const template = deepClone(createChatBodyTemplate())
    applyModelKey(template, modelKey, session.jobToken.userType, options.isVl === true)
    if (options.reasoningEffort !== undefined && options.reasoningEffort !== '') {
      // 官方客户端两处都写，照抄：只写一个可能被某个区域忽略
      template.reasoningEffort = options.reasoningEffort
      template.parameters = { ...(template.parameters ?? {}), reasoning_effort: options.reasoningEffort }
    }
    const prompt = extractLatestUserPrompt(incoming)
    const toolsEnabled = Array.isArray(options.tools) && options.tools.length > 0
    template.messages = buildQoderMessages(incoming, prompt, toolsEnabled) as unknown as unknown[]
    if (toolsEnabled) template.tools = options.tools
    template.request_id = randomId()
    template.chat_record_id = template.request_id
    template.request_set_id = randomId()
    template.session_id = randomId()
    template.business.id = randomId()
    template.business.name = prompt.slice(0, 30) || 'hi'
    template.business.begin_at = Date.now()

    const body = JSON.stringify(template)
    const url = `${this.config.gateway}${this.config.chatPath}`
    const encoded = cosyEncode(new TextEncoder().encode(body))
    const date = String(Math.floor(Date.now() / 1000))
    const payloadB64 = buildPayloadB64(session.cosy.info)
    const sig = signRequest(payloadB64, session.cosy.cosyKey, date, encoded, pathSigFrom(url))
    let resp: Response
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          ...DEFAULT_HEADERS,
          'cosy-machinetype': session.cosy.machineType,
          'cosy-date': date,
          'cosy-user': session.cosy.identity.uid,
          'cosy-key': session.cosy.cosyKey,
          'cache-control': 'no-cache',
          accept: 'text/event-stream',
          authorization: composeBearer(payloadB64, sig),
          'cosy-version': '0.1.43',
          'cosy-machineid': session.cosy.machineId,
          'cosy-machinetoken': session.cosy.machineToken,
          'x-model-key': modelKey,
          'x-model-source': 'system',
        },
        body: encoded,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error: unknown) {
      throw asQoderError(error)
    }
    if (resp.status !== 200) {
      const text = await resp.text()
      // 用 classifyFailure 而不是只看状态：chat 面的「当日用量用尽」正是从这里
      // 进来的（实测 HTTP 403 + `{"code":"110"}`），只看状态会判成凭据被拒。
      throw new QoderError(
        classifyFailure(resp.status, text),
        `聊天请求失败: HTTP ${resp.status} ${truncate(text, 300)}`,
        resp.status,
        deepestBusinessCode(text),
      )
    }
    if (resp.body === null) throw new QoderError('transient', '聊天响应没有 body', resp.status)
    return resp.body
  }

  /** sash 面的 GET：`Authorization: Bearer <sashToken || securityOauthToken>`。 */
  private async sashGet(session: QoderSession, url: string): Promise<Record<string, unknown>> {
    const token = this.sashBearer(session)
    if (token === '') {
      throw new QoderError('auth', '两次令牌交换都没拿到可用令牌，无法访问 sash 接口', 401)
    }
    let resp: Response
    try {
      resp = await this.fetchImpl(url, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'cosy-clienttype': SASH_CLIENT_TYPE,
          'user-agent': SASH_USER_AGENT,
        },
      })
    } catch (error: unknown) {
      throw asQoderError(error)
    }
    return this.readSash(resp, url)
  }

  private async readSash(resp: Response, url: string): Promise<Record<string, unknown>> {
    const text = await resp.text()
    if (resp.status !== 200 && resp.status !== 201) {
      // 国际版 sash 面缺设备风控头时是 401（不是 404）—— 这时给出可执行的解释，
      // 而不是一句「凭据被拒」把用户引去换一个没问题的 PAT。
      if (this.config.requiresDeviceRisk && (resp.status === 401 || resp.status === 403)) {
        throw new QoderError(
          'auth',
          `该区域的积分/签到需要本机 Qoder 客户端的设备风控组件（${url}），本插件不伪造它`,
          resp.status,
          deepestBusinessCode(text),
        )
      }
      throw new QoderError(
        classifyFailure(resp.status, text),
        `sash 请求失败: HTTP ${resp.status} ${truncate(text, 200)}`,
        resp.status,
        deepestBusinessCode(text),
      )
    }
    const data = parseJson(text)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new QoderError('unknown', `sash 响应不是 JSON: ${truncate(text, 200)}`, resp.status)
    }
    return data as Record<string, unknown>
  }

  private sashBearer(session: QoderSession): string {
    if (typeof session.sashToken === 'string' && session.sashToken !== '') return session.sashToken
    return session.jobToken.securityOauthToken
  }

  /** 剩余积分（基础包 + 加量包 + 企业包）。读不到返回 undefined（不是 0）。 */
  async fetchUsage(credential: string): Promise<QoderUsage | undefined> {
    const session = await this.ensureSession(credential)
    const data = await this.sashGet(session, `${this.config.openapi}${USAGE_PATH}`)
    return parseUsage(data)
  }

  /** 活动列表（签到挑用）。 */
  async fetchCampaigns(credential: string): Promise<QoderCampaign[]> {
    const session = await this.ensureSession(credential)
    const data = await this.sashGet(session, `${this.config.openapi}${this.config.campaignsPath}?forceRefresh=true`)
    const rows = Array.isArray(data.campaigns)
      ? (data.campaigns as unknown[])
      : Array.isArray((data.data as Record<string, unknown> | undefined)?.campaigns)
        ? ((data.data as Record<string, unknown>).campaigns as unknown[])
        : []
    const out: QoderCampaign[] = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const raw = row as Record<string, unknown>
      const campaignId = String(raw.campaignId ?? '')
      if (campaignId === '') continue
      const benefit = raw.benefit
      const b = benefit !== null && typeof benefit === 'object' ? benefit as Record<string, unknown> : {}
      const validity = b.validity
      const v = validity !== null && typeof validity === 'object' ? validity as Record<string, unknown> : {}
      out.push({
        campaignId,
        actionType: String(raw.actionType ?? ''),
        claimStatus: String(raw.claimStatus ?? ''),
        ...(typeof b.amount === 'number' ? { amount: b.amount } : {}),
        ...(typeof v.days === 'number' ? { validityDays: v.days } : {}),
        ...(typeof raw.endAt === 'number' ? { endAt: raw.endAt } : {}),
      })
    }
    return out
  }

  /**
   * 领取今天那份每日 Credits。
   *
   * 一次调用自足：先拉活动列表找出可领的那条，再领取。三种结果分得很清 ——
   * `claimed` / `already-claimed`（幂等，不是错误）/ `unavailable`（今天上游没
   * 下发活动，比如企业号或未开窗）。
   */
  async claimDailyCredits(credential: string): Promise<QoderCheckinOutcome> {
    const campaigns = await this.fetchCampaigns(credential)
    const daily = campaigns.find((c) => c.actionType === 'CLAIM_BENEFIT')
    const claimable = campaigns.find((c) => c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE')
    if (claimable === undefined) {
      return daily?.claimStatus === 'CLAIMED'
        ? { status: 'already-claimed' }
        : { status: 'unavailable', message: '上游今日没有下发可领取的签到活动' }
    }
    const session = await this.ensureSession(credential)
    const url = `${this.config.openapi}${this.config.campaignsPath}/${encodeURIComponent(claimable.campaignId)}/claim`
    const token = this.sashBearer(session)
    if (token === '') throw new QoderError('auth', '没有可用令牌，无法领取', 401)
    let resp: Response
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'cosy-clienttype': SASH_CLIENT_TYPE,
          accept: 'application/json',
          'accept-language': 'zh-CN',
          'user-agent': SASH_USER_AGENT,
          'content-type': 'application/json',
          origin: this.config.openapi,
        },
        body: '{}',
      })
    } catch (error: unknown) {
      throw asQoderError(error)
    }
    if (resp.status === 409) return { status: 'already-claimed' } // 重复领取是幂等的
    const data = await this.readSash(resp, url)
    if (String(data.status ?? '') === 'CLAIMED') {
      return {
        status: 'claimed',
        ...(claimable.amount === undefined ? {} : { amount: claimable.amount }),
        ...(claimable.validityDays === undefined ? {} : { validityDays: claimable.validityDays }),
      }
    }
    return { status: 'unavailable', message: `签到未完成（上游状态 ${String(data.status ?? '未知')}）` }
  }
}

function randomId(): string {
  return globalThis.crypto.randomUUID()
}
