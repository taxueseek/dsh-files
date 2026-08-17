// The model-facing read_document tool. Reads through ctx.fs, so workspace
// resolution, sandbox policy and fs-observation policy behave exactly like the
// built-in read tool. Differences from the plain-text read tool: content
// sniffing (never trusts extensions), size pre-check before reading bytes, and
// an LRU parse cache keyed on (targetKey, version, format).
import { defineTool } from '@deepseek-ai/dsh-tools';
import { FsError } from '@deepseek-ai/dsh-fs';
import { sniffFormat, sniffHead, HEAD_SNIFF_BYTES, SUPPORTED_FORMATS, formatFromExtension } from "./detect.js";
import { parseDocument } from "./parse/index.js";
import { windowLines } from "./parse/text.js";
function assertPositiveInteger(value, label) {
    if (!Number.isInteger(value) || value < 1)
        throw new Error(`${label} must be a positive integer`);
}
function parseArgs(args, config) {
    if (typeof args.file_path !== 'string' || args.file_path.trim() === '') {
        throw new Error('file_path must be a non-empty string');
    }
    const filePath = args.file_path.trim();
    const offset = typeof args.offset === 'number' ? args.offset : 1;
    if (!Number.isInteger(offset) || offset < 1)
        throw new Error('offset must be a positive integer');
    const limit = typeof args.limit === 'number' ? args.limit : config.readLimit;
    if (!Number.isInteger(limit) || limit < 1)
        throw new Error('limit must be a positive integer');
    if (limit > config.readLimit)
        throw new Error(`limit must be less than or equal to ${config.readLimit}`);
    const format = args.format === undefined ? 'auto' : args.format;
    if (typeof format !== 'string' || (format !== 'auto' && !SUPPORTED_FORMATS.has(format))) {
        throw new Error(`unsupported format "${String(format)}" (expected auto, pdf, docx, xlsx or text)`);
    }
    const sheet = typeof args.sheet === 'number' ? args.sheet : undefined;
    if (sheet !== undefined && (!Number.isInteger(sheet) || sheet < 1)) {
        throw new Error('sheet must be a positive integer');
    }
    const listSheets = args.list_sheets === true;
    if (listSheets && sheet !== undefined) {
        throw new Error('list_sheets and sheet are mutually exclusive: list first, then read a specific sheet');
    }
    return { filePath, offset, limit, format: format, sheet, listSheets };
}
/** The session workspace cwd for this call, when one applies. */
function sessionCwd(exec) {
    return exec.agent?.session?.header?.cwd;
}
/**
 * Run parseDocument with cooperative cancellation: the underlying parsers
 * (pdfjs/mammoth/read-excel-file) do not take an AbortSignal, so race the
 * parse against the signal and throw the FsError abort code when it fires.
 */
async function parseDocumentWithAbort(bytes, format, options, signal) {
    if (signal.aborted)
        throw new FsError('read_document aborted', 'FS_ABORTED');
    let settle;
    const raced = new Promise((resolve) => {
        settle = resolve;
    });
    const onAbort = () => settle({ ok: false, error: new FsError('read_document aborted', 'FS_ABORTED') });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        void parseDocument(bytes, format, options)
            .then((text) => settle({ ok: true, text }))
            .catch((error) => settle({ ok: false, error }));
        const result = await raced;
        if (result.ok)
            return result.text;
        throw result.error;
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
function renderContent(path, format, value) {
    // 模型看到的正文：完整窗口的行文本。
    // 行号策略按格式分化：text（代码/配置）保留行号供精确定位；
    // pdf/docx/xlsx 是段落/表格流，行号是纯噪音，去掉省 token（每行 ~5 字符）。
    const numbered = format === 'text';
    const body = value.lines.map((l) => (numbered ? `${l.number}: ${l.text}` : l.text)).join('\n');
    return [
        `### document ${path} (${format}) — offset ${value.offset}, ${value.lines.length}/${value.totalLines} lines`,
        body
    ].join('\n');
}
export function defineReadDocumentTool(ctx, config, cache) {
    return defineTool({
        name: 'read_document',
        description: 'Read text, PDF, DOCX or XLSX files the plain read tool cannot handle; returns line-numbered pages. Page with offset/limit.',
        parameters: {
            file_path: {
                type: 'string',
                required: true,
                description: 'Path to the document, resolved by the filesystem backend.'
            },
            format: {
                type: 'string',
                enum: ['auto', 'pdf', 'docx', 'xlsx', 'text'],
                description: 'Optional format override; the sniffed content wins over this hint.'
            },
            offset: {
                type: 'number',
                description: '1-based first line. Defaults to 1.'
            },
            limit: {
                type: 'number',
                description: `Max lines to return. Defaults to ${config.readLimit}.`
            },
            sheet: {
                type: 'number',
                description: '1-based worksheet to read in full (XLSX only).'
            },
            list_sheets: {
                type: 'boolean',
                description: 'List the workbook sheet names without reading cells (XLSX only).'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    path: { type: 'string', required: true },
                    format: { type: 'string', required: true, enum: ['pdf', 'docx', 'xlsx', 'text'] },
                    offset: { type: 'integer', required: true },
                    lines: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                number: { type: 'integer', required: true },
                                text: { type: 'string', required: true }
                            }
                        }
                    },
                    totalLines: { type: 'integer', required: true }
                }
            },
            render: (_args, value) => [
                {
                    type: 'text',
                    text: renderContent(value.path, value.format, value)
                }
            ],
            // 结构化行数据投影给 UI：模型侧只看到紧凑行文本，UI 用 card:'read'
            // 渲染行号/高亮/滚动，与官方 read 工具同一惯例。
            presentationMeta: (_args, value) => ({
                path: value.path,
                format: value.format,
                offset: value.offset,
                totalLines: value.totalLines,
                lines: value.lines
            })
        },
        isConcurrencySafe: () => true,
        // PDF 解析可能很慢（大文件 + pdfjs），超时防止模型空等；
        // 具体数值由部署方通过 timeoutMs 配置（policy 层执行）。
        timeoutMs: 120_000,
        async execute(args, exec) {
            const input = parseArgs(args, config);
            const cwd = sessionCwd(exec);
            const target = await ctx.fs.resolve(input.filePath, {
                ...(cwd !== undefined ? { cwd } : {}),
                signal: exec.signal
            });
            const info = await ctx.fs.stat(target, exec.signal);
            if (info === undefined) {
                ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
                throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND');
            }
            if (info.type !== 'file') {
                throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE');
            }
            if (info.size !== undefined && info.size > config.maxFileBytes) {
                ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
                throw new FsError(`cannot read "${target.displayPath}": file is ${info.size} bytes, over the ${config.maxFileBytes} byte limit`, 'FS_TOO_LARGE');
            }
            // 一次读取完整内容（受 maxFileBytes 上限约束），从头部分字节判定格式。
            // 注意：ctx.fs.readBytes 的 maxBytes 语义是「整个文件必须 ≤ 上限」，
            // 不能用小上限做「只读前 64 KiB」的头部预读——那会把所有大文件误拒。
            const bytes = await ctx.fs.readBytes(target, exec.signal, config.maxFileBytes);
            const headFormat = sniffHead(bytes.subarray(0, HEAD_SNIFF_BYTES));
            if (headFormat === null && input.format === 'auto') {
                ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
                throw new FsError(`cannot read "${target.displayPath}": unrecognized file content (expected text, PDF, DOCX or XLSX)`, 'FS_NOT_TEXT');
            }
            // zip 需要中央目录（在文件尾部）才能区分 docx/xlsx；
            // headFormat 为 null 只发生在显式 format 场景，走完整嗅探兜底。
            // auto 模式下的 hint 取扩展名：字节完全未知时（且非已知二进制）
            // 允许按扩展名兜底解析，解析器仍会校验结构并 loud fail。
            const hint = input.format === 'auto' ? (formatFromExtension(input.filePath) ?? undefined) : input.format;
            const format = headFormat === 'zip' || headFormat === null
                ? sniffFormat(bytes, hint)
                : headFormat;
            if (format === null) {
                ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
                throw new FsError(`cannot read "${target.displayPath}": unrecognized file content (expected text, PDF, DOCX or XLSX)`, 'FS_NOT_TEXT');
            }
            // sheet/list_sheets 只对 xlsx 有意义：对 PDF/DOCX/text 显式报错，
            // 防止模型以为 sheet 参数生效而拿到完整（未按 sheet 过滤）内容。
            if ((input.sheet !== undefined || input.listSheets) && format !== 'xlsx') {
                ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
                throw new FsError(`cannot read "${target.displayPath}": sheet/list_sheets parameters are only supported for XLSX files (detected format: ${format})`, 'FS_NOT_TEXT');
            }
            const cacheKey = { targetKey: target.targetKey, version: info.version, format, sheet: input.sheet, listSheets: input.listSheets };
            let text = cache.get(cacheKey);
            if (text === undefined) {
                // 解析器不接受 AbortSignal；这里包装一层协作取消：
                // 信号触发时立即中止等待，符合 dsh 工具的取消契约。
                text = await parseDocumentWithAbort(bytes, format, {
                    sheetRowLimit: config.sheetRowLimit,
                    maxSheets: config.maxSheets,
                    sheet: input.sheet,
                    listOnly: input.listSheets
                }, exec.signal);
                cache.set(cacheKey, text);
            }
            const window = windowLines(text, input.offset, input.limit, config.maxOutputChars);
            ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
            return {
                path: target.displayPath,
                format,
                offset: input.offset,
                lines: window.lines,
                totalLines: window.totalLines,
                ...(input.sheet !== undefined ? { sheet: input.sheet } : {})
            };
        },
        presentCall(args) {
            return {
                card: 'generic',
                title: `Read document ${args.file_path}`,
                kind: 'read',
                locations: [{ path: args.file_path }]
            };
        },
        presentResult(_args, result) {
            if (result.isError)
                return undefined;
            // meta 就是 presentationMeta 的投影产物（ToolResult.meta 原样透传）。
            const meta = result.meta;
            if (meta === undefined)
                return undefined;
            // text 是行语义（代码/配置）：投影为官方 read 卡片（行号/高亮/滚动）。
            // pdf/docx/xlsx 是段落/表格流：generic 卡片展示文本即可，行号无意义。
            if (meta.format === 'text') {
                return {
                    card: 'read',
                    path: meta.path,
                    offset: meta.offset,
                    lines: meta.lines,
                    totalLines: meta.totalLines
                };
            }
            return {
                card: 'generic',
                title: `Document ${meta.path} (${meta.format})`,
                content: [
                    {
                        type: 'text',
                        text: meta.lines.map((l) => l.text).join('\n')
                    }
                ]
            };
        }
    });
}
