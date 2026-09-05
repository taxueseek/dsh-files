// Plain-text decoding: BOM-aware UTF-16, then UTF-8 (fatal), then GB18030
// (fatal) as a Chinese-scenario fallback. Returns null when no encoding in
// the chain decodes cleanly, so callers can reject instead of emitting
// replacement characters.
function tryDecode(bytes, encoding, stripBom) {
    try {
        const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
        return stripBom ? text.replace(/^\uFEFF/, '') : text;
    }
    catch {
        return null;
    }
}
export function decodeText(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        // BOM 后必须剩偶数个字节才是合法 UTF-16LE；奇数截尾时 fatal 解码会抛
        // TypeError 而非返回 null，违反本函数「解不出就返回 null」的契约。
        if ((bytes.length - 2) % 2 !== 0)
            return null;
        return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        if ((bytes.length - 2) % 2 !== 0)
            return null;
        return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    }
    // 与 detect 的文本判定一致：含 NUL 的解出结果不是合法文本，拒绝，
    // 以免把无 BOM 的 UTF-16 误判成带 NUL 的 UTF-8 串。
    const utf8 = tryDecode(bytes, 'utf-8', true);
    if (utf8 !== null && !utf8.includes('\u0000'))
        return utf8;
    const gb = tryDecode(bytes, 'gb18030', false);
    if (gb !== null && !gb.includes('\u0000'))
        return gb;
    return decodeUtf16WithoutBom(bytes);
}
/**
 * 无 BOM 的 UTF-16 兜底：UTF-8 / GB18030 都失败时才尝试，且仅当字节呈
 * 「偶数长度 + 每对码元含至少一个零字节（ASCII 文本的 UTF-16 特征）」时
 * 启用，配合 TextDecoder fatal 模式，避免把随机二进制误判成 UTF-16。
 */
function decodeUtf16WithoutBom(bytes) {
    if (bytes.length < 2 || bytes.length % 2 !== 0)
        return null;
    const pairs = bytes.length / 2;
    let zeroEven = 0; // LE：每对码元的低字节为 0
    let zeroOdd = 0; // BE：每对码元的高字节为 0
    for (let i = 0; i < bytes.length; i += 2) {
        if (bytes[i] === 0)
            zeroOdd++;
        if (bytes[i + 1] === 0)
            zeroEven++;
    }
    if (zeroEven > pairs * 0.25) {
        const le = tryDecode(bytes, 'utf-16le', false);
        if (le !== null && !le.includes('\u0000'))
            return le;
    }
    if (zeroOdd > pairs * 0.25) {
        const be = tryDecode(bytes, 'utf-16be', false);
        if (be !== null && !be.includes('\u0000'))
            return be;
    }
    return null;
}
/** Split decoded text into 1-based line windows without a trailing phantom line. */
export function windowLines(text, offset, limit, maxChars = Infinity) {
    // CRLF 文本每行残留的 \r 会在行号输出里脏化模型看到的文本。
    const normalized = text.replace(/\r\n/g, '\n');
    const endsWithNewline = normalized.endsWith('\n');
    const all = normalized.split('\n');
    if (endsWithNewline && all.length > 0)
        all.pop();
    const totalLines = all.length;
    const start = Math.max(0, offset - 1);
    const end = Math.min(totalLines, start + limit);
    const lines = [];
    let budget = maxChars;
    for (let i = start; i < end; i++) {
        const raw = all[i];
        // 总字符预算：窗口累计超限就停，防止 2000 行 × 长行撑爆上下文。
        // 单行超长也按剩余预算截断并显式标记。
        if (raw.length > budget) {
            lines.push({
                number: i + 1,
                text: `${raw.slice(0, Math.max(0, budget))}…[truncated, ${raw.length} chars]`
            });
            break;
        }
        lines.push({ number: i + 1, text: raw });
        budget -= raw.length;
    }
    const shown = lines.length;
    const hidden = end - start - shown;
    if (hidden > 0 && lines.length > 0) {
        lines[lines.length - 1] = {
            ...lines[lines.length - 1],
            text: `${lines[lines.length - 1].text}\n…[${hidden} more lines not shown — character budget reached; use offset/limit to page]`
        };
    }
    return { totalLines, lines };
}
