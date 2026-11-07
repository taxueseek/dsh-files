// Content-sniffing tests: real signatures win, spoofed extensions cannot
// redirect parsing, binary garbage is rejected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { sniffFormat, zipMemberNames, formatFromExtension, SUPPORTED_FORMATS } from '../src/detect.ts'

async function makeZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

const DOCX_FILES = {
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': '<w:document/>',
  'word/styles.xml': '<w:styles/>'
}

const XLSX_FILES = {
  '[Content_Types].xml': '<Types/>',
  'xl/workbook.xml': '<workbook/>',
  'xl/worksheets/sheet1.xml': '<worksheet/>'
}

const PPTX_FILES = {
  '[Content_Types].xml': '<Types/>',
  'ppt/presentation.xml': '<p:presentation/>',
  'ppt/slides/slide1.xml': '<p:sld/>'
}

test('pdf signature wins over a spoofed .docx hint', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n%%EOF')
  assert.equal(sniffFormat(bytes, 'docx'), 'pdf')
})

test('zip with word/ members is docx', async () => {
  const bytes = await makeZip(DOCX_FILES)
  assert.equal(sniffFormat(bytes), 'docx')
})

test('zip with xl/ members is xlsx', async () => {
  const bytes = await makeZip(XLSX_FILES)
  assert.equal(sniffFormat(bytes), 'xlsx')
})

test('zip with ppt/ members is pptx', async () => {
  const bytes = await makeZip(PPTX_FILES)
  assert.equal(sniffFormat(bytes), 'pptx')
})

test('zip with neither word/ nor xl/ members is rejected', async () => {
  const bytes = await makeZip({ 'random.txt': 'hello' })
  assert.equal(sniffFormat(bytes), null)
})

test('a .pdf extension cannot make an executable parse as pdf', async () => {
  // MZ header with valid UTF-8-ish text after it: no signature, hint says pdf
  const bytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...new TextEncoder().encode('This program cannot be run in DOS mode')])
  assert.equal(sniffFormat(bytes, 'pdf'), null)
})

test('utf-8 text is detected', () => {
  const bytes = new TextEncoder().encode('hello 世界\nsecond line')
  assert.equal(sniffFormat(bytes), 'text')
})

test('utf-16le with BOM is detected as text', () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])
  assert.equal(sniffFormat(bytes), 'text')
})

test('utf-16be with BOM is detected as text', () => {
  const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69])
  assert.equal(sniffFormat(bytes), 'text')
})

test('binary with NUL bytes is rejected', () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe])
  assert.equal(sniffFormat(bytes), null)
})

test('empty input is a valid empty text document', () => {
  // 空文件是合法空文本：read_document 应能读（返回 0 行），而不是报
  // "unrecognized file content"。短纯 ASCII 同理。
  assert.equal(sniffFormat(new Uint8Array(0)), 'text')
  assert.equal(sniffFormat(new Uint8Array([0x25, 0x50])), 'text')
})

test('hint is honored only when bytes are ambiguous', () => {
  const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])
  assert.equal(sniffFormat(bytes, 'text'), 'text')
})

test('zipMemberNames returns member list and rejects truncated archives', async () => {
  const bytes = await makeZip(DOCX_FILES)
  const names = zipMemberNames(bytes)
  assert.ok(names !== null)
  assert.ok(names.includes('word/document.xml'))
  assert.equal(zipMemberNames(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), null)
})

test('formatFromExtension covers the supported set', () => {
  assert.equal(formatFromExtension('report.pdf'), 'pdf')
  assert.equal(formatFromExtension('a.DOCX'), 'docx')
  assert.equal(formatFromExtension('slides.pptx'), 'pptx')
  assert.equal(formatFromExtension('data.xlsx'), 'xlsx')
  assert.equal(formatFromExtension('notes.md'), 'text')
  assert.equal(formatFromExtension('noextension'), null)
  assert.equal(formatFromExtension('evil.exe'), null)
})

test('SUPPORTED_FORMATS matches the enum union', () => {
  assert.deepEqual([...SUPPORTED_FORMATS].sort(), ['doc', 'docx', 'pdf', 'pptx', 'text', 'xlsx'])
})

test('utf-16 without BOM is detected as text', () => {
  // 'hi' UTF-16LE 无 BOM：68 00 69 00
  const le = new Uint8Array([0x68, 0x00, 0x69, 0x00])
  assert.equal(sniffFormat(le), 'text')
  // UTF-16BE 无 BOM：00 68 00 69
  const be = new Uint8Array([0x00, 0x68, 0x00, 0x69])
  assert.equal(sniffFormat(be), 'text')
})
