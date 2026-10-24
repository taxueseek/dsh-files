// 回归测试（0.6.1 保留项）——外部反馈 #17：
// 0.6.0 的 registerAttachmentRoutes 丢弃三次 webServer.register 返回的
// disposer，而真实宿主的 register 只写路由注册表、不随插件 fiber 清理。
// 后果：插件移除后三条 /plugins/dsh-files/attachments* 路由泄漏（真实宿主
// 探针：移除后下载仍 200，预期 404）；重载撞宿主 duplicate exact route
// （被 catch 成 warn），旧配置继续生效（maxDownloadBytes 收紧后旧值仍放行）。
// 修复：apply() 的 inject 回调把 webServer 包一层，每次 register 的
// disposer 经 loopCtx.effect 绑进注入 fiber。本文件在 apply 接缝钉住这根
// 线——effect 语义按 cordis 真实行为建模（generator 体立即执行、yield 出的
// disposer 由 fiber 持有、fiber 卸载时执行）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/index.ts'
import type { DocsConfig } from '../src/index.ts'

const ROUTES = [
  '/plugins/dsh-files/attachments',
  '/plugins/dsh-files/attachments/download',
  '/plugins/dsh-files/attachments/export'
]

/** 最小 config：与 schema 默认值同形（测试不依赖 schemastery 的解析语义）。 */
const config: DocsConfig = {
  maxFileBytes: 24 * 1024 * 1024,
  readLimit: 800,
  sheetRowLimit: 200,
  maxSheets: 5,
  maxOutputChars: 24000,
  readTimeoutMs: 120_000,
  attachmentsDir: '/nonexistent',
  attachmentsEnabled: true,
  maxDownloadBytes: 200 * 1024 * 1024,
  trustedHosts: []
}

/** 真实宿主形态的 webServer 桩：register 只写表并返回 disposer，不做 fiber 清理。 */
function hostShapedWebServer() {
  const routes = new Map<string, () => void>()
  return {
    routes,
    webServer: {
      register(route: { path: string }) {
        if (routes.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
        const dispose = () => routes.delete(route.path)
        routes.set(route.path, dispose)
        return dispose
      }
    }
  }
}

/** cordis ctx.effect 桩：generator 体立即执行，yield 的 disposer 归入 fiber。 */
function fiberHolder() {
  const disposers: Array<() => void> = []
  return {
    disposers,
    effect(body: () => Generator<() => void, void, unknown>, _label?: string) {
      const step = body().next()
      if (!step.done && step.value) disposers.push(step.value)
    },
    unload() {
      for (const dispose of [...disposers].reverse()) dispose()
      disposers.length = 0
    }
  }
}

function applyPlugin() {
  let injectCallback: ((loopCtx: any) => void) | undefined
  apply(
    {
      systemPrompt: { section: () => () => {} },
      tools: { register: () => () => {} },
      fs: {},
      emit: () => {},
      inject(_deps: string[], cb: (loopCtx: any) => void) {
        injectCallback = cb
      }
    } as any,
    config
  )
  assert.ok(injectCallback !== undefined, 'apply 必须经 ctx.inject 延迟注册附件路由')
  return injectCallback!
}

/** inject 回调收到的 loopCtx：webServer 挂在键上（不能展开铺平），其余为宿主服务桩。 */
function loopCtxWith(webServer: { webServer: unknown }, fiber: ReturnType<typeof fiberHolder>) {
  return {
    ...webServer,
    ...fiber,
    attachments: {},
    sessions: { get: () => undefined },
    llm: {}
  }
}

test('#17 三条路由注册时必须各在注入 fiber 上留一个 disposer', () => {
  const injectCallback = applyPlugin()
  const { routes, webServer } = hostShapedWebServer()
  const fiber = fiberHolder()
  injectCallback(loopCtxWith({ webServer }, fiber))
  assert.deepEqual([...routes.keys()].sort(), [...ROUTES].sort())
  assert.equal(fiber.disposers.length, 3, '每条路由的 disposer 都必须绑进注入 fiber（#17 根因：disposer 被丢弃）')
})

test('#17 卸载注入 fiber 必须注销全部附件路由（移除后 404，不再 200）', () => {
  const injectCallback = applyPlugin()
  const { routes, webServer } = hostShapedWebServer()
  const fiber = fiberHolder()
  injectCallback(loopCtxWith({ webServer }, fiber))
  assert.equal(routes.size, 3)
  fiber.unload()
  assert.equal(routes.size, 0, 'fiber 卸载后路由表必须清空——真实宿主探针里移除插件后仍能 200 下载')
})

test('#17 重载同一路由集不再撞 duplicate exact route，旧配置随旧路由一起消失', () => {
  const injectCallback = applyPlugin()
  const { routes, webServer } = hostShapedWebServer()
  const fiberA = fiberHolder()
  // 第一次装载（旧配置），随后插件重载：先卸 fiberA 再装载新配置。
  injectCallback(loopCtxWith({ webServer }, fiberA))
  assert.equal(routes.size, 3)
  fiberA.unload()
  // 重载走的是同一个 apply 回调：若路由未随 fiber 注销，这里的注册会抛
  // duplicate exact route（0.6.0 里被 catch 成 warn，旧路由继续用旧配置服务）。
  const fiberB = fiberHolder()
  injectCallback(loopCtxWith({ webServer }, fiberB))
  assert.deepEqual([...routes.keys()].sort(), [...ROUTES].sort())
  assert.equal(fiberB.disposers.length, 3)
})
