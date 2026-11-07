// PPTX text and table extraction via jszip (pure JS, maintained, zero-native).
// Parses Open Packaging Conventions (OPC) PresentationML slides in presentation order.
import JSZip from 'jszip';
import { parsePageRange } from "./range.js";
function decodeXml(s) {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}
/**
 * 确定幻灯片的播放顺序。优先按 presentation.xml 里的 sldIdLst + rels 映射；
 * 若关系文件不全则回退至文件名数字升序。
 */
async function resolveSlidePaths(zip) {
    try {
        const presFile = zip.file('ppt/presentation.xml');
        const relsFile = zip.file('ppt/_rels/presentation.xml.rels');
        if (presFile !== null && relsFile !== null) {
            const presXml = await presFile.async('text');
            const relsXml = await relsFile.async('text');
            // 解析 rels: Id -> Target
            const relMap = new Map();
            const relRegex = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g;
            let m;
            while ((m = relRegex.exec(relsXml)) !== null) {
                relMap.set(m[1], m[2]);
            }
            // 解析 sldIdLst 的 r:id 顺序
            const sldRegex = /<p:sldId\b[^>]*\br:id="([^"]+)"/g;
            const orderedPaths = [];
            while ((m = sldRegex.exec(presXml)) !== null) {
                const target = relMap.get(m[1]);
                if (target !== undefined) {
                    // Target 通常为 "slides/slide1.xml"，归一化为 "ppt/slides/slide1.xml"
                    const normalized = target.startsWith('ppt/')
                        ? target
                        : target.startsWith('/')
                            ? target.slice(1)
                            : `ppt/${target}`;
                    if (zip.file(normalized) !== null) {
                        orderedPaths.push(normalized);
                    }
                }
            }
            if (orderedPaths.length > 0)
                return orderedPaths;
        }
    }
    catch {
        // 忽略异常，降级到文件名排序
    }
    // 降级：扫描所有 ppt/slides/slide*.xml 并按数字排序
    const fallbackPaths = [];
    zip.forEach((path) => {
        const match = path.match(/^ppt\/slides\/slide(\d+)\.xml$/);
        if (match) {
            fallbackPaths.push({ path, num: parseInt(match[1], 10) });
        }
    });
    fallbackPaths.sort((a, b) => a.num - b.num);
    return fallbackPaths.map((item) => item.path);
}
function parseSlideXml(xml, outputFormat) {
    const tables = [];
    // 抽出所有表格 <a:tbl> 并暂存，替换为无 $ 字符冲突的纯 ASCII 占位符
    const noTblXml = xml.replace(/<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/g, (_match, tblBody) => {
        const rows = [];
        const trRegex = /<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g;
        let trMatch;
        while ((trMatch = trRegex.exec(tblBody)) !== null) {
            const tcRegex = /<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g;
            const row = [];
            let tcMatch;
            while ((tcMatch = tcRegex.exec(trMatch[1])) !== null) {
                const tMatches = tcMatch[1].match(/<a:t\b[^>]*>([^<]*)<\/a:t>/g) ?? [];
                const cell = tMatches
                    .map((m) => m.replace(/<[^>]+>/g, ''))
                    .map(decodeXml)
                    .join('')
                    .replace(/\r?\n/g, ' ')
                    .trim();
                row.push(cell);
            }
            if (row.length > 0)
                rows.push(row);
        }
        if (rows.length === 0)
            return '';
        const idx = tables.length;
        tables.push(rows);
        return `___TABLE_PLACEHOLDER_${idx}___`;
    });
    // 按出现顺序匹配段落 <a:p> 和表格占位符
    const blocks = [];
    const itemRegex = /(?:<a:p\b[^>]*>([\s\S]*?)<\/a:p>|___TABLE_PLACEHOLDER_(\d+)___)/g;
    let match;
    while ((match = itemRegex.exec(noTblXml)) !== null) {
        if (match[2] !== undefined) {
            const idx = parseInt(match[2], 10);
            const rows = tables[idx];
            if (rows && rows.length > 0) {
                if (outputFormat === 'markdown') {
                    const maxCols = Math.max(...rows.map((r) => r.length), 0);
                    const padded = rows.map((r) => {
                        const copy = [...r];
                        while (copy.length < maxCols)
                            copy.push('');
                        return copy;
                    });
                    const header = padded[0];
                    const headerLine = `| ${header.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
                    const sepLine = `| ${header.map(() => '---').join(' | ')} |`;
                    const dataLines = padded.slice(1).map((r) => `| ${r.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`);
                    blocks.push([headerLine, sepLine, ...dataLines].join('\n'));
                }
                else {
                    blocks.push(rows.map((r) => r.join('\t')).join('\n'));
                }
            }
        }
        else if (match[1] !== undefined) {
            const pBody = match[1];
            const tMatches = pBody.match(/<a:t\b[^>]*>([^<]*)<\/a:t>/g);
            if (tMatches) {
                const line = tMatches
                    .map((m) => m.replace(/<[^>]+>/g, ''))
                    .map(decodeXml)
                    .join('');
                if (line.trim().length > 0) {
                    blocks.push(line);
                }
            }
        }
    }
    return blocks.join('\n');
}
export async function parsePptx(bytes, options = {}) {
    const zip = await JSZip.loadAsync(bytes);
    const slidePaths = await resolveSlidePaths(zip);
    const totalPages = slidePaths.length;
    if (totalPages === 0)
        return '(empty presentation)';
    const outputFormat = options.outputFormat ?? 'markdown';
    const targetPages = options.pageRange !== undefined
        ? parsePageRange(options.pageRange, totalPages)
        : Array.from({ length: totalPages }, (_, i) => i + 1);
    const slidesOutput = [];
    let totalExtractedLength = 0;
    for (const pageNo of targetPages) {
        const slidePath = slidePaths[pageNo - 1];
        const file = zip.file(slidePath);
        if (file === null)
            continue;
        const xml = await file.async('text');
        const content = parseSlideXml(xml, outputFormat);
        totalExtractedLength += content.trim().length;
        const header = `### Slide ${pageNo} / ${totalPages}`;
        slidesOutput.push(content.trim().length > 0 ? `${header}\n${content}` : `${header}\n(no text on this slide)`);
    }
    const result = slidesOutput.join('\n\n');
    if (totalExtractedLength === 0 && totalPages > 0) {
        return '\n[此 PPTX 没有可提取的文本内容（可能是纯图片或未输入文字的幻灯片），如需阅读建议直接使用宿主多模态视觉能力]\n';
    }
    return result;
}
