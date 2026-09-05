// 回归测试（0.5.0 保留项）。
// decodeText 的 UTF-16 BOM + 奇数尾字节契约：必须返回 null 而非抛 TypeError。
// 0.4.3 批次的 sanitizeFileName / upload handler / sweep / cache-key 回归
// 随上传半与解析缓存一起移除（宿主 0.1.3 原生上传接管，见 CHANGELOG 0.5.0）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeText } from '../src/parse/text.ts'

test('decodeText returns null for a UTF-16 BOM followed by an odd trailing byte', () => {
  // BOM + 1 字节：fatal 解码必然失败，必须返回 null 而不是抛 TypeError。
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x41])), null)
  assert.equal(decodeText(new Uint8Array([0xfe, 0xff, 0x00])), null)
  // BOM + 偶数有效字节仍正常解码。
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00])), 'A')
})
