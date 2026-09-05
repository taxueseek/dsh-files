// dsh-files — a dual-face DeepSeek Harness plugin: one cordis row, one apply.
// capabilities:
//   1. read_document tool (host): sniffed-format text extraction for
//      text/PDF/DOCX/XLSX with size pre-check and LRU parse cache.
//   2. upload surface (host webServer + web client): composer paperclip that
//      stores files per session inside the session workspace and attaches the
//      path to the outgoing message.
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineReadDocumentTool } from "./tool.js";
import { createUploadHandler, createSweeper } from "./upload.js";
import { createWorkspaceFilesHandler, DEFAULT_IGNORED_DIRS, DEFAULT_IGNORED_EXTENSIONS, DEFAULT_IGNORED_FILES } from "./workspace.js";
import { ParseCache } from "./cache.js";
import { parseHost } from "./guard.js";
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
    /** Parse-cache capacity (targetKey + fs version fingerprints). */
    cacheEntries: z.number().default(16),
    /** Parse-cache byte budget; large PDFs dominate retained memory. */
    cacheMaxBytes: z.number().default(64 * MEBIBYTE),
    /** Per-call window character budget (text uses it in full; pdf/docx get half, xlsx three-quarters). The window is truncated with an explicit marker when exceeded. */
    maxOutputChars: z.number().default(24000),
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
    readTimeoutMs: z.number().default(120_000),
    /** 信任的额外上传 Host，兼容公网域名/反向隧道部署（`dsh web --trusted-host` 同源语义）。 */
    trustedHosts: z.array(z.string()).default([]),
    workspaceMaxDepth: z.number().default(12),
    workspaceMaxFiles: z.number().default(500)
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
        ['maxConcurrentUploads', config.maxConcurrentUploads]
    ]) {
        assertPositiveInteger(value, label);
    }
    // sweepIntervalMs=0 是合法配置：禁用周期清扫（createSweeper 对 0 直接返回
    // no-op disposer）。校验为非负整数即可，不能进上面的正整数断言——那会让
    // 文档承诺的「0 = 禁用」变成启动即抛错的死路径。
    if (!Number.isInteger(config.sweepIntervalMs) || config.sweepIntervalMs < 0) {
        throw new Error('dsh-files: sweepIntervalMs must be a non-negative integer (0 disables the periodic sweep)');
    }
    if (!Number.isInteger(config.maxUploadBytesPerSession) || config.maxUploadBytesPerSession < 0) {
        throw new Error('dsh-files: maxUploadBytesPerSession must be a non-negative integer');
    }
    // 启动时校验 trustedHosts 条目，拼写错误 loud fail（对齐官方 assertTrustedAuthority）。
    for (const entry of config.trustedHosts) {
        if (parseHost(entry) === null) {
            throw new Error(`dsh-files: trustedHosts entry "${entry}" is not a valid host (expected "example.com" or "example.com:443")`);
        }
    }
    const cache = new ParseCache(config.cacheEntries, config.cacheMaxBytes);
    ctx.systemPrompt.section({
        name: 'tool:read-document',
        order: 110,
        text: 'read_document reads PDF/DOCX/XLSX/text the read tool cannot. For large docs: probe structure first (list_sheets, or a small first window), then page with offset/limit; read only what the task needs, then stop.'
    });
    ctx.tools.register(defineReadDocumentTool(ctx, {
        readLimit: config.readLimit,
        maxFileBytes: config.maxFileBytes,
        sheetRowLimit: config.sheetRowLimit,
        maxSheets: config.maxSheets,
        maxOutputChars: config.maxOutputChars,
        readTimeoutMs: config.readTimeoutMs
    }, cache));
    const defaultDir = config.uploadDir ?? join(process.cwd(), 'uploads');
    // 上传根注册表：每次上传记录其会话 cwd（进程生命周期内）。TTL 清扫的根 =
    // defaultDir ∪ live 会话 cwd（sessions.list()）∪ 该注册表。有 sessions 服务
    // 时文件实际落在 <会话工作区>/.dsh-filess/，defaultDir 只是兜底布局；注册表
    // 兜住「上传后会话已关闭」的清扫盲区（list() 只能看到 live 会话）。
    const sessionRoots = new Set();
    const sessionCwd = (sessionId) => {
        const session = ctx.sessions.get(sessionId);
        return session === undefined ? undefined : session.header.cwd;
    };
    const uploadSessionCwd = (sessionId) => {
        const cwd = sessionCwd(sessionId);
        if (cwd !== undefined)
            sessionRoots.add(cwd);
        return cwd;
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
            trustedHosts: config.trustedHosts,
            defaultDir,
            sessionCwd: uploadSessionCwd
        })
    }));
    const disposeSweeper = createSweeper(() => {
        const roots = new Set([defaultDir]);
        for (const cwd of sessionRoots)
            roots.add(cwd);
        try {
            for (const session of ctx.sessions.list()) {
                const cwd = session?.header?.cwd;
                if (typeof cwd === 'string' && cwd !== '')
                    roots.add(cwd);
            }
        }
        catch {
            // sessions 服务不可用时只扫已知根
        }
        return [...roots];
    }, config.uploadTtlMs, config.sweepIntervalMs);
    ctx.on('dispose', disposeSweeper);
    // @ 工作区候选端点：只读返回当前会话 cwd 下的相对路径列表。
    // 与上传端点同款网络护栏；client 侧 30s 缓存，索引上限默认 500 文件 / 12 层深。
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: '/api/workspace-files',
        handler: createWorkspaceFilesHandler({
            sessionCwd,
            trustedHosts: config.trustedHosts,
            indexOptions: {
                ignoredDirs: DEFAULT_IGNORED_DIRS,
                ignoredFiles: DEFAULT_IGNORED_FILES,
                ignoredExtensions: DEFAULT_IGNORED_EXTENSIONS,
                maxDepth: config.workspaceMaxDepth,
                maxFiles: config.workspaceMaxFiles
            }
        })
    }));
}
