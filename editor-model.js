import { clone, equal, validBook } from './core.js';
import { writeGroups } from './manager-model.js';

const extraMap = {
    group: 'extensions.group', outletName: 'extensions.outlet_name',
    useProbability: 'extensions.useProbability', characterFilter: 'character_filter',
    selectiveLogic: 'extensions.selectiveLogic',
};
function setPath(object, path, value) {
    const parts = path.split('.');
    if (parts.some(p => ['__proto__', 'constructor', 'prototype'].includes(p))) throw new Error('无效字段路径。');
    let node = object;
    for (const key of parts.slice(0, -1)) {
        if (!node[key] || typeof node[key] !== 'object') node[key] = {};
        node = node[key];
    }
    node[parts.at(-1)] = clone(value);
}

export function scopedBooks({ primary = '', extra = [], global = [], names, copies = [], history = [] }) {
    const rows = new Map();
    const add = (name, tag) => {
        if (!name || !names.includes(name)) return;
        if (!rows.has(name)) rows.set(name, { name, tags: [] });
        if (!rows.get(name).tags.includes(tag)) rows.get(name).tags.push(tag);
    };
    add(primary, '角色主世界书');
    for (const name of copies) {
        add(name, '角色世界书副本');
        if (rows.has(name)) rows.get(name).parent = primary;
    }
    for (const name of history) {
        add(name, '对话使用的保留版本');
        if (rows.has(name)) rows.get(name).parent = primary;
    }
    extra.forEach(name => add(name, '角色额外世界书'));
    global.forEach(name => add(name, '全局启用'));
    return [...rows.values()];
}

export class BookDraft {
    constructor(name, data, keyMap = {}) {
        if (!validBook(data)) throw new Error('世界书数据不完整。');
        this.name = name;
        this.keyMap = { ...keyMap, ...extraMap };
        this.accept(data);
    }
    accept(data) {
        this.base = clone(data);
        this.data = clone(data);
        this.changed = new Map();
        this.added = new Set();
        this.deleted = new Set();
        this.index = new Map();
        this.externalChanged = false;
    }
    get dirty() { return !!(this.changed.size || this.added.size || this.deleted.size || !equal(this.data.extensions, this.base.extensions)); }
    setGroups(groups) { writeGroups(this.data, groups); }
    update(id, field, value) {
        const entry = this.data.entries[id];
        if (!entry || ['uid', '__proto__', 'constructor', 'prototype'].includes(field)) throw new Error('无效条目字段。');
        if (equal(entry[field], value)) return;
        entry[field] = clone(value);
        this.index.delete(id);
        if (!this.added.has(id)) {
            const fields = this.changed.get(id) || new Set();
            if (equal(this.base.entries[id]?.[field], value)) fields.delete(field);
            else fields.add(field);
            if (fields.size) this.changed.set(id, fields);
            else this.changed.delete(id);
        }
    }
    add(template, sourceId) {
        let uid = 0;
        // Do not reuse an ID deleted in this unsaved draft; keep source identity unambiguous.
        while (Object.hasOwn(this.data.entries, uid) || Object.hasOwn(this.base.entries, uid)) uid++;
        const id = String(uid);
        this.data.entries[id] = { ...clone(sourceId ? this.data.entries[sourceId] : template), uid };
        if (sourceId) this.data.entries[id].comment = `${this.data.entries[id].comment || '条目'}（副本）`;
        this.added.add(id);
        return id;
    }
    remove(id) {
        if (!Object.hasOwn(this.data.entries, id)) return;
        delete this.data.entries[id];
        this.changed.delete(id);
        this.index.delete(id);
        if (!this.added.delete(id)) this.deleted.add(id);
    }
    search(query = '', mode = 'all') {
        const text = query.trim().toLocaleLowerCase();
        return Object.entries(this.data.entries).filter(([id, entry]) => {
            if (mode === 'enabled' && entry.disable || mode === 'disabled' && !entry.disable) return false;
            if (!text) return true;
            if (!this.index.has(id)) this.index.set(id,
                [entry.comment, ...(entry.key || []), ...(entry.keysecondary || []), entry.content, id].join('\n').toLocaleLowerCase());
            return this.index.get(id).includes(text);
        }).sort((a, b) => (a[1].displayIndex ?? Number(a[0])) - (b[1].displayIndex ?? Number(b[0])))
            .map(([id]) => id);
    }
    serialize() {
        const result = clone(this.data);
        const originals = result.originalData?.entries;
        if (!Array.isArray(originals)) return result;
        const matches = (entry, id) => String(entry.id ?? entry.uid) === String(id);
        result.originalData.entries = originals.filter(entry => ![...this.deleted].some(id => matches(entry, id)));
        for (const id of new Set([...this.changed.keys(), ...this.added])) {
            const entry = result.entries[id];
            let original = result.originalData.entries.find(item => matches(item, id));
            if (!original) {
                original = { id: entry.uid, extensions: clone(entry.extensions || {}) };
                result.originalData.entries.push(original);
            }
            const fields = this.added.has(id) ? Object.keys(entry) : this.changed.get(id);
            for (const field of [...fields].sort((a, b) => a === 'extensions' ? -1 : b === 'extensions' ? 1 : 0)) {
                if (field === 'extensions') original.extensions = clone(entry.extensions);
                else if (field === 'disable') original.enabled = !entry.disable;
                else if (field === 'selectiveLogic') {
                    original.selectiveLogic = entry.selectiveLogic;
                    setPath(original, 'extensions.selectiveLogic', entry.selectiveLogic);
                }
                else if (field === 'position') {
                    original.position = entry.position === 0 ? 'before_char' : 'after_char';
                    setPath(original, 'extensions.position', entry.position);
                } else if (this.keyMap[field]) setPath(original, this.keyMap[field], entry[field]);
            }
        }
        return result;
    }
}

export async function saveDraft(draft, host) {
    if (!draft.dirty) return false;
    await host.assertWritable(draft.name);
    const snapshot = draft.serialize();
    const latest = await host.read(draft.name);
    if (!equal(latest, draft.base)) {
        draft.externalChanged = true;
        throw new Error('这本世界书已在别处修改。草稿已保留，请导出草稿或重新载入，避免覆盖他人的修改。');
    }
    await host.backup(draft.name, latest);
    await host.assertWritable(draft.name);
    if (!equal(await host.read(draft.name), draft.base)) {
        draft.externalChanged = true;
        throw new Error('备份期间世界书已变化，未覆盖；草稿保留。');
    }
    await host.write(draft.name, snapshot);
    if (!equal(await host.read(draft.name), snapshot)) throw new Error('保存回读未通过；草稿保留，请检查备份。');
    draft.accept(snapshot);
    return true;
}
