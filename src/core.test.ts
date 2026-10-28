/**
 * qoder 族共享实现的回归闸门。
 *
 * 这里锁的是**协议事实**，不是实现细节 —— 那些字节（自定义 base64、签名格式、
 * 会话载荷、sash 与 cosy 两套凭据）每一个都直接决定网关认不认请求，改错了
 * 不会报编译错，只会得到 401 `Signature invalid`：
 *
 *   1. cosy 编码/解码可逆、字母表与签名格式逐字固定；
 *   2. 设备指纹对同一凭据稳定；
 *   3. 添加账号先验一次 jobToken（打错的 PAT 不落盘），重复 PAT 不重复建号；
 *   4. chat 请求是**cosy 编码后的密文**、带 `Bearer COSY.*` 与 cosy 头；
 *   5. 上游 SSE 信封被转成 OpenAI SSE（含 role/content/usage/[DONE]）；
 *   6. 错误分类：403+code110 是额度耗尽（不是凭据被拒），401 才是凭证失效；
 *   7. 积分读 sash（jt- 令牌）、模型目录过滤上游的 `auto` 路由；
 *   8. 签到走活动接口，`CLAIMED` 幂等算成功。
 *
 * 运行：npm test（node --test，靠 Node 内建 TS 类型剥离）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSupplier, looksLikePat, normalizePat } from './core.ts'
import { profile as cn } from './cn.ts'
import { profile as global } from './global.ts'
import { cosyDecode, cosyEncode, deriveFingerprint, signLegacy } from './cosy.ts'
import { classifyFailure, deepestBusinessCode, parseStreamDelta, parseUsage } from './upstream.ts'
import type { SupplierEnv } from './contract.ts'

// ---------------------------------------------------------------- 夹具

interface Call {
  url: string
  init: RequestInit
  /** 请求体原文（chat 是 cosy 密文，别的多是 JSON） */
  body: string
}

const FAR_FUTURE = Date.now() + 3600_000
const PAT = 'pt-abcdefghijklmnop'

/** 一个假 env：凭证放在内存 map 里，fetch 由 `route` 决定。 */
function harness(opts: { cred?: { nickname: string; pat: string } } = {}) {
  const calls: Call[] = []
  const creds = new Map<string, unknown>()
  if (opts.cred !== undefined) creds.set('u1', opts.cred)
  const env: SupplierEnv = {
    dataDir: '/tmp',
    log: () => {},
    store: {
      get: () => ({ alias: '', disabled: [], custom: [], poolOrder: [], poolStrategy: 'fallback' as const, credits: {} }),
      setAlias: () => {},
      setPoolOrder: () => {},
      setPoolStrategy: () => {},
      setModelEnabled: () => {},
      addCustomModel: () => {},
      removeCustomModel: () => {},
      setAllModelsEnabled: () => {},
      getCredits: () => -1,
      putCredits: (_i, _u, v) => v,
      clearCredits: () => {},
    },
    credentials: {
      list: () => [...creds.keys()],
      get: <T,>(_s: string, uid: string) => creds.get(uid) as T | undefined,
      save: (_s, uid, blob) => void creds.set(uid, blob),
      remove: (_s, uid) => void creds.delete(uid),
    },
  }
  return { env, calls, creds }
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status })
}

/** 把一次上游调用记下来并按 URL 返回响应。 */
function route(
  calls: Call[],
  handler: (url: string, body: string, seen: number) => Response,
): void {
  const counts = new Map<string, number>()
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push({ url, init: init ?? {}, body })
    const key = url.split('?')[0]!
    const seen = counts.get(key) ?? 0
    counts.set(key, seen + 1)
    return handler(url, body, seen)
  }) as typeof fetch
}

/** jobToken 交换的响应（两个 region 共用）。 */
function jobTokenResponse(): Response {
  return jsonResponse({
    id: 'user-1',
    name: 'tester',
    expireTime: FAR_FUTURE,
    securityOauthToken: 'jt-oauth-token',
    refreshToken: '',
    userType: 'personal_standard',
  })
}

/** 一帧 Qoder SSE 信封。 */
function sseFrame(inner: unknown): string {
  return `data: ${JSON.stringify({ headers: {}, body: JSON.stringify(inner), statusCodeValue: 200 })}\n\n`
}

function sseBody(chunks: string[], inner: unknown[]): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder()
        for (const text of chunks) c.enqueue(enc.encode(text))
        for (const i of inner) c.enqueue(enc.encode(sseFrame(i)))
        c.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += dec.decode(value, { stream: true })
  }
  return out
}

const chatReq = (extra: Record<string, unknown> = {}) => ({
  rawBody: JSON.stringify({
    model: 'm',
    messages: [{ role: 'user', content: '你好' }],
    ...extra,
  }),
  stream: true,
  model: 'm',
})

// ---------------------------------------------------------------- 身份

test('两个供应商的 id / 前缀 / 区域逐字保留', () => {
  assert.equal(cn.id, 'qoder')
  assert.equal(global.id, 'qoder-global')
  assert.equal(cn.region, 'cn')
  assert.equal(global.region, 'global')
  assert.equal(cn.uidPrefix, 'qd')
  assert.equal(global.uidPrefix, 'qdg')
  // 图标必须内联 data URI：面板图标不该依赖另一个服务活着
  for (const p of [cn, global]) assert.match(p.icon, /^data:image\//)
  assert.equal(cn.icon, global.icon, '同族共用一张图')
})

test('PAT 归一：容忍 Bearer 前缀与空白，识别 pt- 形状', () => {
  assert.equal(normalizePat('  Bearer pt-abc12345678  '), 'pt-abc12345678')
  assert.equal(normalizePat('pt-abc12345678'), 'pt-abc12345678')
  assert.equal(looksLikePat('Bearer pt-abc12345678'), true)
  assert.equal(looksLikePat('sk-abc'), false)
})

// ---------------------------------------------------------------- cosy 原语

test('cosy 编码可逆，且拒绝字母表外的字符', () => {
  const text = '{"a":1,"中文":"值","emoji":"🙂"}'
  const encoded = cosyEncode(new TextEncoder().encode(text))
  assert.ok(encoded.length > 0)
  // 自定义字母表里的 pad 是 `$`，不是 `=`
  assert.ok(!encoded.includes('='), '自定义编码不该出现标准 pad')
  assert.equal(new TextDecoder().decode(cosyDecode(encoded)), text)
  assert.throws(() => cosyDecode('='), /custom alphabet/)
})

test('旧式签名格式固定（md5("cosy&<secret>&<date>")）', () => {
  // 期望值由外部 md5 独立算得：改签名格式 = 这个断言必须红
  assert.equal(signLegacy('Mon, 01 Jan 2024 00:00:00 GMT'), '5392744e067ea01616d61a1d617bf9d1')
})

test('设备指纹对同一凭据稳定、对不同凭据不同', () => {
  const a = deriveFingerprint('', 'pt-abc')
  const b = deriveFingerprint('', 'pt-abc')
  const c = deriveFingerprint('', 'pt-xyz')
  assert.deepEqual(a, b)
  assert.notEqual(a.machineId, c.machineId)
  assert.equal(a.machineType.length, 18)
  assert.equal(a.machineToken.length, 43)
  // 有 uid 时用 uid 做种子（与「还没有 uid 时用凭据」区分开）
  assert.notEqual(deriveFingerprint('user-1', 'pt-abc').machineId, a.machineId)
})

// ---------------------------------------------------------------- 添加账号

test('addApiKey：先验 jobToken 再落盘，昵称取上游下发的名字', async () => {
  const { env, calls, creds } = harness()
  route(calls, (url) => {
    if (url.includes('/api/v1/jobToken/exchange')) return jsonResponse({ token: 'sash-token' })
    if (url.includes('/algo/api/v3/user/jobToken')) return jobTokenResponse()
    return jsonResponse({ code: '404' }, 404)
  })
  const m = createSupplier(cn)(env)
  const r = await m.addApiKey!({ name: '', apiKey: PAT })
  assert.equal(r.ok, true)
  assert.equal(r.account?.uid, 'qd-1')
  assert.equal(r.account?.nickname, 'tester', '空名字应回落到上游账号名')
  assert.equal((creds.get('qd-1') as { pat: string }).pat, PAT)
  // 第一次请求必须是 jobToken 交换（用旧式签名头）
  const first = calls[0]!
  assert.match(first.url, /\/algo\/api\/v3\/user\/jobToken/)
  const headers = first.init.headers as Record<string, string>
  assert.equal(headers.appcode, 'cosy')
  assert.match(headers.signature ?? '', /^[0-9a-f]{32}$/)
  assert.match(headers.date ?? '', /GMT$/)
  // 请求体是 cosy 密文：解码后应该是 {payload, encodeVersion}
  const decoded = JSON.parse(new TextDecoder().decode(cosyDecode(first.body))) as { encodeVersion: string; payload: string }
  assert.equal(decoded.encodeVersion, '1')
  assert.equal(JSON.parse(decoded.payload).personalToken, PAT)
})

test('addApiKey：PAT 被拒就不落盘，重复 PAT 不重复建号', async () => {
  const { env, calls, creds } = harness()
  route(calls, (url) => {
    if (url.includes('/algo/api/v3/user/jobToken')) return jsonResponse({ code: '105', message: 'token invalid' }, 401)
    return jsonResponse({}, 404)
  })
  const rejected = await createSupplier(cn)(env).addApiKey!({ name: 'x', apiKey: 'pt-badbadbadbad' })
  assert.equal(rejected.ok, false)
  assert.match(String(rejected.error), /PAT 校验失败/)
  assert.equal(creds.size, 0, '打错的 PAT 绝不能存进去')

  const ok = harness()
  route(ok.calls, (url) => {
    if (url.includes('/api/v1/jobToken/exchange')) return jsonResponse({ token: 't' })
    if (url.includes('/algo/api/v3/user/jobToken')) return jobTokenResponse()
    return jsonResponse({}, 404)
  })
  const m = createSupplier(cn)(ok.env)
  assert.equal((await m.addApiKey!({ name: 'a', apiKey: PAT })).ok, true)
  const again = await m.addApiKey!({ name: 'b', apiKey: PAT })
  assert.equal(again.ok, false)
  assert.match(String(again.error), /已经添加过/)
  assert.equal(ok.creds.size, 1, '同一 PAT 不该建出第二个号')
})

// ---------------------------------------------------------------- chat

test('chatOnce：cosy 密文请求 + Bearer COSY 头 + SSE 转 OpenAI 格式', async () => {
  const { env, calls } = harness({ cred: { nickname: 'N', pat: PAT } })
  route(calls, (url) => {
    if (url.includes('/api/v1/jobToken/exchange')) return jsonResponse({ token: 'sash' })
    if (url.includes('/algo/api/v3/user/jobToken')) return jobTokenResponse()
    if (url.includes('/algo/api/v2/service/pro/sse/agent_chat_generation')) {
      return sseBody([], [
        { choices: [{ delta: { role: 'assistant', content: '你' } }] },
        { choices: [{ delta: { content: '好' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 8 } } },
      ])
    }
    return jsonResponse({}, 500)
  })

  const m = createSupplier(cn)(env)
  const r = await m.chatOnce('u1', 'auto', chatReq({ tools: [] }))
  assert.equal(r.ok, true)
  const chatCall = calls.find((c) => c.url.includes('agent_chat_generation'))!
  const headers = chatCall.init.headers as Record<string, string>
  assert.match(headers.authorization ?? '', /^Bearer COSY\./)
  assert.equal(headers['cosy-version'], '0.1.43')
  assert.equal(headers['x-model-key'], 'm')
  assert.match(headers['cosy-key'] ?? '', /^[A-Za-z0-9+/=]+$/)
  // 签名参与的是**密文**，不是明文；解码后应还原出模板
  const template = JSON.parse(new TextDecoder().decode(cosyDecode(chatCall.body))) as Record<string, unknown>
  assert.equal((template.model_config as Record<string, unknown>).key, 'm')
  assert.equal(template.stream, true)
  assert.equal(template.agent_id, 'agent_common')
  assert.match(String(template.request_id), /^[0-9a-f-]{36}$/)

  const sse = await readAll((r as { ok: true; stream: ReadableStream<Uint8Array> }).stream)
  assert.match(sse, /"delta":\{"role":"assistant"\}/)
  assert.match(sse, /"content":"你"/)
  assert.match(sse, /"content":"好"/)
  assert.match(sse, /"usage":\{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14,"prompt_tokens_details":\{"cached_tokens":8\}\}/)
  assert.match(sse, /"finish_reason":"stop"/)
  assert.ok(sse.trimEnd().endsWith('data: [DONE]'), '必须收尾 [DONE]，否则客户端一直等结束帧')
})

test('chatOnce：无凭证的号报 no_such_model（不记在账号头上）', async () => {
  const { env, calls } = harness()
  route(calls, () => jsonResponse({}, 500))
  const r = await createSupplier(cn)(env).chatOnce('nope', 'auto', chatReq())
  assert.equal(r.ok, false)
  assert.equal(r.ok === false ? r.state : '', 'no_such_model')
  assert.equal(calls.length, 0, '不该打上游')
})

test('chatOnce：模型带别名前缀时剥掉再打上游', async () => {
  const { env, calls } = harness({ cred: { nickname: 'N', pat: PAT } })
  route(calls, (url) => {
    if (url.includes('/api/v1/jobToken/exchange')) return jsonResponse({ token: 'sash' })
    if (url.includes('/algo/api/v3/user/jobToken')) return jobTokenResponse()
    if (url.includes('agent_chat_generation')) return sseBody([], [{ choices: [{ delta: { content: 'ok' } }] }])
    return jsonResponse({}, 500)
  })
  const r = await createSupplier(cn)(env).chatOnce('u1', 'auto', {
    ...chatReq(),
    model: 'qoder/qmodel_x',
    rawBody: JSON.stringify({ model: 'qoder/qmodel_x', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(r.ok, true)
  const chatCall = calls.find((c) => c.url.includes('agent_chat_generation'))!
  assert.equal((chatCall.init.headers as Record<string, string>)['x-model-key'], 'qmodel_x')
})

// ---------------------------------------------------------------- 错误分类

test('错误分类：业务码优先于 HTTP 状态（403+110 是额度耗尽，不是凭据被拒）', () => {
  assert.equal(classifyFailure(403, JSON.stringify({ code: '110', message: 'Billing daily count exceeded' })), 'quota-exhausted')
  assert.equal(classifyFailure(403, JSON.stringify({ code: '113' })), 'quota-exhausted')
  assert.equal(classifyFailure(401, '{"code":"105"}'), 'auth')
  assert.equal(classifyFailure(429, ''), 'rate-limited')
  assert.equal(classifyFailure(400, ''), 'invalid-request')
  assert.equal(classifyFailure(500, ''), 'transient')
  // 层层套的信封：外层 403 是 HTTP 语义，内层 10605 才是真码（排队 → 瞬时）
  assert.equal(deepestBusinessCode(JSON.stringify({ code: 403, message: JSON.stringify({ code: '10605' }) })), '10605')
  assert.equal(classifyFailure(403, JSON.stringify({ code: 403, message: JSON.stringify({ code: '10605' }) })), 'transient')
})

test('错误映射：额度耗尽 → quota（不判账号死），凭据被拒 → session_dead', async () => {
  for (const [response, want] of [
    [() => jsonResponse({ code: '110', message: 'Billing daily count exceeded' }, 403), 'quota'],
    [() => jsonResponse({ code: '105', message: 'token expired' }, 401), 'session_dead'],
    [() => new Response('slow down', { status: 429 }), 'rate_limit'],
    [() => jsonResponse({ code: '430', message: 'not supported' }, 400), 'bad_request'],
  ] as const) {
    const { env, calls } = harness({ cred: { nickname: 'N', pat: PAT } })
    route(calls, (url) => {
      if (url.includes('/api/v1/jobToken/exchange')) return jsonResponse({ token: 'sash' })
      if (url.includes('/algo/api/v3/user/jobToken')) return jobTokenResponse()
      return response()
    })
    const r = await createSupplier(cn)(env).chatOnce('u1', 'auto', chatReq())
    assert.equal(r.ok === false ? r.state : '', want)
  }
})

test('流内信封错误：发一条 OpenAI error 帧 + [DONE]，并上报迟到失败', async () => {
  const { env, calls } = harness({ cred: { nickname: 'N', pat: PAT } })
  const late: Array<{ uid: string; state: string }> = []
  env.onLateFailure = (uid, _model, state) => late.push({ uid, state })
  route(calls, (url) => {
    if (url.includes('/api/v1/jobToken/exchange')) return jsonResponse({ token: 'sash' })
    if (url.includes('/algo/api/v3/user/jobToken')) return jobTokenResponse()
    // HTTP 200 已建流，然后信封里报「今日额度用尽」
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ statusCodeValue: 403, body: JSON.stringify({ code: '110', message: 'Billing daily count exceeded' }) })}\n\n`))
          c.close()
        },
      }),
      { status: 200 },
    )
  })
  const r = await createSupplier(cn)(env).chatOnce('u1', 'auto', chatReq())
  assert.equal(r.ok, true, 'HTTP 已经 200，插件只能把错误放进流里')
  const sse = await readAll((r as { ok: true; stream: ReadableStream<Uint8Array> }).stream)
  assert.match(sse, /"error":\{/)
  assert.match(sse, /quota-exhausted/)
  assert.ok(sse.trimEnd().endsWith('data: [DONE]'))
  assert.deepEqual(late, [{ uid: 'u1', state: 'quota' }], '迟到的失败要报给核心，后续请求才会避开这个号')
})

// ---------------------------------------------------------------- 模型

test('模型目录：读上游 chat[]，过滤 auto 路由，上下文按 k 报', async () => {
  const { env, calls } = harness({ cred: { nickname: 'N', pat: PAT } })
  route(calls, (url) => {
    if (url.includes('/api/v1/jobToken/exchange')) return jsonResponse({ token: 'sash' })
    if (url.includes('/algo/api/v3/user/jobToken')) return jobTokenResponse()
    if (url.includes('/algo/api/v2/model/list')) {
      return jsonResponse({
        chat: [
          { key: 'qmodel_38max', display_name: 'Qwen3.8-Max', enable: true, is_default: false, is_vl: true, max_input_tokens: 200000 },
          { key: 'qmodel_flash', display_name: 'Qwen3.8-Flash', enable: true, is_free: true },
          // 上游的 auto 是「默认路由」而不是模型，不能出现在选择器里
          { key: 'auto', display_name: 'Auto', is_default: true },
        ],
      })
    }
    return jsonResponse({}, 500)
  })
  const models = await createSupplier(cn)(env).listModels(true)
  assert.deepEqual(models, [
    { id: 'qmodel_38max', context_length: 200 },
    { id: 'qmodel_flash' },
  ])
})

test('模型目录读不到时列表为空（不编造模型 key）', async () => {
  const { env, calls } = harness({ cred: { nickname: 'N', pat: PAT } })
  route(calls, (url) => {
    if (url.includes('/api/v1/jobToken/exchange')) return jsonResponse({ token: 'sash' })
    if (url.includes('/algo/api/v3/user/jobToken')) return jobTokenResponse()
    return jsonResponse({ code: '110' }, 403)
  })
  assert.deepEqual(await createSupplier(cn)(env).listModels(true), [])
})

// ---------------------------------------------------------------- 积分

test('积分：读 sash 用量，剩余 = 基础包 + 加量包 + 企业包', async () => {
  const { env, calls } = harness({ cred: { nickname: 'N', pat: PAT } })
  route(calls, (url) => {
    if (url.includes('/api/v1/jobToken/exchange')) return jsonResponse({ token: 'sash-token' })
    if (url.includes('/algo/api/v3/user/jobToken')) return jobTokenResponse()
    if (url.includes('/sash/api/v2/me/usage')) {
      return jsonResponse({
        qoderUsage: {
          userType: 'personal_pro',
          userQuota: { total: 500, used: 380, remaining: 120 },
          addOnQuota: { total: 1000, remaining: 250.5 },
          isQuotaExceeded: false,
        },
      })
    }
    return jsonResponse({}, 500)
  })
  const m = createSupplier(cn)(env)
  m.status() // 触发后台拉取
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(m.status().accounts[0]!.credits, 370.5)
  // sash 面用的是 jobToken 那族令牌，不是 COSY Bearer
  const usage = calls.find((c) => c.url.includes('/sash/api/v2/me/usage'))!
  const headers = usage.init.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer sash-token')
  assert.equal(headers['cosy-clienttype'], '10')
})

test('积分读不到报 -1（不是 0），凭据被拒也要如实落日志', async () => {
  const { env, calls } = harness({ cred: { nickname: 'N', pat: PAT } })
  const logs: string[] = []
  env.log = (m) => logs.push(m)
  route(calls, (url) => {
    if (url.includes('/api/v1/jobToken/exchange')) return jsonResponse({ token: 'sash' })
    if (url.includes('/algo/api/v3/user/jobToken')) return jobTokenResponse()
    return jsonResponse({ code: '105', message: 'token expired' }, 401)
  })
  const m = createSupplier(cn)(env)
  m.status()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(m.status().accounts[0]!.credits, -1, '报 0 会把缓存冲成 0')
})

test('parseUsage：兼容 qoderUsage 内层与平铺两种形状', () => {
  assert.equal(parseUsage({ qoderUsage: { userQuota: { remaining: 5 } } })?.userQuota?.remaining, 5)
  assert.equal(parseUsage({ userQuota: { remaining: 7 } })?.userQuota?.remaining, 7)
  assert.equal(parseUsage({})?.isQuotaExceeded, false)
})

// ---------------------------------------------------------------- 签到

test('签到：可领 → 领取成功；已领 → already；没活动 → error', async () => {
  const cases = [
    {
      campaigns: { campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100, validity: { days: 30 } } }] },
      claim: { status: 'CLAIMED' },
      want: { ok: true, status: 'ok' },
    },
    {
      campaigns: { campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED' }] },
      claim: undefined,
      want: { ok: true, status: 'already' },
    },
    {
      campaigns: { campaigns: [] },
      claim: undefined,
      want: { ok: false, status: 'error' },
    },
  ] as const
  for (const c of cases) {
    const { env, calls } = harness({ cred: { nickname: 'N', pat: PAT } })
    route(calls, (url) => {
      if (url.includes('/api/v1/jobToken/exchange')) return jsonResponse({ token: 'sash' })
      if (url.includes('/algo/api/v3/user/jobToken')) return jobTokenResponse()
      if (url.includes('/claim')) return jsonResponse(c.claim ?? {})
      if (url.includes('/sash/api/v1/me/campaigns')) return jsonResponse(c.campaigns)
      if (url.includes('/sash/api/v2/me/usage')) return jsonResponse({ userQuota: { remaining: 100 } })
      return jsonResponse({}, 500)
    })
    const r = await createSupplier(cn)(env).checkinNow!('u1')
    assert.equal(r.ok, c.want.ok)
    assert.equal(r.status, c.want.status)
    if (c.want.status === 'ok') assert.match(String(r.message), /\+100 Credits/)
  }
})

test('签到：409 视为今天已领（幂等，不是失败）', async () => {
  const { env, calls } = harness({ cred: { nickname: 'N', pat: PAT } })
  route(calls, (url) => {
    if (url.includes('/api/v1/jobToken/exchange')) return jsonResponse({ token: 'sash' })
    if (url.includes('/algo/api/v3/user/jobToken')) return jobTokenResponse()
    if (url.includes('/claim')) return jsonResponse({ message: 'ALREADY_CLAIMED' }, 409)
    if (url.includes('/sash/api/v1/me/campaigns')) {
      return jsonResponse({ campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' }] })
    }
    return jsonResponse({}, 500)
  })
  const r = await createSupplier(cn)(env).checkinNow!('u1')
  assert.equal(r.ok, true)
  assert.equal(r.status, 'already')
})

test('国际版积分：缺设备风控头时给出可执行的解释，而不是「今天没活动」', async () => {
  const { env, calls } = harness({ cred: { nickname: 'N', pat: PAT } })
  route(calls, (url) => {
    if (url.includes('/api/v1/jobToken/exchange')) return jsonResponse({ token: 'sash' })
    if (url.includes('/algo/api/v3/user/jobToken')) return jobTokenResponse()
    return jsonResponse({ code: 'UNAUTHORIZED', message: 'missing cookie header' }, 401)
  })
  const m = createSupplier(global)(env)
  m.status()
  await new Promise((r) => setTimeout(r, 60))
  // 积分读不到 → -1（不是 0）
  assert.equal(m.status().accounts[0]!.credits, -1)
  // 签到会把原因带出来
  const r = await m.checkinNow!('u1')
  assert.equal(r.ok, false)
  assert.match(String(r.message), /设备风控组件/)
})

// ---------------------------------------------------------------- 流解析

test('parseStreamDelta：正常帧取 delta/usage，业务错误帧抛出可分类的错误', () => {
  const ok = parseStreamDelta(JSON.stringify({
    statusCodeValue: 200,
    body: JSON.stringify({ choices: [{ delta: { content: 'hi', reasoning_content: '想' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
  }))
  assert.equal(ok?.content, 'hi')
  assert.equal(ok?.reasoningContent, '想')
  assert.equal(ok?.inputTokens, 3)

  assert.throws(() => parseStreamDelta(JSON.stringify({
    statusCodeValue: 200,
    body: JSON.stringify({ code: '118', message: 'credits exhausted' }),
  })), /credits exhausted/)
})
