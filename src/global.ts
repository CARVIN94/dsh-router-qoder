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
 * ⚠️ `id = 'qoder-global'` **同时是凭证与配置的存储键**，改它 = 账号全部消失。
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
  apiKeyHint: '粘贴 Qoder 国际版（qoder.sh）的个人访问令牌（PAT，形如 pt-…）。'
    + '国际版的积分与每日签到还需要本机安装 Qoder 客户端（设备风控组件），'
    + '只有 PAT 时聊天与模型可用，积分/签到会如实报错。',
  fallbackModels: FALLBACK_MODELS,
}
