// Client draft-token editing tests. The helpers live in src/client/draft.ts
// (JSX-free) so they can be imported directly under node --test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { removeTokenFromDraft } from '../src/client/draft.ts'

test('removeTokenFromDraft deletes the exact ref at the occurrence offset', () => {
  // 路径含空格：盲扫空白会切一半，精确匹配必须删掉完整 token。
  const draft = '看看 /tmp/ws/a b/file.pdf 好了吗'
  const ref = '/tmp/ws/a b/file.pdf'
  const offset = draft.indexOf(ref)
  // chip 自带的分隔空格不再留成双空格：删除点两侧都是空格时吃掉一个。
  assert.equal(removeTokenFromDraft(draft, ref, offset), '看看 好了吗')
})

test('removeTokenFromDraft keeps text before and after the token', () => {
  const draft = 'prefix~/x/y.md suffix'
  assert.equal(removeTokenFromDraft(draft, '~/x/y.md', 6), 'prefix suffix')
})

test('removeTokenFromDraft falls back to whitespace scanning when the draft moved on', () => {
  // ref 与 offset 处的实际文本不一致（用户已编辑草稿）：回退扫到空白。
  assert.equal(removeTokenFromDraft('read /a/b.txt now', '/zzz/other.txt', 5), 'read now')
})

test('removeTokenFromDraft keeps single spacers at draft edges', () => {
  // 删除点在行首/行尾时没有「两侧配对空格」，不吃空格（尾空格保留）。
  assert.equal(removeTokenFromDraft('/a/b.txt tail', '/a/b.txt', 0), ' tail')
  assert.equal(removeTokenFromDraft('head /a/b.txt', '/a/b.txt', 5), 'head ')
})

test('removeTokenFromDraft stops at the first whitespace in fallback mode', () => {
  assert.equal(removeTokenFromDraft('one two three', '/nope', 0), ' two three')
})

test('removeTokenFromDraft with an empty ref falls back to the scan', () => {
  assert.equal(removeTokenFromDraft('keep /a/b', '', 5), 'keep ')
})

test('removeTokenFromDraft beyond the draft length returns the draft unchanged', () => {
  assert.equal(removeTokenFromDraft('abc', '/a', 10), 'abc')
})
