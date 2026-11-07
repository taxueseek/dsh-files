// 1-based page range parser: handles expressions like "1-3, 5, 8-10".
// Validates boundaries and sorts unique page numbers ascending.
export function parsePageRange(rangeStr, totalPages) {
    const parts = rangeStr.split(',');
    const pages = new Set();
    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed)
            continue;
        if (trimmed.includes('-')) {
            const sides = trimmed.split('-');
            if (sides.length !== 2)
                throw new Error(`invalid page range segment: "${trimmed}"`);
            const start = parseInt(sides[0].trim(), 10);
            const end = parseInt(sides[1].trim(), 10);
            if (Number.isNaN(start) || Number.isNaN(end) || start < 1 || end < start) {
                throw new Error(`invalid page range segment: "${trimmed}"`);
            }
            for (let p = start; p <= end; p++) {
                if (p <= totalPages)
                    pages.add(p);
            }
        }
        else {
            const p = parseInt(trimmed, 10);
            if (Number.isNaN(p) || p < 1) {
                throw new Error(`invalid page number: "${trimmed}"`);
            }
            if (p <= totalPages)
                pages.add(p);
        }
    }
    const result = Array.from(pages).sort((a, b) => a - b);
    if (result.length === 0 && totalPages > 0) {
        throw new Error(`page_range "${rangeStr}" yielded no valid pages (document has ${totalPages} page(s))`);
    }
    return result;
}
