// Tool-side budget tests: the per-call output character budget is split by
// format so a verbose PDF/DOCX doesn't inflate the model context to the full
// text-window allowance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatOutputBudget, defineReadDocumentTool } from '../src/tool.ts'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'

test('text uses the full base budget', () => {
  assert.equal(formatOutputBudget('text', 24000), 24000)
})

test('xlsx gets three-quarters of the base budget', () => {
  assert.equal(formatOutputBudget('xlsx', 24000), 18000)
})

test('pdf and docx get half the base budget', () => {
  assert.equal(formatOutputBudget('pdf', 24000), 12000)
  assert.equal(formatOutputBudget('docx', 24000), 12000)
})

test('the halving never drops below the floor for a tiny base', () => {
  assert.equal(formatOutputBudget('pdf', 3000), 2000) // Math.max(2000, floor(1500))
  assert.equal(formatOutputBudget('docx', 2000), 2000)
  assert.equal(formatOutputBudget('xlsx', 2000), 2000) // floor(1500) clamped to 2000
})

// 回归：#5 —— readBytes 的 maxBytes 是整个文件上限（stat 超限即 FS_TOO_LARGE，
// 不截断），旧实现先按 HEAD_SNIFF_BYTES(64 KiB) 嗅探头部，任何更大的文件都会
// 在嗅探阶段被拒。现在一次读满 maxFileBytes，头部从缓冲截取。
test('read_document reads files larger than 64 KiB (head sniff no longer caps the read)', async () => {
  const SIZE = 128 * 1024
  const maxFileBytes = 24 * 1024 * 1024
  const readCaps: number[] = []
  const fs = {
    resolve: async () => ({ targetKey: FsTargetKey('k-big'), displayPath: '/workspace/big.txt' }),
    stat: async () => ({ version: FsVersion('v1'), type: 'file', size: SIZE }),
    readBytes: async (_target: unknown, _signal: unknown, maxBytes: number) => {
      readCaps.push(maxBytes)
      // 复刻 @deepseek-ai/dsh-fs 契约：maxBytes 是整体上限，超限即抛错。
      if (maxBytes < SIZE) throw new FsError(`bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
      return new Uint8Array(SIZE).fill(0x61) // 全 'a'，UTF-8 文本
    }
  }
  const tool = defineReadDocumentTool(
    { fs, emit: () => undefined },
    {
      readLimit: 800,
      maxFileBytes,
      sheetRowLimit: 200,
      maxSheets: 5,
      maxOutputChars: 24000
    }
  )
  const exec = { signal: new AbortController().signal, agent: undefined } as unknown as Parameters<typeof tool.execute>[1]
  const result = (await tool.execute({ file_path: 'big.txt' }, exec)) as {
    format: string
    lines: Array<{ number: number; text: string }>
    totalLines: number
  }
  assert.equal(result.format, 'text')
  assert.ok(result.lines.length > 0)
  // 只读一次，且上限是 maxFileBytes 而非 64 KiB。
  assert.deepEqual(readCaps, [maxFileBytes])
})

test('read_document still rejects files over maxFileBytes with FS_TOO_LARGE', async () => {
  const maxFileBytes = 1024
  const fs = {
    resolve: async () => ({ targetKey: FsTargetKey('k-over'), displayPath: '/workspace/over.bin' }),
    stat: async () => ({ version: FsVersion('v1'), type: 'file', size: 2048 }),
    readBytes: async () => {
      throw new Error('must not be reached')
    }
  }
  const tool = defineReadDocumentTool(
    { fs, emit: () => undefined },
    { readLimit: 800, maxFileBytes, sheetRowLimit: 200, maxSheets: 5, maxOutputChars: 24000 }
  )
  const exec = { signal: new AbortController().signal, agent: undefined } as unknown as Parameters<typeof tool.execute>[1]
  await assert.rejects(
    tool.execute({ file_path: 'over.bin' }, exec),
    (err: unknown) => err instanceof FsError && err.code === 'FS_TOO_LARGE'
  )
})
