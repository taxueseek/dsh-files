// Upload HTTP surface. Security model:
//   - loopback-only host, same-origin and same-site checks (mirrors the
//     official dsh-files-button contract)
//   - files land in a per-session directory under the session's own cwd
//     (`.dsh-filess/<sessionId>`), so the agent's fs backend can always
//     resolve them and storage is isolated between sessions
//   - sanitized file names, size cap, optional extension allowlist, sha256
//     content dedup, bounded concurrency, TTL sweep
import { createHash } from 'node:crypto';
import { mkdir, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
/** True when the request passes the loopback/origin/site guards; writes a 403 otherwise. */
export function guardLoopbackRequest(req, res) {
    const host = String(req.headers?.host ?? '');
    if (!LOOPBACK_HOST.test(host)) {
        res.writeHead(403);
        res.end('forbidden: non-loopback host');
        return false;
    }
    const origin = req.headers?.origin;
    if (origin !== undefined) {
        const scheme = req.socket?.encrypted ? 'https' : 'http';
        if (origin !== `${scheme}://${host}`) {
            res.writeHead(403);
            res.end('forbidden: cross-origin');
            return false;
        }
    }
    const secFetchSite = req.headers?.['sec-fetch-site'];
    if (secFetchSite !== undefined && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
        res.writeHead(403);
        res.end('forbidden: cross-site');
        return false;
    }
    return true;
}
/** Control chars, path separators, dot segments and leading dots stripped. */
export function sanitizeFileName(raw) {
    const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '');
    const segments = cleaned.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..');
    const name = segments.join('_').replace(/^\.+/, '').trim().slice(0, 120);
    return name === '' ? 'upload.bin' : name;
}
/** Session ids are opaque tokens; still constrain them to a safe alphabet. */
export function sanitizeSessionId(id) {
    const cleaned = id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
    return cleaned === '' ? 'anonymous' : cleaned;
}
export function createUploadHandler(options) {
    const { maxBytes, allowedExtensions, ttlMs, maxConcurrent, sessionCwd, defaultDir, now = () => Date.now() } = options;
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
            await mkdir(storage.dir, { recursive: true });
            const digest = createHash('sha256').update(data).digest('hex').slice(0, 12);
            const dest = join(storage.dir, `${digest}-${name}`);
            let deduplicated = false;
            try {
                await writeFile(dest, data, { flag: 'wx' });
            }
            catch (err) {
                if (err?.code === 'EEXIST')
                    deduplicated = true;
                else
                    throw err;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                path: dest,
                name,
                bytes: data.length,
                sessionId: storage.sessionId,
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
        if (!guardLoopbackRequest(req, res))
            return;
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
