import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as core from '../core.js';
import { CHAT_KEY } from '../manager-model.js';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace(/export function /g, 'function ');
function fixture() {
    const character = (id, name) => ({ avatar: `${id}.png`, name, shallow: false,
        data: { extensions: { world: '现有书' }, character_book: { name: '现有书', entries: [{ content: name }] } } });
    const characters = [character('a', '<img src=x onerror=alert(1)>'), character('b', '其他卡')];
    const requests = [];
    const prompts = [];
    let savedMetadata = {};
    const context = {
        characters, characterId: 0, extensionSettings: {}, saveSettingsDebounced() {},
        chatId: '模拟对话', chatMetadata: {}, saveMetadata: async () => { savedMetadata = structuredClone(context.chatMetadata); },
        getRequestHeaders: () => ({}),
        convertCharacterBook: book => ({ entries: { 0: { uid: 0, content: book.entries[0].content } } }),
        Popup: { show: { confirm: async (title, text) => { prompts.push({ title, text }); return 0; } } },
        POPUP_RESULT: { AFFIRMATIVE: 1 },
    };
    const sandbox = {
        ...core, CHAT_KEY, SillyTavern: { getContext: () => context }, isGenerating: () => false,
        crypto: webcrypto, TextEncoder, structuredClone, navigator: {},
        setTimeout: () => 0, clearTimeout() {},
        toastr: { error: text => { throw new Error(text); } },
        fetch: async (url, options) => {
            const body = JSON.parse(options.body); requests.push({ url, body });
            let result;
            if (url === '/api/characters/get') {
                result = characters.find(c => c.avatar === body.avatar_url);
                context.afterRead?.();
            }
            else if (url === '/api/worldinfo/list') result = [{ file_id: '现有书' }];
            else if (url === '/api/files/sanitize-filename') result = { fileName: body.fileName };
            else if (url === '/api/worldinfo/get') result = { entries: { 0: { content: '玩家已修改的书' } } };
            else if (url === '/api/chats/get') result = [{ chat_metadata: savedMetadata }];
            else throw new Error(`Unexpected mutation: ${url}`);
            return { ok: true, json: async () => structuredClone(result) };
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(source + '\nactive = true; epoch = 1; globalThis.harness = {run, check, adapter, migrateRenamedChat, aliases: value => { settings().renames = value; }, setManual: avatar => { manualAvatar = avatar; }};', sandbox);
    return { ...sandbox.harness, context, requests, prompts };
}

test('首次运行只读当前卡，不扫描其他完整卡，不备份或覆盖玩家现有书', async () => {
    const host = fixture(); await host.run();
    assert.deepEqual(host.requests.map(x => x.url), ['/api/characters/get']);
    assert.equal(host.prompts.length, 0);
    assert.equal(Object.keys(host.context.extensionSettings.st_worldbook_updater.records).length, 1);
    assert.ok(host.context.extensionSettings.st_worldbook_updater.records['a.png'].fingerprint);
});
test('重复启动检查不因本地书不同产生写入或弹窗', async () => {
    const host = fixture(); await host.run(); await host.run();
    assert.deepEqual(host.requests.map(x => x.url), ['/api/characters/get', '/api/characters/get']);
    assert.equal(host.prompts.length, 0);
});
test('无当前卡时不处理其他卡', async () => {
    const host = fixture(); host.context.characterId = undefined; await host.run();
    assert.equal(host.requests.length, 0);
});
test('手动检查展示转义后的字符串说明，取消后没有写入', async () => {
    const host = fixture(); await host.check('a.png', true, 1);
    assert.equal(host.prompts.length, 1);
    assert.equal(typeof host.prompts[0].text, 'string');
    assert.match(host.prompts[0].text, /&lt;img/);
    assert.match(host.prompts[0].text, /新版世界书：现有书/);
    assert.equal(host.prompts[0].text.includes('[object HTMLDivElement]'), false);
    assert.equal(host.requests.some(x => /edit|upload|delete|merge/.test(x.url)), false);
});
test('排队的手动检查在切换卡后不会更新原卡', async () => {
    const host = fixture(); host.setManual('a.png'); host.context.characterId = 1; await host.run();
    assert.equal(host.requests.length, 0);
});
test('直接检查非当前卡在读取之前被拒绝', async () => {
    const host = fixture(); await assert.rejects(host.check('b.png', false, 1), /当前角色已切换/);
    assert.equal(host.requests.length, 0);
});
test('读取当前卡期间切换角色，不写基准或继续请求', async () => {
    const host = fixture(); host.context.afterRead = () => { host.context.characterId = 1; };
    await assert.rejects(host.check('a.png', false, 1), /当前角色已切换/);
    assert.equal(host.requests.length, 1);
    assert.equal(host.context.extensionSettings.st_worldbook_updater.records['a.png'], undefined);
});
test('切换角色后，写入和备份适配器均在请求之前拒绝', async () => {
    const host = fixture(); const adapter = host.adapter(1, { avatar: 'a.png' });
    host.context.characterId = 1;
    await assert.rejects(adapter.writeBook('书', { entries: {} }), /当前角色已切换/);
    await assert.rejects(adapter.backup('书', { entries: {} }, 'a.png'), /当前角色已切换/);
    assert.equal(host.requests.length, 0);
});
test('旧对话打开时沿改名链迁移原生关联和副本选择，并读取已保存元数据', async () => {
    const host = fixture(); host.aliases({ 旧副本: '中间名字', 中间名字: '现有书' });
    host.context.chatMetadata = { world_info: '旧副本', st_worldbook_updater_selection: { owner: 'a.png', name: '旧副本', previousWorld: '旧副本' } };
    await host.migrateRenamedChat();
    assert.equal(host.context.chatMetadata.world_info, '现有书');
    assert.equal(host.context.chatMetadata.st_worldbook_updater_selection.name, '现有书');
    assert.equal(host.context.chatMetadata.st_worldbook_updater_selection.previousWorld, '现有书');
    assert.equal(host.requests.at(-1).url, '/api/chats/get');
});
test('不相关对话的关联不会被改名迁移影响', async () => {
    const host = fixture(); host.aliases({ 旧副本: '现有书' }); host.context.chatMetadata = { world_info: '独立的其他书' };
    await host.migrateRenamedChat(); assert.equal(host.context.chatMetadata.world_info, '独立的其他书'); assert.equal(host.requests.length, 0);
});
