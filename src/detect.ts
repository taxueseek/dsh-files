// Content sniffing: decide the real format of a document from its bytes,
// never from the file extension. An attacker-controlled name must not be able
// to route bytes into a parser they were not meant for (extension spoofing).
//
// Supported formats:
//   pdf   — "%PDF-" header
//   doc   — OLE Compound File (Word 97-2003 binary)
//   docx  — ZIP archive whose central directory lists word/ members
//   xlsx  — ZIP archive whose central directory lists xl/ members
//   text  — UTF-8 (no NUL bytes) or UTF-16 with BOM

export type DocumentFormat = 'pdf' | 'doc' | 'docx' | 'pptx' | 'xlsx' | 'text'

export const SUPPORTED_FORMATS: ReadonlySet<string> = new Set(['pdf', 'doc', 'docx', 'pptx', 'xlsx', 'text'])

/** Null bytes in the first chunk defeat every text decoding we accept. */
const SNIFF_BYTES = 8192
/** 头部预读量：64 KiB 足够覆盖所有头部签名（PDF 头 / BOM / 已知二进制 / 文本探测）。 */
export const HEAD_SNIFF_BYTES = 64 * 1024

/**
 * Lightweight ZIP central-directory probe. Returns the member names recorded
 * in the archive, or null when the bytes are not a readable ZIP. Reads only
 * the central directory metadata — never decompresses anything.
 */
export function zipMemberNames(bytes: Uint8Array): string[] | null {
  const len = bytes.length
  if (len < 22) return null
  // End Of Central Directory record: PK\x05\x06, at least 22 bytes + comment.
  const eocdMax = Math.min(len, 22 + 65535)
  let eocd = -1
  for (let i = len - eocdMax; i + 22 <= len; i++) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const readU16 = (off: number): number => bytes[off] | (bytes[off + 1] << 8)
  // ZIP 中央目录偏移是 UInt32（小端）。用 | 组合再 >>>0 转无符号，避免
  // 高位字节把中间结果推进 32 位有符号负值导致读取错误。
  const readU32 = (off: number): number =>
    (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
  const count = readU16(eocd + 10)
  const cdOffset = readU32(eocd + 16)
  // 合法办公文档成员数远低于此；超限视为不可信归档，拒绝而非展开。
  const MAX_MEMBERS = 4096
  if (count === 0 || count > MAX_MEMBERS || cdOffset + 46 > len) return null
  const names: string[] = []
  let off = cdOffset
  for (let i = 0; i < count; i++) {
    if (off + 46 > len) return null
    if (!(bytes[off] === 0x50 && bytes[off + 1] === 0x4b && bytes[off + 2] === 0x01 && bytes[off + 3] === 0x02)) {
      return null
    }
    const nameLen = readU16(off + 28)
    const extraLen = readU16(off + 30)
    const commentLen = readU16(off + 32)
    if (off + 46 + nameLen > len) return null
    // 用 latin1 逐字节转写代替 String.fromCharCode(...spread)：
    // spread 超过 ~12 万实参抛 RangeError，恶意大成员名可打崩进程。
    // 中央目录成员名是 CP437，ASCII 前缀探测用 latin1 逐字节一致。
    let s = ''
    for (let j = 0; j < nameLen; j++) {
      s += String.fromCharCode(bytes[off + 46 + j])
    }
    names.push(s)
    off += 46 + nameLen + extraLen + commentLen
  }
  return names
}

/** GB18030 可解即视为合法文本（fatal 模式无替换字符）。 */
function looksLikeGb18030(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, SNIFF_BYTES)
  // 太短无法判断；纯 ASCII 已由 looksLikeUtf8 覆盖。
  if (n < 4) return false
  // GBK/GB18030 中文文本必然包含高位双字节；无高位字节不可能是它。
  let hasHigh = false
  for (let i = 0; i < n; i++) {
    if (bytes[i] >= 0x80) {
      hasHigh = true
      break
    }
  }
  if (!hasHigh) return false
  try {
    const dec = new TextDecoder('gb18030', { fatal: true }).decode(bytes.subarray(0, n))
    // 可解但几乎全是控制字符的序列不是文本（防随机字节/压缩数据误判）。
    let printable = 0
    for (const ch of dec) {
      const code = ch.codePointAt(0) ?? 0
      if (code >= 0x20 && code !== 0x7f) printable++
    }
    return printable / Math.max(dec.length, 1) > 0.9
  } catch {
    return false
  }
}

/**
 * 无 BOM 的 UTF-16（ASCII 主导）识别：偶数长度 + 单侧码元含零字节。
 * 长样本（≥8 对）阈值 0.25，与 parse/text.ts 的 decodeUtf16WithoutBom
 * 对齐——嗅探比解码严会让同一文件「auto 拒、显式 format 收」（如中文
 * 占比偏高的混排文本，ASCII 字符的高位零字节占比落在 0.25-0.5 区间）。
 * 短样本统计无意义：随机 6 字节可有 1/3 的对恰含零字节，须过半才认。
 * 中文 UTF-16 文本码元常见非零高位而不会被命中（可保守），已知二进制
 * 由 isKnownBinary 优先拒绝。
 */
function looksLikeUtf16NoBom(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, SNIFF_BYTES)
  if (n < 4 || n % 2 !== 0) return false
  const pairs = n / 2
  let zeroEven = 0 // LE：每对码元的低字节为 0
  let zeroOdd = 0 // BE：每对码元的高字节为 0
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) zeroOdd++
    if (bytes[i + 1] === 0) zeroEven++
  }
  const threshold = pairs >= 8 ? 0.25 : 0.5
  return zeroEven > pairs * threshold || zeroOdd > pairs * threshold
}

function looksLikeUtf8(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, SNIFF_BYTES)
  // 空文件与极短纯 ASCII 是合法文本：拒绝它们会让 0-3 字节的
  // txt/csv/md 全部读不了（"unrecognized file content"）。
  if (n === 0) return true
  let i = 0
  while (i < n) {
    const b = bytes[i]
    if (b === 0) return false
    if (b < 0x80) {
      i += 1
    } else if ((b & 0xe0) === 0xc0) {
      if (i + 1 >= n || (bytes[i + 1] & 0xc0) !== 0x80) return false
      i += 2
    } else if ((b & 0xf0) === 0xe0) {
      if (i + 2 >= n || (bytes[i + 1] & 0xc0) !== 0x80 || (bytes[i + 2] & 0xc0) !== 0x80) return false
      i += 3
    } else if ((b & 0xf8) === 0xf0) {
      if (i + 3 >= n || (bytes[i + 1] & 0xc0) !== 0x80 || (bytes[i + 2] & 0xc0) !== 0x80 || (bytes[i + 3] & 0xc0) !== 0x80) return false
      i += 4
    } else {
      return false
    }
  }
  return true
}

/**
 * Signatures of common binary formats we do NOT parse. A file whose content
 * is clearly one of these must never be routed into a document parser, even
 * when a caller-supplied hint claims otherwise.
 */
const KNOWN_BINARY_SIGNATURES: ReadonlyArray<{ name: string; bytes: ReadonlyArray<number> }> = [
  { name: 'ms-dos executable', bytes: [0x4d, 0x5a] }, // MZ
  { name: 'elf executable', bytes: [0x7f, 0x45, 0x4c, 0x46] }, // \x7fELF
  { name: 'png image', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: 'jpeg image', bytes: [0xff, 0xd8, 0xff] },
  { name: 'gif image', bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { name: 'webp image', bytes: [0x52, 0x49, 0x46, 0x46] } // RIFF (checked against WEBP below)
]

function isKnownBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, SNIFF_BYTES)
  for (const sig of KNOWN_BINARY_SIGNATURES) {
    if (n < sig.bytes.length) continue
    let match = true
    for (let i = 0; i < sig.bytes.length; i++) {
      if (bytes[i] !== sig.bytes[i]) {
        match = false
        break
      }
    }
    if (match) {
      // RIFF is only WEBP when the form field says so; other RIFF forms
      // (AVI/WAV) are also unparsed binary.
      if (sig.name === 'webp image') {
        if (n >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
          return true
        }
        return n >= 12 // any other RIFF form is binary too
      }
      return true
    }
  }
  return false
}

/**
 * 只读头部的快速判定：返回 zip 标记时调用方需全量读取后再用 sniffFormat
 * 区分 docx/xlsx（ZIP 中央目录在文件尾部，头部看不到）。
 * hint 不参与头部判定——显式 format 场景由调用方走全量兜底。
 */
export function sniffHead(bytes: Uint8Array): 'pdf' | 'text' | 'zip' | 'doc' | null {
  const n = Math.min(bytes.length, SNIFF_BYTES)
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return 'text'
  }
  if (n >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return 'pdf'
  }
  if (n >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return 'zip'
  }
  // OLE Compound File（Word 97-2003）：8 字节固定魔数，必然不是文本。
  // 老式 .xls/.ppt 同为 OLE 容器，头部无法与 .doc 区分——先按 doc 路由，
  // 解析器找不到 Word 文档流时 loud fail，错误消息里给出可能性提示。
  if (n >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1) {
    return 'doc'
  }
  if (looksLikeUtf8(bytes)) return 'text'
  if (isKnownBinary(bytes)) return null
  if (looksLikeGb18030(bytes)) return 'text'
  if (looksLikeUtf16NoBom(bytes)) return 'text'
  return null
}

/**
 * Sniff the real format of `bytes`. `hint` is only consulted when the bytes
 * are ambiguous (unrecognized content with no clear signature) AND not a
 * known foreign binary; a recognized signature always wins so spoofed
 * extensions cannot redirect parsing.
 */
export function sniffFormat(bytes: Uint8Array, hint?: string): DocumentFormat | null {
  const n = Math.min(bytes.length, SNIFF_BYTES)
  // UTF-16 BOMs are unambiguous text encodings.
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return 'text'
  }
  if (n >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return 'pdf'
  }
  if (n >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const names = zipMemberNames(bytes)
    if (names !== null) {
      if (names.some((name) => name.startsWith('word/'))) return 'docx'
      if (names.some((name) => name.startsWith('xl/'))) return 'xlsx'
      if (names.some((name) => name.startsWith('ppt/'))) return 'pptx'
    }
    return null
  }
  if (n >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1) {
    return 'doc'
  }
  if (looksLikeUtf8(bytes)) return 'text'
  if (isKnownBinary(bytes)) return null
  // GB18030 兜底：中文场景常见的 GBK/GB2312 文件，UTF-8 fatal 判定失败后的
  // 合法文本候选。TextDecoder fatal 模式不产生替换字符，可解即为文本。
  if (looksLikeGb18030(bytes)) return 'text'
  if (looksLikeUtf16NoBom(bytes)) return 'text'
  if (hint !== undefined && SUPPORTED_FORMATS.has(hint)) {
    // Unrecognized content: honor the caller's explicit override as a last
    // resort (the parser still validates the structure and will fail loudly
    // on mismatched content).
    return hint as DocumentFormat
  }
  return null
}

/** Whether the extension alone declares a supported format (for hints only). */
export function formatFromExtension(name: string): DocumentFormat | null {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const ext = name.slice(dot + 1).toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (ext === 'doc') return 'doc'
  if (ext === 'docx') return 'docx'
  if (ext === 'pptx') return 'pptx'
  if (ext === 'xlsx') return 'xlsx'
  if (ext === 'txt' || ext === 'md' || ext === 'csv' || ext === 'json' || ext === 'log' || ext === 'yml' || ext === 'yaml' || ext === 'toml' || ext === 'ini') return 'text'
  return null
}
