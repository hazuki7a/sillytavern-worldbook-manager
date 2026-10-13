import { canonical, equal, linkOf, clone, makePlan, applyPlan } from './core.js';
// Internal imports are explicitly pinned to the inspected local ST 1.18.0 contract.
import { world_info, selected_world_info, worldInfoCache, deleteWorldInfo,
    newWorldInfoEntryDefinition, newWorldInfoEntryTemplate, originalWIDataKeyMap, updateWorldInfoSettings, world_names } from '../../../world-info.js';
import { isGenerating, select_selected_character } from '../../../../script.js';
import { createWorldbookEditor } from './editor.js';
import { createManagerHost } from './manager-host.js';
import { CHAT_KEY, filterChatVariant } from './manager-model.js';
import { mountLauncher } from './launcher.js';
import { extensionTypes } from '../../../extensions.js';
import { mountUpdateChecker } from './update-check.js';

const ID = 'st_worldbook_updater';
const ROOT = 'st-worldbook-updater-panel';
let active = false;
let epoch = 0;
let timer;
let running = false;
let again = false;
let manualAvatar = '';
let panel;
let lastEditorInput = 0;
let editor;
let manager;
let disposeLauncher;
let disposeUpdateChecker;
const subscriptions = [];
const muted = new Set();
const observedLinks = new Map();
const ctx = () => SillyTavern.getContext();

function settings() {
    const all = ctx().extensionSettings;
    all[ID] ??= { enabled: true, records: {}, backups: [] };
    all[ID].records ??= {};
    all[ID].backups ??= [];
    all[ID].families ??= {};
    return all[ID];
}
function saveSettings() { ctx().saveSettingsDebounced(); }
function status(text) {
    const node = panel?.querySelector('[data-status]');
    if (node) node.textContent = text;
}
function notice(text, kind = 'info') {
    status(text);
    globalThis.toastr?.[kind]?.(text, '世界书更新器');
}
function assertEpoch(token, avatar) {
    if (!active || epoch !== token || !settings().enabled) throw new Error('更新器已停用，后续操作已停止。');
    if (avatar && ctx().characters[ctx().characterId]?.avatar !== avatar) throw new Error('当前角色已切换，已停止更新上一张卡。');
    if (isGenerating()) throw new Error('正在生成回复，已暂停更新；生成结束后再检查。');
    if (Date.now() - lastEditorInput < 1500) throw new Error('角色编辑器正在保存输入，请稍后再检查。');
}
async function post(path, body) {
    const response = await fetch(path, {
        method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body), cache: 'no-store',
    });
    if (!response.ok) throw new Error(`酒馆请求失败：${path}（HTTP ${response.status}）。`);
    return response;
}
async function readCharacter(avatar) {
    const character = await (await post('/api/characters/get', { avatar_url: avatar })).json();
    if (!character?.data || character.avatar !== avatar) throw new Error('角色卡读取失败。');
    return character;
}
async function listNames() {
    const list = await (await post('/api/worldinfo/list', {})).json();
    if (!Array.isArray(list)) throw new Error('世界书列表读取失败。');
    return list.map(item => item.file_id);
}
async function readBook(name) {
    // Bypass the UI cache for transaction checks.
    return (await post('/api/worldinfo/get', { name })).json();
}
const convert = book => ctx().convertCharacterBook(clone(book));
async function fingerprint(value) {
    const bytes = new TextEncoder().encode(canonical(value));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        byte => byte.toString(16).padStart(2, '0')).join('');
}
async function sanitizedName(name) {
    const reply = await (await post('/api/files/sanitize-filename', { fileName: `${name}.json` })).json();
    const result = reply.fileName?.replace(/\.json$/i, '');
    if (!result || result === '.' || result === '..') throw new Error('卡内世界书名称无效。');
    return result;
}
async function backup(name, book, avatar) {
    const filename = `worldbook-backup-${Date.now()}-${crypto.randomUUID()}.json`;
    const blob = new Blob([JSON.stringify(book, null, 2)], { type: 'application/json' });
    const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('无法编码备份。'));
        reader.readAsDataURL(blob);
    });
    const result = await (await post('/api/files/upload', { name: filename, data })).json();
    const url = new URL(result.path, `${location.origin}/`);
    if (url.origin !== location.origin || !url.pathname.endsWith(filename)) throw new Error('备份路径异常。');
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok || !equal(await response.json(), book)) throw new Error('备份回读失败，未更新或删除旧书。');
    settings().backups.push({ name, avatar, time: new Date().toISOString(), path: url.pathname });
    saveSettings();
    renderBackups();
}
async function references(name, owner, { target = false } = {}) {
    if (!name) return [];
    const refs = [];
    // A fresh list also sees links from characters outside the visible page.
    const characters = await (await post('/api/characters/all', {})).json();
    if (!Array.isArray(characters)) throw new Error('无法检查其他角色的世界书关联。');
    for (const character of characters) {
        if (character.avatar !== owner && linkOf(character) === name) refs.push(`角色「${character.name}」`);
    }
    for (const record of world_info.charLore ?? []) {
        if (target && record.name === owner.replace(/\.png$/i, '')) continue;
        if (record.extraBooks?.includes(name)) refs.push(`额外角色世界书「${record.name}」`);
    }
    if (Object.values(settings().families).some(f => f.copies?.includes(name))) refs.push('玩家独立世界书副本');
    const power = ctx().powerUserSettings;
    if (power.persona_description_lorebook === name
        || Object.values(power.persona_descriptions ?? {}).some(p => p?.lorebook === name)) refs.push('用户角色');
    // All persisted chat metadata, including group chats. Never store or log chat messages.
    const chats = await (await post('/api/chats/recent', { metadata: true })).json();
    if (!Array.isArray(chats)) throw new Error('无法检查聊天世界书关联。');
    if (chats.some(chat => chat.chat_metadata?.world_info === name && (!target || chat.avatar !== owner))
        || (!target && ctx().chatMetadata?.world_info === name)) refs.push('聊天世界书');
    // A global selection applies independently. Retain it rather than alter that user's setting.
    if (selected_world_info.includes(name)) refs.push('全局世界书');
    return [...new Set(refs)];
}
function adapter(token, plan) {
    return {
        assertActive: () => {
            assertEpoch(token, plan.avatar);
            if (editor?.hasDirtyBook(plan.oldName) || editor?.hasDirtyBook(plan.newName)) {
                throw new Error('编辑器出现了未保存草稿，已停止自动更新。');
            }
        }, getCharacter: readCharacter, listNames, readBook,
        convert, references,
        async backup(name, book, avatar) {
            assertEpoch(token, avatar);
            await backup(name, book, avatar);
        },
        async writeBook(name, book) {
            assertEpoch(token, plan.avatar);
            await post('/api/worldinfo/edit', { name, data: book });
            worldInfoCache.delete(name);
            await ctx().eventSource.emit(ctx().eventTypes.WORLDINFO_UPDATED, name, clone(book));
        },
        async bind(avatar, name) {
            assertEpoch(token, avatar);
            await post('/api/characters/merge-attributes', { avatar, data: { extensions: { world: name } } });
            await ctx().getOneCharacter(avatar);
            if (ctx().characters[ctx().characterId]?.avatar === avatar) {
                // Refresh the editor immediately, before native deletion can inspect its field.
                select_selected_character(ctx().characterId, { switchMenu: false });
            }
        },
        async deleteBook(name) {
            assertEpoch(token, plan.avatar);
            await ctx().updateWorldInfoList();
            assertEpoch(token, plan.avatar);
            if (!await deleteWorldInfo(name)) throw new Error(`无法删除旧世界书「${name}」。`);
        },
    };
}

async function check(avatar, force, token) {
    assertEpoch(token, avatar);
    const character = await readCharacter(avatar);
    assertEpoch(token, avatar);
    const book = character.data.character_book;
    if (!book || !Array.isArray(book.entries)) {
        if (force) notice('这张卡没有内嵌世界书，不能从卡内更新。', 'warning');
        return;
    }
    const incoming = convert(book);
    const digest = await fingerprint(incoming);
    assertEpoch(token, avatar);
    const previous = settings().records[avatar];
    // Installation is not evidence of a new release. First observation is read-only.
    if (!force && !previous?.fingerprint) {
        assertEpoch(token, avatar);
        settings().records[avatar] = { fingerprint: digest, world: linkOf(character) };
        observedLinks.set(avatar, linkOf(character));
        saveSettings();
        status('已记录当前卡的世界书基准，未导入、覆盖或删除世界书。需要修复现有绑定时，请点击“检查并更新当前卡”。');
        return;
    }
    const muteKey = `${avatar}:${digest}`;
    if (!force && muted.has(muteKey)) return;
    if (!force && previous?.fingerprint === digest) {
        // Manual primary-link edits are not a reason to overwrite the user's worldbook.
        if (previous.world !== linkOf(character)) {
            previous.world = linkOf(character);
            saveSettings();
        }
        return;
    }
    const names = await listNames();
    const name = await sanitizedName(book.name || `${character.name}'s Lorebook`);
    const oldRecord = previous || { world: observedLinks.get(avatar) || linkOf(character) };
    const plan = makePlan({ character, incoming, name, previous: oldRecord, names });
    if (Object.values(settings().families).some(f => f.copies?.includes(plan.oldName) || f.copies?.includes(plan.newName))) {
        throw new Error('当前绑定或新版书名属于玩家副本，自动卡更新不会覆盖副本。请在管理界面导入主书新版。');
    }
    if (editor?.hasDirtyBook(plan.oldName) || editor?.hasDirtyBook(plan.newName)) {
        throw new Error('世界书编辑器有未保存的草稿或正在读写，请先保存或放弃草稿，再重试更新卡。');
    }
    const linked = linkOf(character);
    if (!force && linked === name && names.includes(name) && equal(await readBook(name), incoming)) {
        settings().records[avatar] = { fingerprint: digest, world: name };
        saveSettings();
        return;
    }
    // Before a baseline exists, differences can be the player's edits, not a new release.
    if (force || ((!previous?.fingerprint || book.entries.length === 0) && (plan.oldName || names.includes(name)))) {
        const description = `角色：${character.name}。新版世界书：${name}（${book.entries.length} 条）。`
            + (plan.oldName ? `旧世界书：${plan.oldName}。` : '')
            + '将先备份，再启用新版。不同名的旧书会在确认没有其他用途后删除；同名书会覆盖。'
            + '首次检查无法判断差异来自版本更新还是你的手动修改，请确认。';
        const decision = await ctx().Popup.show.confirm('更新角色世界书', escapeHtml(description));
        assertEpoch(token, avatar);
        if (decision !== ctx().POPUP_RESULT.AFFIRMATIVE) { muted.add(muteKey); return; }
    }
    status(`正在更新「${character.name}」的世界书…`);
    assertEpoch(token, avatar);
    const result = await applyPlan(adapter(token, plan), plan);
    settings().records[avatar] = { fingerprint: digest, world: name };
    observedLinks.set(avatar, name);
    saveSettings();
    await ctx().updateWorldInfoList();
    const context = ctx();
    if (context.characters[context.characterId]?.avatar === avatar && active && epoch === token) {
        select_selected_character(context.characterId, { switchMenu: false });
        context.reloadWorldInfoEditor(name);
    }
    notice(result.warning || (result.sameName
        ? `「${character.name}」新版世界书已启用，同名旧版已备份并覆盖。`
        : `「${character.name}」新版世界书已启用${result.deleted ? '，旧书已删除' : ''}。`), result.warning ? 'warning' : 'success');
}

function rememberVisibleLinks() {
    for (const character of ctx().characters) {
        if (character.avatar && !observedLinks.has(character.avatar)) observedLinks.set(character.avatar, linkOf(character));
    }
}
function schedule(avatar = '', force = false) {
    if (!active || !settings().enabled) return;
    if (force && avatar) manualAvatar = avatar;
    if (running) { again = true; return; }
    clearTimeout(timer);
    timer = setTimeout(run, 1600);
}
async function run() {
    if (running || !active || !settings().enabled || isGenerating()) return;
    running = true;
    const token = epoch;
    const forced = manualAvatar;
    manualAvatar = '';
    try {
        const context = ctx();
        const current = context.characters[context.characterId]?.avatar;
        const avatars = new Set((forced ? forced === current ? [forced] : [] : [current]).filter(Boolean));
        for (const avatar of avatars) {
            try {
                const task = () => check(avatar, avatar === forced, token);
                if (navigator.locks?.request) await navigator.locks.request(ID, task);
                else await task();
            }
            catch (error) {
                notice(error.message || '更新失败；请检查备份列表。', 'error');
                // Avoid repeatedly presenting a failing card on unrelated UI events.
                const character = ctx().characters.find(c => c.avatar === avatar);
                if (character?.data?.character_book) muted.add(`${avatar}:${await fingerprint(convert(character.data.character_book))}`);
            }
            if (!active || epoch !== token) break;
        }
        rememberVisibleLinks();
    } finally {
        running = false;
        if (again && active) { again = false; schedule(); }
    }
}
function onEditorInput(event) {
    if (event.isTrusted && event.target?.closest?.('#rm_ch_create')) lastEditorInput = Date.now();
}
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
async function migrateRenamedChat() {
    if (!active || ctx().groupId || isGenerating()) return;
    const captured = ctx(), metadata = captured.chatMetadata, owner = captured.characters[captured.characterId]?.avatar, chat = captured.chatId, token = epoch;
    if (!chat || !owner || !metadata) return;
    const task = async () => {
        const guard = () => {
            const current = ctx();
            if (!active || epoch !== token || current.chatMetadata !== metadata || current.chatId !== chat || current.characters[current.characterId]?.avatar !== owner || isGenerating()) throw new Error('重命名关联迁移已暂停，请在当前对话重试。');
        };
        const aliases = settings().renames || {};
        if (![metadata.world_info, metadata[CHAT_KEY]?.name, metadata[CHAT_KEY]?.previousWorld].some(name => aliases[name])) return;
        guard(); const names = await listNames(); guard();
        const resolve = original => {
            let name = original; const seen = new Set();
            while (aliases[name] && !seen.has(name)) { seen.add(name); name = aliases[name]; }
            return names.includes(name) ? name : original;
        };
        if (metadata.world_info) metadata.world_info = resolve(metadata.world_info);
        if (metadata[CHAT_KEY]?.name) metadata[CHAT_KEY].name = resolve(metadata[CHAT_KEY].name);
        if (metadata[CHAT_KEY]?.previousWorld) metadata[CHAT_KEY].previousWorld = resolve(metadata[CHAT_KEY].previousWorld);
        await ctx().saveMetadata(); guard();
        const saved = await (await post('/api/chats/get', { ch_name: ctx().characters[ctx().characterId]?.name, avatar_url: owner, file_name: chat })).json();
        if (!equal(saved[0]?.chat_metadata?.world_info, metadata.world_info) || !equal(saved[0]?.chat_metadata?.[CHAT_KEY], metadata[CHAT_KEY])) throw new Error('旧对话重命名关联回读失败；旧名兼容文件保留，请重试。');
        guard(); editor?.scopeChanged();
    };
    try { if (navigator.locks?.request) await navigator.locks.request(ID, task); else await task(); }
    catch (error) { notice(error.message, 'warning'); }
}
function renderBackups() {
    const list = panel?.querySelector('[data-backups]');
    if (!list) return;
    list.replaceChildren();
    for (const item of settings().backups.slice(-20).reverse()) {
        const row = document.createElement('div');
        const link = document.createElement('a');
        // Persisted settings are data; only accept this extension's same-origin backup files.
        if (!/^\/[^?#]*\/worldbook-backup-[\w.-]+\.json$/.test(item.path)) continue;
        link.href = item.path;
        link.download = `${item.name}-备份.json`;
        link.textContent = `${item.name} · ${item.time}`;
        row.append(link);
        list.append(row);
    }
}
function mount() {
    document.getElementById(ROOT)?.remove();
    panel = document.createElement('div');
    panel.id = ROOT;
    panel.className = 'extension_container';
    panel.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header">
        <b>世界书管理器</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div><div class="inline-drawer-content">
        <label class="checkbox_label"><input type="checkbox" data-enabled><span>自动检测新版，备份后启用并清理旧书</span></label>
        <p>只检查当前卡。首次打开只记录基准，不改世界书；之后卡内世界书变化时自动更新。共享旧书会保留并说明。</p>
        <button type="button" class="menu_button" data-check>检查并更新当前卡</button>
        <button type="button" class="menu_button" data-editor>打开世界书编辑器</button>
        <div data-status style="white-space:pre-wrap;overflow-wrap:anywhere" role="status">等待检查。</div>
        <details><summary>备份下载（最近 20 份）</summary><p>备份保存在酒馆用户 files 目录，不在世界书列表中。下载后可作为世界书 JSON 导入恢复。</p><div data-backups></div></details>
        </div></div>`;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) throw new Error('找不到酒馆扩展设置面板。');
    container.append(panel);
    disposeUpdateChecker = mountUpdateChecker(panel, { types: extensionTypes, headers: () => ctx().getRequestHeaders() });
    const enabled = panel.querySelector('[data-enabled]');
    enabled.checked = settings().enabled;
    enabled.addEventListener('change', () => {
        settings().enabled = enabled.checked;
        epoch++;
        saveSettings();
        status(enabled.checked ? '自动检测已开启。' : '自动检测已关闭。');
        if (enabled.checked) { muted.clear(); schedule(); }
    });
    panel.querySelector('[data-check]').addEventListener('click', () => {
        const character = ctx().characters[ctx().characterId];
        if (!settings().enabled) { notice('请先开启更新器。', 'warning'); return; }
        if (!character) { notice('请先打开要更新的角色卡。', 'warning'); return; }
        if (isGenerating()) { notice('请等回复生成结束后再检查。', 'warning'); return; }
        schedule(character.avatar, true);
    });
    panel.querySelector('[data-editor]').addEventListener('click', () => editor?.open());
    renderBackups();
}
function setupEditor() {
    if (!manager) manager = createManagerHost({
        context: ctx, settings, saveSettings, listNames, read: readBook, readCharacter, convert, name: sanitizedName, backup, references,
        session: () => epoch,
        async verifyMetadata(ticket, expected) {
            const character = ctx().characters.find(c => c.avatar === ticket.owner);
            const saved = await (await post('/api/chats/get', { ch_name: character?.name, avatar_url: ticket.owner, file_name: ticket.chat })).json();
            const metadata = Array.isArray(saved) ? saved[0]?.chat_metadata : undefined;
            if (!metadata || !equal(metadata.world_info, expected.world_info) || !equal(metadata[CHAT_KEY], expected[CHAT_KEY])) {
                throw new Error('对话关联保存回读未通过，请检查连接并重试。');
            }
        },
        assertActive() { if (!active) throw new Error('扩展已停用。'); if (isGenerating()) throw new Error('请等回复生成结束后操作。'); },
        async write(name, data) { await post('/api/worldinfo/edit', { name, data }); worldInfoCache.delete(name); },
        async bind(avatar, name) {
            await post('/api/characters/merge-attributes', { avatar, data: { extensions: { world: name } } });
            await ctx().getOneCharacter(avatar);
            if (ctx().characters[ctx().characterId]?.avatar === avatar) select_selected_character(ctx().characterId, { switchMenu: false });
        },
        async remove(name) { await ctx().updateWorldInfoList(); if (!await deleteWorldInfo(name)) throw new Error('旧书删除失败。'); },
        async activateGlobal(name) {
            updateWorldInfoSettings({}, [...new Set([...selected_world_info, name])]);
            await ctx().eventSource.emit(ctx().eventTypes.WORLDINFO_SETTINGS_UPDATED);
        },
        globals: () => [...selected_world_info],
        async setGlobals(names) {
            updateWorldInfoSettings({}, [...new Set(names)]);
            await ctx().eventSource.emit(ctx().eventTypes.WORLDINFO_SETTINGS_UPDATED);
        },
        async retarget(oldName, newName, guard) {
            const characters = await (await post('/api/characters/all', {})).json();
            if (!Array.isArray(characters)) throw new Error('无法读取角色关联列表。');
            for (const character of characters.filter(c => linkOf(c) === oldName)) {
                guard(); const fresh = await readCharacter(character.avatar);
                if (linkOf(fresh) !== oldName) throw new Error('角色关联已变化，请重试。');
                guard(); await post('/api/characters/merge-attributes', { avatar: character.avatar, data: { extensions: { world: newName } } });
                if (linkOf(await readCharacter(character.avatar)) !== newName) throw new Error('角色关联回读失败。');
                await ctx().getOneCharacter(character.avatar);
            }
            guard();
            for (const record of world_info.charLore || []) if (record.extraBooks?.includes(oldName)) record.extraBooks = [...new Set(record.extraBooks.map(name => name === oldName ? newName : name))];
            const power = ctx().powerUserSettings;
            if (power.persona_description_lorebook === oldName) power.persona_description_lorebook = newName;
            for (const persona of Object.values(power.persona_descriptions || {})) if (persona?.lorebook === oldName) persona.lorebook = newName;
            updateWorldInfoSettings({}, [...new Set(selected_world_info.map(name => name === oldName ? newName : name))]); saveSettings();
            const c = ctx(); if (c.characters[c.characterId]) select_selected_character(c.characterId, { switchMenu: false });
        },
        async changed() { await ctx().updateWorldInfoList(); await ctx().eventSource.emit(ctx().eventTypes.WORLDINFO_SETTINGS_UPDATED); editor?.scopeChanged(); },
    });
    if (!editor) editor = createWorldbookEditor({
        manager: Object.fromEntries(['copy', 'bindChat', 'unbindChat', 'useForCharacter', 'importBook', 'rename', 'deactivateGlobal'].map(key => [key, (...args) =>
            navigator.locks?.request ? navigator.locks.request(ID, () => manager[key](...args)) : manager[key](...args)])),
        schema: newWorldInfoEntryDefinition, template: newWorldInfoEntryTemplate, keyMap: originalWIDataKeyMap,
        assertActive() {
            if (!active) throw new Error('扩展已停用，草稿保留在当前页面。');
            if (isGenerating()) throw new Error('正在生成回复，请等生成结束后保存。');
        },
        characterName: () => ctx().characters[ctx().characterId]?.name || '',
        async scope() {
            const context = ctx();
            const character = context.characters[context.characterId];
            const extra = world_info.charLore?.find(item => item.name === character?.avatar?.replace(/\.png$/i, ''))?.extraBooks || [];
            let family;
            if (linkOf(character) && !context.groupId) { family = manager.family().value; saveSettings(); }
            const choice = context.chatMetadata?.[CHAT_KEY];
            const selected = choice?.owner === character?.avatar && choice?.name === context.chatMetadata?.world_info ? choice.name : linkOf(character);
            return { primary: family?.main || linkOf(character), copies: family?.copies || [], extra: [...extra], global: [...selected_world_info],
                history: (family?.ancestors || []).filter(name => name === selected),
                owner: character?.avatar, chat: context.chatId, selected, names: await listNames() };
        },
        read: readBook,
        backup: (name, book) => backup(name, book, ctx().characters[ctx().characterId]?.avatar || ''),
        async write(name, data) {
            if (!active) throw new Error('扩展已停用。');
            await post('/api/worldinfo/edit', { name, data });
            worldInfoCache.delete(name);
        },
        async notifySaved(name, data) {
            await ctx().eventSource.emit(ctx().eventTypes.WORLDINFO_UPDATED, name, clone(data));
            ctx().reloadWorldInfoEditor(name);
        },
        confirm: async (title, message) => await ctx().Popup.show.confirm(escapeHtml(title), escapeHtml(message)) === ctx().POPUP_RESULT.AFFIRMATIVE,
        lock: task => navigator.locks?.request ? navigator.locks.request(ID, task) : task(),
    });
    const context = ctx();
    const add = (event, handler) => {
        if (!event) return;
        context.eventSource.on(event, handler);
        subscriptions.push([event, handler]);
    };
    add(context.eventTypes.WORLDINFO_UPDATED, name => editor.externalUpdate(name));
    add(context.eventTypes.CHAT_CHANGED, () => migrateRenamedChat());
    add(context.eventTypes.GENERATION_ENDED, () => migrateRenamedChat());
    add(context.eventTypes.WORLDINFO_ENTRIES_LOADED, payload => {
        const c = ctx(), owner = c.characters[c.characterId]?.avatar;
        if (!c.groupId) filterChatVariant(payload, { owner, metadata: c.chatMetadata, family: settings().families[owner], names: world_names });
    });
    for (const event of [context.eventTypes.WORLDINFO_SETTINGS_UPDATED, context.eventTypes.CHAT_CHANGED,
        context.eventTypes.CHARACTER_EDITOR_OPENED, context.eventTypes.CHARACTER_EDITED]) {
        add(event, () => editor.scopeChanged());
    }
}
function start() {
    if (active) return;
    const context = ctx();
    const required = ['getRequestHeaders', 'convertCharacterBook', 'getOneCharacter', 'updateWorldInfoList', 'reloadWorldInfoEditor', 'saveMetadata'];
    if (required.some(name => typeof context[name] !== 'function') || !context.Popup?.show?.confirm || !crypto.subtle || !context.eventTypes.WORLDINFO_ENTRIES_LOADED) {
        globalThis.toastr?.error('酒馆缺少必要接口，世界书更新器未启动。');
        return;
    }
    active = true;
    epoch++;
    try {
        setupEditor();
        mount();
        disposeLauncher = mountLauncher(() => editor.open());
        migrateRenamedChat();
        rememberVisibleLinks();
        document.addEventListener('input', onEditorInput, true);
        const types = context.eventTypes;
        for (const event of [types.CHAT_CHANGED, types.CHARACTER_EDITOR_OPENED, types.CHARACTER_EDITED,
            types.CHARACTER_PAGE_LOADED, types.GENERATION_ENDED]) {
            if (!event) throw new Error('酒馆事件接口不完整。');
            const handler = () => schedule();
            context.eventSource.on(event, handler);
            subscriptions.push([event, handler]);
        }
        schedule();
    } catch (error) { onDisable(); globalThis.toastr?.error(error.message); }
}
let readyHandler;
export function onActivate() {
    if (active || readyHandler) return;
    // The loader hook is synchronous; host requests run after APP_READY or a later task.
    readyHandler = () => { readyHandler = undefined; start(); };
    ctx().eventSource.once(ctx().eventTypes.APP_READY, readyHandler);
}
export function onDisable() {
    active = false;
    epoch++;
    clearTimeout(timer);
    again = false;
    manualAvatar = '';
    for (const [event, handler] of subscriptions.splice(0)) ctx().eventSource.removeListener(event, handler);
    if (readyHandler) ctx().eventSource.removeListener(ctx().eventTypes.APP_READY, readyHandler);
    readyHandler = undefined;
    panel?.remove();
    disposeUpdateChecker?.(); disposeUpdateChecker = undefined;
    disposeLauncher?.(); disposeLauncher = undefined;
    editor?.suspend();
    document.removeEventListener('input', onEditorInput, true);
    panel = undefined;
}
