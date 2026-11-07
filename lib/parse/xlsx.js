// XLSX cell text extraction via read-excel-file (read-only parser, no known
// advisories — replaces xlsx@0.18.5 which carries prototype-pollution CVEs).
// The parser streams the workbook internally; `sheetRowLimit` bounds the rows
// we keep for the model per sheet, and `maxSheets` bounds how many sheets are
// read. Truncation is reported explicitly so the model never mistakes a
// partial table for the whole workbook.
import readXlsxFile, { readSheetNames } from 'read-excel-file/node';
function cellText(value) {
    if (value === null || value === undefined)
        return '';
    if (value instanceof Date) {
        // read-excel-file 返回 UTC 的 Date；输出干净格式：
        // 有非零时间分量才带时间，去掉 .000Z 噪音。
        const iso = value.toISOString().replace('T', ' ').slice(0, 19);
        return iso.endsWith(' 00:00:00') ? iso.slice(0, 10) : iso;
    }
    // 单元格内换行会破坏表格行对齐（行与列以 \n 和 \t 分隔），替换为空格。
    return String(value).replace(/\r?\n/g, ' ');
}
function rowsToText(rows) {
    return rows.map((row) => row.map(cellText).join('\t').replace(/\s+$/, '')).join('\n');
}
function rowsToMarkdown(rows) {
    if (rows.length === 0)
        return '';
    const sanitized = rows.map((row) => row.map(cellText));
    const maxCols = Math.max(...sanitized.map((r) => r.length), 0);
    if (maxCols === 0)
        return '';
    const padded = sanitized.map((r) => {
        const copy = [...r];
        while (copy.length < maxCols)
            copy.push('');
        return copy;
    });
    const header = padded[0];
    const headerLine = `| ${header.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
    const sepLine = `| ${header.map(() => '---').join(' | ')} |`;
    const dataLines = padded.slice(1).map((r) => `| ${r.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`);
    return [headerLine, sepLine, ...dataLines].join('\n');
}
function formatRows(rows, format) {
    if (format === 'markdown')
        return rowsToMarkdown(rows);
    return rowsToText(rows);
}
export async function parseXlsx(bytes, options) {
    const buf = Buffer.from(bytes);
    const sheetNames = await readSheetNames(buf);
    // 只列 sheet 名：模型先看有哪些 sheet，再决定读哪个（sheet 参数）。
    if (options.listOnly === true) {
        if (sheetNames.length === 0)
            return '(empty workbook)';
        return `### Sheets (${sheetNames.length})\n${sheetNames.map((s, i) => `${i + 1}. ${String(s)}`).join('\n')}`;
    }
    // sheet 级读取：截断发生在解析期，offset 翻页翻不回来；
    // 指定 sheet 时返回该 sheet 全量，由工具层分页控制输出。
    if (options.sheet !== undefined) {
        const idx = options.sheet;
        if (idx < 1 || idx > sheetNames.length) {
            // 越界错误带上可用列表，模型能自纠正而不是瞎猜。
            const list = sheetNames.map((s, i) => `${i + 1}. ${String(s)}`).join(', ');
            throw new Error(`sheet ${idx} out of range: workbook has ${sheetNames.length} sheet(s) — ${list}`);
        }
        const sheet = sheetNames[idx - 1];
        const rows = await readXlsxFile(buf, { sheet });
        return [`### Sheet: ${String(sheet)}（全量，共 ${rows.length} 行）`, formatRows(rows, options.outputFormat)].join('\n\n');
    }
    const maxSheets = options.maxSheets ?? 5;
    const sheets = sheetNames.length > 0 ? sheetNames.slice(0, maxSheets) : [1];
    const parts = [];
    let totalRows = 0;
    let truncated = false;
    let sheetTruncated = false;
    for (const sheet of sheets) {
        const rows = await readXlsxFile(buf, { sheet });
        totalRows += rows.length;
        const kept = rows.slice(0, options.sheetRowLimit);
        if (rows.length > kept.length)
            sheetTruncated = true;
        parts.push(`### Sheet: ${String(sheet)}\n${formatRows(kept, options.outputFormat)}`);
    }
    // 多 sheet 但被 maxSheets 截断
    if (sheetNames.length > sheets.length) {
        parts.push(`… 另有 ${sheetNames.length - sheets.length} 个 sheet 未读取（上限 ${maxSheets}）`);
        truncated = true;
    }
    // 单 sheet 行数被 sheetRowLimit 截断
    if (sheetTruncated) {
        parts.push(`… 已截断：每个 sheet 仅保留前 ${options.sheetRowLimit} 行，全簿共 ${totalRows} 行`);
    }
    return parts.join('\n\n');
}
