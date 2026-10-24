// dsh-files 0.5.0 — a DeepSeek Harness plugin with a single job:
// the read_document tool. Structured text extraction (PDF/DOCX/XLSX/text)
// for files the built-in read tool rejects with FS_NOT_TEXT.
//
// Upload, image pipeline, @ candidates and the composer UI were removed in
// 0.5.0: harness 0.1.3 ships all of them natively (durable attachments with
// progress/cancellation, @file/@session reference, @path grammar), and the
// ablation on 2026-09-05 (plugin disabled, service stable, zero cross-plugin
// deps) proved the remaining value is the parser.
import z from '@deepseek-ai/schemastery';
import { defineReadDocumentTool } from "./tool.js";
import { defineAttachmentListTool, defineAttachmentExportTool } from "./attachment-tool.js";
import { defaultAttachmentsDir } from "./attachments.js";
import { registerAttachmentRoutes } from "./attachment-loop.js";
/** Cordis plugin name — must match the row id in cordis.patch.yml. */
export const name = 'dsh-files';
/** Services required by this plugin. */
export const inject = ['tools', 'fs', 'systemPrompt'];
const MEBIBYTE = 1024 * 1024;
export const Config = z.object({
    /** Byte cap for one document read (PDF parsing amplifies memory severalfold). */
    maxFileBytes: z.number().default(24 * MEBIBYTE),
    /** Default and maximum number of lines returned by one call. */
    readLimit: z.number().default(800),
    /** Rows kept per worksheet. */
    sheetRowLimit: z.number().default(200),
    /** Sheets read per workbook (the rest are reported as truncated). */
    maxSheets: z.number().default(5),
    /** Per-call window character budget (text uses it in full; pdf/docx get half, xlsx three-quarters). The window is truncated with an explicit marker when exceeded. */
    maxOutputChars: z.number().default(24000),
    /** read_document 单次执行超时（ms）。 */
    readTimeoutMs: z.number().default(120_000),
    /** 附件库根（attachments/v1）；空串按 DSH_HOME / ~/.dsh/attachments/v1 自动探测。 */
    attachmentsDir: z.string().default(''),
    /** 附件闭环总开关：false 时不注册任何附件 UI 路由（attachment_list/export_attachment 工具仍生效）。 */
    attachmentsEnabled: z.boolean().default(true),
    /** 单次附件下载/导出的字节上限（超限 413）。 */
    maxDownloadBytes: z.number().default(200 * MEBIBYTE),
    /** 非回环 host[:port] 授权列表；语义同官方 --trusted-host（裸 host 任意端口、host:port 精确）。 */
    trustedHosts: z.array(String).default([])
});
export function apply(ctx, config) {
    for (const [label, value] of [
        ['maxFileBytes', config.maxFileBytes],
        ['readLimit', config.readLimit],
        ['sheetRowLimit', config.sheetRowLimit],
        ['maxSheets', config.maxSheets],
        ['maxOutputChars', config.maxOutputChars],
        ['readTimeoutMs', config.readTimeoutMs],
        ['maxDownloadBytes', config.maxDownloadBytes]
    ]) {
        if (!Number.isInteger(value) || value < 1) {
            throw new Error(`dsh-files: ${label} must be a positive integer`);
        }
    }
    for (const entry of config.trustedHosts) {
        if (entry.trim() === '')
            throw new Error('dsh-files: trustedHosts entries must be non-empty');
    }
    ctx.systemPrompt.section({
        name: 'tool:read-document',
        order: 110,
        text: 'read_document reads PDF/DOC/DOCX/XLSX/text the read tool cannot. For large docs: probe structure first (list_sheets, or a small first window), then page with offset/limit; read only what the task needs, then stop. attachment_list shows what was uploaded this workspace; export_attachment copies an uploaded file into the workspace (by sha prefix) so read/edit/bash can operate on it.'
    });
    const attachmentsDir = config.attachmentsDir.trim() !== '' ? config.attachmentsDir : defaultAttachmentsDir();
    ctx.tools.register(defineReadDocumentTool(ctx, {
        readLimit: config.readLimit,
        maxFileBytes: config.maxFileBytes,
        sheetRowLimit: config.sheetRowLimit,
        maxSheets: config.maxSheets,
        maxOutputChars: config.maxOutputChars,
        readTimeoutMs: config.readTimeoutMs
    }));
    ctx.tools.register(defineAttachmentListTool({ attachmentsDir }));
    ctx.tools.register(defineAttachmentExportTool(ctx, { attachmentsDir }));
    // ---- Attachment loop: panel / download / export / @ source routes ----
    // All services are optional: the read_document + attachment tools keep
    // working in headless or attachment-less deployments; routes simply skip.
    // Registration is deferred through ctx.inject — webServer/attachments/
    // sessions initialize after this plugin's apply, and a plain ctx.get at
    // apply time would see a not-yet-activated webServer (probe-verified).
    if (!config.attachmentsEnabled)
        return;
    ctx.inject?.(['webServer', 'attachments', 'sessions', 'llm'], (loopCtx) => {
        try {
            registerAttachmentRoutes({
                webServer: {
                    // 宿主 webServer.register 只写路由注册表，不随插件 fiber 清理；
                    // disposer 必须显式绑进注入 fiber，插件移除/重载时才能注销路由。
                    // 否则旧路由泄漏、重载撞 duplicate exact route 后旧配置继续生效
                    //（外部反馈 #17，真实宿主探针复现）。
                    register: (route) => loopCtx.effect(function* () {
                        yield loopCtx.webServer.register(route);
                    }, 'dsh-files.attachment-route')
                }
            }, {
                attachments: loopCtx.attachments,
                llm: loopCtx.llm,
                sessions: loopCtx.sessions
            }, {
                attachmentsDir,
                maxDownloadBytes: config.maxDownloadBytes,
                trustedHosts: config.trustedHosts
            });
            console.log('[dsh-files] attachment loop routes registered');
        }
        catch (error) {
            console.warn(`[dsh-files] attachment loop registration failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
}
