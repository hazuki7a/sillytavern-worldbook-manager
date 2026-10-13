import { clone, validBook } from './core.js';

export const CHAT_KEY = 'st_worldbook_updater_selection';
export const GROUP_KEY = 'st_worldbook_manager_groups';
export function nextCopyName(source, names) {
    let i = 1;
    while (names.includes(`${source} - 副本${i}`)) i++;
    return `${source} - 副本${i}`;
}
export function normalizeImport(value, convert) {
    const book = value?.data?.character_book || value?.character_book || value;
    if (Array.isArray(book?.entries)) return convert(clone(book));
    if (!validBook(book)) throw new Error('文件不是支持的世界书 JSON（需要 entries）。');
    const result = clone(book);
    for (const [id, entry] of Object.entries(result.entries)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('世界书存在无效条目。');
        if (entry.uid === undefined) entry.uid = Number(id);
        if (!Number.isSafeInteger(entry.uid) || String(entry.uid) !== id) throw new Error('条目 UID 与编号不一致，请先用酒馆原生导入转换。');
        if (typeof entry.content !== 'string') throw new Error('条目正文必须为字符串。');
        if (entry.key !== undefined && !Array.isArray(entry.key)) throw new Error('主要关键词必须为数组。');
    }
    return result;
}
export function familyNames(family) {
    return [...new Set([family?.main, ...(family?.copies || []), ...(family?.ancestors || [])].filter(Boolean))];
}
// EventEmitter exposes these actual arrays before ST merges/scans entries.
export function filterChatVariant(payload, { owner, metadata, family, names }) {
    const selection = metadata?.[CHAT_KEY];
    if (!selection || selection.owner !== owner || !family || !selection.name
        || metadata.world_info !== selection.name || !names.includes(selection.name)
        || !familyNames(family).includes(selection.name)) return false;
    const excluded = new Set(familyNames(family).filter(name => name !== selection.name));
    for (const key of ['characterLore', 'globalLore', 'chatLore', 'personaLore']) {
        const entries = payload[key];
        if (!Array.isArray(entries)) continue;
        for (let i = entries.length - 1; i >= 0; i--) if (excluded.has(entries[i].world)) entries.splice(i, 1);
    }
    return true;
}

export function groupsFor(book) {
    const stored = book.extensions?.[GROUP_KEY];
    const labels = [...new Set(['默认', 'MVU', ...(Array.isArray(stored?.labels) ? stored.labels : []).filter(s => typeof s === 'string')])];
    const assignments = {};
    for (const [id, entry] of Object.entries(book.entries)) {
        const assigned = stored?.assignments?.[id];
        assignments[id] = labels.includes(assigned) ? assigned : /mvu|\[initvar\]|\[updatevar\]/i.test(entry.comment || '') ? 'MVU' : '默认';
    }
    return { labels, assignments };
}
export function writeGroups(book, groups) {
    book.extensions ??= {};
    book.extensions[GROUP_KEY] = clone(groups);
}
export function strategyOf(entry) {
    if (entry.constant) return 'constant';
    if (entry.vectorized) return 'vectorized';
    return 'keyword';
}
export function setStrategy(draft, id, value) {
    draft.update(id, 'constant', value === 'constant');
    draft.update(id, 'vectorized', value === 'vectorized');
}
