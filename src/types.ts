/**
 * 供应商通用类型 —— 自含（不依赖 dsh-router 包）。
 * 与 dsh-router 的 router/types.ts 保持同步。
 */
import type { ServerResponse } from 'node:http'

/** 面板展示的账号状态（脱敏）。 */
export interface SupplierAccount {
  uid: string
  nickname?: string
  credits: number
  cooling: boolean
  until?: string
  reason?: string
  err_count?: number
}

/** 供应商面板状态。 */
export interface SupplierStatus {
  id: string
  name: string
  accounts: SupplierAccount[]
}

/** OpenAI 模型条目。 */
export interface ModelInfo {
  /** 上游模型 key（`qmodel_38max`）——组合、路由、请求都用它。 */
  id: string
  /**
   * 可读名（上游目录的 `display_name`，如 `Qwen3.8-Max`），**只用于显示**。
   * 核心把它画在主标签上；请求仍然只认 `id`。
   */
  name?: string
  context_length?: number
}

/** 一次 /v1/chat/completions 请求。 */
export interface ChatRequest {
  rawBody: string
  stream: boolean
  model: string
}
