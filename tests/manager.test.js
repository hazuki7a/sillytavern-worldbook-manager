import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagerHost } from '../manager-host.js';
import { CHAT_KEY, nextCopyName, filterChatVariant, groupsFor, normalizeImport, setStrategy } from '../manager-model.js';
import { BookDraft, scopedBooks, saveDraft } from '../editor-model.js';
const book = () => ({ entries: { 0: { uid: 0, key: ['原词'], comment: '[mvu_update]变量规则', content: '男主', constant: true, pluginUnknown: { keep: 7 } }, 1: { uid: 1, comment: '其他条目', content: '说明' } }, unknownRoot: 9 });
function fixture() {
    const books = new Map([['原书', book()]]), backups = [], calls = [];
    const config = { families: {} };
    const c = { characterId: 0, chatId: '对话1', chatMetadata: {}, characters: [{ avatar: 'a.png', data: { extensions: { world: '原书' } } }], saveMetadata: async () => calls.push('metadata') };
    let refs = [], session = 1, globals = ['原书', '其他全局'];
    const api = {
        context: () => c, settings: () => config, saveSettings() {}, assertActive() {}, session: () => session,
        listNames: async () => [...books.keys()], name: async s => { if (!s.trim()) throw new Error('空名字'); return s; },
        read: async name => structuredClone(books.get(name)), readCharacter: async () => structuredClone(c.characters[0]),
        write: async (name, data) => { calls.push('write'); books.set(name, structuredClone(data)); },
        backup: async (name, data) => { calls.push('backup'); backups.push({ name, data: structuredClone(data) }); },
        bind: async (_, name) => { calls.push('bind'); c.characters[0].data.extensions.world = name; },
        references: async () => refs,
        remove: async name => { calls.push('delete'); books.delete(name); },
        activateGlobal: async name => { calls.push('global'); c.global = name; }, changed: async () => {}, convert: value => value,
        globals: () => [...globals], setGlobals: async names => { globals = [...names]; calls.push('setGlobals'); },
        retarget: async (old, name, guard) => {
            guard(); calls.push('retarget');
            if (c.characters[0].data.extensions.world === old) c.characters[0].data.extensions.world = name;
            globals = globals.map(value => value === old ? name : value);
        },
    };
    const manager = createManagerHost(api); manager.family();
    return { manager, books, backups, calls, c, config, api, refs: value => { refs = value; }, stop: () => session++ };
}
test('副本默认名递增；主书下面显示副本，排除无关书', () => {
    assert.equal(nextCopyName('原书', ['原书 - 副本1']), '原书 - 副本2');
    const rows = scopedBooks({ primary: '原书', copies: ['副本'], global: ['全局'], names: ['原书', '副本', '全局', '无关'] });
    assert.equal(rows[1].parent, '原书'); assert.equal(rows.length, 3);
});
test('创建副本不默认绑定；修改副本不影响原书，未知字段保留', async () => {
    const h = fixture(); await h.manager.copy({ source: '原书', name: '副本', bind: false });
    assert.equal(h.c.chatMetadata.world_info, undefined);
    h.books.get('副本').entries[0].content = '女主';
    assert.equal(h.books.get('原书').entries[0].content, '男主');
    assert.equal(h.books.get('副本').entries[0].pluginUnknown.keep, 7);
    assert.equal(h.config.families['a.png'].copies[0], '副本');
});
test('副本重名时零写入，不覆盖其他用途的书', async () => {
    const h = fixture(); await assert.rejects(h.manager.copy({ source: '原书', name: '原书' }), /书名已存在/);
    assert.equal(h.calls.length, 0);
});
test('绑定只改当前对话，解除后恢复原对话世界书', async () => {
    const h = fixture(); h.c.chatMetadata.world_info = '原有对话书'; h.books.set('原有对话书', book());
    await h.manager.copy({ source: '原书', name: '副本', bind: true });
    assert.equal(h.c.chatMetadata[CHAT_KEY].name, '副本');
    assert.equal(h.c.characters[0].data.extensions.world, '原书');
    await h.manager.bindChat('原书');
    assert.equal(h.c.chatMetadata[CHAT_KEY].previousWorld, '原有对话书');
    await h.manager.unbindChat(); assert.equal(h.c.chatMetadata.world_info, '原有对话书');
});
test('原生界面改了对话书后解除选择，不覆盖玩家新选择', async () => {
    const h = fixture(); await h.manager.copy({ source: '原书', name: '副本', bind: true });
    h.c.chatMetadata.world_info = '玩家另选的书'; await h.manager.unbindChat();
    assert.equal(h.c.chatMetadata.world_info, '玩家另选的书');
});
test('生成时按书名排除同组其他版本，保留所选副本与其他书', () => {
    const entry = world => ({ world, content: world });
    const payload = { characterLore: [entry('原书'), entry('额外')], globalLore: [entry('全局'), entry('另一副本')], chatLore: [entry('女主副本')], personaLore: [entry('用户角色')] };
    assert.equal(filterChatVariant(payload, { owner: 'a', metadata: { world_info: '女主副本', [CHAT_KEY]: { owner: 'a', name: '女主副本' } }, family: { main: '原书', copies: ['女主副本', '另一副本'] }, names: ['女主副本'] }), true);
    assert.deepEqual(payload.characterLore.map(e => e.world), ['额外']);
    assert.deepEqual(payload.globalLore.map(e => e.world), ['全局']);
    assert.equal(payload.chatLore[0].world, '女主副本'); assert.equal(payload.personaLore.length, 1);
});
test('非目标角色、缺失副本、原生关联已改动时，不过滤任何条目', () => {
    for (const changed of [{ owner: 'b' }, { names: [] }, { metadata: { world_info: '其他书', [CHAT_KEY]: { owner: 'a', name: '副本' } } }]) {
        const payload = { characterLore: [{ world: '原书' }] };
        assert.equal(filterChatVariant(payload, { owner: 'a', names: ['副本'], metadata: { world_info: '副本', [CHAT_KEY]: { owner: 'a', name: '副本' } }, family: { main: '原书', copies: ['副本'] }, ...changed }), false);
        assert.equal(payload.characterLore.length, 1);
    }
});
test('MVU 初始自动聚组；自定义分组保存后回读仍在，触发组字段不变', async () => {
    const data = book(); data.entries[0].group = '原生包含组';
    const draft = new BookDraft('书', data); const groups = groupsFor(data);
    assert.equal(groups.assignments['0'], 'MVU'); assert.equal(groups.assignments['1'], '默认');
    groups.labels.push('我的组'); groups.assignments['0'] = '我的组'; draft.setGroups(groups);
    assert.equal(draft.dirty, true);
    let stored = data;
    await saveDraft(draft, { assertWritable() {}, read: async () => structuredClone(stored), backup: async () => {}, write: async (_, value) => { stored = structuredClone(value); } });
    assert.equal(groupsFor(stored).assignments['0'], '我的组'); assert.equal(stored.entries[0].group, '原生包含组'); assert.equal(draft.dirty, false);
});
test('触发策略只改常驻和向量字段，不清除隐藏字段', () => {
    const draft = new BookDraft('书', book()); setStrategy(draft, '0', 'keyword');
    assert.equal(draft.data.entries[0].constant, false); assert.equal(draft.data.entries[0].vectorized, false);
    assert.equal(draft.data.entries[0].pluginUnknown.keep, 7);
});
test('全局导入新书并启用，原书不变', async () => {
    const h = fixture(); await h.manager.importBook({ json: book(), name: '全局新书', role: false });
    assert.equal(h.c.global, '全局新书'); assert.deepEqual(h.calls, ['write', 'global']);
    assert.equal(h.books.get('原书').entries[0].content, '男主');
});
test('角色新版改名：备份、写书、绑定、删除旧书；副本保持原样', async () => {
    const h = fixture(); await h.manager.copy({ source: '原书', name: '副本', bind: false }); h.calls.length = 0;
    const json = book(); json.entries[0].content = '新版';
    await h.manager.importBook({ json, name: '新版书', role: true });
    assert.deepEqual(h.calls, ['backup', 'write', 'bind', 'delete']);
    assert.equal(h.books.get('副本').entries[0].content, '男主'); assert.equal(h.config.families['a.png'].main, '新版书');
});
test('角色新版同名：先备份再覆盖，没有删除', async () => {
    const h = fixture(); const json = book(); json.entries[0].content = '新版';
    await h.manager.importBook({ json, name: '原书', role: true });
    assert.deepEqual(h.calls, ['backup', 'write', 'bind']); assert.equal(h.backups[0].data.entries[0].content, '男主');
});
test('共享旧书保留；新版名称共享或玩家副本时拒绝覆盖', async () => {
    const h = fixture(); h.api.references = async name => name === '原书' ? ['聊天'] : [];
    await h.manager.importBook({ json: book(), name: '新版', role: true }); assert.ok(h.books.has('原书'));
    h.refs(['其他角色']); h.api.references = async () => ['其他角色'];
    await assert.rejects(h.manager.importBook({ json: book(), name: '冲突', role: true }), /其他用途/);
    await h.manager.copy({ source: '新版', name: '副本' });
    await assert.rejects(h.manager.importBook({ json: book(), name: '副本', role: true }), /独立副本/);
});
test('备份失败、切换对话和重新启用时阻止后续写入', async () => {
    for (const change of [h => { h.c.chatId = '另一个'; }, h => h.stop()]) {
        const h = fixture(); h.api.backup = async () => { change(h); };
        await assert.rejects(h.manager.importBook({ json: book(), name: '新版', role: true }), /切换|重新加载/);
        assert.equal(h.calls.length, 0); assert.ok(h.books.has('原书'));
    }
    const h = fixture(); h.api.backup = async () => { throw new Error('失败'); };
    await assert.rejects(h.manager.importBook({ json: book(), name: '原书', role: true }), /失败/); assert.equal(h.calls.length, 0);
});
test('绑定请求失败不覆盖角色主书，新副本保留并报告部分成功', async () => {
    for (const phase of ['save', 'verify']) {
        const h = fixture();
        if (phase === 'save') h.c.saveMetadata = async () => { throw new Error('网络失败'); };
        else h.api.verifyMetadata = async () => { throw new Error('服务器回读不一致'); };
        await assert.rejects(h.manager.copy({ source: '原书', name: '副本', bind: true }), /已创建，但未绑定/);
        assert.ok(h.books.has('副本')); assert.equal(h.c.chatMetadata.world_info, undefined);
    }
});
test('导入拒绝无 entries、坏正文、UID 不一致；没有执行条目内容', () => {
    assert.throws(() => normalizeImport({}, value => value), /entries/);
    const bad = book(); bad.entries[0].uid = 4; assert.throws(() => normalizeImport(bad), /UID/);
    bad.entries[0].uid = 0; bad.entries[0].content = {}; assert.throws(() => normalizeImport(bad), /正文/);
});
test('关闭全局选择仅取消所选书，角色绑定与书文件保留', async () => {
    const h = fixture(); await h.manager.deactivateGlobal('原书');
    assert.deepEqual(h.api.globals(), ['其他全局']); assert.ok(h.books.has('原书'));
    assert.equal(h.c.characters[0].data.extensions.world, '原书'); assert.deepEqual(h.calls, ['setGlobals']);
});
test('非全局书不能误关闭其他书', async () => {
    const h = fixture(); await assert.rejects(h.manager.deactivateGlobal('不存在'), /没有全局/);
    assert.equal(h.calls.length, 0);
});
test('改名：备份、写新文件、迁移关联后删旧文件，内容不变', async () => {
    const h = fixture(); h.config.records = { 'a.png': { world: '原书', fingerprint: 'keep' } };
    await h.manager.rename({ source: '原书', name: '新书名' });
    assert.deepEqual(h.calls, ['backup', 'write', 'retarget', 'delete']);
    assert.deepEqual(h.books.get('新书名'), book()); assert.equal(h.books.has('原书'), false);
    assert.equal(h.config.families['a.png'].main, '新书名'); assert.equal(h.config.records['a.png'].world, '新书名');
    assert.equal(h.config.records['a.png'].fingerprint, 'keep'); assert.equal(h.c.characters[0].data.extensions.world, '新书名');
    assert.deepEqual(h.api.globals(), ['新书名', '其他全局']);
});
test('副本改名同步当前对话选择，旧存档仍引用时保留原名兼容文件', async () => {
    const h = fixture(); await h.manager.copy({ source: '原书', name: '副本', bind: true }); h.calls.length = 0;
    h.refs(['其他对话']); const result = await h.manager.rename({ source: '副本', name: '女性版' });
    assert.match(result, /兼容文件/); assert.ok(h.books.has('副本')); assert.ok(h.books.has('女性版'));
    assert.deepEqual(h.config.families['a.png'].copies, ['女性版']); assert.equal(h.c.chatMetadata[CHAT_KEY].name, '女性版');
    assert.equal(h.c.chatMetadata.world_info, '女性版'); assert.equal(h.config.renames['副本'], '女性版');
});
test('重名或备份失败时不改文件、不改关联', async () => {
    const h = fixture(); h.books.set('存在的名字', book());
    await assert.rejects(h.manager.rename({ source: '原书', name: '存在的名字' }), /书名已存在/); assert.equal(h.calls.length, 0);
    h.api.backup = async () => { throw new Error('备份失败'); };
    await assert.rejects(h.manager.rename({ source: '原书', name: '新名' }), /备份失败/); assert.equal(h.calls.length, 0);
});
test('迁移关联失败时保留新旧两份文件并报告阶段', async () => {
    const h = fixture(); h.api.retarget = async () => { throw new Error('绑定失败'); };
    await assert.rejects(h.manager.rename({ source: '原书', name: '新名' }), /新书.*旧书保留/);
    assert.ok(h.books.has('原书')); assert.ok(h.books.has('新名')); assert.equal(h.calls.includes('delete'), false);
});
