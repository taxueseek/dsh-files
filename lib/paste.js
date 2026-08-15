// Pasted-text landing surface. The composer intercepts a long paste, POSTs the
// text here, and the host writes it into the session's own workspace
// (.dsh-filess/<sessionId>) so the fs backend always resolves it. The returned
// path is inserted into the outgoing message as a reference chip; the model
// reads the file on demand with the read_document tool.
//
// Security model mirrors the upload handler: loopback-only host, same-origin /
// same-site checks, per-session storage, sanitized names, byte cap.
import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { guardLoopbackRequest, sanitizeFileName, sanitizeSessionId } from "./upload.js";
function readJsonBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                reject(Object.assign(new Error('payload too large'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (raw.trim() === '') {
                    reject(Object.assign(new Error('empty payload'), { status: 400 }));
                    return;
                }
                resolve(JSON.parse(raw));
            }
            catch (err) {
                reject(Object.assign(new Error('invalid json'), { status: 400, cause: err }));
            }
        });
        req.on('error', reject);
    });
}
export function createPasteTextHandler(options) {
    const { maxBytes, minChars, sessionCwd, defaultDir, nameHint = () => `pasted-${Date.now()}.txt` } = options;
    return async (req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end('method not allowed');
            return;
        }
        if (!guardLoopbackRequest(req, res))
            return;
        const rawSession = req.headers['x-session-id'];
        const sessionId = sanitizeSessionId(typeof rawSession === 'string' ? rawSession : 'anonymous');
        let cwd;
        if (sessionCwd !== undefined) {
            cwd = await sessionCwd(sessionId);
        }
        else {
            cwd = defaultDir;
        }
        if (cwd === undefined) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'unknown session' }));
            return;
        }
        let body;
        try {
            body = await readJsonBody(req, maxBytes + 64 * 1024);
        }
        catch (err) {
            const status = err?.status ?? 500;
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: status === 413 ? 'payload too large' : 'bad request' }));
            return;
        }
        const text = body.text;
        if (typeof text !== 'string' || text.length < minChars) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                error: `text must be a string of at least ${minChars} characters`
            }));
            return;
        }
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > maxBytes) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'text too large' }));
            return;
        }
        const name = sanitizeFileName(typeof body.name === 'string' && body.name !== '' ? body.name : nameHint(text));
        const dir = join(cwd, '.dsh-filess', sessionId);
        await mkdir(dir, { recursive: true });
        const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
        const dest = join(dir, `${digest}-${name}`);
        // Content-address dedup: a same-digest file already present (from any
        // prior paste) is returned as-is regardless of filename differences.
        let deduplicated = false;
        let resolved = dest;
        try {
            const existing = (await readdir(dir)).find((f) => f.startsWith(`${digest}-`));
            if (existing !== undefined) {
                resolved = join(dir, existing);
                deduplicated = true;
            }
            else {
                await writeFile(dest, text, { encoding: 'utf8', flag: 'wx' });
            }
        }
        catch (err) {
            if (err?.code === 'EEXIST') {
                resolved = dest;
                deduplicated = true;
            }
            else {
                console.error('[dsh-files] paste persist failed:', err);
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'write failed' }));
                return;
            }
        }
        const result = {
            path: resolved,
            name,
            bytes,
            lines: text.split('\n').length,
            chars: text.length,
            ...(deduplicated ? { deduplicated: true } : {})
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
    };
}
