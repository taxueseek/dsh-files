// dsh-files — a dual-face DeepSeek Harness plugin: one cordis row, one apply,
// two capabilities:
//   1. read_document tool (host): sniffed-format text extraction for
//      text/PDF/DOCX/XLSX with size pre-check and LRU parse cache.
//   2. upload surface (host webServer + web client): composer paperclip that
//      stores files per session inside the session workspace and attaches the
//      path to the outgoing message.

import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineReadDocumentTool } from './tool.ts'
import { createUploadHandler, createSweeper } from './upload.ts'
import { createPasteTextHandler } from './paste.ts'
import { ParseCache } from './cache.ts'

/** Cordis plugin name — must match the row id in cordis.patch.yml. */
export const name = 'dsh-files'

/** Services required by this plugin. */
export const inject = ['tools', 'fs', 'systemPrompt', 'webServer', 'sessions']

const MEBIBYTE = 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000

/** Plugin config, mirroring the schemastery schema below. */
export interface DocsConfig {
  maxFileBytes: number
  readLimit: number
  sheetRowLimit: number
  maxSheets: number
  cacheEntries: number
  cacheMaxBytes: number
  uploadMaxBytes: number
  allowedExtensions: string[]
  uploadTtlMs: number
  sweepIntervalMs: number
  maxConcurrentUploads: number
  uploadDir: string
  pasteMaxBytes: number
  pasteMinChars: number
}

export const Config = z.object({
  /** Byte cap for one document read (PDF parsing amplifies memory severalfold). */
  maxFileBytes: z.number().default(24 * MEBIBYTE),
  /** Default and maximum number of lines returned by one call. */
  readLimit: z.number().default(2000),
  /** Rows kept per worksheet. */
  sheetRowLimit: z.number().default(200),
  /** Sheets read per workbook (the rest are reported as truncated). */
  maxSheets: z.number().default(5),
  /** Parse-cache capacity (targetKey + version fingerprints). */
  cacheEntries: z.number().default(16),
  /** Parse-cache byte budget; large PDFs dominate retained memory. */
  cacheMaxBytes: z.number().default(64 * MEBIBYTE),
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
  /** Upload storage root; files land in <root>/.dsh-filess/<sessionId>/. */
  uploadDir: z.string().default(join(process.cwd(), 'uploads')),
  /** Byte cap for one pasted-text payload (UTF-8). */
  pasteMaxBytes: z.number().default(8 * MEBIBYTE),
  /** Pasting text at or above this many characters triggers the save-to-file flow. */
  pasteMinChars: z.number().default(4000)
})

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`dsh-files: ${label} must be a positive integer`)
}

export function apply(ctx: any, config: DocsConfig): void {
  for (const [label, value] of [
    ['maxFileBytes', config.maxFileBytes],
    ['readLimit', config.readLimit],
    ['sheetRowLimit', config.sheetRowLimit],
    ['maxSheets', config.maxSheets],
    ['cacheEntries', config.cacheEntries],
    ['cacheMaxBytes', config.cacheMaxBytes],
    ['uploadMaxBytes', config.uploadMaxBytes],
    ['uploadTtlMs', config.uploadTtlMs],
    ['sweepIntervalMs', config.sweepIntervalMs],
    ['maxConcurrentUploads', config.maxConcurrentUploads],
    ['pasteMaxBytes', config.pasteMaxBytes],
    ['pasteMinChars', config.pasteMinChars]
  ] as const) {
    assertPositiveInteger(value, label)
  }

  const cache = new ParseCache(config.cacheEntries, config.cacheMaxBytes)

  ctx.systemPrompt.section({
    name: 'tool:read-document',
    order: 110,
    text: 'Use the read_document tool to read PDF, DOCX and XLSX documents that the plain read tool cannot handle; it also reads plain text files. Use offset and limit to page through long documents.'
  })

  ctx.tools.register(
    defineReadDocumentTool(
      ctx,
      {
        readLimit: config.readLimit,
        maxFileBytes: config.maxFileBytes,
        sheetRowLimit: config.sheetRowLimit,
        maxSheets: config.maxSheets
      },
      cache
    )
  )

  const defaultDir = config.uploadDir ?? join(process.cwd(), 'uploads')
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/upload',
      handler: createUploadHandler({
        maxBytes: config.uploadMaxBytes,
        allowedExtensions: config.allowedExtensions,
        ttlMs: config.uploadTtlMs,
        sweepIntervalMs: config.sweepIntervalMs,
        maxConcurrent: config.maxConcurrentUploads,
        defaultDir,
        sessionCwd: (sessionId) => {
          const session = ctx.sessions.get(sessionId)
          return session === undefined ? undefined : session.header.cwd
        }
      })
    })
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/paste-text',
      handler: createPasteTextHandler({
        maxBytes: config.pasteMaxBytes,
        minChars: config.pasteMinChars,
        defaultDir,
        sessionCwd: (sessionId) => {
          const session = ctx.sessions.get(sessionId)
          return session === undefined ? undefined : session.header.cwd
        }
      })
    })
  )

  const disposeSweeper = createSweeper(defaultDir, config.uploadTtlMs, config.sweepIntervalMs)
  ctx.on('dispose', disposeSweeper)
}
