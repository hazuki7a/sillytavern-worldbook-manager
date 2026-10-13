import { BookDraft, scopedBooks, saveDraft } from './editor-model.js';
import { equal } from './core.js';

const LABELS = {
    comment: '条目标题 / 备注', content: '条目正文', key: '主要关键词', keysecondary: '辅助关键词',
    constant: '常驻条目', selective: '使用辅助关键词', selectiveLogic: '辅助关键词逻辑',
    disable: '停用条目', order: '插入顺序', position: '插入位置', depth: '聊天插入深度', role: '消息角色',
    probability: '触发概率（%）', useProbability: '使用概率', addMemo: '显示备注',
    vectorized: '允许向量检索', ignoreBudget: '忽略预算限制', excludeRecursion: '排除递归激活',
    preventRecursion: '阻止后续递归', delayUntilRecursion: '延迟到第几轮递归',
    matchPersonaDescription: '扫描用户角色描述', matchCharacterDescription: '扫描角色描述',
    matchCharacterPersonality: '扫描角色性格', matchCharacterDepthPrompt: '扫描角色备注',
    matchScenario: '扫描场景', matchCreatorNotes: '扫描作者备注', outletName: '输出槽名称',
    group: '包含组', groupOverride: '优先覆盖组选择', groupWeight: '组权重', scanDepth: '扫描深度',
    caseSensitive: '区分大小写', matchWholeWords: '匹配完整单词', useGroupScoring: '启用组评分',
    automationId: '自动化 ID', sticky: '持续生效轮数', cooldown: '冷却轮数', delay: '延迟轮数',
    characterFilterNames: '角色名称筛选', characterFilterTags: '角色标签筛选', characterFilterExclude: '排除筛选角色',
    triggers: '生成类型筛选', characterFilter: '角色筛选对象', extensions: '扩展数据', displayIndex: '显示顺序',
};
const COMMON = ['comment', 'disable', 'constant', 'key', 'keysecondary', 'content', 'order', 'position'];
const CHOICES = {
    position: [[0, '角色定义之前'], [1, '角色定义之后'], [2, '作者备注顶部'], [3, '作者备注底部'],
        [4, '聊天指定深度'], [5, '示例消息之前'], [6, '示例消息之后'], [7, '输出槽']],
    selectiveLogic: [[0, '辅助词任意一个匹配'], [1, '辅助词全部不匹配'], [2, '至少一个辅助词不匹配'], [3, '辅助词全部匹配']],
    role: [[0, '系统消息'], [1, '用户消息'], [2, '助手消息']],
};
const PAGE = 40;
function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}
function button(label, action, className = '') {
    const node = element('button', `wb-btn ${className}`, label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
}
function download(name, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createWorldbookEditor(host) {
    let dialog;
    let draft;
    let rows = [];
    let selectedId = '';
    let query = '';
    let mode = 'all';
    let page = 0;
    let filtered = [];
    let advancedOpen = false;
    let busy = false;
    let suspended = false;
    let loading = 0;
    let searchTimer;
    let refreshTimer;
    let scopeTicket = 0;
    let session = 0;
    let fieldsInvalid = new Set();
    const refs = {};
    const allowed = name => rows.some(row => row.name === name);
    function message(text, bad = false) {
        if (!refs.status) return;
        refs.status.textContent = text;
        refs.status.classList.toggle('wb-error', bad);
    }
    const guard = name => {
        host.assertActive();
        if (suspended || !allowed(name)) throw new Error('这本书已不在当前角色/全局范围内，草稿保留，请重新选择角色。');
    };
    function header() {
        if (!dialog) return;
        refs.title.textContent = draft && allowed(draft.name) ? draft.name : '世界书编辑器';
        refs.badge.textContent = draft?.dirty ? '有未保存修改' : '已同步';
        refs.badge.classList.toggle('wb-dirty', !!draft?.dirty);
        refs.save.disabled = busy || !draft?.dirty || !allowed(draft.name) || fieldsInvalid.size > 0;
        refs.export.disabled = !draft || busy;
        refs.reload.disabled = !draft || busy || !allowed(draft.name);
        refs.add.disabled = !draft || busy || !allowed(draft.name);
        refs.duplicate.disabled = !selectedId || busy || !allowed(draft?.name);
        refs.remove.disabled = !selectedId || busy || !allowed(draft?.name);
        refs.prev.disabled = busy || page === 0;
        refs.next.disabled = busy || (page + 1) * PAGE >= filtered.length;
        dialog.classList.toggle('wb-busy', busy);
        for (const input of refs.detail.querySelectorAll('input,textarea,select')) input.disabled = busy || !allowed(draft?.name);
    }
    function renderBooks() {
        refs.books.replaceChildren();
        if (!rows.length) {
            refs.books.append(element('p', 'wb-empty', '当前角色没有关联世界书，全局也没有启用世界书。请先在酒馆里关联或启用。'));
        }
        for (const row of rows) {
            const item = button('', () => selectBook(row.name), 'wb-book');
            item.classList.toggle('is-selected', row.name === draft?.name);
            item.setAttribute('aria-pressed', String(row.name === draft?.name));
            item.append(element('strong', '', row.name), element('small', '', row.tags.join(' · ')));
            refs.books.append(item);
        }
        refs.scope.textContent = `${host.characterName() || '未打开角色'} · ${rows.length} 本书`;
    }
    function renderList(recompute = true) {
        if (!dialog) return;
        if (recompute) filtered = draft && allowed(draft.name) ? draft.search(query, mode) : [];
        page = Math.max(0, Math.min(page, Math.ceil(filtered.length / PAGE) - 1));
        refs.entries.replaceChildren();
        for (const id of filtered.slice(page * PAGE, (page + 1) * PAGE)) {
            const entry = draft.data.entries[id];
            const item = button('', () => {
                if (fieldsInvalid.size) { message('请先修正红色字段，再切换条目。', true); return; }
                selectedId = id; renderList(false); renderDetail();
            }, 'wb-entry');
            item.classList.toggle('is-selected', id === selectedId);
            item.setAttribute('aria-pressed', String(id === selectedId));
            item.append(element('strong', '', entry.comment || (entry.key || []).join('、') || `条目 ${id}`),
                element('small', '', `${entry.disable ? '停用' : entry.constant ? '常驻' : '关键词'} · #${id}`),
                element('span', 'wb-preview', String(entry.content || '').slice(0, 100)));
            refs.entries.append(item);
        }
        if (!filtered.length) refs.entries.append(element('p', 'wb-empty', draft ? '没有符合筛选条件的条目。' : '先从左侧选择世界书。'));
        refs.count.textContent = `${filtered.length} 条 · 每页 ${PAGE} 条`;
        refs.page.textContent = `${filtered.length ? page + 1 : 0} / ${Math.ceil(filtered.length / PAGE)}`;
        refs.prev.disabled = busy || page === 0;
        refs.next.disabled = busy || (page + 1) * PAGE >= filtered.length;
        header();
    }
    function field(name, definition, entry) {
        const wrapper = element('label', `wb-field ${name === 'content' ? 'wb-field-body' : ''}`);
        wrapper.append(element('span', '', LABELS[name] || name));
        const value = Object.hasOwn(entry, name) ? entry[name] : definition.default;
        const kind = definition.type;
        let control;
        if (CHOICES[name] || kind === 'boolean?') {
            control = element('select');
            const choices = kind === 'boolean?' ? [['null', '跟随全局设置'], ['true', '开启'], ['false', '关闭']] : CHOICES[name];
            for (const [val, label] of choices) { const option = element('option', '', label); option.value = String(val); control.append(option); }
            const current = value == null ? 'null' : String(value);
            if (!Array.from(control.options).some(option => option.value === current)) {
                const option = element('option', '', `保留当前值：${current}`); option.value = current; control.append(option);
            }
            control.value = current;
        } else if (kind === 'boolean') {
            control = element('input'); control.type = 'checkbox'; control.checked = !!value;
            wrapper.classList.add('wb-check');
        } else if (kind === 'number' || kind === 'number?' || kind === 'enum') {
            control = element('input'); control.type = 'number'; control.step = '1'; control.value = value ?? '';
        } else if (kind === 'array' || kind === 'object' || name === 'content') {
            control = element('textarea');
            control.rows = name === 'content' ? 16 : kind === 'object' ? 6 : 3;
            control.value = kind === 'array' ? (Array.isArray(value) ? value.join('\n') : '')
                : kind === 'object' ? JSON.stringify(value ?? {}, null, 2) : value ?? '';
            if (kind === 'array') wrapper.append(element('small', '', '每行一个；正则表达式中的逗号会保留。'));
        } else {
            control = element('input'); control.type = 'text'; control.value = value ?? '';
        }
        control.dataset.field = name;
        control.disabled = busy;
        control.addEventListener('input', () => {
            let next;
            try {
                if (kind === 'boolean') next = control.checked;
                else if (kind === 'boolean?') next = control.value === 'null' ? null : control.value === 'true';
                else if (kind === 'number' || kind === 'number?' || kind === 'enum' || CHOICES[name]) {
                    if (control.value === '' && kind === 'number?') next = null;
                    else {
                        if (control.value === '') throw new Error('请输入数字。');
                        next = Number(control.value);
                        if (!Number.isFinite(next) || !Number.isInteger(next)) throw new Error('请输入整数。');
                        if (name === 'probability' && (next < 0 || next > 100)) throw new Error('概率应在 0 到 100 之间。');
                    }
                } else if (kind === 'array') next = control.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                else if (kind === 'object') {
                    next = JSON.parse(control.value);
                    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('请输入 JSON 对象。');
                } else next = control.value;
                draft.update(selectedId, name, next);
                fieldsInvalid.delete(name);
                control.removeAttribute('aria-invalid');
                control.setCustomValidity('');
                header();
                if (name !== 'content') {
                    clearTimeout(searchTimer); searchTimer = setTimeout(() => renderList(), 160);
                }
            } catch (error) {
                fieldsInvalid.add(name);
                control.setAttribute('aria-invalid', 'true');
                control.setCustomValidity(error.message);
                message(`${LABELS[name] || name}：${error.message}`, true);
                header();
            }
        });
        wrapper.append(control);
        return wrapper;
    }
    function renderDetail() {
        refs.detail.replaceChildren();
        fieldsInvalid.clear();
        if (draft && !allowed(draft.name)) {
            refs.detail.append(element('p', 'wb-empty', '关联范围已变化。原书的草稿仍保留在当前页面；可导出草稿，或返回原角色继续编辑。'));
            header(); return;
        }
        const entry = draft?.data.entries[selectedId];
        if (!entry) { refs.detail.append(element('p', 'wb-empty', '选择一个条目开始编辑。')); header(); return; }
        const common = element('div', 'wb-fields');
        for (const name of COMMON) common.append(field(name, host.schema[name], entry));
        refs.detail.append(common);
        const advanced = element('details', 'wb-advanced');
        advanced.open = advancedOpen;
        advanced.append(element('summary', '', '高级设置'));
        advanced.addEventListener('toggle', () => { advancedOpen = advanced.open; });
        const advancedFields = element('div', 'wb-fields');
        for (const [name, definition] of Object.entries(host.schema)) {
            if (!COMMON.includes(name)) advancedFields.append(field(name, definition, entry));
        }
        for (const name of ['displayIndex', 'characterFilter', 'extensions']) {
            if (Object.hasOwn(entry, name) && !host.schema[name]) advancedFields.append(field(name,
                { default: name === 'displayIndex' ? 0 : {}, type: name === 'displayIndex' ? 'number' : 'object' }, entry));
        }
        advanced.append(advancedFields);
        refs.detail.append(advanced);
        const unknown = Object.fromEntries(Object.entries(entry).filter(([name]) => name !== 'uid'
            && !host.schema[name] && !['displayIndex', 'characterFilter', 'extensions'].includes(name)));
        if (Object.keys(unknown).length) {
            const details = element('details', 'wb-advanced');
            details.append(element('summary', '', '其他字段（保留原值）'), element('pre', 'wb-json', JSON.stringify(unknown, null, 2)));
            refs.detail.append(details);
        }
        header();
    }
    async function confirmDiscard() {
        if (!draft?.dirty && !fieldsInvalid.size) return true;
        return host.confirm('放弃未保存修改？', '当前草稿尚未保存。选择取消可继续编辑；也可以先导出草稿。');
    }
    async function selectBook(name, reload = false) {
        if (busy || (!reload && draft?.name === name)) return;
        if (!await confirmDiscard()) return;
        if (busy || suspended) return;
        const token = ++loading;
        busy = true; header();
        try {
            guard(name);
            const data = await host.read(name);
            if (token !== loading || suspended) return;
            guard(name);
            draft = new BookDraft(name, data, host.keyMap);
            selectedId = draft.search()[0] || '';
            query = ''; mode = 'all'; page = 0;
            refs.search.value = ''; refs.filter.value = 'all';
            renderBooks(); renderList(); renderDetail();
            message('已载入酒馆当前保存的内容。');
        } catch (error) { message(error.message, true); }
        finally { if (token === loading) { busy = false; header(); } }
    }
    async function refreshScope() {
        if (!dialog?.open || suspended) return;
        const ticket = ++scopeTicket;
        try {
            const scope = await host.scope();
            if (!dialog?.open || suspended || ticket !== scopeTicket) return;
            rows = scopedBooks(scope);
            renderBooks();
            if (draft && !allowed(draft.name)) {
                if (draft.dirty || fieldsInvalid.size) { renderList(); renderDetail(); message('关联范围已变化，原草稿未丢弃。', true); return; }
                draft = undefined; selectedId = '';
            }
            if (!draft && rows.length) await selectBook(rows[0].name);
            else { renderList(); header(); }
        } catch (error) { message(error.message, true); }
    }
    async function externalUpdate(name) {
        if (!dialog?.open || suspended || busy) return;
        try {
            await refreshScope();
            if (!draft || (name && name !== draft.name) || !allowed(draft.name)) return;
            const captured = draft;
            const data = await host.read(captured.name);
            if (!dialog?.open || busy || suspended || draft !== captured) return;
            if (equal(data, draft.base)) return;
            if (draft.dirty || fieldsInvalid.size) {
                draft.externalChanged = true;
                message('这本书在原界面或其他地方发生了修改。当前草稿保留；保存前会再次检查冲突。', true);
            } else {
                draft.accept(data);
                if (!draft.data.entries[selectedId]) selectedId = draft.search()[0] || '';
                renderList(); renderDetail(); message('已同步外部修改。');
            }
        } catch (error) { message(error.message, true); }
    }
    async function save() {
        if (busy || !draft || fieldsInvalid.size) return;
        const savingDraft = draft;
        const savingSession = session;
        busy = true; header();
        for (const input of refs.detail.querySelectorAll('input,textarea,select')) input.disabled = true;
        message('正在检查并备份，随后保存…');
        try {
            const task = async () => {
                // Verify scope immediately before saving, including programmatic chat changes.
                rows = scopedBooks(await host.scope());
                const saved = await saveDraft(savingDraft, {
                    assertWritable: async name => {
                        if (session !== savingSession) throw new Error('编辑器已停用，保存已中止；草稿保留。');
                        rows = scopedBooks(await host.scope());
                        if (session !== savingSession) throw new Error('编辑器已停用，保存已中止；草稿保留。');
                        guard(name);
                    },
                    read: host.read, backup: host.backup, write: host.write,
                });
                if (saved) await host.notifySaved(savingDraft.name, savingDraft.base);
            };
            await host.lock(task);
            if (session !== savingSession) return;
            message('已保存并回读验证；酒馆缓存已刷新。');
            renderBooks(); renderList();
        } catch (error) { if (session === savingSession) message(error.message, true); }
        finally {
            if (session !== savingSession) return;
            busy = false;
            for (const input of refs.detail.querySelectorAll('input,textarea,select')) input.disabled = false;
            header();
        }
    }
    function changePage(offset) { page += offset; renderList(false); }
    function add(sourceId) {
        if (busy || !draft || fieldsInvalid.size) return;
        selectedId = draft.add(host.template, sourceId);
        query = ''; mode = 'all'; refs.search.value = ''; refs.filter.value = 'all';
        filtered = draft.search(); page = Math.floor(filtered.indexOf(selectedId) / PAGE);
        renderList(); renderDetail(); message('条目已加入草稿，点击保存后才写入酒馆。');
    }
    async function remove() {
        if (busy || !draft || !selectedId || fieldsInvalid.size) return;
        if (!await host.confirm('删除当前条目？', '条目会从草稿移除，保存后才写入酒馆。保存前会备份原书。')) return;
        draft.remove(selectedId); selectedId = draft.search(query, mode)[0] || '';
        renderList(); renderDetail(); message('条目已从草稿移除，尚未保存。');
    }
    async function close() {
        if (busy) { message('请等当前读写完成后再关闭。', true); return; }
        if (!await confirmDiscard()) return;
        if (draft?.dirty) draft.accept(draft.base);
        fieldsInvalid.clear(); dialog.close();
    }
    function beforeUnload(event) {
        if (draft?.dirty || fieldsInvalid.size || busy) { event.preventDefault(); event.returnValue = ''; }
    }
    function onFocus() { externalUpdate(); }
    function onVisibility() { if (document.visibilityState === 'visible') onFocus(); }
    function mount() {
        dialog = element('dialog', 'wb-editor');
        dialog.id = 'st-worldbook-editor';
        dialog.setAttribute('aria-label', '世界书编辑器');
        const top = element('header', 'wb-top');
        const heading = element('div', 'wb-heading');
        refs.title = element('h2', '', '世界书编辑器'); refs.badge = element('span', 'wb-badge', '已同步');
        heading.append(refs.title, refs.badge);
        refs.save = button('保存世界书', save, 'wb-primary');
        refs.export = button('导出草稿', () => {
            if (fieldsInvalid.size) { message('请先修正无效字段；它们还没有写入草稿。', true); return; }
            if (draft) download(`${draft.name}-草稿.json`, draft.serialize());
        });
        refs.reload = button('重新载入', () => draft && selectBook(draft.name, true));
        top.append(heading, refs.save, refs.export, refs.reload, button('关闭', close));
        const columns = element('div', 'wb-columns');
        const books = element('aside', 'wb-books-pane');
        refs.scope = element('p', 'wb-scope'); refs.books = element('div', 'wb-books');
        books.append(element('h3', '', '当前角色与全局世界书'), refs.scope, button('刷新关联', refreshScope), refs.books);
        const entries = element('section', 'wb-entries-pane');
        const tools = element('div', 'wb-tools');
        refs.search = element('input'); refs.search.type = 'search'; refs.search.placeholder = '搜索标题、关键词、正文';
        refs.search.setAttribute('aria-label', '搜索条目');
        refs.search.addEventListener('input', () => {
            query = refs.search.value; page = 0; clearTimeout(searchTimer);
            searchTimer = setTimeout(() => renderList(), 160);
        });
        refs.filter = element('select'); refs.filter.setAttribute('aria-label', '条目状态筛选');
        for (const [val, label] of [['all', '全部条目'], ['enabled', '启用条目'], ['disabled', '停用条目']]) {
            const option = element('option', '', label); option.value = val; refs.filter.append(option);
        }
        refs.filter.addEventListener('change', () => { mode = refs.filter.value; page = 0; renderList(); });
        refs.add = button('新增条目', () => add()); refs.count = element('small', 'wb-count');
        tools.append(refs.search, refs.filter, refs.add, refs.count);
        refs.entries = element('div', 'wb-entries');
        const pagination = element('div', 'wb-pagination');
        refs.prev = button('上一页', () => changePage(-1)); refs.next = button('下一页', () => changePage(1));
        refs.page = element('span'); pagination.append(refs.prev, refs.page, refs.next);
        entries.append(tools, refs.entries, pagination);
        const detail = element('section', 'wb-detail-pane');
        const actions = element('div', 'wb-tools');
        refs.duplicate = button('复制条目', () => add(selectedId)); refs.remove = button('删除条目', remove, 'wb-danger');
        actions.append(refs.duplicate, refs.remove); refs.detail = element('div', 'wb-detail');
        detail.append(actions, refs.detail);
        columns.append(books, entries, detail);
        refs.status = element('footer', 'wb-status', '选择世界书开始编辑。'); refs.status.setAttribute('role', 'status');
        dialog.append(top, columns, refs.status);
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        document.body.append(dialog);
        window.addEventListener('beforeunload', beforeUnload);
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibility);
    }
    return {
        async open() {
            suspended = false;
            if (!dialog) mount();
            if (!dialog.open) dialog.showModal();
            renderDetail(); header();
            await refreshScope();
        },
        scopeChanged() {
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => externalUpdate(), 180);
        },
        externalUpdate,
        hasDirtyBook(name) { return !!draft && draft.name === name && (draft.dirty || fieldsInvalid.size || busy); },
        suspend() {
            suspended = true; loading++; session++;
            busy = false;
            clearTimeout(searchTimer); clearTimeout(refreshTimer);
            window.removeEventListener('beforeunload', beforeUnload);
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisibility);
            dialog?.remove(); dialog = undefined;
            // Keep the in-memory draft across disable/enable within this page.
        },
    };
}
