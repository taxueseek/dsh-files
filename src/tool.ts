// The model-facing read_document tool. Reads through ctx.fs, so workspace
// resolution, sandbox policy and fs-observation policy behave exactly like the
// built-in read tool. Differences from the plain-text read tool: content
// sniffing (never trusts extensions) and a size pre-check before reading bytes.
// The 0.4.x LRU parse cache was removed in 0.5.0 — measured parse cost
// (180-235 ms for a 1.1 MB PDF) is noise next to model latency, so the cache
// could not prove its necessity in the 0.5.0 ablation.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsError, type FsTarget, type FsVersion } from '@deepseek-ai/dsh-fs'
import { sniffFormat, sniffHead, HEAD_SNIFF_BYTES, SUPPORTED_FORMATS, formatFromExtension, type DocumentFormat } from './detect.ts'
import { parseDocument, type ParseOptions } from './parse/index.ts'
import { windowLines } from './parse/text.ts'

/**
 * 单次 read_document 窗口的字符预算。按格式分级：
 * - text：需要逐行精确定位（代码/配置），用满基础预算。
 * - xlsx：按 sheet/row 天然受限，用满基础预算。
 * - pdf/docx：叙述性流式文本，模型通常只需关键段落，一次塞满会把上下文
 *   稀释并推高 token 成本；给基础预算的一半，配合 windowLines 的截断标记
 *   引导模型用 offset/limit 翻页增量获取。
 */
export function formatOutputBudget(format: DocumentFormat, base: number): number {
  // pdf/docx：叙述性流式文本，模型通常只需关键段落，减半防上下文稀释。
  if (format === 'pdf' || format === 'docx') return Math.max(2000, Math.floor(base / 2))
  // xlsx：结构化表格信息密度高，但行多列宽也会撑爆上下文；给 3/4，配合
  // windowLines 的截断标记引导模型 offset 翻页增量取。
  if (format === 'xlsx') return Math.max(2000, Math.floor(base * 0.75))
  return base
}

export interface ReadDocumentConfig {
  readLimit: number
  maxFileBytes: number
  sheetRowLimit: number
  maxSheets: number
  /** 单次输出字符预算：超长行按字符截断，防止一次 read_document 撑爆上下文。 */
  maxOutputChars: number
  /** read_document 单次执行的超时上限（ms）。大 PDF 解析可能超默认值。 */
  readTimeoutMs?: number
}

interface ParsedArgs {
  filePath: string
  offset: number
  limit: number
  format: 'auto' | DocumentFormat
  sheet?: number
  listSheets: boolean
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`)
}

function parseArgs(args: Record<string, unknown>, config: ReadDocumentConfig): ParsedArgs {
  if (typeof args.file_path !== 'string' || args.file_path.trim() === '') {
    throw new Error('file_path must be a non-empty string')
  }
  const filePath = args.file_path.trim()
  const offset = typeof args.offset === 'number' ? args.offset : 1
  if (!Number.isInteger(offset) || offset < 1) throw new Error('offset must be a positive integer')
  const limit = typeof args.limit === 'number' ? args.limit : config.readLimit
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
  if (limit > config.readLimit) throw new Error(`limit must be less than or equal to ${config.readLimit}`)
  const format = args.format === undefined ? 'auto' : args.format
  if (typeof format !== 'string' || (format !== 'auto' && !SUPPORTED_FORMATS.has(format))) {
    throw new Error(`unsupported format "${String(format)}" (expected auto, pdf, docx, xlsx or text)`)
  }
  const sheet = typeof args.sheet === 'number' ? args.sheet : undefined
  if (sheet !== undefined && (!Number.isInteger(sheet) || sheet < 1)) {
    throw new Error('sheet must be a positive integer')
  }
  const listSheets = args.list_sheets === true
  if (listSheets && sheet !== undefined) {
    throw new Error('list_sheets and sheet are mutually exclusive: list first, then read a specific sheet')
  }
  return { filePath, offset, limit, format: format as ParsedArgs['format'], sheet, listSheets }
}

/** The session workspace cwd for this call, when one applies. */
function sessionCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string | undefined {
  return exec.agent?.session?.header?.cwd
}

/**
 * Run parseDocument with cooperative cancellation: the underlying parsers
 * (pdfjs/mammoth/read-excel-file) do not take an AbortSignal, so race the
 * parse against the signal and throw the FsError abort code when it fires.
 */
async function parseDocumentWithAbort(
  bytes: Uint8Array,
  format: DocumentFormat,
  options: ParseOptions,
  signal: AbortSignal
): Promise<string> {
  if (signal.aborted) throw new FsError('read_document aborted', 'FS_ABORTED')
  let settle!: (result: { ok: true; text: string } | { ok: false; error: unknown }) => void
  const raced = new Promise<{ ok: true; text: string } | { ok: false; error: unknown }>((resolve) => {
    settle = resolve
  })
  const onAbort = () => settle({ ok: false, error: new FsError('read_document aborted', 'FS_ABORTED') })
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    void parseDocument(bytes, format, options)
      .then((text) => settle({ ok: true, text }))
      .catch((error: unknown) => settle({ ok: false, error }))
    const result = await raced
    if (result.ok) return result.text
    throw result.error
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function renderContent(path: string, format: string, value: { offset: number; lines: Array<{ number: number; text: string }>; totalLines: number }): string {
  const numbered = format === 'text'
  const body = value.lines.map((l) => (numbered ? `${l.number}: ${l.text}` : l.text)).join('\n')
  const header = `### document ${path} (${format}) — offset ${value.offset}, ${value.lines.length}/${value.totalLines} lines`
  return [header, body].filter((s) => s.length > 0).join('\n')
}

export function defineReadDocumentTool(ctx: {
  fs: {
    resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
    stat(target: FsTarget, signal?: AbortSignal): Promise<{ version: FsVersion; type: string; size?: number } | undefined>
    readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  }
  emit(event: string, target: FsTarget, observation: object, exec: object): void
}, config: ReadDocumentConfig) {
  return defineTool({
    name: 'read_document',
    description:
      'Read text/PDF/DOCX/XLSX the plain read tool cannot; page with offset/limit, list_sheets then sheet for XLSX.',
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
        type: 'integer',
        description: '1-based first line. Defaults to 1.'
      },
      limit: {
        type: 'integer',
        description: `Max lines to return. Defaults to ${config.readLimit}.`
      },
      sheet: {
        type: 'integer',
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
          totalLines: { type: 'integer', required: true },
          // execute 在 sheet 读取时返回该字段；schema 必须声明，
          // 否则 additionalProperties:false 会把合法输出打成 INVALID_TOOL_OUTPUT。
          sheet: { type: 'integer' }
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
    timeoutMs: config.readTimeoutMs ?? 120_000,
    async execute(args, exec) {
      const input = parseArgs(args, config)
      const cwd = sessionCwd(exec)
      const target = await ctx.fs.resolve(input.filePath, {
        ...(cwd !== undefined ? { cwd } : {}),
        signal: exec.signal
      })
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'file') {
        throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (info.size !== undefined && info.size > config.maxFileBytes) {
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
        throw new FsError(
          `cannot read "${target.displayPath}": file is ${info.size} bytes, over the ${config.maxFileBytes} byte limit`,
          'FS_TOO_LARGE'
        )
      }
      // readBytes 的 maxBytes 是整个文件上限：底层 stat 后若 size > maxBytes
      // 直接抛 FS_TOO_LARGE，不做截断。因此不能先按 64 KiB 嗅探头部——那会把
      // 任何更大的文件挡在门外。一次读满 maxFileBytes，格式判定从缓冲头部截取。
      const bytes = await ctx.fs.readBytes(target, exec.signal, config.maxFileBytes)
      const head = bytes.subarray(0, Math.min(HEAD_SNIFF_BYTES, bytes.length))
      const headFormat = sniffHead(head)
      if (headFormat === null && input.format === 'auto') {
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
        throw new FsError(
          `cannot read "${target.displayPath}": unrecognized file content (expected text, PDF, DOCX or XLSX)`,
          'FS_NOT_TEXT'
        )
      }
      // zip 需要中央目录（在文件尾部）才能区分 docx/xlsx；
      // headFormat 为 null 只发生在显式 format 场景，走完整嗅探兜底。
      // auto 模式下的 hint 取扩展名：字节完全未知时（且非已知二进制）
      // 允许按扩展名兜底解析，解析器仍会校验结构并 loud fail。
      const hint = input.format === 'auto' ? (formatFromExtension(input.filePath) ?? undefined) : input.format
      const format =
        headFormat === 'zip' || headFormat === null
          ? sniffFormat(bytes, hint)
          : headFormat
      if (format === null) {
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
        throw new FsError(
          `cannot read "${target.displayPath}": unrecognized file content (expected text, PDF, DOCX or XLSX)`,
          'FS_NOT_TEXT'
        )
      }
      // sheet/list_sheets 只对 xlsx 有意义：对 PDF/DOCX/text 显式报错，
      // 防止模型以为 sheet 参数生效而拿到完整（未按 sheet 过滤）内容。
      if ((input.sheet !== undefined || input.listSheets) && format !== 'xlsx') {
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
        throw new FsError(
          `cannot read "${target.displayPath}": sheet/list_sheets parameters are only supported for XLSX files (detected format: ${format})`,
          'FS_NOT_TEXT'
        )
      }
      // 解析器不接受 AbortSignal；这里包装一层协作取消：
      // 信号触发时立即中止等待，符合 dsh 工具的取消契约。
      const text = await parseDocumentWithAbort(bytes, format, {
        sheetRowLimit: config.sheetRowLimit,
        maxSheets: config.maxSheets,
        sheet: input.sheet,
        listOnly: input.listSheets
      }, exec.signal)
      const window = windowLines(text, input.offset, input.limit, formatOutputBudget(format, config.maxOutputChars))
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return {
        path: target.displayPath,
        format,
        offset: input.offset,
        lines: window.lines,
        totalLines: window.totalLines,
        ...(input.sheet !== undefined ? { sheet: input.sheet } : {})
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Read document ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }]
      }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      // meta 就是 presentationMeta 的投影产物（ToolResult.meta 原样透传）。
      const meta = result.meta as
        | { path: string; format: string; offset: number; totalLines: number; lines: Array<{ number: number; text: string }> }
        | undefined
      if (meta === undefined) return undefined
      if (meta.format === 'text') {
        return {
          card: 'read',
          path: meta.path,
          offset: meta.offset,
          lines: meta.lines,
          totalLines: meta.totalLines
        }
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
      }
    }
  })
}
