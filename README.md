<h1 align="center">dsh-router-qoder</h1>

<p align="center">dsh-router 的 Qoder 族供应商插件（国内版 + 国际版）</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-router-qoder"><img src="https://img.shields.io/npm/v/dsh-router-qoder?style=flat-square&logo=npm&label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-10b981?style=flat-square" alt="MIT license"></a>
  <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="支持的 DSH 版本：0.2.0+" src="https://img.shields.io/badge/DSH-0.2.0%2B-4d6bfe" /></a>
</p>

<p align="center">
  <a href="#快速安装">快速安装</a> ·
  <a href="#两个供应商">两个供应商</a> ·
  <a href="#取-pat">取 PAT</a> ·
  <a href="#能力">能力</a> ·
  <a href="https://github.com/CARVIN94/dsh-router#readme">dsh-router 核心</a>
</p>

为 [dsh-router](https://github.com/CARVIN94/dsh-router) 提供 **Qoder**（阿里 AI 编码平台）的
**两个**供应商（PAT 认证，cosy 签名网关）。单独装它没用——它只是向核心注册供应商，
面板、账号池、组合回退、模型管理都在核心里。

## 两个供应商

| 供应商 id | 面板名 | 网关 | openapi | uid 前缀 |
|---|---|---|---|---|
| `qoder` | Qoder | `gateway.qoder.com.cn` | `openapi.qoder.com.cn` | `qd` |
| `qoder-global` | Qoder Global | `api1.qoder.sh` | `openapi.qoder.sh` | `qdg` |

两个区域**同协议同契约**（cosy 签名、jobToken 交换、同一套 chat/models 端点），
所以共用同一份实现（`src/core.ts`），差异只在 `src/cn.ts` / `src/global.ts` 的
profile 与 `QODER_REGIONS` 的主机表。

两个 id **同时是凭证与配置的存储键**（`credentials.sqlite` 的 `supplier` 列、
`supplier-config.json` 的键）——改 id = 已添加的账号全部消失。

```
src/
  core.ts       共享实现 —— 供应商契约、账号/积分缓存、chatOnce、签到、addApiKey
  cosy.ts       cosy 协议原语 —— 自定义 base64、请求签名、RSA/AES 会话、设备指纹
  messages.ts   OpenAI 请求 → Qoder 请求体（模板 + 消息/工具转换）
  upstream.ts   Qoder HTTP 客户端 —— jobToken 交换、模型目录、SSE 聊天、用量、活动/领取
  sse.ts        Qoder SSE → OpenAI SSE（核心只接受 OpenAI 格式的字节）
  cn.ts         qoder profile（区域、图标、uid 前缀、弹窗提示文案）
  global.ts     qoder-global profile
  icon.ts       内联 SVG data URI（面板图标不依赖另一个服务活着）
  index.ts      插件入口（host 半，一次注册两个供应商）
  contract.ts   供应商契约（自含，与 dsh-router 契约同步，含 addApiKey/apiKeyHint）
  types.ts      通用类型
cordis.patch.yml  bundle patch，把插件插入 DSH cordis bundle stack
```

## 与 CodeBuddy 族的两处不同

1. **认证是 PAT，不是 OAuth。** 粘贴一个 `pt-…` 就完事，没有浏览器登录、没有回调、
   没有 refresh token。所以本插件实现的是契约里的 `addApiKey` 那条路，不是
   `generateLoginUrl`/`completeLogin`。添加时会**真的交换一次 jobToken** 校验——
   打错一个字符的 PAT 不会存进去。
2. **上游不是 OpenAI 兼容端点。** Qoder 官方没有 OpenAI 兼容接口，chat 直连它的
   `agent_chat_generation`：请求体是私有模板 + cosy 编码加密，响应是「信封套一层
   OpenAI 形状」的 SSE。`sse.ts` 把这层拆开重新包成 OpenAI SSE 交给核心。

## 快速安装

需要 **DSH `0.2.0` 及以上**。先装核心，再装本插件，然后**重启 `dsh web`**：

```bash
dsh plugin --profile web add dsh-router-core
dsh plugin --profile web add dsh-router-qoder
```

`dsh plugin add` 会在 profile 里 `pnpm add`，并自动把声明了 `dsh.bundle.patch`
的包加入 `dsh.profile.bundles`（本插件即声明了，即 `cordis.patch.yml`）。

> 本地开发版：不用 npm，直接 `dependencies` 加
> `"dsh-router-qoder": "link:/path/to/dsh-router-qoder"` 指向本地仓库
> （本机 profile 就是这么装的，改完 `pnpm build` 再重启 `dsh web` 即生效）。

重启后本插件以 cordis service `router.suppliers` 向 dsh-router 注册两个供应商，
面板「供应商」出现 **Qoder** 与 **Qoder Global** 两张卡片。

## 能力

| 能力 | 说明 |
|---|---|
| 添加账号（PAT） | 弹窗粘贴 `pt-…`。先交换 jobToken 校验，成功才落盘，昵称取上游下发的账号名；同一 PAT 不会重复建号。粘贴时带 `Bearer ` 前缀也能识别（会被剥掉）。 |
| 模型列表 | 「获取模型」从 `GET /algo/api/v2/model/list` 实时拉取。**面板显示上游的 `display_name`、请求仍用上游 key**（对照表见[使用](#使用)）。上游的 `auto` 不列出来：它是该区的默认路由（请求时才决定解析成哪个模型），不是可描述的模型。没有 PAT 时列表为空——这是正确状态，不是故障。 |
| 对话 | 直连 cosy 网关：请求体走 Qoder 私有模板（`chat_context`/`model_config`/`business`/`session_id`），body 经自定义 base64 加密后参与签名；响应 SSE 转成 OpenAI SSE（含 `reasoning_content`、`tool_calls`、`usage`、`[DONE]`）。`usage` 里的 `prompt_tokens_details.cached_tokens` 原样透传，宿主的缓存命中率因此是真实读数。 |
| 图文输入 | 请求里出现 `image_url` / `input_image` 时把 `model_config.is_vl` 置真，否则置假——图片能力按**这次请求**决定，不靠一张静态能力表。 |
| 思考强度 | 核心给的推理等级按上游约定的**两处同时写**（顶层 `reasoningEffort` + `parameters.reasoning_effort`）——官方客户端如此，只写一个可能被某个区域忽略。`auto`/空/`none`/`off` 一律不下发，用模型自己的默认档。 |
| 积分显示 | 面板账号积分 = `sash/api/v2/me/usage` 的剩余量（基础包 `userQuota` + 加量包 `addOnQuota` + 企业包 `orgResourcePackage` 的 `remaining` 求和），内存缓存 10 分钟。读不到报 `-1`（不是 0），核心据此保留上次持久化的值。 |
| 每日签到 | 走**活动**接口（`/sash/api/v1/me/campaigns` → `…/{id}/claim`），路径里没有「签到」二字。`CLAIMED` 与 409 都算「今日已领」（幂等，不是失败）；上游今日没下发可领活动时如实说明。 |
| 多账号池 | 核心按池顺序/策略选号回退，本插件只报单个账号的成败与语义状态。 |

## 取 PAT

本插件只认 **PAT**（Personal Access Token，`pt-` 开头）。两个区域**各签发一份、互不通用**：

| 用哪个卡片 | 控制台 | 入口 |
|---|---|---|
| Qoder（国内版） | [qoder.cn](https://qoder.cn)（同 `qoder.com.cn`） | 设置 → **个人访问令牌**（旧页面/旧文档写作「API 令牌」）→ 创建令牌 |
| Qoder Global（国际版） | [qoder.com](https://qoder.com) | Settings → **Personal Access Tokens** → Create token |

创建时填名称（只是给你自己看的备注），有效期按需选；**完整令牌只在创建那一刻显示一次**，
当场复制。漏了就只能删掉重建。

官方原文（令牌格式与作用域说明）：

- 国内版：[docs.qoder.cn · 认证](https://docs.qoder.cn/cloud-agents/api-authentication.md)
- 国际版：[docs.qoder.com · Authentication](https://docs.qoder.com/cloud-agents/api/conventions/authentication)

三件容易踩的事：

- **国际版的控制台不是 `qoder.sh`**。那只是网关与开放 API 的主机名（`api1.qoder.sh` /
  `openapi.qoder.sh`），没有网页控制台，域名本身也不解析。发 PAT 的是 `qoder.com`。
- **区域对不上一定被拒**：国内版的 `pt-…` 贴进国际版卡片（或反之）交换 jobToken 就失败，
  这不是插件坏了、也不是令牌过期。
- **别把令牌提交进仓库或贴进 issue**：它等价于你的账号权限，谁拿到都能以你的身份调接口。

## 使用

1. 重启 `dsh web`
2. 面板 → 供应商 → Qoder / Qoder Global 卡片 → 添加 API key → 粘贴 PAT
   （从哪个入口拿见上一节）
3. 点「获取模型」从上游拉目录，勾选要用的模型
4. 请求模型可写 `qmodel_38max`，或带别名前缀 `qoder/qmodel_38max`（插件自动剥前缀）

> **模型名：显示用名字，请求用 key。** 上游的 key 是内部标识（`qmodel_38max`、
> `kmodel_latest`），人读的是它同时下发的 `display_name`（`Qwen3.8-Max`、
> `Kimi-K3.1-Pro`）。插件把两者都报给核心：**面板、搜索、组合挑选显示可读名，
> 组合里存的与请求里发的仍是 key**——拿显示名去请求上游只会 404。
> 面板每行的 key 以小号淡字跟在名字后面，hover 也有完整说明。

2026-10-28 国内版实测快照（会随上游变，以面板为准）：

| 面板显示 | 上游 key（请求/组合用） | 上下文 | 倍率 |
|---|---|---|---|
| Qwen3.8-Max | `qmodel_38max` | 180K | 0.5× |
| Qwen3.8-Flash | `qfmodel` | 180K | 免费 |
| DeepSeek-V4-Pro | `dmodel` | 96K | 0.5× |
| DeepSeek-Flash | `dfmodel` | 180K | 免费 |
| GLM-5.3 | `gmodel` | 180K | 0.8× |
| GLM-5.3-Flash | `gfmodel` | 1000K | 0.1× |
| Kimi-K3.1-Pro | `kmodel_latest` | 180K | 1× |
| Kimi-K2.8-Preview | `kmodel` | 180K | 0.8× |
| MiniMax-M3.1-Flash | `mmodel` | 180K | 0.1× |

命名规律只是巧合（`q`=Qwen、`d`=DeepSeek、`g`=GLM、`k`=Kimi、`m`=MiniMax，`f` 后缀
=Flash、`_latest`=同族较新），**不要照规律猜 key**——猜错就是 404。

## 上游

**国内版**（`https://gateway.qoder.com.cn` + `https://openapi.qoder.com.cn`）：

- **chat**：`POST /algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
- **模型**：`GET /algo/api/v2/model/list?Encode=1` → `chat[]`（`key` / `display_name` / `max_input_tokens` / `price_factor` / `thinking_config.efforts`）
- **jobToken**：`POST /algo/api/v3/user/jobToken?Encode=1`（旧式签名：`date` + `signature`；body 整体 cosy 编码，`personalToken` 与 `refreshToken` 二选一）
- **sash 令牌**：`POST {openapi}/api/v1/jobToken/exchange`（`{personal_token}` → `token`）
- **用量**：`GET /sash/api/v2/me/usage`（sash 面，`Bearer <jt-…>`）
- **签到**：`GET /sash/api/v1/me/campaigns?forceRefresh=true` → `POST …/{campaignId}/claim`
- 凭证：核心的 `credentials.sqlite`，`supplier='qoder'`，blob 为 `{nickname, pat, userId?}`

**国际版**（`https://api1.qoder.sh` + `https://openapi.qoder.sh`）—— 路径逐字相同，
差异只有一个：sash 面（积分/签到）需要设备风控头（见「已知限制」）。
凭证存在同一张表，`supplier='qoder-global'`。

## 与核心的分工

本插件只管**对单个账号调通上游**：PAT 校验、cosy 会话、chat、模型目录、积分、签到。

**策略全在核心**（`AccountPool`）：选号、冷却、禁用、连续错误累计、遍历回退、
响应写入。所以：

- `chatOnce(uid, lv, req)` 一次只服务一个账号，**不遍历账号、不维护冷却表、不写响应**
- 失败时返回语义状态（`rate_limit` / `quota` / `session_dead` / `unavailable` /
  `transport` / `unknown` / `no_such_model` / `bad_request`），由核心决定冷却多久、
  是否禁用、要不要换号
- `status()` 只报「现在状态」（凭证 + 积分），冷却/禁用由核心叠加后给面板
- 积分只报**值**，不落盘（持久化归核心 `supplier-config.json`）：拿不到时报 `-1`
  （不是 0），核心保留上次持久化的值
- 非流式请求也走同一条路：本插件**只产出 OpenAI SSE**，客户端要 JSON 时由核心
  聚合成整包（协议错配由核心吸收，插件不做第二套出口）

完整契约见 [dsh-router 的 `docs/suppliers.md`](https://github.com/CARVIN94/dsh-router/blob/main/docs/suppliers.md)。

## 错误分类（一个重要细节）

**业务码优先于 HTTP 状态**。Qoder 对「当日用量用尽」回的是
`HTTP 403 {"code":"110","Billing daily count exceeded"}` —— 只看状态会判成
「凭据被拒」，于是「今天用满、明天自愈」的号会被要求换 PAT。所以：

| 上游信号 | 归类 | 后果 |
|---|---|---|
| `code 110/113/115/116/117/118/119/122/402/6004`（额度族） | `quota` | 不判账号死，等周期重置或补额度 |
| `code 105` / `HTTP 401` / `HTTP 403`（无业务码） | `session_dead` | 凭据失效，需要换 PAT |
| `HTTP 429` | `rate_limit` | 短冷换号 |
| `code 406` / 内容审核标记 | `bad_request` | 请求级（同一请求对每个号都一样），不惩罚账号 |
| `code 416/430/80411/80412` / `HTTP 400` | `bad_request` | 请求形态问题（范围/能力/过长/媒体过多） |
| `code 500/10408/10500/10605` | `rate_limit` | 瞬时（失败/超时/模型内部错/排队），换号确实管用 |

失败帧会层层套（外层 `403` + 内层 `10605`），所以取码是**沿 `message` 下钻到最深
一层认识的码**，只剥一层会把「排队一分钟」判成「凭据被拒」。认不出的码继续往里找，
最终回落 HTTP 状态分类。

流已经写出字节之后上游才报错（HTTP 200 信封里带业务码）时，插件发一条 OpenAI 形状
的 `error` 帧 + `[DONE]`，并通过 `onLateFailure` 把「这个号额度用尽」报给核心——
后续请求才会避开它。

## 已知限制

- **国际版的积分与签到需要本机 Qoder 客户端的设备风控组件**（`Cosy-Machine*` 三件套，
  由 UMID 组件生成）。本插件**不伪造**它：拿不到时如实报「该区域需要设备组件」，
  而不是显示「今天没有活动」。国际版的**聊天与模型列表不受影响**（走 cosy 面）。
- **国内版已用真实 PAT 端到端跑通（2026-10-28 实测）**：模型目录 9 条全部带可读名、
  对话出字（含 `reasoning_content` 与 `usage`）、积分读到 400（300 基础 + 100 加量）、
  活动列表读到当日已领。**国际版尚未用真实 PAT 联调**——chat 与模型列表与国内版同协议，
  但设备风控那条只能在你本机试。
- 协议来自社区实测记录（见「致谢」）。单测覆盖编码/签名/请求构造/SSE 转换/错误分类/
  签到状态机；第一次失败建议看 `dsh web` 日志里 `qoder` 前缀那几行——它会带上游原文。

## 架构

通过 cordis service `router.suppliers` 的**共享聚合表**向 dsh-router 注册两个供应商工厂：

```
dsh web (cordis)
  ├─ dsh-router-core        先 provide 空的 router.suppliers 表
  └─ dsh-router-qoder       ctx.inject(['router.suppliers']) 等表出现
       ├─ 往表里追加 qoder / qoder-global 两个工厂（已存在则跳过，幂等）
       └─ ctx.emit('internal/service') 让核心重扫 → 面板出现两张卡片
```

cordis 每个 service name 只允许一个插件 `provide`，所以这里**不能**各自 provide，
只能等核心先提供表再往里追加；`inject` + 广播的写法与加载顺序无关，先装谁都能工作。

## 开发

```bash
pnpm install
pnpm build        # lib/index.js
pnpm typecheck
pnpm test         # 行为回归闸门（node --test，Node 原生 TS 类型剥离）
```

`src/core.test.ts` 锁的是**协议事实**，不是实现细节——那些字节每一个都直接决定网关
认不认请求，改错不报编译错、只会得到 401 `Signature invalid`：

1. cosy 编码/解码可逆、字母表与签名格式逐字固定；
2. 设备指纹对同一凭据稳定、换凭据就变；
3. 添加账号先验一次 jobToken（打错的 PAT 不落盘），重复 PAT 不重复建号；
4. chat 请求是**cosy 编码后的密文**、带 `Bearer COSY.*` 与 cosy 头；
5. 上游 SSE 信封被转成 OpenAI SSE（含 role/content/usage/`[DONE]`）；
6. 错误分类：403+code110 是额度耗尽（不是凭据被拒），401 才是凭证失效；
7. 积分读 sash（jt- 令牌）、模型目录过滤上游的 `auto` 且带上 `display_name`；
8. 签到走活动接口，`CLAIMED` 与 409 幂等算成功。

## 致谢

cosy 协议的实现来自以下 MIT 项目的实测记录（本仓库的 `src/cosy.ts` /
`src/messages.ts` 移植自第一项，并按本项目风格重写、加注）：

- [dingminhua/dsh-connect-qoder](https://github.com/dingminhua/dsh-connect-qoder)（MIT）
- fengyinxia/qoder2api（MIT）—— PAT→jobToken、cosy 签名、自定义 base64、RSA/AES 会话
- x_Zhengyuuuui/qoder2api（Go，MIT）—— 同一协议 + 指纹派生 + 双区域端点
- @qoder-ai/qoder-agent-sdk 的 `.d.ts` —— 模型/用量字段的官方命名

## 许可证

[MIT](LICENSE)

## 免责声明

本项目仅用于学习与技术研究，请勿用于商业用途。
