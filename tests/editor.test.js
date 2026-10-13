import test from 'node:test';
import assert from 'node:assert/strict';
import { BookDraft, scopedBooks, saveDraft } from '../editor-model.js';
import { clone } from '../core.js';

const map = { content: 'content', key: 'keys', keysecondary: 'secondary_keys', comment: 'comment',
    order: 'insertion_order', probability: 'extensions.probability' };
function book() {
    return { unknownRoot: { keep: '根数据' }, entries: {
        0: { uid: 0, key: ['alpha'], content: '原正文', comment: '第一个', disable: false, order: 100, custom: { keep: '未知字段' } },
        1: { uid: 1, key: ['beta'], content: '第二条', comment: '第二个', disable: true, order: 99 },
    }, originalData: { customBook: '导出根字段', entries: [
        { id: 0, content: '原正文', keys: ['alpha'], customOriginal: '导出条目字段', extensions: { custom: '保留扩展' } },
        { uid: 1, content: '第二条', keys: ['beta'], enabled: false },
    ] } };
}
function hostFor(draft) {
    let stored = clone(draft.base);
    const calls = [];
    return {
        calls,
        get stored() { return stored; }, set stored(value) { stored = clone(value); },
        assertWritable() {},
        async read() { return clone(stored); },
        async backup(name, data) { calls.push('backup'); assert.deepEqual(data, draft.base); },
        async write(name, data) { calls.push('write'); stored = clone(data); },
    };
}
test('只列当前角色主书、额外书、全局书，去重并保留用途标签', () => {
    const rows = scopedBooks({ primary: '当前', extra: ['额外', '当前'], global: ['全局', '当前', '不存在'],
        names: ['当前', '额外', '全局', '无关书', '用户角色书', '聊天书'] });
    assert.deepEqual(rows.map(row => row.name), ['当前', '额外', '全局']);
    assert.equal(rows[0].tags.length, 3);
});
test('无角色时只显示全局；不存在的绑定不显示', () => {
    assert.deepEqual(scopedBooks({ global: ['全局'], names: ['全局', '无关'] }).map(row => row.name), ['全局']);
    assert.deepEqual(scopedBooks({ primary: '不存在', names: ['无关'] }), []);
});
test('正文修改同时进入运行条目与角色卡导出条目，保留未知数据', () => {
    const draft = new BookDraft('书', book(), map);
    draft.update('0', 'content', '修改后的正文');
    draft.update('0', 'probability', 72);
    const output = draft.serialize();
    assert.equal(output.entries[0].content, '修改后的正文');
    assert.equal(output.originalData.entries[0].content, '修改后的正文');
    assert.equal(output.originalData.entries[0].extensions.probability, 72);
    assert.equal(output.originalData.entries[0].extensions.custom, '保留扩展');
    assert.equal(output.originalData.entries[0].customOriginal, '导出条目字段');
    assert.equal(output.entries[0].custom.keep, '未知字段');
    assert.equal(output.unknownRoot.keep, '根数据');
    assert.equal(draft.base.entries[0].content, '原正文');
});
test('支持 originalData 的 UID 匹配和 id 匹配', () => {
    const draft = new BookDraft('书', book(), map);
    draft.update('1', 'disable', false);
    assert.equal(draft.serialize().originalData.entries[1].enabled, true);
});
test('设置插入位置同步标准位置与原生扩展值', () => {
    const draft = new BookDraft('书', book(), map);
    draft.update('0', 'position', 4);
    const entry = draft.serialize().originalData.entries[0];
    assert.equal(entry.position, 'after_char');
    assert.equal(entry.extensions.position, 4);
});
test('修改后改回原值，不再算未保存', () => {
    const draft = new BookDraft('书', book(), map);
    draft.update('0', 'content', '暂时修改');
    assert.equal(draft.dirty, true);
    draft.update('0', 'content', '原正文');
    assert.equal(draft.dirty, false);
});
test('搜索正文、关键词、标题；修改后更新索引', () => {
    const draft = new BookDraft('书', book(), map);
    assert.deepEqual(draft.search('ALPHA'), ['0']);
    assert.deepEqual(draft.search('第二条', 'disabled'), ['1']);
    draft.update('0', 'content', 'new needle');
    assert.deepEqual(draft.search('needle'), ['0']);
    assert.deepEqual(draft.search('needle', 'disabled'), []);
});
test('新增、复制与删除同步导出数据，UID 不复用旧草稿删除的身份', () => {
    const draft = new BookDraft('书', book(), map);
    draft.remove('0');
    const id = draft.add({ content: '新增', key: [], disable: false });
    assert.equal(id, '2');
    const copied = draft.add({}, '1');
    assert.equal(draft.data.entries[copied].content, '第二条');
    assert.equal(draft.data.entries[copied].uid, 3);
    const output = draft.serialize();
    assert.equal(output.originalData.entries.some(entry => entry.id === 0), false);
    assert.equal(output.originalData.entries.find(entry => entry.id === 2).content, '新增');
    assert.equal(output.originalData.entries.find(entry => entry.id === 3).content, '第二条');
});
test('新增再删除不会污染原书或留下脏状态', () => {
    const draft = new BookDraft('书', book(), map);
    const id = draft.add({ content: '新增' });
    draft.remove(id);
    assert.equal(draft.dirty, false);
    assert.deepEqual(draft.serialize(), book());
});
test('关键词数组保留正则里的逗号', () => {
    const draft = new BookDraft('书', book(), map);
    draft.update('0', 'key', ['/foo,bar/i', '第二个词']);
    assert.deepEqual(draft.serialize().originalData.entries[0].keys, ['/foo,bar/i', '第二个词']);
});
test('保存先备份并复核，再写入和回读，成功才清除草稿', async () => {
    const draft = new BookDraft('书', book(), map);
    draft.update('0', 'content', '新正文');
    const host = hostFor(draft);
    await saveDraft(draft, host);
    assert.deepEqual(host.calls, ['backup', 'write']);
    assert.equal(host.stored.entries[0].content, '新正文');
    assert.equal(draft.dirty, false);
});
test('外部变化时零写入，保留草稿', async () => {
    const draft = new BookDraft('书', book(), map);
    draft.update('0', 'content', '我的草稿');
    const host = hostFor(draft);
    host.stored = { ...book(), other: '外部变化' };
    await assert.rejects(saveDraft(draft, host), /别处修改/);
    assert.deepEqual(host.calls, []);
    assert.equal(draft.data.entries[0].content, '我的草稿');
    assert.equal(draft.dirty, true);
});
test('备份失败不写书', async () => {
    const draft = new BookDraft('书', book(), map); draft.update('0', 'content', '草稿');
    const host = hostFor(draft); host.backup = async () => { throw new Error('备份失败'); };
    await assert.rejects(saveDraft(draft, host), /备份失败/);
    assert.equal(host.stored.entries[0].content, '原正文');
    assert.equal(draft.dirty, true);
});
test('备份期间外部改动不覆盖', async () => {
    const draft = new BookDraft('书', book(), map); draft.update('0', 'content', '草稿');
    const host = hostFor(draft); host.backup = async () => { host.stored = { ...book(), change: true }; };
    await assert.rejects(saveDraft(draft, host), /备份期间/);
    assert.equal(host.calls.includes('write'), false);
});
test('范围变更、扩展停用的复核失败会阻止保存', async () => {
    const draft = new BookDraft('书', book(), map); draft.update('0', 'content', '草稿');
    const host = hostFor(draft); let checks = 0;
    host.assertWritable = async () => { if (++checks > 1) throw new Error('范围变化'); };
    await assert.rejects(saveDraft(draft, host), /范围变化/);
    assert.deepEqual(host.calls, ['backup']);
});
test('写入失败或回读失败，草稿仍可导出', async () => {
    const draft = new BookDraft('书', book(), map); draft.update('0', 'content', '草稿');
    const host = hostFor(draft); host.write = async () => {};
    await assert.rejects(saveDraft(draft, host), /回读未通过/);
    assert.equal(draft.dirty, true);
    assert.equal(draft.serialize().entries[0].content, '草稿');
});
test('未知扩展对象保存同步 originalData', () => {
    const draft = new BookDraft('书', book(), map);
    draft.update('0', 'extensions', { plugin: { enabled: true } });
    assert.deepEqual(draft.serialize().originalData.entries[0].extensions, { plugin: { enabled: true } });
});
test('拒绝改 UID 和原型路径', () => {
    const draft = new BookDraft('书', book(), map);
    assert.throws(() => draft.update('0', 'uid', 9), /无效/);
    assert.throws(() => draft.update('0', '__proto__', {}), /无效/);
});

test('辅助逻辑同时写入标准字段和宿主读取的扩展字段', () => {
    const draft = new BookDraft('书', book(), map);
    draft.update('0', 'selectiveLogic', 3);
    const original = draft.serialize().originalData.entries[0];
    assert.equal(original.selectiveLogic, 3);
    assert.equal(original.extensions.selectiveLogic, 3);
});

test('同时编辑扩展对象和常用字段时，以显式常用字段值为准', () => {
    const draft = new BookDraft('书', book(), map);
    draft.update('0', 'selectiveLogic', 3);
    draft.update('0', 'extensions', { selectiveLogic: 1, plugin: { value: 7 } });
    const original = draft.serialize().originalData.entries[0];
    assert.equal(original.extensions.selectiveLogic, 3);
    assert.deepEqual(original.extensions.plugin, { value: 7 });
});
