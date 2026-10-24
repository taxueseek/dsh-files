// Unified document parsing entry: dispatch by sniffed format, keep line
// semantics consistent across parsers.
//
// 重型解析器全部延迟导入：插件的 apply 在宿主每次启动都会执行，而
// read_document 可能整个会话都不被调用，把 pdfjs legacy（≈130ms）、mammoth
// （≈42ms）、read-excel-file（≈31ms）挂在顶层等于每次宿主启动都交 ~200ms
// 启动税。按格式推迟到真正解析时再加载——word-extractor 自 0.4.x 起已是
// 动态导入（doc 兜底路径），本改动把同一纪律推广到其余三个；text 走
// TextDecoder，保持顶层导入。

import type { DocumentFormat } from '../detect.js'
import { decodeText } from './text.ts'

export interface ParseOptions {
  sheetRowLimit: number
  maxSheets?: number
  /** 1-based；XLSX 专用，指定后读取该 sheet 全量。 */
  sheet?: number
  /** XLSX 专用：只列 sheet 名，不读单元格。 */
  listOnly?: boolean
}

export async function parseDocument(
  bytes: Uint8Array,
  format: DocumentFormat,
  options: ParseOptions
): Promise<string> {
  // sheet/listOnly 只对 xlsx 有意义：对 PDF/DOCX/text 显式报错，防止调用方
  // 以为 sheet 参数生效而拿到完整（未按 sheet 过滤）内容。
  if ((options.sheet !== undefined || options.listOnly === true) && format !== 'xlsx') {
    throw new Error(`sheet/listOnly parameters are only supported for XLSX files (format: ${format})`)
  }
  switch (format) {
    case 'pdf': {
      const { parsePdf } = await import('./pdf.ts')
      return parsePdf(bytes)
    }
    case 'doc': {
      const { parseDoc } = await import('./doc.ts')
      return parseDoc(bytes)
    }
    case 'docx': {
      const { parseDocx } = await import('./docx.ts')
      return parseDocx(bytes)
    }
    case 'xlsx': {
      const { parseXlsx } = await import('./xlsx.ts')
      return parseXlsx(bytes, options)
    }
    case 'text': {
      const text = decodeText(bytes)
      if (text === null) {
        throw new Error('cannot decode text file: unsupported encoding (expected UTF-8, UTF-16 or GB18030)')
      }
      return text
    }
  }
}
