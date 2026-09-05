// dsh-files 0.5.0 — a DeepSeek Harness plugin with a single job:
// the read_document tool. Structured text extraction (PDF/DOCX/XLSX/text)
// for files the built-in read tool rejects with FS_NOT_TEXT.
//
// Upload, image pipeline, @ candidates and the composer UI were removed in
// 0.5.0: harness 0.1.3 ships all of them natively (durable attachments with
// progress/cancellation, @file/@session reference, @path grammar), and the
// ablation on 2026-09-05 (plugin disabled, service stable, zero cross-plugin
// deps) proved the remaining value is the parser.

import z from '@deepseek-ai/schemastery'
import { defineReadDocumentTool } from './tool.ts'

/** Cordis plugin name — must match the row id in cordis.patch.yml. */
export const name = 'dsh-files'

/** Services required by this plugin. */
export const inject = ['tools', 'fs', 'systemPrompt']

const MEBIBYTE = 1024 * 1024

/** Plugin config, mirroring the schemastery schema below. */
export interface DocsConfig {
  maxFileBytes: number
  readLimit: number
  sheetRowLimit: number
  maxSheets: number
  maxOutputChars: number
  readTimeoutMs: number
}

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
  readTimeoutMs: z.number().default(120_000)
})

export function apply(ctx: any, config: DocsConfig): void {
  for (const [label, value] of [
    ['maxFileBytes', config.maxFileBytes],
    ['readLimit', config.readLimit],
    ['sheetRowLimit', config.sheetRowLimit],
    ['maxSheets', config.maxSheets],
    ['maxOutputChars', config.maxOutputChars]
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`dsh-files: ${label} must be a positive integer`)
    }
  }

  ctx.systemPrompt.section({
    name: 'tool:read-document',
    order: 110,
    text: 'read_document reads PDF/DOCX/XLSX/text the read tool cannot. For large docs: probe structure first (list_sheets, or a small first window), then page with offset/limit; read only what the task needs, then stop.'
  })

  ctx.tools.register(
    defineReadDocumentTool(ctx, {
      readLimit: config.readLimit,
      maxFileBytes: config.maxFileBytes,
      sheetRowLimit: config.sheetRowLimit,
      maxSheets: config.maxSheets,
      maxOutputChars: config.maxOutputChars,
      readTimeoutMs: config.readTimeoutMs
    })
  )
}
