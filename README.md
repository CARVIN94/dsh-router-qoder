<h1 align="center">dsh-router-qoder</h1>

<p align="center">dsh-router 的 Qoder 族供应商插件（国内版 + 国际版）</p>

为 [dsh-router](https://github.com/CARVIN94/dsh-router) 提供 **Qoder**（阿里 AI 编码平台）
的**两个**供应商（PAT 认证，cosy 签名网关）。单独装它没用——它只是向核心注册供应商，
面板、账号池、组合回退、模型管理都在核心里。

## 两个供应商

| 供应商 id | 面板名 | 网关 | openapi | uid 前缀 |
|---|---|---|---|---|
| `qoder` | Qoder | `gateway.qoder.com.cn` | `openapi.qoder.com.cn` | `qd` |
| `qoder-global` | Qoder Global | `api1.qoder.sh` | `openapi.qoder.sh` | `qdg` |

两个区域**同协议同契约**（cosy 签名、jobToken 交换、同一套 chat/models 端点），
所以共用同一份实现（`src/core.ts`），差异只在 `src/cn.ts` / `src/global.ts` 的
profile 与 `QODER_REGIONS` 的主机表。

```
src/
  core.ts       共享实现 —— 供应商契约、账号/积分缓存、chatOnce、签到、addApiKey
  cosy.ts       cosy 协议原语 —— 自定义 base64、请求签名、RSA/AES 会话、设备指纹
  messages.ts   OpenAI 请求 → Qoder 请求体（模板 + 消息/工具转换）
  upstream.ts   Qoder HTTP 客户端 —— jobToken 交换、模型目录、SSE 聊天、用量、活动/领取
  sse.ts        Qoder SSE → OpenAI SSE（核心只接受 OpenAI 格式的字节）
  cn.ts         qoder profile
  global.ts     qoder-global profile
  index.ts      插件入口（host 半，一次注册两个供应商）
  contract.ts   供应商契约（自含，与 dsh-router 契约同步，含 addApiKey/apiKeyHint）
  types.ts      通用类型
cordis.patch.yml  bundle patch，把插件插入 DSH cordis bundle stack
```

## 与 CodeBuddy 族最大的两处不同

1. **认证是 PAT，不是 OAuth。** 粘贴一个 `pt-…` 就完事，没有浏览器登录、没有回调、
   没有 refresh token。所以本插件实现的是契约里的 `addApiKey` 那条路，不是
   `generateLoginUrl`/`completeLogin`。添加时会**真的交换一次 jobToken** 校验——
   打错一个字符的 PAT 不会存进去。
2. **上游不是 OpenAI 兼容端点。** Qoder 官方没有 OpenAI 兼容接口，chat 直连它的
   `agent_chat_generation`：请求体是私有模板 + cosy 编码加密，响应是「信封套一层
   OpenAI 形状」的 SSE。`sse.ts` 把这层拆开重新包成 OpenAI SSE 交给核心。

## 能力

| 能力 | 说明 |
|---|---|
| 添加账号（PAT） | 弹窗粘贴 `pt-…`。先交换 jobToken 校验，成功才落盘，昵称取上游下发的账号名；同一 PAT 不会重复建号。 |
| 模型列表 | 「获取模型」从 `GET /algo/api/v2/model/list` 实时拉取。**上游的 `auto` 不列出来**：它是该区的默认路由（请求时才决定解析成哪个模型），不是可描述的模型。没有 PAT 时列表为空——这是正确状态，不是故障。 |
| 对话 | 直连 cosy 网关：请求体走 Qoder 私有模板（`chat_context`/`model_config`/`business`/`session_id`），body 经自定义 base64 加密后参与签名；响应 SSE 转成 OpenAI SSE（含 `reasoning_content`、`tool_calls`、`usage`、`[DONE]`）。 |
| 思考强度 | 核心给的推理等级按上游约定的**两处同时写**（顶层 `reasoningEffort` + `parameters.reasoning_effort`）——官方客户端如此，只写一个可能被某个区域忽略。 |
| 积分显示 | 面板账号积分 = `sash/api/v2/me/usage` 的剩余量（基础包 + 加量包 + 企业包），内存缓存 10 分钟。读不到报 `-1`（不是 0），核心据此保留上次持久化的值。 |
| 每日签到 | 走**活动**接口（`/sash/api/v1/me/campaigns` → `…/{id}/claim`），路径里没有「签到」二字。`CLAIMED` 与 409 都算「今日已领」（幂等，不是失败）；上游没下发活动时如实说明。 |
| 多账号池 | 核心按池顺序/策略选号回退，本插件只报单个账号的成败与语义状态。 |

## 错误分类（一个重要细节）

**业务码优先于 HTTP 状态**。Qoder 对「当日用量用尽」回的是
`HTTP 403 {"code":"110","Billing daily count exceeded"}` —— 只看状态会判成
「凭据被拒」，于是「今天用满、明天自愈」的号会被要求换 PAT。所以：

| 上游 | 归类 | 后果 |
|---|---|---|
| `code 110/113/115-119/122`（额度族） | `quota` | 不判账号死，等周期重置 |
| `code 105` / `HTTP 401` | `session_dead` | 凭据失效，需要换 PAT |
| `HTTP 429` | `rate_limit` | 短冷换号 |
| `code 406` / 内容审核标记 | `bad_request` | 请求级，不惩罚账号 |
| `code 416/430/80411/80412` | `bad_request` | 请求形态问题 |
| `code 500/10408/10500/10605` | `rate_limit` | 瞬时（排队/超时），换号确实管用 |

失败帧会层层套（外层 `403` + 内层 `10605`），所以取码是**下钻到最深一层认识的码**，
只剥一层会把「排队一分钟」判成「凭据被拒」。

流已经写出字节之后上游才报错（HTTP 200 信封里带业务码）时，插件发一条 OpenAI 形状
的 `error` 帧 + `[DONE]`，并通过 `onLateFailure` 把「这个号额度用尽」报给核心——
后续请求才会避开它。

## 已知限制

- **国际版的积分与签到需要本机 Qoder 客户端的设备风控组件**（`Cosy-Machine*` 三件套，
  由 UMID 组件生成）。本插件**不伪造**它：拿不到时如实报「该区域需要设备组件」，
  而不是显示「今天没有活动」。国际版的**聊天与模型列表不受影响**（走 cosy 面）。
- **没有真实 PAT 做过端到端联调**：本插件的协议来自社区实测记录
  （见下方「协议来源」）。单测覆盖了编码/签名/请求构造/SSE 转换/错误分类/签到状态机，
  但「某个具体 PAT 能不能通」需要你本机试。第一次失败建议看 `dsh web` 日志里
  `qoder` 前缀那几行——它会带上游原文。

## 快速安装

需要 **DSH `0.2.0` 及以上**。先装核心，再装本插件，然后**重启 `dsh web`**：

```bash
dsh plugin --profile web add dsh-router-core
dsh plugin --profile web add dsh-router-qoder
```

`dsh plugin add` 会在 profile 里 `pnpm add`，并自动把声明了 `dsh.bundle.patch`
的包加入 `dsh.profile.bundles`（本插件即声明了，即 `cordis.patch.yml`）。

> 本地开发版：不用 npm，直接 `dependencies` 加
> `"dsh-router-qoder": "link:/path/to/dsh-router-qoder"` 指向本地仓库。

## 使用

1. 重启 `dsh web`
2. 面板 → 供应商 → Qoder / Qoder Global 卡片 → 添加 API key → 粘贴 PAT
3. 点「获取模型」从上游拉目录，勾选要用的模型
4. 请求模型可写 `qmodel_xxx` 或带别名前缀 `qoder/qmodel_xxx`（插件自动剥前缀）

## 上游

**国内版**（`https://gateway.qoder.com.cn` + `https://openapi.qoder.com.cn`）：

- **chat**：`POST /algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
- **模型**：`GET /algo/api/v2/model/list?Encode=1`
- **jobToken**：`POST /algo/api/v3/user/jobToken?Encode=1`（旧式签名：`date` + `signature`）
- **sash 令牌**：`POST /api/v1/jobToken/exchange`（`{personal_token}` → `token`）
- **用量**：`GET /sash/api/v2/me/usage`（sash 面，`Bearer <jt-…>`）
- **签到**：`GET /sash/api/v1/me/campaigns?forceRefresh=true` → `POST …/{campaignId}/claim`
- 凭证：`auths/qoder/{uid}.json`（`{nickname, pat, userId}`）

**国际版**（`https://api1.qoder.sh` + `https://openapi.qoder.sh`）—— 路径逐字相同，
差异只有一个：sash 面需要设备风控头（见「已知限制」）。

## 与核心的分工

本插件只管**对单个账号调通上游**：PAT 校验、cosy 会话、chat、模型目录、积分、签到。

**策略全在核心**（`AccountPool`）：选号、冷却、禁用、连续错误累计、遍历回退、响应写入。
`chatOnce(uid, lv, req)` 一次只服务一个账号，**不遍历账号、不维护冷却表、不写响应**。

## 协议来源

cosy 协议的实现来自以下 MIT 项目的实测记录（本仓库的 `src/cosy.ts` /
`src/messages.ts` 移植自第一项，并按本项目风格重写、加注）：

- [dingminhua/dsh-connect-qoder](https://github.com/dingminhua/dsh-connect-qoder)（MIT）
- fengyinxia/qoder2api（MIT）—— PAT→jobToken、cosy 签名、自定义 base64、RSA/AES 会话
- x_Zhengyuuuui/qoder2api（Go，MIT）—— 同一协议 + 指纹派生 + 双区域端点
- @qoder-ai/qoder-agent-sdk 的 `.d.ts` —— 模型/用量字段的官方命名

## License

MIT
