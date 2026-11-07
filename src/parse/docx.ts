// DOCX text extraction via mammoth (maintained, pure JS, no known advisories).

import mammoth from 'mammoth'

export interface DocxParseOptions {
  outputFormat?: 'markdown' | 'text'
}

export async function parseDocx(bytes: Uint8Array, options: DocxParseOptions = {}): Promise<string> {
  const buf = Buffer.from(bytes)
  if (options.outputFormat === 'text') {
    const result = await mammoth.extractRawText({ buffer: buf })
    return result.value
  }
  const result = await mammoth.convertToMarkdown({ buffer: buf })
  return result.value
}
