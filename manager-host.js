import { clone, equal, linkOf } from './core.js';
import { CHAT_KEY, familyNames, normalizeImport } from './manager-model.js';

export function createManagerHost(api) {
    const context = () => api.context();
    const settings = () => api.settings();
    function family() {
        const c = context(), character = c.characters[c.characterId];
        if (!character || c.groupId) throw new Error('请先打开一个角色的对话。群聊暂不支持角色副本替换。');
        const main = linkOf(character);
        if (!main) throw new Error('当前角色没有绑定主世界书。');
        settings().families ??= {};
        let value = settings().families[character.avatar];
        if (!value) value = settings().families[character.avatar] = { main, copies: [], ancestors: [] };
        if (!Array.isArray(value.copies)) value.copies = [];
        if (!Array.isArray(value.ancestors)) value.ancestors = [];
        if (main !== value.main && !value.copies.includes(main)) {
            value.ancestors = [...new Set([...(value.ancestors || []), value.main])]; value.main = main;
        }
        return { owner: character.avatar, value };
    }
    function ticket() {
        api.assertActive();
        const c = context();
        return { owner: c.characters[c.characterId]?.avatar, chat: c.chatId, metadata: c.chatMetadata, session: api.session?.() };
    }
    function guard(t) {
        api.assertActive(); const c = context();
        if (t.session !== api.session?.()) throw new Error('扩展已重新加载，后续操作已停止。');
        if (t.owner !== c.characters[c.characterId]?.avatar || t.chat !== c.chatId || t.metadata !== c.chatMetadata) throw new Error('对话或角色已经切换，后续操作已停止。');
    }
    async function writeVerified(name, data, t, overwrite = false) {
        guard(t);
        const names = await api.listNames();
        if (names.includes(name) && !overwrite) throw new Error('书名已存在，请选择其他名称，原书未覆盖。');
        const previous = names.includes(name) ? await api.read(name) : undefined;
        if (previous) await api.backup(name, previous, t.owner);
        guard(t);
        if (previous && !equal(await api.read(name), previous)) throw new Error('备份期间世界书变化，未覆盖。');
        if (!previous && (await api.listNames()).includes(name)) throw new Error('出现同名世界书，未覆盖。');
        guard(t); await api.write(name, data);
        if (!equal(await api.read(name), data)) throw new Error('世界书保存回读失败，请检查备份。');
        return previous;
    }
    async function bindChat(name, t = ticket()) {
        guard(t);
        const { owner, value } = family();
        if (!t.chat) throw new Error('当前没有可保存的对话，请先打开或创建对话。');
        if (!familyNames(value).includes(name) || !(await api.listNames()).includes(name)) throw new Error('这本书不是当前角色的有效主书或副本。');
        guard(t);
        const metadata = t.metadata;
        const previous = metadata[CHAT_KEY];
        const oldWorld = metadata.world_info;
        metadata[CHAT_KEY] = { owner, name, previousWorld: previous?.owner === owner && oldWorld === previous.name ? previous.previousWorld : oldWorld || '' };
        metadata.world_info = name;
        try {
            await context().saveMetadata(); guard(t);
            if (metadata.world_info !== name) throw new Error('对话关联在保存期间变化。');
            await api.verifyMetadata?.(t, metadata); guard(t);
        } catch (error) {
            if (metadata.world_info === name) {
                if (oldWorld) metadata.world_info = oldWorld; else delete metadata.world_info;
                if (previous) metadata[CHAT_KEY] = previous; else delete metadata[CHAT_KEY];
            }
            throw error;
        }
        await api.changed();
    }
    return {
        family,
        async copy({ source, name, bind }) {
            const t = ticket(); const { value } = family();
            if (!familyNames(value).includes(source)) throw new Error('只能复制当前角色的主书或副本。');
            const actual = await api.name(name);
            const data = await api.read(source);
            await writeVerified(actual, data, t);
            // Register the successfully written book even if the player has switched chats.
            value.copies = [...new Set([...(value.copies || []), actual])]; api.saveSettings();
            if (bind) {
                try { await bindChat(actual, t); }
                catch (error) { throw new Error(`副本「${actual}」已创建，但未绑定：${error.message}`); }
            }
            await api.changed(); return actual;
        },
        bindChat,
        async unbindChat() {
            const t = ticket(); guard(t); const old = t.metadata[CHAT_KEY];
            if (!old || old.owner !== t.owner) throw new Error('当前对话没有本扩展管理的世界书选择。');
            const names = await api.listNames(); guard(t);
            if (t.metadata.world_info === old.name) {
                if (old.previousWorld && names.includes(old.previousWorld)) t.metadata.world_info = old.previousWorld;
                else delete t.metadata.world_info;
            }
            delete t.metadata[CHAT_KEY]; await context().saveMetadata(); guard(t);
            await api.verifyMetadata?.(t, t.metadata); guard(t); await api.changed();
        },
        async useForCharacter(name) {
            const t = ticket(); const { value } = family();
            if (!familyNames(value).includes(name) || !(await api.listNames()).includes(name)) throw new Error('请选择当前角色的主书或副本。');
            guard(t); await api.bind(t.owner, name);
            if (linkOf(await api.readCharacter(t.owner)) !== name) throw new Error('角色主书关联回读失败。');
            api.saveSettings(); await api.changed();
        },
        async importBook({ json, name, role }) {
            const t = ticket(); const actual = await api.name(name);
            const data = normalizeImport(json, api.convert);
            if (!role) {
                await writeVerified(actual, data, t);
                try { guard(t); await api.activateGlobal(actual); }
                catch (error) { throw new Error(`新书「${actual}」已保存，但尚未全局启用：${error.message}`); }
                await api.changed(); return actual;
            }
            const { value } = family();
            if (value.copies.includes(actual)) throw new Error('新版本不能覆盖你的独立副本，请更换书名。');
            const character = await api.readCharacter(t.owner); const old = linkOf(character);
            const refs = await api.references(actual, t.owner, { target: true });
            if (refs.length) throw new Error(`新书名被其他用途使用：${refs.join('；')}。请更换书名。`);
            const oldData = old !== actual && (await api.listNames()).includes(old) ? await api.read(old) : undefined;
            if (oldData) await api.backup(old, oldData, t.owner);
            const before = await api.readCharacter(t.owner);
            if (!equal(before.data, character.data)) throw new Error('角色卡已变化，请重新检查。');
            await writeVerified(actual, data, t, actual === old);
            guard(t);
            if (!equal((await api.readCharacter(t.owner)).data, character.data)) throw new Error('角色卡已变化，新书保留但没有更改关联。');
            guard(t); await api.bind(t.owner, actual);
            if (linkOf(await api.readCharacter(t.owner)) !== actual) throw new Error('新书已写入，但关联未保存；旧书保留。');
            value.ancestors = [...new Set([...(value.ancestors || []), value.main])]; value.main = actual;
            api.saveSettings();
            let retained = '';
            if (oldData) {
                const refs = await api.references(old, t.owner);
                if (value.copies.includes(old) || refs.length || !equal(await api.read(old), oldData)) retained = '旧书为独立副本、还有其他用途或内容变化，已保留。';
                else {
                    guard(t);
                    if (linkOf(await api.readCharacter(t.owner)) !== actual || !equal(await api.read(actual), data)) throw new Error('新版内容或关联变化，旧书保留。');
                    guard(t); await api.remove(old);
                    if ((await api.listNames()).includes(old)) throw new Error('新版已启用，但旧书删除失败。');
                }
            }
            await api.changed(); return `${actual}${retained ? `（${retained}）` : ''}`;
        },
    };
}
