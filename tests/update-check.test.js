import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installedLocation, checkInstalledExtension, EXTENSION_VERSION } from '../update-check.js';
const moduleUrl = 'http://127.0.0.1:8000/scripts/extensions/third-party/custom-install-name/update-check.js';
const options = { moduleUrl, types: { 'third-party/custom-install-name': 'local' }, headers: { 'Content-Type': 'application/json' } };
test('按实际安装文件夹检查，支持用户与全局安装，未知路径拒绝', () => {
    assert.deepEqual(installedLocation(moduleUrl, options.types), { extensionName: 'custom-install-name', global: false });
    assert.equal(installedLocation(moduleUrl, { 'third-party/custom-install-name': 'global' }).global, true);
    assert.throws(() => installedLocation('http://localhost/editor.js', {}), /无法识别/);
    assert.throws(() => installedLocation(moduleUrl, {}), /安装范围/);
});
test('原生检查区分远端同步和有新提交，只调用 version 接口', async () => {
    for (const isUpToDate of [true, false]) {
        const calls = [];
        const result = await checkInstalledExtension({ ...options, fetcher: async (url, request) => {
            calls.push(url); assert.deepEqual(JSON.parse(request.body), { extensionName: 'custom-install-name', global: false });
            return { ok: true, json: async () => ({ currentCommitHash: 'abc123', remoteUrl: 'https://github.com/user/repo', currentBranchName: 'main', isUpToDate }) };
        } });
        assert.equal(result.state, isUpToDate ? 'current' : 'available'); assert.deepEqual(calls, ['/api/extensions/version']);
    }
});
test('ZIP 非 Git 安装不能被原生 isUpToDate=true 误报最新', async () => {
    const result = await checkInstalledExtension({ ...options, fetcher: async () => ({ ok: true, json: async () => ({ currentCommitHash: '', remoteUrl: '', isUpToDate: true }) }) });
    assert.equal(result.state, 'manual');
});
test('网络 HTTP 失败不返回已同步', async () => {
    await assert.rejects(checkInstalledExtension({ ...options, fetcher: async () => ({ ok: false, status: 500 }) }), /HTTP 500/);
});
test('无明确更新状态的响应拒绝', async () => {
    await assert.rejects(checkInstalledExtension({ ...options, fetcher: async () => ({ ok: true, json: async () => ({ currentCommitHash: 'abc', remoteUrl: 'https://github.com/user/repo' }) }) }), /不完整/);
});
test('取消信号传给请求，取消保持失败而不是同步', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(checkInstalledExtension({ ...options, signal: controller.signal, fetcher: async (_, request) => { assert.equal(request.signal.aborted, true); throw new DOMException('cancelled', 'AbortError'); } }), { name: 'AbortError' });
});
test('面板显示版本与发布 manifest 一致', () => {
    assert.equal(EXTENSION_VERSION, JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')).version);
});
