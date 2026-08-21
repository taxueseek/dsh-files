// dsh-files — a dual-face DeepSeek Harness plugin: one cordis row, one apply,
// two capabilities:
//   1. read_document tool (host): sniffed-format text extraction for
//      text/PDF/DOCX/XLSX with size pre-check and LRU parse cache.
//   2. upload surface (host webServer + web client): composer paperclip that
//      stores files per session inside the session workspace and attaches the
//      path to the outgoing message.
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineReadDocumentTool } from "./tool.js";
import { createUploadHandler, createSweeper } from "./upload.js";
import { ParseCache } from "./cache.js";
import { assertTrustedAuthority } from "./guard.js";
/** Cordis plugin name — must match the row id in cordis.patch.yml. */
export const name = 'dsh-files';
/** Services required by this plugin. */
export const inject = ['tools', 'fs', 'systemPrompt', 'webServer', 'sessions'];
const MEBIBYTE = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
export const Config = z.object({
    /** Byte cap for one document read (PDF parsing amplifies memory severalfold). */
    maxFileBytes: z.number().default(24 * MEBIBYTE),
    /** Default and maximum number of lines returned by one call. */
    readLimit: z.number().default(800),
    /** Rows kept per worksheet. */
    sheetRowLimit: z.number().default(200),
    /** Sheets read per workbook (the rest are reported as truncated). */
    maxSheets: z.number().default(5),
    /** Parse-cache capacity (targetKey + version fingerprints). */
    cacheEntries: z.number().default(16),
    /** Parse-cache byte budget; large PDFs dominate retained memory. */
    cacheMaxBytes: z.number().default(64 * MEBIBYTE),
    /** Per-call window character budget; the window is truncated with an explicit marker when exceeded. */
    maxOutputChars: z.number().default(50000),
    /** Byte cap for one upload body. */
    uploadMaxBytes: z.number().default(24 * MEBIBYTE),
    /** Lowercase extension allowlist for uploads; empty means all allowed. */
    allowedExtensions: z.array(z.string()).default([]),
    /** Uploaded files older than this are swept away. */
    uploadTtlMs: z.number().default(7 * DAY_MS),
    /** Sweep interval; 0 disables the periodic sweep. */
    sweepIntervalMs: z.number().default(60 * 60 * 1000),
    /** Concurrent upload bodies admitted at once. */
    maxConcurrentUploads: z.number().default(4),
    /** Per-session storage byte quota; 0 disables the check. */
    maxUploadBytesPerSession: z.number().default(0),
    /** Upload storage root; files land in <root>/.dsh-filess/<sessionId>/. */
    uploadDir: z.string().default(join(process.cwd(), 'uploads')),
    /**
     * Non-loopback authorities the upload fence accepts (e.g. the value of
     * `dsh web --trusted-host` for reverse-tunnel / LAN deployments). Port-less
     * entries match any port; entries with an explicit port match exactly.
     * Empty keeps the loopback-only default.
     */
    trustedHosts: z.array(z.string()).default([])
});
function assertPositiveInteger(value, label) {
    if (!Number.isInteger(value) || value < 1)
        throw new Error(`dsh-files: ${label} must be a positive integer`);
}
export function apply(ctx, config) {
    for (const [label, value] of [
        ['maxFileBytes', config.maxFileBytes],
        ['readLimit', config.readLimit],
        ['sheetRowLimit', config.sheetRowLimit],
        ['maxSheets', config.maxSheets],
        ['cacheEntries', config.cacheEntries],
        ['cacheMaxBytes', config.cacheMaxBytes],
        ['maxOutputChars', config.maxOutputChars],
        ['uploadMaxBytes', config.uploadMaxBytes],
        ['uploadTtlMs', config.uploadTtlMs],
        ['sweepIntervalMs', config.sweepIntervalMs],
        ['maxConcurrentUploads', config.maxConcurrentUploads]
    ]) {
        assertPositiveInteger(value, label);
    }
    if (!Number.isInteger(config.maxUploadBytesPerSession) || config.maxUploadBytesPerSession < 0) {
        throw new Error('dsh-files: maxUploadBytesPerSession must be a non-negative integer');
    }
    for (const entry of config.trustedHosts)
        assertTrustedAuthority(entry);
    const cache = new ParseCache(config.cacheEntries, config.cacheMaxBytes);
    ctx.systemPrompt.section({
        name: 'tool:read-document',
        order: 110,
        text: 'read_document reads PDF/DOCX/XLSX (and plain text) the read tool cannot; page with offset/limit, list_sheets then sheet=N for XLSX.'
    });
    ctx.tools.register(defineReadDocumentTool(ctx, {
        readLimit: config.readLimit,
        maxFileBytes: config.maxFileBytes,
        sheetRowLimit: config.sheetRowLimit,
        maxSheets: config.maxSheets,
        maxOutputChars: config.maxOutputChars
    }, cache));
    const defaultDir = config.uploadDir ?? join(process.cwd(), 'uploads');
    const sessionCwd = (sessionId) => {
        const session = ctx.sessions.get(sessionId);
        return session === undefined ? undefined : session.header.cwd;
    };
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: '/api/upload',
        handler: createUploadHandler({
            maxBytes: config.uploadMaxBytes,
            allowedExtensions: config.allowedExtensions,
            ttlMs: config.uploadTtlMs,
            sweepIntervalMs: config.sweepIntervalMs,
            maxConcurrent: config.maxConcurrentUploads,
            maxSessionBytes: config.maxUploadBytesPerSession,
            defaultDir,
            sessionCwd,
            trustedHosts: config.trustedHosts
        })
    }));
    const disposeSweeper = createSweeper(defaultDir, config.uploadTtlMs, config.sweepIntervalMs);
    ctx.on('dispose', disposeSweeper);
}
