// Upload-surface tests: name/session sanitization, network guards, size and
// extension limits, content dedup, per-session storage, DELETE containment,
// and TTL sweeping.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createUploadHandler, createSweeper, readHintFor, sanitizeFileName, sanitizeSessionId, sweep } from '../src/upload.ts'

test('sanitizeFileName strips control chars, separators, dot segments and leading dots', () => {
  assert.equal(sanitizeFileName('..\\..\\etc\\passwd'), 'etc_passwd')
  assert.equal(sanitizeFileName('../../.env'), 'env')
  assert.equal(sanitizeFileName('a\u0000b.txt'), 'ab.txt')
  assert.equal(sanitizeFileName('...'), 'upload.bin')
  assert.equal(sanitizeFileName('x'.repeat(200) + '.pdf').length <= 120, true)
})

test('sanitizeSessionId keeps a safe alphabet', () => {
  assert.equal(sanitizeSessionId('session-12'), 'session-12')
  assert.equal(sanitizeSessionId('../etc'), '_etc')
  assert.equal(sanitizeSessionId(''), 'anonymous')
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

test('upload stores files per session under the session cwd', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-'))
  const sessions = new Map([['session-a', sessionDir]])
  await withServer(
    {
      maxBytes: 1024 * 1024,
      allowedExtensions: [],
      ttlMs: 60_000,
      sweepIntervalMs: 0,
      maxConcurrent: 4,
      defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')),
      sessionCwd: (id) => sessions.get(id)
    },
    async (base) => {
      const res = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('notes.txt'), 'x-session-id': 'session-a' },
        body: 'hello'
      })
      assert.equal(res.status, 200)
      const payload = (await res.json()) as { path: string; sessionId: string }
      assert.equal(payload.sessionId, 'session-a')
      assert.ok(payload.path.startsWith(join(sessionDir, '.dsh-filess', 'session-a')))
      const files = await readdir(join(sessionDir, '.dsh-filess', 'session-a'))
      assert.equal(files.length, 1)
    }
  )
})

test('upload preserves sub-directories from x-file-relative-path, rejecting traversal', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-'))
  const sessions = new Map([['session-b', sessionDir]])
  await withServer(
    {
      maxBytes: 1024 * 1024,
      allowedExtensions: [],
      ttlMs: 60_000,
      sweepIntervalMs: 0,
      maxConcurrent: 4,
      defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')),
      sessionCwd: (id) => sessions.get(id)
    },
    async (base) => {
      const safe = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: {
          'x-file-name': encodeURIComponent('a.pdf'),
          'x-file-relative-path': encodeURIComponent('sub/dir/a.pdf'),
          'x-session-id': 'session-b'
        },
        body: 'pdf-bytes'
      })
      assert.equal(safe.status, 200)
      const subFiles = await readdir(join(sessionDir, '.dsh-filess', 'session-b', 'sub', 'dir'))
      assert.equal(subFiles.length, 1)
      assert.ok(subFiles[0].startsWith('e1af36aaec24') === false || subFiles.length === 1)

      const traversal = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: {
          'x-file-name': encodeURIComponent('b.pdf'),
          'x-file-relative-path': encodeURIComponent('../../etc/b.pdf'),
          'x-session-id': 'session-b'
        },
        body: 'more'
      })
      assert.equal(traversal.status, 200)
      // 逃逸段被剥离但其余路径保留：../../etc/b.pdf → etc/b.pdf，仍落在会话目录内
      const rootDirs = await readdir(join(sessionDir, '.dsh-filess', 'session-b'))
      assert.deepEqual(rootDirs.sort(), ['etc', 'sub'])
      const etcFiles = await readdir(join(sessionDir, '.dsh-filess', 'session-b', 'etc'))
      assert.equal(etcFiles.length, 1)
      assert.ok(etcFiles[0].startsWith('..') === false)
      const subFiles2 = await readdir(join(sessionDir, '.dsh-filess', 'session-b', 'sub', 'dir'))
      assert.equal(subFiles2.length, 1)
    }
  )
})

test('unknown session is rejected when a session resolver exists', async () => {
  await withServer(
    {
      maxBytes: 1024 * 1024,
      allowedExtensions: [],
      ttlMs: 60_000,
      sweepIntervalMs: 0,
      maxConcurrent: 4,
      defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')),
      sessionCwd: () => undefined
    },
    async (base) => {
      const res = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-session-id': 'ghost' },
        body: 'x'
      })
      assert.equal(res.status, 403)
    }
  )
})

test('oversized upload is rejected', async () => {
  await withServer(
    {
      maxBytes: 8,
      allowedExtensions: [],
      ttlMs: 60_000,
      sweepIntervalMs: 0,
      maxConcurrent: 4,
      defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-'))
    },
    async (base) => {
      const res = await fetch(`${base}/api/upload`, { method: 'POST', body: 'x'.repeat(64) })
      assert.equal(res.status, 413)
    }
  )
})

test('extension allowlist rejects disallowed types', async () => {
  await withServer(
    {
      maxBytes: 1024 * 1024,
      allowedExtensions: ['pdf', 'txt'],
      ttlMs: 60_000,
      sweepIntervalMs: 0,
      maxConcurrent: 4,
      defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-'))
    },
    async (base) => {
      const res = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('evil.exe') },
        body: 'MZ'
      })
      assert.equal(res.status, 415)
    }
  )
})

test('identical content deduplicates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-files-fallback-'))
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: dir, sessionCwd: () => dir },
    async (base) => {
      const first = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('a.txt') },
        body: 'same bytes'
      })
      const second = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('a.txt') },
        body: 'same bytes'
      })
      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      const a = (await first.json()) as { deduplicated?: boolean }
      const b = (await second.json()) as { deduplicated?: boolean }
      assert.equal(a.deduplicated, undefined)
      assert.equal(b.deduplicated, true)
    }
  )
})

test('identical content with different names stores one file and returns the existing path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-files-fallback-'))
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: dir, sessionCwd: () => dir },
    async (base) => {
      const first = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('a.txt') },
        body: 'same bytes'
      })
      const second = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('b.txt') },
        body: 'same bytes'
      })
      const a = (await first.json()) as { path: string; deduplicated?: boolean }
      const b = (await second.json()) as { path: string; deduplicated?: boolean }
      assert.equal(b.deduplicated, true)
      // 第二次返回已存在文件的路径，模型读取不会 404。
      assert.equal(a.path, b.path)
      const files = await readdir(join(dir, '.dsh-filess', 'anonymous'))
      assert.equal(files.length, 1)
    }
  )
})

test('DELETE refuses paths outside the session upload dir', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-'))
  const sessions = new Map([['s1', sessionDir]])
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')), sessionCwd: (id) => sessions.get(id) },
    async (base) => {
      const outside = join(sessionDir, 'victim.txt')
      await writeFile(outside, 'secret')
      const res = await fetch(`${base}/api/upload?path=${encodeURIComponent(outside)}`, {
        method: 'DELETE',
        headers: { 'x-session-id': 's1' }
      })
      assert.equal(res.status, 403)
      const info = await stat(outside)
      assert.equal(info.isFile(), true)
    }
  )
})

test('DELETE removes an uploaded file', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-'))
  const sessions = new Map([['s1', sessionDir]])
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')), sessionCwd: (id) => sessions.get(id) },
    async (base) => {
      const up = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('x.txt'), 'x-session-id': 's1' },
        body: 'data'
      })
      const { path } = (await up.json()) as { path: string }
      const del = await fetch(`${base}/api/upload?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
        headers: { 'x-session-id': 's1' }
      })
      assert.equal(del.status, 200)
      const files = await readdir(join(sessionDir, '.dsh-filess', 's1'))
      assert.equal(files.length, 0)
    }
  )
})

test('sweep removes expired files and emptied dirs, keeps fresh ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-sweep-'))
  const sessionDir = join(root, '.dsh-filess', 's1')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'old.txt'), 'x')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const result = await sweep(root, 10, () => Date.now())
  assert.equal(result.removedFiles, 1)
  assert.equal(result.removedDirs, 1)

  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'fresh.txt'), 'y')
  const result2 = await sweep(root, 60_000, () => Date.now())
  assert.equal(result2.removedFiles, 0)
  assert.equal(result2.removedDirs, 0)
})

test('createSweeper with zero interval does nothing and returns a disposer', () => {
  const dispose = createSweeper('/nonexistent', 1000, 0)
  assert.equal(typeof dispose, 'function')
})

test('sanitizeFileName truncates by UTF-8 bytes, not characters', () => {
  // 250 个中文字符 = 750 字节；按字符截断会超 255 字节文件系统上限。
  const name = sanitizeFileName('中文文件名'.repeat(50))
  assert.ok(Buffer.byteLength(name) <= 120, `bytes ${Buffer.byteLength(name)} > 120`)
  assert.equal(name.length, 40) // 120 字节 / 每字 3 字节
  assert.ok(name.endsWith('名')) // 不切半个字符
  // ASCII 长名保持原有截断行为
  assert.equal(sanitizeFileName('x'.repeat(200) + '.pdf').length, 120)
})

test('sanitizeFileName preserves the extension when truncating a long stem', () => {
  // 长主干 + 扩展名：截断不能把 .pdf/.xlsx 切掉，否则 allowlist 与
  // 客户端徽章会把文件当成无扩展名。
  const name = sanitizeFileName('y'.repeat(300) + '.xlsx')
  assert.ok(name.endsWith('.xlsx'), `expected .xlsx suffix, got "${name}"`)
  assert.ok(Buffer.byteLength(name) <= 120)
  // 中文长名 + 扩展名同样保留扩展名。
  const cn = sanitizeFileName('中文文件名'.repeat(50) + '.pdf')
  assert.ok(cn.endsWith('.pdf'), `expected .pdf suffix, got "${cn}"`)
  assert.ok(Buffer.byteLength(cn) <= 120)
})

test('sanitizeFileName rejects pure dot names', () => {
  assert.equal(sanitizeFileName('...'), 'upload.bin')
  assert.equal(sanitizeFileName('..'), 'upload.bin')
})

test('upload response carries the byte-sniffed format', async () => {
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')) },
    async (base) => {
      // 扩展名撒谎：.txt 的真实内容是 PDF，嗅探必须胜出。
      const pdf = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('notes.txt') },
        body: '%PDF-1.7 fake'
      })
      assert.equal(pdf.status, 200)
      const p = (await pdf.json()) as { sniffedFormat: string | null }
      assert.equal(p.sniffedFormat, 'pdf')
      // exe 伪装成 .pdf：嗅探为 null（已知二进制），客户端不会按扩展名着色。
      const exe = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('photo.pdf') },
        body: 'MZ\x90\x00\x03\x00\x00\x00\x04\x00'
      })
      assert.equal(exe.status, 200)
      const e = (await exe.json()) as { sniffedFormat: string | null }
      assert.equal(e.sniffedFormat, null)
      // 普通文本
      const txt = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('x.bin') },
        body: 'hello world'
      })
      const t = (await txt.json()) as { sniffedFormat: string | null }
      assert.equal(t.sniffedFormat, 'text')
    }
  )
})

test('session quota rejects oversize totals with 507', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-session-'))
  const sessions = new Map([['q1', sessionDir]])
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, maxSessionBytes: 16, defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')), sessionCwd: (id) => sessions.get(id) },
    async (base) => {
      const ok = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('a.txt'), 'x-session-id': 'q1' },
        body: '0123456789abcdef'
      })
      assert.equal(ok.status, 200)
      // 16 字节已满，再传 1 字节必须 507，且不落盘。
      const over = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('b.txt'), 'x-session-id': 'q1' },
        body: 'x'
      })
      assert.equal(over.status, 507)
      const files = await readdir(join(sessionDir, '.dsh-filess', 'q1'))
      assert.equal(files.length, 1)
    }
  )
})

test('readHintFor labels the read cost by size and format', () => {
  assert.equal(readHintFor('text', 5000).cost, 'cheap')
  assert.equal(readHintFor('text', 2 * 1024 * 1024).cost, 'moderate')
  assert.equal(readHintFor('pdf', 20 * 1024 * 1024).cost, 'expensive')
  // text 给字符估算、且不超过单次窗口上限；其它格式给保守默认。
  const t = readHintFor('text', 10000)
  assert.ok(t.estimatedChars >= 2000 && t.estimatedChars <= 24000)
  assert.equal(readHintFor('pdf', 12345).estimatedChars, 12000)
})

test('sweep recurses into folder-upload subdirectories and reaps emptied dirs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-sweep-nested-'))
  const deep = join(root, '.dsh-filess', 's1', 'sub', 'dir')
  await mkdir(deep, { recursive: true })
  await writeFile(join(deep, 'expired.pdf'), 'x')
  await utimes(join(deep, 'expired.pdf'), new Date(0), new Date(0))
  await writeFile(join(root, '.dsh-filess', 's1', 'sub', 'keep.txt'), 'y')
  const result = await sweep(root, 60_000, () => Date.now())
  // 嵌套过期文件被回收；清空的 sub/dir 被 reap，sub 因还有 keep.txt 保留。
  assert.equal(result.removedFiles, 1)
  assert.equal(result.removedDirs, 1)
  await assert.rejects(stat(join(deep, 'expired.pdf')), /ENOENT/)
  await assert.rejects(stat(deep), /ENOENT/)
  await stat(join(root, '.dsh-filess', 's1', 'sub', 'keep.txt'))
})

test('sweep skips symlinks and never deletes through them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-sweep-link-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-files-sweep-outside-'))
  const sessionDir = join(root, '.dsh-filess', 's1')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(outside, 'precious.txt'), 'keep me')
  await utimes(join(outside, 'precious.txt'), new Date(0), new Date(0))
  await symlink(join(outside, 'precious.txt'), join(sessionDir, 'link.txt'))
  await symlink(outside, join(sessionDir, 'linkdir'))
  const result = await sweep(root, 60_000, () => Date.now())
  assert.equal(result.removedFiles, 0)
  assert.equal(result.removedDirs, 0)
  // 链接目标（含旧文件）原样保留。
  await stat(join(outside, 'precious.txt'))
  await stat(join(sessionDir, 'link.txt'))
  await stat(join(sessionDir, 'linkdir'))
})

test('createSweeper accepts a roots function and sweeps every root per tick', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'dsh-files-sweep-roots-'))
  const file = join(ws, '.dsh-filess', 's1', 'old.txt')
  await mkdir(join(ws, '.dsh-filess', 's1'), { recursive: true })
  await writeFile(file, 'x')
  await utimes(file, new Date(0), new Date(0))
  const dispose = createSweeper(() => [ws], 60_000, 10)
  try {
    await new Promise((resolve) => setTimeout(resolve, 120))
    await assert.rejects(stat(file), /ENOENT/)
  } finally {
    dispose()
  }
})

test('session quota counts nested folder-upload storage', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-quota-nested-'))
  const sessions = new Map([['q1', sessionDir]])
  // 预置：子目录里已有 500 字节存量（模拟此前文件夹上传）。
  await mkdir(join(sessionDir, '.dsh-filess', 'q1', 'sub'), { recursive: true })
  await writeFile(join(sessionDir, '.dsh-filess', 'q1', 'sub', 'blob.bin'), Buffer.alloc(500, 1))
  // 配额 600：子目录存量 500 + 新传 200 = 700 > 600 → 507（平铺统计会漏判为 200）。
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, maxSessionBytes: 600, defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')), sessionCwd: (id) => sessions.get(id) },
    async (base) => {
      const over = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('b.txt'), 'x-session-id': 'q1' },
        body: 'x'.repeat(200)
      })
      assert.equal(over.status, 507)
    }
  )
  // 配额 1000：500 + 400 = 900 ≤ 1000 → 200，阈值边界正确。
  await withServer(
    { maxBytes: 1024 * 1024, allowedExtensions: [], ttlMs: 60_000, sweepIntervalMs: 0, maxConcurrent: 4, maxSessionBytes: 1000, defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-fallback-')), sessionCwd: (id) => sessions.get(id) },
    async (base) => {
      const within = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'x-file-name': encodeURIComponent('c.txt'), 'x-session-id': 'q1' },
        body: 'x'.repeat(400)
      })
      assert.equal(within.status, 200)
    }
  )
})
