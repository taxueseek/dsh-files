// Upload HTTP surface. Security model:
//   - loopback or configured trusted host, same-origin and same-site checks
//     (mirrors the official dsh-files-button contract)
//   - files land in a per-session directory under the session's own cwd
//     (`.dsh-filess/<sessionId>`), so the agent's fs backend can always
//     resolve them and storage is isolated between sessions
//   - sanitized file names, size cap, optional extension allowlist, sha256
//     content dedup, bounded concurrency, TTL sweep
import { createHash } from 'node:crypto';
import { mkdir, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { sniffFormat } from "./detect.js";
import { networkGuard } from "./guard.js";
/**
 * Control chars, path separators, dot segments and leading dots stripped;
 * then truncated by UTF-8 BYTES, not characters, with the extension
 * preserved: 120 CJK characters are 360 bytes and exceed the common 255-byte
 * filename limit, so writeFile would fail with ENAMETOOLONG on long Chinese
 * names — but cutting the stem must not also cut ".pdf"/".xlsx", or the
 * extension allowlist and client badge would see a nameless file.
 */
export function sanitizeFileName(raw) {
    const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '');
    const segments = cleaned.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..');
    const joined = segments.join('_').replace(/^\.+/, '').trim();
    // 分离扩展名：最后一个点之后的 1-8 个字符（无空格）。
    // 注意 joined 已剥掉前导点，但 ".foo" 会变成 "foo"（无点），
    // 而 "..." 会被剥成空串，走 upload.bin 兜底。
    const dot = joined.lastIndexOf('.');
    const ext = dot > 0 && dot < joined.length - 1 ? joined.slice(dot) : '';
    const stem = dot > 0 ? joined.slice(0, dot) : joined;
    // 纯点串（"." / ".."）不是合法文件名。
    if (/^\.+$/.test(stem))
        return 'upload.bin';
    const MAX_BYTES = 120;
    const extBytes = Buffer.byteLength(ext);
    let bytes = 0;
    let cut = stem.length;
    for (let i = 0; i < stem.length; i++) {
        const code = stem.codePointAt(i) ?? 0;
        const width = code > 0xffff ? 4 : code > 0x7ff ? 3 : code > 0x7f ? 2 : 1;
        if (bytes + width > MAX_BYTES - extBytes) {
            cut = i;
            break;
        }
        bytes += width;
    }
    const name = stem.slice(0, cut) + ext;
    return name === '' ? 'upload.bin' : name;
}
/** Session ids are opaque tokens; still constrain them to a safe alphabet. */
export function sanitizeSessionId(id) {
    const cleaned = id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
    return cleaned === '' ? 'anonymous' : cleaned;
}
/** Whether any file in `dir` starts with `prefix` (the sha256 content digest). */
async function fileWithPrefixExists(dir, prefix) {
    try {
        const entries = await readdir(dir);
        return entries.some((entry) => entry.startsWith(prefix));
    }
    catch {
        // dir not created yet — nothing stored
        return false;
    }
}
export function createUploadHandler(options) {
    const { maxBytes, allowedExtensions, ttlMs, maxConcurrent, maxSessionBytes = 0, sessionCwd, defaultDir, trustedHosts = [], now = () => Date.now() } = options;
    let inflight = 0;
    async function storageDirFor(req) {
        const raw = req.headers['x-session-id'];
        const sessionId = typeof raw === 'string' ? sanitizeSessionId(raw) : 'anonymous';
        if (sessionCwd !== undefined) {
            const cwd = await sessionCwd(sessionId);
            if (cwd === undefined)
                return null;
            return { dir: join(cwd, '.dsh-filess', sessionId), sessionId };
        }
        return { dir: join(defaultDir, '.dsh-filess', sessionId), sessionId };
    }
    async function handlePost(req, res) {
        // 限流检查必须与 inflight += 1 之间无 await（Node 单线程下原子），
        // 且要在 storageDirFor 之后——否则两个请求可同时通过检查。
        const storage = await storageDirFor(req);
        if (storage === null) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'unknown session' }));
            return;
        }
        if (inflight >= maxConcurrent) {
            res.writeHead(429, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'too many concurrent uploads' }));
            return;
        }
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'payload too large' }));
            return;
        }
        inflight += 1;
        try {
            const chunks = [];
            let total = 0;
            for await (const chunk of req) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += buf.length;
                if (total > maxBytes) {
                    res.writeHead(413, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: 'payload too large' }));
                    return;
                }
                chunks.push(buf);
            }
            if (total === 0) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'empty upload' }));
                return;
            }
            let rawName = 'upload.bin';
            try {
                const header = String(req.headers['x-file-name'] ?? '');
                if (header !== '')
                    rawName = decodeURIComponent(header);
            }
            catch {
                // fall through to the default name
            }
            const name = sanitizeFileName(rawName);
            const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
            if (allowedExtensions.length > 0 && !allowedExtensions.includes(ext)) {
                res.writeHead(415, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: `extension ".${ext}" not allowed` }));
                return;
            }
            const data = Buffer.concat(chunks);
            // 会话配额：TTL 周期内每会话文件数有限，readdir+stat 统计可接受。
            // 检查放在 inflight 内，两个并发请求仍可能同时通过（低风险，TTL 会回收）。
            if (maxSessionBytes > 0) {
                let used = 0;
                try {
                    const entries = await readdir(storage.dir);
                    for (const entry of entries) {
                        try {
                            used += (await stat(join(storage.dir, entry))).size;
                        }
                        catch {
                            // raced with a DELETE or sweep
                        }
                    }
                }
                catch {
                    // dir not created yet — nothing stored
                }
                if (used + data.length > maxSessionBytes) {
                    res.writeHead(507, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: `session upload quota exceeded (${maxSessionBytes} bytes)` }));
                    return;
                }
            }
            await mkdir(storage.dir, { recursive: true });
            const digest = createHash('sha256').update(data).digest('hex').slice(0, 12);
            const dest = join(storage.dir, `${digest}-${name}`);
            let deduplicated = false;
            // 去重键是内容 digest：同内容不同名只存一份。writeFile 的 wx 旗标
            // 只对同名生效，所以先按 digest 前缀找已存在的同内容文件，
            // 命中时返回已存在文件的真实路径（模型读它不会 404）。
            let path = dest;
            if (!(await fileWithPrefixExists(storage.dir, digest))) {
                try {
                    await writeFile(dest, data, { flag: 'wx' });
                }
                catch (err) {
                    if (err?.code === 'EEXIST')
                        deduplicated = true;
                    else
                        throw err;
                }
            }
            else {
                deduplicated = true;
                const entries = await readdir(storage.dir);
                const existing = entries.find((entry) => entry.startsWith(digest));
                if (existing !== undefined)
                    path = join(storage.dir, existing);
            }
            // 嗅探前移：上传时字节已在内存，顺手判定真实格式（不信任扩展名），
            // 客户端据此显示真实格式徽章，伪装文件一上传就暴露。
            const sniffedFormat = sniffFormat(data);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                path,
                name,
                bytes: data.length,
                sessionId: storage.sessionId,
                sniffedFormat,
                ...(deduplicated ? { deduplicated: true } : {})
            }));
        }
        catch (err) {
            console.error('[dsh-files] upload persist failed:', err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'write failed' }));
        }
        finally {
            inflight -= 1;
        }
    }
    async function handleDelete(req, res) {
        const storage = await storageDirFor(req);
        if (storage === null) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'unknown session' }));
            return;
        }
        const url = new URL(req.url ?? '', 'http://localhost');
        const target = decodeURIComponent(url.searchParams.get('path') ?? '');
        if (target === '') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing path' }));
            return;
        }
        const root = resolve(storage.dir);
        const resolved = resolve(target);
        if (resolved !== root && !resolved.startsWith(root + sep)) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'path outside session upload dir' }));
            return;
        }
        try {
            await unlink(resolved);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ removed: true }));
        }
        catch {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
        }
    }
    return async (req, res) => {
        if (req.method !== 'POST' && req.method !== 'DELETE') {
            res.writeHead(405, { allow: 'POST, DELETE' });
            res.end('method not allowed');
            return;
        }
        const denied = networkGuard(req, trustedHosts);
        if (denied !== null) {
            res.writeHead(403);
            res.end(denied);
            return;
        }
        if (req.method === 'DELETE') {
            await handleDelete(req, res);
            return;
        }
        await handlePost(req, res);
    };
}
/**
 * Remove uploaded files older than `ttlMs` and the emptied session
 * directories. Returns a dispose function; safe to call concurrently with
 * uploads (a file written after the sweep's readdir is newer than the sweep
 * window, and unlink failures are ignored).
 */
export function createSweeper(root, ttlMs, intervalMs, now = () => Date.now()) {
    if (intervalMs <= 0)
        return () => undefined;
    const timer = setInterval(() => {
        void sweep(root, ttlMs, now).catch((err) => {
            console.error('[dsh-files] upload sweep failed:', err);
        });
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}
export async function sweep(root, ttlMs, now = () => Date.now()) {
    const cutoff = now() - ttlMs;
    let removedFiles = 0;
    let removedDirs = 0;
    // Uploaded files live at <root>/.dsh-filess/<sessionId>/; session dirs are
    // the only entries directly under the uploads base.
    const base = join(root, '.dsh-filess');
    let sessions;
    try {
        sessions = await readdir(base);
    }
    catch {
        return { removedFiles: 0, removedDirs: 0 };
    }
    for (const session of sessions) {
        const dir = join(base, session);
        let info;
        try {
            info = await stat(dir);
        }
        catch {
            continue;
        }
        if (!info.isDirectory())
            continue;
        let files;
        try {
            files = await readdir(dir);
        }
        catch {
            continue;
        }
        for (const file of files) {
            const path = join(dir, file);
            try {
                const fileInfo = await stat(path);
                if (fileInfo.mtimeMs < cutoff) {
                    await unlink(path);
                    removedFiles += 1;
                }
            }
            catch {
                // raced with a DELETE or another sweep
            }
        }
        try {
            const remaining = await readdir(dir);
            if (remaining.length === 0) {
                await rmdir(dir);
                removedDirs += 1;
            }
        }
        catch {
            // ignore
        }
    }
    return { removedFiles, removedDirs };
}
