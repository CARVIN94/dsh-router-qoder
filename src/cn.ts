/**
 * qoder（Qoder 国内版）供应商 profile —— 上游 https://gateway.qoder.com.cn。
 *
 * 全部共享逻辑在 core.ts；这里只声明这个部署的差异（区域、图标、名字、uid 前缀）。
 * 区域决定的主机与端点表在 upstream.ts 的 `QODER_REGIONS` 里 —— 那是**唯一**一处
 * 事实，profile 只说「我是哪个区域」，不重复写域名。
 *
 * ⚠️ `id = 'qoder'` **同时是凭证与配置的存储键**（auths/qoder、
 * supplier-config.json、积分缓存）。改它 = 已添加的账号全部消失。
 */
import type { ModelInfo } from './types.ts'
import type { QoderProfile } from './core.ts'
import { QODER_ICON } from './icon.ts'

/**
 * 兜底模型列表：**故意留空**。
 *
 * Qoder 的模型 key 是上游下发的（形如 `qmodel_38max` 这类服务端标识），不是可以
 * 照着模型名猜出来的。猜一个塞进去，用户点了只会拿到 404，而「没有 PAT 时列表
 * 为空」本来就是正确状态 —— 加 PAT 后点一次「获取模型」就有了。宁可空着，也不
 * 让面板列出一堆点不动的假模型。
 */
const FALLBACK_MODELS: ModelInfo[] = []

export const profile: QoderProfile = {
  id: 'qoder',
  name: 'Qoder',
  region: 'cn',
  icon: QODER_ICON,
  priority: -2, // 账户自带额度，排在免费通道之前
  uidPrefix: 'qd',
  defaultNickname: 'Qoder',
  errPrefix: 'qoder',
  apiKeyHint: '粘贴 Qoder 个人访问令牌（PAT，形如 pt-…）。插件只在本机用它换 jobToken，'
    + '之后的请求都带签名会话；PAT 不会发给 Qoder 网关以外的任何地方。'
    + '国内版与 Qoder 国际版是两个不同的供应商，PAT 不通用。',
  fallbackModels: FALLBACK_MODELS,
}
