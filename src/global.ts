/**
 * qoder-global（Qoder 国际版）供应商 profile —— 上游 https://api1.qoder.sh。
 *
 * 与国内版**同协议同契约**（cosy 签名、jobToken、同一套模型/聊天端点），差异只有
 * 主机与一件实测事实：**sash 面（积分 / 签到）需要设备风控头**，那三件套来自本机
 * Qoder 客户端的 UMID 组件。本插件不伪造它 —— 拿不到时积分与签到会如实报
 * 「该区域需要本机 Qoder 客户端的设备组件」，而不是显示「今天没有活动」。
 *
 * chat 与模型列表不受这条限制（它们走 cosy 面，不吃设备风控头）。
 *
 * ⚠️ `id = 'qoder-global'` **同时是凭证与配置的存储键**（`credentials.sqlite` 的
 * `supplier` 列、`supplier-config.json` 的键），改它 = 账号全部消失。
 */
import type { ModelInfo } from './types.ts'
import type { QoderProfile } from './core.ts'
import { QODER_ICON } from './icon.ts'

/** 兜底列表故意留空（理由见 cn.ts）。 */
const FALLBACK_MODELS: ModelInfo[] = []

export const profile: QoderProfile = {
  id: 'qoder-global',
  name: 'Qoder Global',
  region: 'global',
  icon: QODER_ICON,
  priority: -2,
  uidPrefix: 'qdg',
  defaultNickname: 'Qoder Global',
  errPrefix: 'qoder-global',
  // 国际版控制台域名是 qoder.com（`qoder.sh` 只有网关/开放 API 主机名，没有网页）；
  // 写成 qoder.sh 会让用户去访问一个解析不出来域名。
  apiKeyHint: '粘贴 Qoder 国际版的个人访问令牌（PAT，形如 pt-…）。在哪拿：登录 qoder.com '
    + '控制台 → Settings → Personal Access Tokens → 创建（复制只显示一次的 pt-…）。'
    + '令牌按区域签发，国际版的 pt-… 在国内版卡片上无效（反之亦然）。'
    + '国际版的积分与每日签到还需要本机安装 Qoder 客户端（设备风控组件），'
    + '只有 PAT 时聊天与模型可用，积分/签到会如实报错。',
  fallbackModels: FALLBACK_MODELS,
}
