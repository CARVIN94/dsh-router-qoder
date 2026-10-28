/**
 * qoder 族供应商共享实现。
 *
 * 国内版（gateway.qoder.com.cn）与国际版（api1.qoder.sh）是同一套 cosy 协议的
 * 两个部署：契约、签名、消息形状完全一致，只差主机与「sash 面是否要设备风控头」
 * 两件事，所以全部共享逻辑住在这里，差异收敛进 `QoderProfile`；cn.ts / global.ts
 * 各给一份 profile。
 *
 * 与 codebuddy 族最大的不同：**认证是 PAT 而不是 OAuth**。用户粘贴一个 `pt-…`
 * 就完事，没有浏览器登录、没有回调、没有 refresh token —— 所以这里实现的是
 * 契约里的 `addApiKey` 那条路，不是 `generateLoginUrl`/`completeLogin`。
 *
 * 另一个不同：上游不是 OpenAI 兼容端点，因此 chat 必须自己把 Qoder 的 SSE 转成
 * OpenAI SSE（见 sse.ts）。核心对插件流的要求就是「OpenAI SSE 字节」。
 *
 * @module dsh-router-qoder/core
 */
import type { ChatRequest, ModelInfo } from './types.ts'
import type {
  AccountState,
  ChatOnceResult,
  SupplierEnv,
  SupplierModule,
  SupplierStatusNow,
} from './contract.ts'
import { QoderClient, isQoderError, type QoderErrorKind, type QoderModel, type QoderRegion } from './upstream.ts'
import { toOpenAiSse } from './sse.ts'

/** 一个上游部署的差异描述。 */
export interface QoderProfile {
  /** 供应商 id。**同时是凭证/配置/积分的存储键**，改它等于换一个供应商。 */
  id: string
  /** 面板展示名。 */
  name: string
  /** 该 profile 对应的上游区域（决定主机与设备风控要求）。 */
  region: QoderRegion
  /** 面板图标（内联 data URI，不能放网络 URL）。 */
  icon: string
  /** 池内排序（越小越靠前）。 */
  priority: number
  /** 账号 uid 前缀（`qd-1` / `qdg-1`）。 */
  uidPrefix: string
  /** 默认昵称（上游不下发昵称时用）。 */
  defaultNickname: string
  /** 错误文本前缀，如 `qoder-cn: …`。 */
  errPrefix: string
  /** 「添加 API key」弹窗里的提示文案。 */
  apiKeyHint: string
  /** 上游拉不到模型时的兜底列表（只是最后退路，不是「当前可用模型」）。 */
  fallbackModels: ModelInfo[]
}

/** 凭证 blob。 */
interface QoderCred {
  nickname: string
  /** 个人访问令牌（`pt-…`）。 */
  pat: string
  /** 上游账号 id（交换 jobToken 时拿到，仅用于展示/去重）。 */
  userId?: string
}

/** 积分缓存 10 分钟（与 codebuddy 同口径）。 */
const CREDITS_TTL_MS = 10 * 60 * 1000
/** 拿不到积分时报它（**不是 0**）：核心据此保留上次持久化的值。 */
const CREDITS_UNKNOWN = -1

/** 上游错误种类 → 契约的账号状态。 */
function stateOf(kind: QoderErrorKind): AccountState {
  switch (kind) {
    case 'auth':
      return 'session_dead'
    case 'quota-exhausted':
      return 'quota'
    case 'rate-limited':
      return 'rate_limit'
    // 瞬时（5xx / 排队 / 超时）：短冷换号确实管用，归 rate_limit 让核心换下一个
    case 'transient':
      return 'rate_limit'
    // 内容审核与请求形态问题都不是账号的错：同一个请求对池里每个号都会失败
    case 'content-policy':
    case 'invalid-request':
      return 'bad_request'
    case 'network':
      return 'transport'
    default:
      return 'unknown'
  }
}

/** 剩余额度：基础包 + 加量包 + 企业包（缺哪个算哪个；都缺 = undefined）。 */
function remainingOf(usage: { userQuota?: { remaining?: number }; addOnQuota?: { remaining?: number }; orgResourcePackage?: { remaining?: number } }): number | undefined {
  const parts: number[] = []
  for (const bucket of [usage.userQuota, usage.addOnQuota, usage.orgResourcePackage]) {
    if (bucket !== undefined && typeof bucket.remaining === 'number' && Number.isFinite(bucket.remaining)) {
      parts.push(bucket.remaining)
    }
  }
  if (parts.length === 0) return undefined
  return Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100
}

/** 消息里有没有图片（决定 `model_config.is_vl`）。只看 user 消息的 parts。 */
function hasImageInput(messages: unknown[]): boolean {
  for (const m of messages) {
    if (m === null || typeof m !== 'object') continue
    const msg = m as Record<string, unknown>
    if (msg.role !== 'user') continue
    const content = msg.content
    if (!Array.isArray(content)) continue
    for (const part of content as unknown[]) {
      if (part === null || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      if (p.type === 'image_url' || p.type === 'input_image') return true
    }
  }
  return false
}

/** 按 profile 造一个供应商模块。 */
export function createSupplier(p: QoderProfile): (env: SupplierEnv) => SupplierModule {
  return function factory(env: SupplierEnv): SupplierModule {
    const id = p.id
    const creds = env.credentials
    const store = env.store
    const log = env.log
    const client = new QoderClient(p.region, { log })

    /** 积分缓存：uid → { value, at }。积分本身由核心持久化，这里只管内存 TTL。 */
    const creditsCache = new Map<string, { value: number; at: number }>()
    /** 正在拉积分的 uid：并发 status() 共享同一次请求。 */
    const creditsInflight = new Set<string>()
    /** 模型缓存 + 并发去重。 */
    let modelsCache: QoderModel[] | undefined
    let modelsInflight: Promise<QoderModel[]> | undefined

    function listUids(): string[] {
      return creds.list(id)
    }

    function getCred(uid: string): QoderCred | undefined {
      return creds.get<QoderCred>(id, uid)
    }

    /** 账号顺序：池顺序优先，未配置按凭证原始顺序。 */
    function orderedUids(): string[] {
      const all = listUids()
      const order = store.get(id).poolOrder
      return [...order.filter((u) => all.includes(u)), ...all.filter((u) => !order.includes(u))]
    }

    /** 当前别名前缀（核心可能在 store 里覆盖默认值）。 */
    function currentAlias(): string {
      return store.get(id).alias || id
    }

    /**
     * 剥离本供应商的 alias 前缀。
     *
     * 只剥自己的（`qoder/xxx`），模型 id 自带的斜杠保留 —— 否则上游的
     * `org/name` 会被剥成 `name`，请求必然 404。
     */
    function stripAlias(model: string): string {
      const alias = currentAlias()
      return alias !== '' && model.startsWith(`${alias}/`) ? model.slice(alias.length + 1) : model
    }

    async function refreshCredits(uid: string): Promise<number | undefined> {
      if (creditsInflight.has(uid)) return undefined
      const cred = getCred(uid)
      if (cred === undefined) return undefined
      creditsInflight.add(uid)
      try {
        const usage = await client.fetchUsage(cred.pat)
        if (usage === undefined) return undefined
        const value = remainingOf(usage)
        if (value === undefined) return undefined
        creditsCache.set(uid, { value, at: Date.now() })
        return value
      } catch (error: unknown) {
        // 读不到就报 -1（核心保留上次的值）；但凭据被拒要落日志，
        // 否则面板上只看到「积分 -1」，看不出这个号已经登不上了。
        if (isQoderError(error) && error.kind === 'auth') {
          log(`${p.errPrefix} credits ${uid}: ${error.message}`)
        }
        return undefined
      } finally {
        creditsInflight.delete(uid)
      }
    }

    async function fetchModelsFromUpstream(): Promise<QoderModel[]> {
      for (const uid of orderedUids()) {
        const cred = getCred(uid)
        if (cred === undefined) continue
        try {
          const list = await client.fetchModels(cred.pat)
          if (list.length > 0) return list
        } catch (error: unknown) {
          log(`${p.errPrefix} models ${uid}: ${(error as Error).message.slice(0, 160)}`)
        }
      }
      return []
    }

    /** 上游模型 → 契约的 `ModelInfo`（面板按 k 显示上下文，与别的插件一致）。 */
    function toModelInfo(m: QoderModel): ModelInfo {
      return m.maxInputTokens === undefined
        ? { id: m.key }
        : { id: m.key, context_length: Math.round(m.maxInputTokens / 1000) }
    }

    async function allModels(force: boolean): Promise<ModelInfo[]> {
      // 核心按 TTL 缓存，force=false 的频繁调用直接用缓存，别打上游
      if (!force && modelsCache !== undefined) return modelsCache.map(toModelInfo)
      if (modelsInflight !== undefined) return (await modelsInflight).map(toModelInfo)
      modelsInflight = fetchModelsFromUpstream()
        .then((list) => {
          if (list.length > 0) modelsCache = list
          return modelsCache ?? []
        })
        .catch(() => modelsCache ?? [])
        .finally(() => {
          modelsInflight = undefined
        })
      const list = await modelsInflight
      // 上游一个都拿不到（没账号 / 全挂了）时才用兜底表：它只是「别让面板空着」，
      // 不是「当前可用模型」。
      return (list.length > 0 ? list : p.fallbackModels.map((m) => ({
        key: m.id,
        displayName: m.id,
        enable: true,
        isDefault: false,
        isVl: false,
        isReasoning: false,
        isFree: false,
        priceFactor: undefined,
        maxInputTokens: m.context_length === undefined ? undefined : m.context_length * 1000,
        maxOutputTokens: undefined,
        efforts: [],
      }))).map(toModelInfo)
    }

    /** 装一个不落盘的新账号（uid 按前缀递增，跳过已占用的）。 */
    function allocateUid(): string {
      let n = listUids().length + 1
      let uid = `${p.uidPrefix}-${n}`
      while (getCred(uid) !== undefined) uid = `${p.uidPrefix}-${++n}`
      return uid
    }

    return {
      id,
      name: p.name,
      priority: p.priority,
      icon: p.icon,
      apiKeyHint: p.apiKeyHint,
      status: (): SupplierStatusNow => {
        const now = Date.now()
        const accounts = orderedUids().map((uid) => {
          const cred = getCred(uid)
          const cached = creditsCache.get(uid)
          // 过期就后台刷一次，本次仍报缓存值（面板同步接口不能等网络）
          if (cached === undefined || now - cached.at > CREDITS_TTL_MS) void refreshCredits(uid)
          return {
            uid,
            nickname: cred?.nickname || p.defaultNickname,
            // 没缓存过报 -1，不是 0：0 是「真的用完了」，核心分得清两者
            credits: cached?.value ?? CREDITS_UNKNOWN,
            state: (cred === undefined ? 'session_dead' : 'ok') as AccountState,
          }
        })
        return { id, name: p.name, accounts }
      },
      listModels: (force?: boolean): Promise<ModelInfo[]> => allModels(!!force),
      /**
       * 添加账号：粘贴 PAT。
       *
       * 这里**真的去交换一次 jobToken** 才落盘 —— 一个打错一个字符的 PAT 存进去
       * 之后，面板上只会显示「凭据失效」，用户不知道是当初就错了还是后来过期了。
       * 交换顺带拿到显示名，比 `qd-1` 这种占位名有用。
       */
      addApiKey: async (input: { name: string; apiKey: string }): Promise<{ ok: boolean; error?: string; account?: { uid: string; nickname: string } }> => {
        const pat = normalizePat(input.apiKey)
        if (pat === '') return { ok: false, error: 'PAT 不能为空' }
        // 同一个 PAT 重复添加：直接报出来，别偷偷造出第二个号（两个号共用一个
        // 额度，池里会互相打脸）
        for (const uid of listUids()) {
          if (getCred(uid)?.pat === pat) return { ok: false, error: `这个 PAT 已经添加过了（${uid}）` }
        }
        try {
          const verified = await client.verifyCredential(pat)
          const uid = allocateUid()
          const nickname = input.name.trim() || verified.name || p.defaultNickname
          creds.save(id, uid, { nickname, pat, ...(verified.id === '' ? {} : { userId: verified.id }) })
          log(`${p.errPrefix} account added: ${uid} (${nickname})`)
          return { ok: true, account: { uid, nickname } }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          return { ok: false, error: `PAT 校验失败：${message}` }
        }
      },
      removeLink: (uid: string): Promise<boolean> => {
        const cred = getCred(uid)
        if (cred === undefined) return Promise.resolve(false)
        creds.remove(id, uid)
        creditsCache.delete(uid)
        client.forget(cred.pat)
        return Promise.resolve(true)
      },
      /** 对单个账号调一次上游。选号/冷却/换号是核心的活，这里只报结果。 */
      async chatOnce(uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult> {
        const base = stripAlias(req.model)
        if (base === '') {
          return { ok: false, state: 'no_such_model', message: `unknown model ${JSON.stringify(req.model)}` }
        }
        const cred = getCred(uid)
        if (cred === undefined) {
          return { ok: false, state: 'no_such_model', message: `unknown account ${JSON.stringify(uid)}` }
        }

        let messages: Array<Record<string, unknown>>
        let tools: unknown[] | undefined
        try {
          const body = JSON.parse(req.rawBody) as Record<string, unknown>
          const rawMessages = Array.isArray(body.messages) ? (body.messages as unknown[]) : []
          messages = rawMessages.filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
          tools = Array.isArray(body.tools) && body.tools.length > 0 ? (body.tools as unknown[]) : undefined
        } catch {
          return { ok: false, state: 'bad_request', message: '请求体不是合法 JSON' }
        }

        // 思考强度：`auto`/空 不下发（用模型自己的默认档），其余原样带给上游。
        // 上游只认它自己声明的档位（low/high/max…），传不认识的档会被拒 ——
        // 那是**这个模型**不支持该档，不是账号错，归 bad_request。
        const effort = lv === 'auto' || lv === '' || lv === 'none' || lv === 'off' ? undefined : lv

        try {
          const upstreamBody = await client.openChat(cred.pat, base, messages, {
            ...(tools === undefined ? {} : { tools }),
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
            isVl: hasImageInput(messages),
          })
          const stream = toOpenAiSse(upstreamBody, {
            model: base,
            onLateError: (error) => {
              // 流已开始，状态码发不出去了；把「这个号额度用尽 / 被限流」这条
              // 事后事实报给核心，让后续请求别再选中它。
              env.onLateFailure?.(uid, base, stateOf(error.kind), error.message)
            },
          })
          return { ok: true, stream }
        } catch (error: unknown) {
          if (isQoderError(error)) {
            // 凭据被判失效时顺手把会话丢掉：下次换号回来会重新交换，
            // 而不是继续用一份已经不被认的 cosy 会话。
            if (error.kind === 'auth') client.forget(cred.pat)
            return {
              ok: false,
              state: stateOf(error.kind),
              message: `${p.errPrefix} ${error.message}`,
            }
          }
          return { ok: false, state: 'unknown', message: (error as Error).message }
        }
      },
      /**
       * 签到：领取今天那份每日 Credits。
       *
       * 上游把它做成「活动」（campaigns），不是一个叫签到/checkin 的端点。
       * `already-claimed` 是**成功**（幂等），不是错误。
       */
      checkinNow: async (uid: string): Promise<{ ok: boolean; status: string; message?: string }> => {
        const cred = getCred(uid)
        if (cred === undefined) return { ok: false, status: 'error', message: '凭证缺失' }
        try {
          const outcome = await client.claimDailyCredits(cred.pat)
          if (outcome.status === 'claimed') {
            await refreshCredits(uid)
            const amount = outcome.amount === undefined ? '' : `+${outcome.amount} Credits`
            const days = outcome.validityDays === undefined ? '' : `（${outcome.validityDays} 天有效）`
            log(`${p.errPrefix} checkin ${uid}: claimed ${amount}`)
            return { ok: true, status: 'ok', message: `${amount}${days}` || '签到成功' }
          }
          if (outcome.status === 'already-claimed') {
            await refreshCredits(uid)
            return { ok: true, status: 'already', message: '今日已签到' }
          }
          return { ok: false, status: 'error', message: outcome.message }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          log(`${p.errPrefix} checkin ${uid}: ${message.slice(0, 160)}`)
          return { ok: false, status: 'error', message: `${p.errPrefix} ${message}` }
        }
      },
      dispose: (): void => {
        creditsCache.clear()
        creditsInflight.clear()
        modelsCache = undefined
        modelsInflight = undefined
      },
    }
  }
}

/**
 * 把用户粘进来的输入当作 PAT（容忍带 `Bearer ` 前缀或首尾空白）。
 *
 * 面板上粘贴时很容易带上从文档里复制来的 `Bearer `，那不是令牌的一部分，
 * 直接当 PAT 用只会得到一个难以理解的 401。
 */
export function normalizePat(input: string): string {
  return input.trim().replace(/^Bearer\s+/i, '').trim()
}

/** 判断一段输入看起来像不像 PAT（`pt-…`；只用于提示，不做硬校验）。 */
export function looksLikePat(input: string): boolean {
  return /^pt-[A-Za-z0-9._-]{8,}$/.test(normalizePat(input))
}
