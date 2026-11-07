// PDF text extraction via pdfjs-dist (Mozilla's maintained renderer).
// Replaces pdf-parse@1.1.1 (unmaintained since 2020, crash-prone debug path).
// Text layer only — no rendering, no font downloads (useSystemFonts for any
// embedded font fallback stays local).
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parsePageRange } from "./range.js";
/**
 * Extract the text layer of a PDF as line-oriented text (one entry per
 * original line where the content stream marks EOLs), pages separated by a
 * blank line.
 */
export async function parsePdf(bytes, options = {}) {
    // pdfjs 会把传入的 data.buffer 作为 transferable 转移（Node 26 的 LoopbackPort
    // 对 detached buffer 的二次 transfer 抛 DataCloneError），因此解析前必须复制
    // 一份工作副本，保住调用方的 bytes 不被 detach。
    const doc = await getDocument({
        data: new Uint8Array(bytes),
        // Node has no web worker; these options keep the legacy build self-contained.
        disableWorker: true,
        isEvalSupported: false,
        useSystemFonts: true
    }).promise;
    try {
        const targetPages = options.pageRange !== undefined
            ? parsePageRange(options.pageRange, doc.numPages)
            : Array.from({ length: doc.numPages }, (_, i) => i + 1);
        const pages = [];
        for (const pageNo of targetPages) {
            const page = await doc.getPage(pageNo);
            try {
                const content = await page.getTextContent();
                const lines = [];
                let line = '';
                let prevX;
                let prevWidth;
                for (const item of content.items) {
                    if ('str' in item) {
                        // 相邻 text run 之间若存在水平间隙则补空格：PDF 常把一个
                        // 单词/句子拆成多个 run，直接拼接会得到 "Helloworld"。
                        const x = item.transform?.[4];
                        const width = 'width' in item ? item.width : undefined;
                        if (prevX !== undefined && prevWidth !== undefined && x !== undefined && x > prevX + prevWidth + 1) {
                            line += ' ';
                        }
                        line += item.str;
                        prevX = x;
                        prevWidth = width;
                        if (item.hasEOL) {
                            lines.push(line);
                            line = '';
                            prevX = undefined;
                            prevWidth = undefined;
                        }
                    }
                }
                if (line !== '')
                    lines.push(line);
                const pageText = lines.join('\n');
                if (doc.numPages > 1 || options.pageRange !== undefined) {
                    pages.push(`### Page ${pageNo} / ${doc.numPages}\n${pageText}`);
                }
                else {
                    pages.push(pageText);
                }
            }
            finally {
                page.cleanup();
            }
        }
        const text = pages.join('\n\n');
        // 扫描件/纯图片 PDF 没有文本层：返回显式提示而非空串，
        // 防止模型把「无文本」误读成「空文件」。
        if (text.trim() === '' && doc.numPages > 0) {
            return '\n[此 PDF 没有文本层（可能是扫描件或纯图片文档），read_document 无法提取文字内容。建议直接使用宿主多模态视觉能力进行识读]\n';
        }
        return text;
    }
    finally {
        await doc.destroy();
    }
}
