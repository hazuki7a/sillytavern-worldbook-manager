import test from 'node:test';
import assert from 'node:assert/strict';
import { isTauriHost, hostPath, readApiJson, assertApiResponse, readWorldNames } from '../host-http.js';
const module = 'https://example.org/scripts/extensions/third-party/book-manager/host-http.js';
test('普通地址与子路径代理使用模块实际前缀；备份前缀不重复', () => {
    assert.equal(hostPath('/api/worldinfo/get', module), '/api/worldinfo/get');
    const prefix = module.replace('example.org/', 'example.org/tavern/');
    assert.equal(hostPath('/api/worldinfo/get', prefix), '/tavern/api/worldinfo/get');
    assert.equal(hostPath('/tavern/user/files/backup.json', prefix), '/tavern/user/files/backup.json');
    assert.throws(() => hostPath('//remote/api', module), /无效/);
});
test('HTML 200、登录跳转、HTML 404 均明确报告失败接口，不泄露网页内容', async () => {
    for (const status of [200, 404]) {
        const response = new Response('<!DOCTYPE html><html>private page</html>', { status, headers: { 'Content-Type': 'text/html' } });
        await assert.rejects(readApiJson(response, '/api/worldinfo/list'), error => error.message.includes('/api/worldinfo/list') && error.message.includes('网页') && !error.message.includes('private page'));
    }
    assert.throws(() => assertApiResponse({ ok: true, status: 200, url: 'https://example.org/login?secret=hidden', headers: new Headers({ 'Content-Type': 'text/html' }) }, '/api/worldinfo/list'), error => error.message.includes('/login') && !error.message.includes('hidden'));
});
test('缺少 Content-Type 的 HTML 和坏 JSON 都停止，不伪装成功', async () => {
    await assert.rejects(readApiJson(new Response('<!DOCTYPE html>'), '/api/test'), /HTML/);
    await assert.rejects(readApiJson(new Response('{bad json'), '/api/test'), /无效 JSON/);
});
test('合法 JSON 与 HTTP 失败分别处理，包含 HTML 的正文不误判', async () => {
    assert.deepEqual(await readApiJson(new Response(JSON.stringify({ entries: { 0: { content: '<tag>正文</tag>' } } })), '/api/test'), { entries: { 0: { content: '<tag>正文</tag>' } } });
    await assert.rejects(readApiJson(new Response('{}', { status: 403 }), '/api/test'), /HTTP 403/);
});
test('Tauri 标记与标准酒馆分离', () => {
    assert.equal(isTauriHost({}), false); assert.equal(isTauriHost({ __TAURITAVERN__: {} }), true); assert.equal(isTauriHost({ __TAURI_RUNNING__: true }), true);
});
test('TauriTavern 2.3.0 使用设置接口 world_names，绝不请求缺失的 list', async () => {
    const calls = [];
    const names = await readWorldNames(async path => { calls.push(path); return { world_names: ['主书', '副本', '主书'], settings: 'ignored' }; }, true);
    assert.deepEqual(calls, ['/api/settings/get']); assert.deepEqual(names, ['主书', '副本']);
});
test('标准酒馆保留原 list/file_id 接口，空列表合法', async () => {
    const calls = [];
    assert.deepEqual(await readWorldNames(async path => { calls.push(path); return [{ file_id: '书' }]; }, false), ['书']);
    assert.deepEqual(calls, ['/api/worldinfo/list']); assert.deepEqual(await readWorldNames(async () => ({ world_names: [] }), true), []);
});
test('坏列表和服务失败不退回缓存、不继续事务', async () => {
    await assert.rejects(readWorldNames(async () => ({ world_names: null }), true), /无效/);
    await assert.rejects(readWorldNames(async () => [{ name: '缺少文件名' }], false), /读取失败/);
    await assert.rejects(readWorldNames(async () => { throw new Error('离线'); }, true), /离线/);
});
