// 附件库的模型侧窗口：attachment_list 让黑箱可见，export_attachment 补上
// 「上传件 → 工作区」的搬运断点（模型对附件只有一行只读路径 handle，此前
// read/edit/bash 都够不着附件目录）。导出的写入必须先过 ctx.fs.resolve 的
// 沙箱校验，落地用 node:fs 的 COPYFILE_EXCL（writeText 只收 UTF-8 文本，
// 二进制附件走不了官方写通道；EXCL 语义同时防竞态覆盖）。
import { copyFile, constants as fsConstants } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { FsError } from '@deepseek-ai/dsh-fs';
import { listAttachments, findAttachment } from "./attachments.js";
import { formatBytes, formatTime } from "./format.js";
import { sessionCwd } from "./tool.js";
/** 清单上限：防附件库失控时一次调用撑爆上下文；截断时显式标记。 */
const MAX_LIST_ITEMS = 200;
function requireString(args, key) {
    const value = args[key];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${key} must be a non-empty string`);
    }
    return value.trim();
}
export function defineAttachmentListTool(config) {
    return defineTool({
        name: 'attachment_list',
        description: 'List files in the session attachment library (uploads via the paperclip/folder button): original name, sha256 prefix, size, last modified. An optional query filters by name substring before the 200-item cap, so libraries larger than one listing stay reachable. Pair with export_attachment to copy one into the workspace.',
        parameters: {
            query: {
                type: 'string',
                description: 'Optional case-insensitive substring matched against original file names; omit to list everything.'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    count: { type: 'integer', required: true },
                    truncated: { type: 'boolean', required: true },
                    totalBytes: { type: 'integer', required: true },
                    items: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                name: { type: 'string', required: true },
                                sha: { type: 'string', required: true },
                                bytes: { type: 'integer', required: true },
                                modified: { type: 'string', required: true }
                            }
                        }
                    }
                }
            },
            render: (_args, value) => [
                {
                    type: 'text',
                    text: [
                        `### attachments (${value.count} file(s), ${formatBytes(value.totalBytes)}${value.truncated ? ', showing first ' + value.items.length : ''})`,
                        ...value.items.map((item) => `${item.sha}  ${formatBytes(item.bytes)}  ${item.modified}  ${item.name}`)
                    ].join('\n')
                }
            ]
        },
        isConcurrencySafe: () => true,
        async execute(args) {
            const all = await listAttachments(config.attachmentsDir);
            // query 是名字子串过滤：截断发生在过滤之后——大库按名检索仍然可达，
            // 而不是被前 200 条截断挡在外面。计数与字节数都按过滤后口径上报。
            const rawQuery = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
            const matches = rawQuery === '' ? all : all.filter((entry) => entry.name.toLowerCase().includes(rawQuery));
            const items = matches.slice(0, MAX_LIST_ITEMS);
            return {
                count: matches.length,
                truncated: matches.length > items.length,
                totalBytes: matches.reduce((sum, entry) => sum + entry.bytes, 0),
                items: items.map((entry) => ({
                    name: entry.name,
                    sha: entry.sha.slice(0, 8),
                    bytes: entry.bytes,
                    modified: formatTime(entry.modifiedMs)
                }))
            };
        }
    });
}
export function defineAttachmentExportTool(ctx, config) {
    return defineTool({
        name: 'export_attachment',
        description: 'Copy one uploaded attachment from the session attachment library into the workspace so read/edit/bash can operate on it. Identify the file by the sha prefix (or exact original name) from attachment_list; dest_path must be a new file path.',
        parameters: {
            attachment: {
                type: 'string',
                required: true,
                description: 'sha256 prefix (8+ hex chars, from attachment_list) or the exact original file name.'
            },
            dest_path: {
                type: 'string',
                required: true,
                description: 'Destination file path inside the workspace; must not already exist.'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    path: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    bytes: { type: 'integer', required: true }
                }
            },
            render: (_args, value) => [
                { type: 'text', text: `exported ${value.name} (${formatBytes(value.bytes)}) → ${value.path}` }
            ]
        },
        presentCall(args) {
            return {
                card: 'generic',
                title: `Export attachment ${args.attachment}`,
                kind: 'edit',
                locations: [{ path: args.dest_path }]
            };
        },
        presentResult(_args, result) {
            if (result.isError)
                return undefined;
            const meta = result.meta;
            if (meta === undefined)
                return undefined;
            return {
                card: 'generic',
                title: `Exported ${meta.name} (${formatBytes(meta.bytes)})`,
                content: [{ type: 'text', text: `${meta.name} → ${meta.path}` }]
            };
        },
        // 同 dest 并发由 COPYFILE_EXCL 互斥，不同 dest 互不干扰。
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const id = requireString(args, 'attachment');
            const destPath = requireString(args, 'dest_path');
            const found = await findAttachment(config.attachmentsDir, id);
            const cwd = sessionCwd(exec);
            const target = await ctx.fs.resolve(destPath, {
                ...(cwd !== undefined ? { cwd } : {}),
                signal: exec.signal
            });
            const existing = await ctx.fs.stat(target, exec.signal);
            if (existing !== undefined) {
                throw new FsError(`cannot export "${found.name}" to "${target.displayPath}": destination already exists; choose another dest_path`, 'FS_NOT_OBSERVED');
            }
            ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
            try {
                await copyFile(found.hostPath, target.displayPath, fsConstants.COPYFILE_EXCL);
            }
            catch (error) {
                const code = error?.code;
                if (code === 'EEXIST') {
                    throw new FsError(`cannot export "${found.name}" to "${target.displayPath}": destination already exists; choose another dest_path`, 'FS_NOT_OBSERVED');
                }
                throw new FsError(`cannot export "${found.name}" to "${target.displayPath}": ${error.message ?? 'io error'}`, 'FS_IO_ERROR');
            }
            const after = await ctx.fs.stat(target, exec.signal);
            if (after !== undefined) {
                ctx.emit('fs/observed', target, { kind: 'present', version: after.version }, exec);
            }
            return { path: target.displayPath, name: found.name, bytes: after?.size ?? found.bytes };
        }
    });
}
