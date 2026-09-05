// 回归测试：0.4.3 修复批次。
// 1. sanitizeFileName 超长「扩展名」绕过 120 字节截断（ENAMETOOLONG 回归）。
// 2. DELETE 路径二次解码 URIError（文件名含 % 时连接挂起）。
// 3. decodeText UTF-16 BOM 后奇数字节抛 TypeError（违反返回 null 契约）。
// 4. sweepIntervalMs=0 是合法配置（README：0 = 禁用周期清扫）。
// 5. 缓存键改用 fs version token：命中路径免 sha256、version 变化即失效。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeFileName } from '../src/upload.ts'
import { createUploadHandler } from '../src/upload.ts'
import { decodeText } from '../src/parse/text.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineReadDocumentTool } from '../src/tool.ts'
import { ParseCache } from '../src/cache.ts'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'

test('sanitizeFileName caps a long pseudo-extension so the 120-byte budget holds', () => {
  const name = sanitizeFileName('a.' + 'x'.repeat(50))
  assert.ok(Buffer.byteLength(name) <= 120, `bytes ${Buffer.byteLength(name)} > 120`)
  // 超长尾巴不被当作扩展名保留，名字落在 120 字节预算内。
  const long = sanitizeFileName('f'.repeat(200) + '.' + 'x'.repeat(50))
  assert.ok(Buffer.byteLength(long) <= 120)
})

test('sanitizeFileName still preserves real extensions', () => {
  assert.ok(sanitizeFileName('report.PDF').endsWith('.pdf'))
  assert.ok(sanitizeFileName('表格.xlsx').endsWith('.xlsx'))
  assert.ok(sanitizeFileName('中文文件名'.repeat(50) + '.pdf').endsWith('.pdf'))
})

test('sanitizeFileName keeps bare-extension input lossless', () => {
  // '.pdf' 剥前导点后变成 'pdf'：全名就是 stem，不丢字符。
  assert.equal(sanitizeFileName('.pdf'), 'pdf')
})

async function withServer(options: Parameters<typeof createUploadHandler>[0], fn: (base: string) => Promise<void>): Promise<void> {
  const handler = createUploadHandler(options)
  const server = createServer((req, res) => {
    void handler(req as IncomingMessage, res as ServerResponse)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

test('DELETE tolerates a % in the path without double-decoding (no hung connection)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-files-percent-'))
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: dir },
    async (base) => {
      // '50%off.txt' 经 encodeURIComponent 后是 '50%25off.txt'；searchParams
      // 解码一次还原。旧实现再 decodeURIComponent 一次会对 '%of' 抛 URIError。
      // 无 sessions 服务时回退到 defaultDir 布局：路径不在其中 → 403（含 % 的
      // 路径能安全走出守卫，说明没有因二次解码崩溃挂起）。
      const res = await fetch(`${base}/api/upload?path=${encodeURIComponent(join(dir, '.dsh-filess', '50%off.txt'))}`, {
        method: 'DELETE'
      })
      assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`)
    }
  )
})

test('decodeText returns null for a UTF-16 BOM followed by an odd trailing byte', () => {
  // BOM + 1 字节：fatal 解码必然失败，必须返回 null 而不是抛 TypeError。
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x41])), null)
  assert.equal(decodeText(new Uint8Array([0xfe, 0xff, 0x00])), null)
  // BOM + 偶数有效字节仍正常解码。
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00])), 'A')
})

test('sweepIntervalMs=0 is accepted and disables the periodic sweep', async () => {
  // 强断言：0 间隔不得创建任何定时器。实现用 setInterval，spy 必须盯
  // setInterval 而不是 setTimeout（盯错则实现退化成 setInterval(0) 也恒过）。
  const { createSweeper } = await import('../src/upload.ts')
  const originalSetInterval = globalThis.setInterval
  let intervalCreated = false
  const spySetInterval = ((...args: unknown[]) => {
    intervalCreated = true
    return (originalSetInterval as unknown as (...a: unknown[]) => NodeJS.Timeout)(...args)
  }) as unknown as typeof setInterval
  ;(globalThis as { setInterval: typeof setInterval }).setInterval = spySetInterval
  try {
    const dispose = createSweeper('/nonexistent', 1000, 0)
    assert.equal(typeof dispose, 'function')
    assert.equal(intervalCreated, false, 'sweepIntervalMs=0 must not create an interval timer')
    dispose()
  } finally {
    ;(globalThis as { setInterval: typeof setInterval }).setInterval = originalSetInterval
  }
})

test('cache-key change: repeated reads of one version parse the document only once', async () => {
  const SIZE = 64 * 1024
  let parseCalls = 0
  const fs = {
    resolve: async () => ({ targetKey: FsTargetKey('k-pages'), displayPath: '/workspace/doc.txt' }),
    stat: async () => ({ version: FsVersion('v1'), type: 'file', size: SIZE }),
    readBytes: async () => new Uint8Array(SIZE).fill(0x61) // 全 'a'
  }
  const cache = new ParseCache(4, 1024 * 1024)
  // 间谍：包住 getOrCompute 的 compute 参数计数真实解析次数。
  const origGetOrCompute = cache.getOrCompute.bind(cache)
  cache.getOrCompute = (key, compute) => origGetOrCompute(key, async () => {
    parseCalls += 1
    return compute()
  })
  const tool = defineReadDocumentTool(
    { fs, emit: () => undefined },
    { readLimit: 10, maxFileBytes: 1024 * 1024, sheetRowLimit: 200, maxSheets: 5, maxOutputChars: 24000 },
    cache
  )
  const exec = { signal: new AbortController().signal, agent: undefined } as unknown as Parameters<typeof tool.execute>[1]
  // 同一 version 下连读 2 次：解析恰好 1 次，第二次走缓存。
  // 注意：本测试锁「不重复解析」契约（旧 sha256 键也满足）；区分键机制的
  // 判别性断言在下方『same content, different version forces a re-parse』。
  for (let call = 0; call < 2; call++) {
    const result = (await tool.execute({ file_path: 'doc.txt', offset: 1, limit: 10 }, exec)) as {
      format: string
      lines: Array<{ text: string }>
    }
    assert.equal(result.format, 'text')
    // 65536 个 'a' 无换行 = 单行超预算，windowLines 会按字符预算截断；
    // 关键断言是内容为 a 开头（而非报错），且两次调用结果一致。
    assert.ok(result.lines[0].text.startsWith('a'.repeat(10)))
  }
  assert.equal(parseCalls, 1)
})

test('same content rewritten under a new version forces a re-parse (version-key discriminant)', async () => {
  // 判别性测试：内容相同但 version 变化必须重解析。旧 sha256 键下此测试
  // 无法区分（同内容同键不重解析，parseCalls=1）——这正是 0.2.0 与本次
  // 修复的机制分界，锁住「version 参与键」这个修复本身。
  const SIZE = 64 * 1024
  let version = 'v1'
  let parseCalls = 0
  const fs = {
    resolve: async () => ({ targetKey: FsTargetKey('k-discrim'), displayPath: '/workspace/d.txt' }),
    stat: async () => ({ version: FsVersion(version), type: 'file', size: SIZE }),
    readBytes: async () => new Uint8Array(SIZE).fill(0x61) // 两次内容完全相同
  }
  const cache = new ParseCache(4, 1024 * 1024)
  const origGetOrCompute = cache.getOrCompute.bind(cache)
  cache.getOrCompute = (key, compute) => origGetOrCompute(key, async () => {
    parseCalls += 1
    return compute()
  })
  const tool = defineReadDocumentTool(
    { fs, emit: () => undefined },
    { readLimit: 10, maxFileBytes: 1024 * 1024, sheetRowLimit: 200, maxSheets: 5, maxOutputChars: 24000 },
    cache
  )
  const exec = { signal: new AbortController().signal, agent: undefined } as unknown as Parameters<typeof tool.execute>[1]
  await tool.execute({ file_path: 'd.txt' }, exec)
  version = 'v2' // 同内容、新 version（外部进程重写）
  await tool.execute({ file_path: 'd.txt' }, exec)
  // version 进键 → v2 必 miss → 重解析。若有人把键退化回纯内容哈希，此处 =1 变红。
  assert.equal(parseCalls, 2, 'a new version must invalidate the parse cache even for identical content')
})

test('a changed fs version invalidates the parse cache (stale text never served)', async () => {
  const SIZE = 64 * 1024
  let version = 'v1'
  const fs = {
    resolve: async () => ({ targetKey: FsTargetKey('k-fresh'), displayPath: '/workspace/fresh.txt' }),
    stat: async () => ({ version: FsVersion(version), type: 'file', size: SIZE }),
    readBytes: async () => new Uint8Array(SIZE).fill(version === 'v1' ? 0x61 : 0x62)
  }
  const tool = defineReadDocumentTool(
    { fs, emit: () => undefined },
    { readLimit: 10, maxFileBytes: 1024 * 1024, sheetRowLimit: 200, maxSheets: 5, maxOutputChars: 24000 },
    new ParseCache(4, 1024 * 1024)
  )
  const exec = { signal: new AbortController().signal, agent: undefined } as unknown as Parameters<typeof tool.execute>[1]
  const first = (await tool.execute({ file_path: 'fresh.txt' }, exec)) as { lines: Array<{ text: string }> }
  assert.ok(first.lines[0].text.startsWith('a'.repeat(10)))
  version = 'v2' // 文件被改写 → stat version 变化 → 缓存必须失效
  const second = (await tool.execute({ file_path: 'fresh.txt' }, exec)) as { lines: Array<{ text: string }> }
  assert.ok(second.lines[0].text.startsWith('b'.repeat(10)))
})

test('oversized files are still rejected before reading bytes (FS_TOO_LARGE unchanged)', async () => {
  const fs = {
    resolve: async () => ({ targetKey: FsTargetKey('k-over'), displayPath: '/workspace/over.bin' }),
    stat: async () => ({ version: FsVersion('v1'), type: 'file', size: 2048 }),
    readBytes: async () => {
      throw new Error('must not be reached')
    }
  }
  const tool = defineReadDocumentTool(
    { fs, emit: () => undefined },
    { readLimit: 800, maxFileBytes: 1024, sheetRowLimit: 200, maxSheets: 5, maxOutputChars: 24000 },
    new ParseCache(4, 1024 * 1024)
  )
  const exec = { signal: new AbortController().signal, agent: undefined } as unknown as Parameters<typeof tool.execute>[1]
  await assert.rejects(
    tool.execute({ file_path: 'over.bin' }, exec),
    (err: unknown) => err instanceof FsError && err.code === 'FS_TOO_LARGE'
  )
})
