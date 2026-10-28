/**
 * dsh-router-qoder —— DSH 插件 host half，一次注册**两个** Qoder 供应商。
 *
 * 通过 cordis service `router.suppliers`（聚合表 `{ [supplierId]: (env) => SupplierModule }`）
 * 把 qoder 族供应商工厂暴露给 dsh-router：
 *   - `qoder`        Qoder 国内版（gateway.qoder.com.cn）
 *   - `qoder-global` Qoder 国际版（api1.qoder.sh）
 * 两者共用 core.ts 的同一份实现，差异只在 cn.ts / global.ts 的 profile。
 *
 * cordis 的 `ctx.provide` 每个 service name 只允许一个插件注册，多个供应商插件不能
 * 各自 provide `router.suppliers`（会抛 "service has been registered"）。本插件用
 * 共享表模式：`inject` 等待该 service（由核心 dsh-router 持有空表），把工厂追加进
 * 共享表后广播一次 `internal/service`，让 dsh-router 重新扫描。该模式与插件加载
 * 顺序无关。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createSupplier } from './core.ts'
import { profile as cnProfile } from './cn.ts'
import { profile as globalProfile } from './global.ts'
import type { SupplierEnv, SupplierModule } from './contract.ts'

export const name = 'dsh-router-qoder'

/** 暴露给 dsh-router 的供应商工厂表。 */
export interface RouterSuppliersService {
  [supplierId: string]: (env: SupplierEnv) => SupplierModule
}

/** 本插件注册的全部供应商（profile → 工厂）。 */
const SUPPLIERS: ReadonlyArray<readonly [string, (env: SupplierEnv) => SupplierModule]> = [
  [cnProfile.id, createSupplier(cnProfile)],
  [globalProfile.id, createSupplier(globalProfile)],
]

/** 读取当前 router.suppliers 聚合表（同一 live 对象，可追加）。 */
function currentSuppliers(ctx: Context): RouterSuppliersService | undefined {
  const c = ctx as unknown as {
    get?: (key: string) => unknown
    router?: { suppliers?: RouterSuppliersService }
  }
  return (c.get?.('router.suppliers') ?? c.router?.suppliers) as RouterSuppliersService | undefined
}

export function apply(ctx: Context): void {
  // 等 router.suppliers 可用后，把两个供应商追加进共享聚合表并通知 dsh-router 重扫。
  ctx.inject(['router.suppliers'], (sctx) => {
    const suppliers = currentSuppliers(sctx)
    if (!suppliers) return undefined
    const added: string[] = []
    for (const [id, factory] of SUPPLIERS) {
      if (suppliers[id]) continue
      suppliers[id] = factory
      added.push(id)
    }
    if (added.length > 0) {
      // 复用 dsh-router 的 internal/service 监听（读 live 表、幂等），增量加载。
      ctx.emit('internal/service', 'router.suppliers', suppliers)
      ctx.logger?.info?.(`[dsh-router-qoder] registered router.suppliers: ${added.join(', ')}`)
    }
    return () => {
      for (const [id] of SUPPLIERS) delete suppliers[id]
    }
  })
}
