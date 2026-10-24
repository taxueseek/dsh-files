// 附件库视图与导出工具：tmpdir 造假 attachments/v1 结构（sha 目录按真实
// 布局 files/<sha2>/<sha>/<原名>），不依赖本机真实附件库。
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, copyFile, readFile, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { listAttachments, findAttachment, defaultAttachmentsDir } from '../src/attachments.ts'
import { defineAttachmentListTool, defineAttachmentExportTool } from '../src/attachment-tool.ts'

const FAKE_SHA = 'ab'.repeat(31) + 'cd' // 64 hex
const FAKE_NAME = '物业管理条例.doc'

let store: string
let workspace: string

beforeEach(async () => {
  store = await mkdtemp(join(tmpdir(), 'dsh-att-store-'))
  workspace = await mkdtemp(join(tmpdir(), 'dsh-att-ws-'))
  const objDir = join(store, 'files', FAKE_SHA.slice(0, 2), FAKE_SHA)
  await mkdir(objDir, { recursive: true })
  await copyFile(new URL('./fixtures/sanming-dog-regulation.doc', import.meta.url), join(objDir, FAKE_NAME))
})

afterEach(async () => {
  await rm(store, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

test('defaultAttachmentsDir honors DSH_HOME and ~ expansion', () => {
  const original = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.ok(defaultAttachmentsDir().endsWith(join('.dsh', 'attachments', 'v1')))
    process.env.DSH_HOME = '/tmp/dsh-alt'
    assert.equal(defaultAttachmentsDir(), join('/tmp/dsh-alt', 'attachments', 'v1'))
    process.env.DSH_HOME = '~/dsh-alt'
    assert.ok(defaultAttachmentsDir().startsWith(homedir()))
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  }
})

test('listAttachments walks the CAS layout and skips junk dirs', async () => {
  // 干扰项：非 sha 目录、隐藏文件、空对象目录。
  await mkdir(join(store, 'files', 'zz', 'nothex'), { recursive: true })
  await writeFile(join(store, 'files', 'zz', 'nothex', 'x.bin'), 'x')
  await writeFile(join(store, 'files', FAKE_SHA.slice(0, 2), '.DS_Store'), 'x')
  const items = await listAttachments(store)
  assert.equal(items.length, 1)
  assert.equal(items[0].name, FAKE_NAME)
  assert.equal(items[0].sha, FAKE_SHA)
  assert.ok(items[0].bytes > 20000)
})

test('listAttachments on a missing store returns empty, not throw', async () => {
  assert.deepEqual(await listAttachments(join(store, 'nope')), [])
})

test('listAttachments caches by mtime and invalidates on directory change', async () => {
  // 第一次调用：全量扫描并填充缓存。
  const first = await listAttachments(store)
  assert.equal(first.length, 1)
  // 第二次调用：命中缓存，结果一致。
  const second = await listAttachments(store)
  assert.deepEqual(first, second)
  // 添加新文件 → mtime 变化 → 缓存失效 → 重新扫描。
  const otherSha = 'cd'.repeat(32)
  const otherDir = join(store, 'files', otherSha.slice(0, 2), otherSha)
  await mkdir(otherDir, { recursive: true })
  await writeFile(join(otherDir, 'new-file.txt'), 'new content')
  // mtime 变化是文件系统行为；等待一 tick 确保 mtime 不同。
  await new Promise((resolve) => setTimeout(resolve, 10))
  const third = await listAttachments(store)
  assert.equal(third.length, 2)
  assert.ok(third.some((e) => e.name === 'new-file.txt'))
})

test('findAttachment resolves by sha prefix', async () => {
  const found = await findAttachment(store, FAKE_SHA.slice(0, 8))
  assert.equal(found.name, FAKE_NAME)
  assert.equal(found.sha, FAKE_SHA)
  const st = await stat(found.hostPath)
  assert.ok(st.isFile())
})

test('findAttachment resolves by exact original name', async () => {
  const found = await findAttachment(store, FAKE_NAME)
  assert.equal(found.sha, FAKE_SHA)
})

test('findAttachment reports ambiguous prefixes and missing ids', async () => {
  // 造第二个同前缀对象。
  const other = FAKE_SHA.slice(0, 63) + 'ef'
  const objDir = join(store, 'files', other.slice(0, 2), other)
  await mkdir(objDir, { recursive: true })
  await writeFile(join(objDir, 'other.doc'), 'x')
  await assert.rejects(() => findAttachment(store, FAKE_SHA.slice(0, 8)), /ambiguous/)
  await assert.rejects(() => findAttachment(store, 'ffff0000'), /no attachment matches/)
  await assert.rejects(() => findAttachment(store, '不存在.doc'), /no attachment named/)
  // 7 位纯 hex 是手滑的短前缀，提示加长；非 hex 的 'short' 走原名匹配。
  await assert.rejects(() => findAttachment(store, 'abcd123'), /at least 8 hex chars/)
  await assert.rejects(() => findAttachment(store, 'short'), /no attachment named/)
})

function makeExportContext() {
  const emitted: Array<Record<string, unknown>> = []
  return {
    emitted,
    ctx: {
      fs: {
        resolve: async (path: string) => ({ targetKey: { key: path } as never, displayPath: path }),
        stat: async (target: { displayPath: string }) => {
          try {
            const st = await stat(target.displayPath)
            return { version: `v-${st.mtimeMs}` as never, type: st.isFile() ? 'file' : 'other', size: st.size }
          } catch {
            return undefined
          }
        }
      },
      emit: (event: string, target: unknown, observation: unknown) => {
        emitted.push({ event, target, observation })
      }
    }
  }
}

test('attachment_list tool reports the store contents', async () => {
  const tool = defineAttachmentListTool({ attachmentsDir: store })
  const result = (await tool.execute({}, {} as never)) as {
    count: number
    truncated: boolean
    totalBytes: number
    items: Array<{ name: string; sha: string; bytes: number }>
  }
  assert.equal(result.count, 1)
  assert.equal(result.truncated, false)
  assert.equal(result.items[0].name, FAKE_NAME)
  assert.equal(result.items[0].sha, FAKE_SHA.slice(0, 8))
  assert.ok(result.totalBytes > 20000)
})

test('attachment_list query filters by name substring after scan, before truncation', async () => {
  const tool = defineAttachmentListTool({ attachmentsDir: store })
  // 命中（大小写不敏感的子串）与未命中两种口径都要对。
  const hit = (await tool.execute({ query: ' 物业 ' }, {} as never)) as { count: number; items: Array<{ name: string }> }
  assert.equal(hit.count, 1)
  assert.equal(hit.items[0].name, FAKE_NAME)
  const miss = (await tool.execute({ query: '不存在的名字' }, {} as never)) as { count: number; totalBytes: number; items: unknown[] }
  assert.equal(miss.count, 0)
  assert.equal(miss.totalBytes, 0)
  assert.deepEqual(miss.items, [])
})

test('export_attachment copies bytes into the workspace and emits observations', async () => {
  const { ctx, emitted } = makeExportContext()
  const tool = defineAttachmentExportTool(ctx as never, { attachmentsDir: store })
  const dest = join(workspace, 'out', FAKE_NAME)
  await mkdir(join(workspace, 'out'), { recursive: true })
  const result = (await tool.execute({ attachment: FAKE_SHA.slice(0, 8), dest_path: dest }, {} as never)) as {
    path: string
    name: string
    bytes: number
  }
  assert.equal(result.name, FAKE_NAME)
  const exported = await readFile(dest)
  const source = await readFile(new URL('./fixtures/sanming-dog-regulation.doc', import.meta.url))
  assert.deepEqual(exported, source)
  const kinds = emitted.map((e) => (e.observation as { kind: string }).kind)
  assert.deepEqual(kinds, ['absent', 'present'])
})

test('export_attachment refuses an existing destination', async () => {
  const { ctx } = makeExportContext()
  const tool = defineAttachmentExportTool(ctx as never, { attachmentsDir: store })
  const dest = join(workspace, FAKE_NAME)
  await writeFile(dest, 'occupied')
  await assert.rejects(
    () => tool.execute({ attachment: FAKE_NAME, dest_path: dest }, {} as never),
    /destination already exists/
  )
})

test('export_attachment requires non-empty args', async () => {
  const { ctx } = makeExportContext()
  const tool = defineAttachmentExportTool(ctx as never, { attachmentsDir: store })
  // 缺参由 dsh-tools 的 schema 校验先拦（required 属性）。
  await assert.rejects(() => tool.execute({}, {} as never), /missing required property "attachment"/)
  // 存在但为空的参数由工具层 requireString 拦。
  await assert.rejects(
    () => tool.execute({ attachment: '  ', dest_path: 'x' }, {} as never),
    /attachment must be/
  )
  await assert.rejects(
    () => tool.execute({ attachment: FAKE_SHA.slice(0, 8), dest_path: '' }, {} as never),
    /dest_path must be/
  )
})
