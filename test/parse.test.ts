// Parser tests against programmatically generated samples: PDF via pdf-lib,
// DOCX/XLSX via JSZip. Verifies text extraction, sheet row limits, line
// windows and BOM-aware text decoding.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { parsePdf } from '../src/parse/pdf.ts'
import { parseDocx } from '../src/parse/docx.ts'
import { parsePptx } from '../src/parse/pptx.ts'
import { parseXlsx } from '../src/parse/xlsx.ts'
import { parseDocument } from '../src/parse/index.ts'
import { parsePageRange } from '../src/parse/range.ts'
import { decodeText, windowLines } from '../src/parse/text.ts'

async function makePdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 300])
  page.drawText(text, { x: 50, y: 250, size: 14, font, color: rgb(0, 0, 0) })
  return new Uint8Array(await doc.save())
}

/** 两个分离的 text run（x 坐标不同），模拟 PDF 常见的单词拆分。 */
async function makeSplitRunPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 300])
  page.drawText('Hello', { x: 50, y: 250, size: 14, font, color: rgb(0, 0, 0) })
  page.drawText('world', { x: 110, y: 250, size: 14, font, color: rgb(0, 0, 0) })
  return new Uint8Array(await doc.save())
}

const DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
  </w:body>
</w:document>`

async function makeDocx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/document.xml', DOCX_XML)
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

async function makeXlsx(rows: Array<Array<string | number>>): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
  const cells = rows
    .map((row, r) => {
      const cols = row
        .map((cell, c) => {
          const ref = `${String.fromCharCode(65 + c)}${r + 1}`
          if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`
          return `<c r="${ref}" t="inlineStr"><is><t>${cell}</t></is></c>`
        })
        .join('')
      return `<row r="${r + 1}">${cols}</row>`
    })
    .join('')
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`)
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

test('pdf text extraction', async () => {
  const pdf = await makePdf('Hello PDF world')
  const text = await parsePdf(pdf)
  assert.match(text, /Hello PDF world/)
})

test('pdf separated text runs get a space inserted', async () => {
  // 两个 x 坐标不同的 text run：直接拼接会得到 "Helloworld"，
  // 间隙检测应补空格。
  const text = await parsePdf(await makeSplitRunPdf())
  assert.match(text, /Hello world/)
})

test('docx text extraction', async () => {
  const text = await parseDocx(await makeDocx())
  assert.match(text, /First paragraph/)
  assert.match(text, /Second paragraph/)
})

test('xlsx text extraction with row limit', async () => {
  const rows: Array<Array<string | number>> = [
    ['Name', 'Score'],
    ['Alice', 42],
    ['Bob', 7]
  ]
  const bytes = await makeXlsx(rows)
  const full = await parseXlsx(bytes, { sheetRowLimit: 10 })
  assert.match(full, /Alice/)
  assert.match(full, /42/)
  // 截断必须显式告知模型：数据行 + sheet 标题 + 截断标记。
  const limited = await parseXlsx(bytes, { sheetRowLimit: 2 })
  assert.match(limited, /Alice/)
  assert.doesNotMatch(limited, /Bob/)
  assert.match(limited, /### Sheet:/)
  assert.match(limited, /已截断/)
})

test('utf-8 text decoding', () => {
  const bytes = new TextEncoder().encode('你好，世界\nline 2')
  assert.equal(decodeText(bytes), '你好，世界\nline 2')
})

test('utf-16le BOM text decoding', () => {
  // 你 = U+4F60, 好 = U+597D, little-endian
  const bytes = new Uint8Array([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59])
  assert.equal(decodeText(bytes), '你好')
})

test('windowLines pages without a phantom trailing line', () => {
  const text = 'a\nb\nc\n'
  const w1 = windowLines(text, 1, 2)
  assert.equal(w1.totalLines, 3)
  assert.deepEqual(w1.lines, [
    { number: 1, text: 'a' },
    { number: 2, text: 'b' }
  ])
  const w2 = windowLines(text, 3, 10)
  assert.deepEqual(w2.lines, [{ number: 3, text: 'c' }])
})

test('windowLines clamps offsets past the end', () => {
  const w = windowLines('x\ny', 10, 5)
  assert.equal(w.totalLines, 2)
  assert.deepEqual(w.lines, [])
})

async function makeBlankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([400, 300])
  return new Uint8Array(await doc.save())
}

async function makeMultiSheetXlsx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/><sheet name="S2" sheetId="2" r:id="rId2"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`)
  const sheetXml = (rows: string[], tag: string) =>
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    rows.map((v, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${v}</t></is></c></row>`).join('') +
    `</sheetData></worksheet>`
  zip.file('xl/worksheets/sheet1.xml', sheetXml(['alpha'], 's1'))
  zip.file('xl/worksheets/sheet2.xml', sheetXml(['beta', 'gamma', 'delta'], 's2'))
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

test('scan-only PDFs are flagged instead of returning empty text', async () => {
  const text = await parsePdf(await makeBlankPdf())
  assert.match(text, /没有文本层|扫描/)
})

test('xlsx sheet parameter reads a single sheet in full', async () => {
  const bytes = await makeMultiSheetXlsx()
  // sheet=2 全量读取：sheetRowLimit=1 和 maxSheets=1 都不应截断它。
  const sheet2 = await parseXlsx(bytes, { sheetRowLimit: 1, maxSheets: 1, sheet: 2 })
  assert.match(sheet2, /beta/)
  assert.match(sheet2, /delta/)
  assert.doesNotMatch(sheet2, /alpha/)
  // 默认路径仍受 maxSheets 截断（只读 S1）。
  const merged = await parseXlsx(bytes, { sheetRowLimit: 1, maxSheets: 1 })
  assert.match(merged, /alpha/)
  assert.doesNotMatch(merged, /beta/)
  // 越界 sheet 明确报错。
  await assert.rejects(parseXlsx(bytes, { sheetRowLimit: 1, sheet: 9 }), /out of range/)
})

test('sheet 参数只对 xlsx 有意义，对 pdf/docx/text 显式报错而非静默忽略', async () => {
  const pdfBytes = await makePdf('sheet n/a') // pdf-lib 标准字体只能编码 WinAnsi/拉丁文本
  for (const [bytes, label] of [
    [pdfBytes, 'pdf'],
    [await makeDocx(), 'docx'],
    [new TextEncoder().encode('plain'), 'text']
  ] as const) {
    await assert.rejects(
      parseDocument(bytes, label, { sheetRowLimit: 10, sheet: 2 }),
      /only supported for XLSX/
    )
  }
  // xlsx 仍正常
  const ok = await parseDocument(await makeXlsx([['a']]), 'xlsx', { sheetRowLimit: 10, sheet: 1 })
  assert.match(ok, /a/)
})

test('listOnly lists sheet names without reading cells', async () => {
  const bytes = await makeMultiSheetXlsx()
  const listed = await parseXlsx(bytes, { sheetRowLimit: 1, listOnly: true })
  assert.match(listed, /Sheets \(2\)/)
  assert.match(listed, /1\. S1/)
  assert.match(listed, /2\. S2/)
  // 不读单元格：没有 alpha/beta 内容。
  assert.doesNotMatch(listed, /alpha/)
  assert.doesNotMatch(listed, /beta/)
})

test('sheet out-of-range error names the available sheets', async () => {
  const bytes = await makeMultiSheetXlsx()
  await assert.rejects(parseXlsx(bytes, { sheetRowLimit: 1, sheet: 9 }), /S1.*S2|S2.*S1/)
})

test('windowLines truncates over-long lines with an explicit marker', () => {
  const w = windowLines('short\n' + 'x'.repeat(50), 1, 10, 20)
  assert.equal(w.lines[0].text, 'short') // 5 chars, fits
  // 剩余预算 15 字符：超长行截断到 15 字符 + 标记。
  assert.match(w.lines[1].text, /^x{15}…\[已截断，共 50 字符\]$/)
})

test('windowLines enforces a total character budget across the window', () => {
  // 预算 25：第 1 行 11 字符，剩余 14；第 2 行 11 字符，剩余 3；
  // 第 3 行 13 字符超剩余预算 → 截断到 3 字符 + 标记。
  const w = windowLines('line-one-12\nline-two-12\nline-three-14', 1, 10, 25)
  assert.equal(w.lines.length, 3)
  assert.equal(w.lines[0].text, 'line-one-12')
  assert.equal(w.lines[1].text, 'line-two-12')
  assert.match(w.lines[2].text, /^lin…\[已截断，共 13 字符\]$/)
  assert.equal(w.totalLines, 3)
})

test('windowLines reports hidden lines when the budget cuts the window', () => {
  const w = windowLines('a\nb\nc\nd\ne', 1, 10, 3)
  // 预算 3：a/b/c 各 1 字符用尽；第 4 行超预算 → 截断标记行 + 隐藏 1 行。
  assert.equal(w.lines.length, 4)
  assert.match(w.lines[3].text, /已截断，共 1 字符/)
  assert.match(w.lines[3].text, /还有 1 行未显示/)
})

test('empty text decodes as an empty document', () => {
  assert.equal(decodeText(new Uint8Array(0)), '')
  const w = windowLines('', 1, 10)
  assert.equal(w.totalLines, 1)
  assert.deepEqual(w.lines, [{ number: 1, text: '' }])
})

test('utf-16le without BOM decodes as a fallback', () => {
  // 'hi' 的 UTF-16LE（无 BOM）：68 00 69 00。UTF-8/GB18030 解出会带 NUL，
  // 被拒绝后走无 BOM UTF-16 兜底。
  const bytes = new Uint8Array([0x68, 0x00, 0x69, 0x00])
  assert.equal(decodeText(bytes), 'hi')
})

test('parsePageRange parses ranges, de-duplicates and clamps to boundaries', () => {
  assert.deepEqual(parsePageRange('1-3, 5, 2', 10), [1, 2, 3, 5])
  assert.deepEqual(parsePageRange('8-12', 10), [8, 9, 10])
  assert.deepEqual(parsePageRange('2', 5), [2])
  assert.throws(() => parsePageRange('invalid', 5), /invalid page number/)
  assert.throws(() => parsePageRange('5-2', 5), /invalid page range segment/)
  assert.throws(() => parsePageRange('15', 5), /yielded no valid pages/)
})

async function makeMultiPagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([400, 300])
  p1.drawText('Page One Content', { x: 50, y: 250, size: 14, font, color: rgb(0, 0, 0) })
  const p2 = doc.addPage([400, 300])
  p2.drawText('Page Two Secret', { x: 50, y: 250, size: 14, font, color: rgb(0, 0, 0) })
  return new Uint8Array(await doc.save())
}

test('pdf pageRange extracts only the specified page', async () => {
  const bytes = await makeMultiPagePdf()
  const all = await parsePdf(bytes)
  assert.match(all, /Page One Content/)
  assert.match(all, /Page Two Secret/)

  const onlyPage2 = await parsePdf(bytes, { pageRange: '2' })
  assert.doesNotMatch(onlyPage2, /Page One Content/)
  assert.match(onlyPage2, /Page Two Secret/)
})

async function makePptx(hasText = true): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`)
  zip.file('ppt/presentation.xml', `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>`)

  if (hasText) {
    const slide1Xml = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Quarterly Strategy</a:t></a:r></a:p></p:txBody></p:sp><p:graphicFrame><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Item</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Target</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>$10M</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame></p:spTree></p:cSld></p:sld>`
    const slide2Xml = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide Two Roadmap</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    zip.file('ppt/slides/slide1.xml', slide1Xml)
    zip.file('ppt/slides/slide2.xml', slide2Xml)
  } else {
    zip.file('ppt/slides/slide1.xml', `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>`)
    zip.file('ppt/slides/slide2.xml', `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>`)
  }

  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))
}

test('pptx text and table extraction with markdown table', async () => {
  const bytes = await makePptx(true)
  const md = await parsePptx(bytes, { outputFormat: 'markdown' })
  assert.match(md, /### Slide 1 \/ 2/)
  assert.match(md, /Quarterly Strategy/)
  assert.match(md, /\| Item \| Target \|/)
  assert.match(md, /\| Revenue \| \$10M \|/)
  assert.match(md, /### Slide 2 \/ 2/)
  assert.match(md, /Slide Two Roadmap/)
})

test('pptx pageRange filters slides', async () => {
  const bytes = await makePptx(true)
  const slide1 = await parsePptx(bytes, { pageRange: '1' })
  assert.match(slide1, /Quarterly Strategy/)
  assert.doesNotMatch(slide1, /Slide Two Roadmap/)

  const slide2 = await parsePptx(bytes, { pageRange: '2' })
  assert.doesNotMatch(slide2, /Quarterly Strategy/)
  assert.match(slide2, /Slide Two Roadmap/)
})

test('pptx blank/image-only presentation returns visual hint', async () => {
  const bytes = await makePptx(false)
  const text = await parsePptx(bytes)
  assert.match(text, /没有可提取的文本内容|视觉/)
})

test('parseDocument dispatches pptx format', async () => {
  const bytes = await makePptx(true)
  const result = await parseDocument(bytes, 'pptx', {
    sheetRowLimit: 10,
    pageRange: '2'
  })
  assert.match(result, /Slide Two Roadmap/)
  assert.doesNotMatch(result, /Quarterly Strategy/)
})
