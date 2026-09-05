// Upload HTTP surface. Security model:
//   - loopback-only host, same-origin and same-site checks (mirrors the
//     official dsh-files-button contract)
//   - files land in a per-session directory under the session's own cwd
//     (`.dsh-filess/<sessionId>`), so the agent's fs backend can always
//     resolve them and storage is isolated between sessions
//   - sanitized file names, size cap, optional extension allowlist, sha256
//     content dedup, bounded concurrency, TTL sweep

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sniffFormat } from './detect.ts'
import { jsonError, networkGuard } from './guard.ts'

export interface UploadOptions {
  /** Byte cap for one upload body. */
  maxBytes: number
  /** Lowercase extension allowlist; empty array means every extension is allowed. */
  allowedExtensions: string[]
  /** How long an uploaded file may live before the sweep removes it. */
  ttlMs: number
  /** Sweep interval; 0 disables the periodic sweep. */
  sweepIntervalMs: number
  /** Concurrent upload bodies admitted at once. */
  maxConcurrent: number
  /** Per-session storage byte quota; 0 disables the check. */
  maxSessionBytes?: number
  /**
   * Resolve a session id to its workspace cwd. When the resolver exists but
   * returns undefined the request is rejected (unauthenticated session);
   * when the resolver is absent (no sessions service injected) requests fall
   * back to `defaultDir`.
   */
  sessionCwd?: (sessionId: string) => string | undefined | Promise<string | undefined>
  /** Fallback storage root when no sessions service is available. */
  defaultDir: string
  /** 额外信任的上传 Host（裸 host 匹配任意端口，host:port 精确匹配）；默认仅回环。 */
  trustedHosts?: string[]
  now?: () => number
}

/**
 * Control chars, path separators, dot segments and leading dots stripped;
 * then truncated by UTF-8 BYTES, not characters, with the extension
 * preserved: 120 CJK characters are 360 bytes and exceed the common 255-byte
 * filename limit, so writeFile would fail with ENAMETOOLONG on long Chinese
 * names — but cutting the stem must not also cut ".pdf"/".xlsx", or the
 * extension allowlist and client badge would see a nameless file.
 */
export function sanitizeFileName(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '')
  const segments = cleaned.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..')
  const joined = segments.join('_').replace(/^\.+/, '').trim()
  // 分离扩展名：最后一个点之后的 1-8 个 ASCII 字符才算扩展名。`.pdf` 这类
  // 「裸扩展名」输入在前导点剥离后变成 "pdf"（无点），stem 即全名，不会
  // 丢字符。上限 8：覆盖 .docx/.xlsx/.webp，挡掉超长「扩展名」——否则
  // extBytes 可被撑到 120 以上，stem 截断条件永远无法满足，120 字节上限
  // 被绕过（ENAMETOOLONG 回归）。
  const dot = joined.lastIndexOf('.')
  const extCandidate = dot > 0 && dot < joined.length - 1 ? joined.slice(dot + 1) : ''
  const ext =
    extCandidate !== '' && /^[A-Za-z0-9]{1,8}$/.test(extCandidate) ? `.${extCandidate.toLowerCase()}` : ''
  const stem = ext !== '' ? joined.slice(0, dot) : joined
  // 纯点串（"." / ".."）不是合法文件名。
  if (/^\.+$/.test(stem)) return 'upload.bin'
  const MAX_BYTES = 120
  const extBytes = Buffer.byteLength(ext)
  let bytes = 0
  let cut = stem.length
  // 按字符（code point）迭代而不是按 code unit 遍历：codePointAt + i++ 会
  // 在 astral 字符（emoji，4 字节）中途把切点停在代理对中间，切出孤立代理
  // （\ud83d.pdf 这类损坏文件名）。for...of 每次给一个完整字符，ch.length
  // 是该字符在 UTF-16 里的 code unit 数（astral=2, BMP=1），切点永远落在
  // 完整字符边界。
  let codeUnit = 0
  for (const ch of stem) {
    const code = ch.codePointAt(0) ?? 0
    const width = code > 0xffff ? 4 : code > 0x7ff ? 3 : code > 0x7f ? 2 : 1
    const next = codeUnit + ch.length
    if (bytes + width > MAX_BYTES - extBytes) {
      cut = codeUnit
      break
    }
    bytes += width
    codeUnit = next
  }
  const name = stem.slice(0, cut) + ext
  return name === '' ? 'upload.bin' : name
}

/** Session ids are opaque tokens; still constrain them to a safe alphabet. */
export function sanitizeSessionId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80)
  return cleaned === '' ? 'anonymous' : cleaned
}

/**
 * 上传文件的读取体量提示：给前端/后续读取一个「读起来贵不贵」的档位。
 * 模型侧体量感知由 read_document 的 totalLines 承担，这里主要帮前端预览/预判成本。
 */
export function readHintFor(
  sniffedFormat: string | null,
  bytes: number
): { cost: 'cheap' | 'moderate' | 'expensive'; estimatedChars: number } {
  const cost = bytes > 8 * 1024 * 1024 ? 'expensive' : bytes > 1024 * 1024 ? 'moderate' : 'cheap'
  // 仅文本可粗略估算可读字符（UTF-8 中文 <1 字/字节、ASCII 1:1），其它
  // 格式文本量无法从字节直推，给一个保守默认。
  const estimatedChars = sniffedFormat === 'text' ? Math.min(24000, Math.max(2000, Math.round(bytes * 0.6))) : 12000
  return { cost, estimatedChars }
}

/** Whether any file in `dir` starts with `prefix` (the sha256 content digest). */
async function fileWithPrefixExists(dir: string, prefix: string): Promise<boolean> {
  try {
    const entries = await readdir(dir)
    return entries.some((entry) => entry.startsWith(prefix))
  } catch {
    // dir not created yet — nothing stored
    return false
  }
}

/**
 * Recursive byte total of regular files under `dir` (0 when absent). Folder
 * uploads store files in subdirectories, so the per-session quota must count
 * the whole tree, not just the top level. Symlinks are skipped.
 */
async function directoryBytes(dir: string): Promise<number> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(path)
    else if (entry.isFile()) {
      try {
        total += (await stat(path)).size
      } catch {
        // raced with a DELETE or sweep
      }
    }
  }
  return total
}

export function createUploadHandler(options: UploadOptions) {
  const {
    maxBytes,
    allowedExtensions,
    ttlMs,
    maxConcurrent,
    maxSessionBytes = 0,
    sessionCwd,
    defaultDir,
    trustedHosts = [],
    now = () => Date.now()
  } = options

  let inflight = 0

  async function storageDirFor(req: IncomingMessage): Promise<{ dir: string; sessionId: string } | null> {
    const raw = req.headers['x-session-id']
    const sessionId = typeof raw === 'string' ? sanitizeSessionId(raw) : 'anonymous'
    if (sessionCwd !== undefined) {
      const cwd = await sessionCwd(sessionId)
      if (cwd === undefined) return null
      return { dir: join(cwd, '.dsh-filess', sessionId), sessionId }
    }
    return { dir: join(defaultDir, '.dsh-filess', sessionId), sessionId }
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 限流检查必须与 inflight += 1 之间无 await（Node 单线程下原子），
    // 且要在 storageDirFor 之后——否则两个请求可同时通过检查。
    const storage = await storageDirFor(req)
    if (storage === null) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown session' }))
      return
    }
    if (inflight >= maxConcurrent) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'too many concurrent uploads' }))
      return
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'payload too large' }))
      return
    }
    inflight += 1
    try {
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buf.length
        if (total > maxBytes) {
          // 提前阻止继续缓冲，但要排空剩余请求体，否则 keep-alive 连接
          // 会被未消费的 body 挂起，导致后续上传卡住。
          req.resume()
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'payload too large' }))
          return
        }
        chunks.push(buf)
      }
      if (total === 0) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'empty upload' }))
        return
      }
      let rawName = 'upload.bin'
      try {
        const header = String(req.headers['x-file-name'] ?? '')
        if (header !== '') rawName = decodeURIComponent(header)
      } catch {
        // fall through to the default name
      }
      const name = sanitizeFileName(rawName)
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
      if (allowedExtensions.length > 0 && !allowedExtensions.includes(ext)) {
        res.writeHead(415, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `extension ".${ext}" not allowed` }))
        return
      }
      const data = Buffer.concat(chunks)
      // 会话配额：文件夹上传会把文件存进子目录，统计必须递归整棵树。
      // 检查放在 inflight 内，两个并发请求仍可能同时通过（低风险，TTL 会回收）。
      if (maxSessionBytes > 0) {
        const used = await directoryBytes(storage.dir)
        if (used + data.length > maxSessionBytes) {
          res.writeHead(507, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: `session upload quota exceeded (${maxSessionBytes} bytes)` }))
          return
        }
      }
      await mkdir(storage.dir, { recursive: true })
      const digest = createHash('sha256').update(data).digest('hex').slice(0, 12)
      // 文件夹上传保留子目录层级：x-file-relative-path 里的目录前缀重建在
      // 会话上传目录内（如 sub/dir/file.pdf → <session>/.dsh-filess/<sid>/sub/dir/<digest>-file.pdf）。
      // 相对路径已按 POSIX 解析并去段，拒绝 ../ 与绝对路径。
      let subDir = ''
      try {
        const rel = String(req.headers['x-file-relative-path'] ?? '')
        if (rel !== '') {
          const decoded = decodeURIComponent(rel)
          const normalized = decoded.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.' && s !== '..')
          if (normalized.length > 0) {
            const safe = normalized.map((s) => sanitizeFileName(s)).filter((s) => s !== 'upload.bin' && s !== '')
            subDir = safe.join('/')
          }
        }
      } catch {
        // 非法相对路径：忽略，平铺到会话根
      }
      const dirWithSub = subDir === '' ? storage.dir : join(storage.dir, subDir)
      await mkdir(dirWithSub, { recursive: true })
      const dest = join(dirWithSub, `${digest}-${name}`)
      let deduplicated = false
      // 去重键是内容 digest：同内容不同名只存一份。writeFile 的 wx 旗标
      // 只对同名生效，所以先按 digest 前缀找已存在的同内容文件，
      // 命中时返回已存在文件的真实路径（模型读它不会 404）。
      let path = dest
      if (!(await fileWithPrefixExists(dirWithSub, digest))) {
        try {
          await writeFile(dest, data, { flag: 'wx' })
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') deduplicated = true
          else throw err
        }
      } else {
        deduplicated = true
        const entries = await readdir(dirWithSub)
        const existing = entries.find((entry) => entry.startsWith(digest))
        // 竞态保护：sweep 可能在 find 前一瞬删掉这个同 digest 文件，此时
        // existing 为 undefined，返回一个不存在的路径会让模型读取 404。
        // 回退为直接写入（wx 保原子）；EEXIST 则重新判定为去重成功。
        if (existing !== undefined) {
          path = join(dirWithSub, existing)
        } else {
          deduplicated = false
          try {
            await writeFile(dest, data, { flag: 'wx' })
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') deduplicated = true
            else throw err
          }
        }
      }
      // 嗅探前移：上传时字节已在内存，顺手判定真实格式（不信任扩展名），
      // 客户端据此显示真实格式徽章，伪装文件一上传就暴露。
      const sniffedFormat = sniffFormat(data)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          path,
          name,
          bytes: data.length,
          sessionId: storage.sessionId,
          sniffedFormat,
          readHint: readHintFor(sniffedFormat, data.length),
          ...(deduplicated ? { deduplicated: true } : {})
        })
      )
    } catch (err) {
      console.error('[dsh-files] upload persist failed:', err)
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'write failed' }))
    } finally {
      inflight -= 1
    }
  }

  async function handleDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const storage = await storageDirFor(req)
    if (storage === null) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown session' }))
      return
    }
    const url = new URL(req.url ?? '', 'http://localhost')
    // searchParams.get 已做一次百分号解码；这里不能再用 decodeURIComponent
    // 二次解码——上传允许文件名含 %（如 "50%off.pdf"），二次解码会把 "%of"
    // 之类序列打抛 URIError 且未捕获，keep-alive 连接就此挂起。
    const target = url.searchParams.get('path') ?? ''
    if (target === '') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing path' }))
      return
    }
    const root = resolve(storage.dir)
    const resolved = resolve(target)
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'path outside session upload dir' }))
      return
    }
    try {
      await unlink(resolved)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ removed: true }))
    } catch {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    }
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      res.writeHead(405, { allow: 'POST, DELETE' })
      res.end('method not allowed')
      return
    }
    const denied = networkGuard(req, trustedHosts)
    if (denied !== null) {
      res.writeHead(403)
      res.end(denied)
      return
    }
    if (req.method === 'DELETE') {
      await handleDelete(req, res)
      return
    }
    await handlePost(req, res)
  }
}

export interface SweepResult {
  removedFiles: number
  removedDirs: number
}

/**
 * Periodically sweep one root (string form) or every root a provider returns
 * (function form). The provider is evaluated per tick so roots discovered at
 * runtime — live session workspaces, or session cwds recorded while serving
 * uploads — are picked up without re-registration. Returns a dispose
 * function; safe to call concurrently with uploads (a file written after the
 * sweep's readdir is newer than the sweep window, and unlink failures are
 * ignored).
 */
export function createSweeper(
  roots: string | (() => string[]),
  ttlMs: number,
  intervalMs: number,
  now: () => number = () => Date.now()
) {
  if (intervalMs <= 0) return () => undefined
  const timer = setInterval(() => {
    void (async () => {
      const list = typeof roots === 'function' ? roots() : [roots]
      for (const root of new Set(list)) {
        try {
          await sweep(root, ttlMs, now)
        } catch (err) {
          console.error('[dsh-files] upload sweep failed:', err)
        }
      }
    })()
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

export async function sweep(root: string, ttlMs: number, now: () => number = () => Date.now()): Promise<SweepResult> {
  const cutoff = now() - ttlMs
  const counters = { files: 0, dirs: 0 }
  // Uploaded files live at <root>/.dsh-filess/<sessionId>[/sub/dir/…]: the
  // base is the single entry point; recursion covers folder-upload subtrees.
  await sweepDir(join(root, '.dsh-filess'), cutoff, counters)
  return { removedFiles: counters.files, removedDirs: counters.dirs }
}

/**
 * Post-order recursive sweep of one directory: expired files unlinked, and a
 * child directory that ends up empty is reaped bottom-up (session dirs and
 * folder-upload subdirs included). Symlinks are skipped entirely — a link
 * must never widen the sweep beyond the uploads base. Unlink/rmdir failures
 * are ignored (raced with a DELETE, a concurrent upload or another sweep).
 */
async function sweepDir(dir: string, cutoff: number, counters: { files: number; dirs: number }): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await sweepDir(path, cutoff, counters)
      try {
        if ((await readdir(path)).length === 0) {
          await rmdir(path)
          counters.dirs += 1
        }
      } catch {
        // raced with a DELETE or another sweep; non-empty dirs fail rmdir
      }
    } else if (entry.isFile()) {
      try {
        const info = await stat(path)
        if (info.mtimeMs < cutoff) {
          await unlink(path)
          counters.files += 1
        }
      } catch {
        // raced with a DELETE or another sweep
      }
    }
  }
}
