import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CHAT_KEY, filterChatVariant } from '../manager-model.js';
const path = process.env.ST_WORLDINFO_SOURCE || 'D:/sillytaverns/SillyTavern/public/scripts/world-info.js';
const available = fs.existsSync(path);
function fixture() {
    const source = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    const extract = name => {
        const start = source.indexOf(`async function ${name}(`);
        if (start < 0) throw new Error(`Missing native function ${name}`);
        return source.slice(start, source.indexOf('\n}\n', start) + 2);
    };
    const metadata = { world_info: '副本', [CHAT_KEY]: { owner: 'a.png', name: '副本' } };
    const sandbox = {
        characters: [{ name: '临时测试角色', data: { extensions: { world: '原书' } } }], this_chid: 0,
        world_info: { charLore: [{ name: 'a', extraBooks: ['额外'] }] }, selected_world_info: ['全局'],
        chat_metadata: metadata, METADATA_KEY: 'world_info', power_user: {}, getCharaFilename: () => 'a',
        loadWorldInfo: async name => ({ entries: { 0: { uid: 0, order: 100, content: name } } }),
        event_types: { WORLDINFO_ENTRIES_LOADED: 'loaded' },
        eventSource: { emit: async (_, payload) => filterChatVariant(payload, { owner: 'a.png', metadata,
            family: { main: '原书', copies: ['副本'] }, names: ['原书', '副本'] }) },
        world_info_character_strategy: 0, world_info_insertion_strategy: { evenly: 0, character_first: 1, global_first: 2 },
        sortFn: (a, b) => b.order - a.order, parseDecorators: content => [[], content], getStringHash: () => 1,
        structuredClone, console: { debug() {}, error(error) { throw error; } },
    };
    vm.createContext(sandbox);
    vm.runInContext(['getCharacterLore', 'getGlobalLore', 'getChatLore', 'getPersonaLore', 'getSortedEntries'].map(extract).join('\n'), sandbox);
    return { sandbox, metadata };
}
test('本机原生加载函数：副本进入候选条目、原书排除、额外和全局保留', { skip: !available }, async () => {
    const { sandbox } = fixture(); const entries = await sandbox.getSortedEntries();
    assert.deepEqual(entries.map(e => e.world).sort(), ['全局', '副本', '额外'].sort());
});
test('本机原生全局去重：副本同时全局启用时仍只加载一次', { skip: !available }, async () => {
    const { sandbox } = fixture(); sandbox.selected_world_info.push('副本', '原书');
    const entries = await sandbox.getSortedEntries();
    assert.equal(entries.filter(e => e.world === '副本').length, 1); assert.equal(entries.some(e => e.world === '原书'), false);
});
test('切换到未选副本的对话后，本机原生函数恢复原书', { skip: !available }, async () => {
    const { sandbox, metadata } = fixture(); delete metadata[CHAT_KEY]; delete metadata.world_info;
    const entries = await sandbox.getSortedEntries();
    assert.equal(entries.some(e => e.world === '原书'), true); assert.equal(entries.some(e => e.world === '副本'), false);
});
