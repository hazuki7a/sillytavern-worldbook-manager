import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlan, makePlan, canonical, equal, clone } from '../core.js';

const book = content => ({ entries: { 0: { uid: 0, content } }, originalData: { entries: [{ id: 0, content }] } });
const oldBook = book('旧设定');
const newBook = book('新设定');
function fixture({ oldName = '旧书', newName = '新书', oldRefs = [], targetRefs = [] } = {}) {
    const calls = [];
    const backups = [];
    const worlds = new Map([[oldName, clone(oldBook)]]);
    let character = { avatar: 'test.png', name: '测试角色', data: {
        character_book: clone(newBook.originalData), extensions: { world: oldName, untouched: '保留' }, description: '正文保留',
    } };
    const host = {
        assertActive() {},
        convert: value => book(value.entries[0].content),
        async getCharacter() { return clone(character); },
        async listNames() { return [...worlds.keys()]; },
        async readBook(name) { return clone(worlds.get(name)); },
        async references(name, avatar, options) { return options?.target ? targetRefs : oldRefs; },
        async backup(name, value) { calls.push(`backup:${name}`); backups.push([name, clone(value)]); },
        async writeBook(name, value) { calls.push(`write:${name}`); worlds.set(name, clone(value)); },
        async bind(avatar, name) { calls.push(`bind:${name}`); character.data.extensions.world = name; },
        async deleteBook(name) { calls.push(`delete:${name}`); worlds.delete(name); },
    };
    const plan = makePlan({ character, incoming: newBook, name: newName, previous: { world: oldName }, names: [...worlds.keys()] });
    return { host, plan, calls, worlds, backups, get character() { return character; } };
}

test('改名更新：先备份、写新书、关联，最后删除旧书；正文不变', async () => {
    const f = fixture();
    const result = await applyPlan(f.host, f.plan);
    assert.deepEqual(f.calls, ['backup:旧书', 'write:新书', 'bind:新书', 'delete:旧书']);
    assert.equal(result.deleted, true);
    assert.equal(f.worlds.has('旧书'), false);
    assert.equal(f.character.data.extensions.world, '新书');
    assert.equal(f.character.data.extensions.untouched, '保留');
    assert.equal(f.character.data.description, '正文保留');
    assert.deepEqual(f.backups[0][1], oldBook);
});
test('同名更新：备份后覆盖，不调用删除', async () => {
    const f = fixture({ oldName: '同名', newName: '同名' });
    const result = await applyPlan(f.host, f.plan);
    assert.equal(result.sameName, true);
    assert.deepEqual(f.calls, ['backup:同名', 'write:同名', 'bind:同名']);
    assert.deepEqual(f.worlds.get('同名'), newBook);
});
test('备份失败：不写、不关联、不删除', async () => {
    const f = fixture();
    f.host.backup = async () => { throw new Error('backup failed'); };
    await assert.rejects(applyPlan(f.host, f.plan), /backup failed/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.worlds.get('旧书'), oldBook);
});
test('新书写入失败：旧书保留', async () => {
    const f = fixture();
    f.host.writeBook = async () => { throw new Error('write failed'); };
    await assert.rejects(applyPlan(f.host, f.plan), /write failed/);
    assert.equal(f.character.data.extensions.world, '旧书');
    assert.equal(f.worlds.has('旧书'), true);
});
test('写入回读不一致：不关联、不删除', async () => {
    const f = fixture();
    f.host.writeBook = async () => {};
    await assert.rejects(applyPlan(f.host, f.plan), /回读不一致/);
    assert.equal(f.calls.some(x => x.startsWith('bind:') || x.startsWith('delete:')), false);
});
test('关联 HTTP 失败：旧书保留', async () => {
    const f = fixture();
    f.host.bind = async () => { throw new Error('bind failed'); };
    await assert.rejects(applyPlan(f.host, f.plan), /bind failed/);
    assert.equal(f.worlds.has('旧书'), true);
});
test('关联未实际保存：不删除旧书', async () => {
    const f = fixture();
    f.host.bind = async () => {};
    await assert.rejects(applyPlan(f.host, f.plan), /关联未保存/);
    assert.equal(f.worlds.has('旧书'), true);
});
test('同名覆盖后关联失败：补偿旧版内容', async () => {
    const f = fixture({ oldName: '同名', newName: '同名' });
    f.host.bind = async () => { throw new Error('bind failed'); };
    await assert.rejects(applyPlan(f.host, f.plan), /bind failed/);
    assert.deepEqual(f.worlds.get('同名'), oldBook);
});
test('旧书共享：启用新版，保留共享旧书并说明', async () => {
    const f = fixture({ oldRefs: ['其他角色'] });
    const result = await applyPlan(f.host, f.plan);
    assert.equal(result.deleted, false);
    assert.match(result.warning, /其他角色/);
    assert.equal(f.worlds.has('旧书'), true);
    assert.equal(f.character.data.extensions.world, '新书');
});
test('新书同名被别人使用：零写入', async () => {
    const f = fixture({ targetRefs: ['其他角色'] });
    f.worlds.set('新书', book('别人的设定'));
    await assert.rejects(applyPlan(f.host, f.plan), /其他用途/);
    assert.deepEqual(f.calls, []);
});
test('更新备份期间世界书被修改：不覆盖', async () => {
    const f = fixture();
    f.host.backup = async () => { f.worlds.set('旧书', book('玩家改动')); };
    await assert.rejects(applyPlan(f.host, f.plan), /备份期间世界书被修改/);
    assert.deepEqual(f.worlds.get('旧书'), book('玩家改动'));
});
test('备份期间角色换卡：不写世界书', async () => {
    const f = fixture();
    f.host.backup = async () => { f.character.data.character_book = book('第三版').originalData; };
    await assert.rejects(applyPlan(f.host, f.plan), /备份期间角色卡被修改/);
    assert.equal(f.worlds.has('新书'), false);
});
test('删除前旧书被别人修改：保留并说明', async () => {
    const f = fixture();
    const bind = f.host.bind;
    f.host.bind = async (...args) => { await bind(...args); f.worlds.set('旧书', book('玩家改动')); };
    const result = await applyPlan(f.host, f.plan);
    assert.match(result.warning, /被修改/);
    assert.equal(f.worlds.has('旧书'), true);
});
test('删除请求假成功：报告旧书仍存在', async () => {
    const f = fixture();
    f.host.deleteBook = async () => {};
    await assert.rejects(applyPlan(f.host, f.plan), /删除未成功/);
    assert.equal(f.worlds.has('旧书'), true);
});
test('删除前新书被别人修改：不删旧书', async () => {
    const f = fixture();
    const bind = f.host.bind;
    f.host.bind = async (...args) => { await bind(...args); f.worlds.set('新书', book('玩家改动')); };
    await assert.rejects(applyPlan(f.host, f.plan), /删除前检查/);
    assert.equal(f.worlds.has('旧书'), true);
});
test('禁用中断：备份后不写', async () => {
    const f = fixture();
    let active = true;
    f.host.assertActive = () => { if (!active) throw new Error('disabled'); };
    f.host.backup = async () => { active = false; };
    await assert.rejects(applyPlan(f.host, f.plan), /disabled/);
    assert.equal(f.worlds.has('新书'), false);
});
test('重复应用：不会再次写入内容或删除不存在的旧书', async () => {
    const f = fixture();
    await applyPlan(f.host, f.plan);
    f.calls.length = 0;
    const plan = makePlan({ character: f.character, incoming: newBook, name: '新书',
        previous: { world: '新书' }, names: [...f.worlds.keys()] });
    await applyPlan(f.host, plan);
    assert.equal(f.calls.some(x => x.startsWith('write:') || x.startsWith('delete:')), false);
});
test('替换卡已指向新书：仍能从历史记录识别旧书', () => {
    const f = fixture();
    f.character.data.extensions.world = '新书';
    const plan = makePlan({ character: f.character, incoming: newBook, name: '新书',
        previous: { world: '旧书' }, names: ['旧书'] });
    assert.equal(plan.oldName, '旧书');
    assert.equal(plan.originalLink, '新书');
});
test('坏数据在任何写入前拒绝', () => {
    const f = fixture();
    assert.throws(() => makePlan({ character: f.character, incoming: { entries: [] }, name: '新书', names: [] }), /不完整/);
});
test('比较不受 JSON 键顺序影响，保留数组顺序及未知字段', () => {
    assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
    assert.equal(equal([1, 2], [2, 1]), false);
    assert.equal(equal({ x: 1, extra: 2 }, { x: 1 }), false);
});
