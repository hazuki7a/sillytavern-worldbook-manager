import { hostPath, readApiJson } from './host-http.js';
export const EXTENSION_VERSION = '0.3.4';
export const REPOSITORY_URL = 'https://github.com/hazuki7a/sillytavern-worldbook-manager';

export function installedLocation(moduleUrl, types) {
    const parts = new URL(moduleUrl).pathname.split('/');
    const index = parts.lastIndexOf('third-party');
    if (index < 0 || !parts[index + 1]) throw new Error('无法识别扩展安装目录，请在酒馆扩展管理中检查更新。');
    const name = decodeURIComponent(parts[index + 1]);
    if (!name || /[\\/]/.test(name) || ['.', '..'].includes(name)) throw new Error('扩展安装目录无效。');
    const type = types[`third-party/${name}`] || types[name];
    if (!['local', 'global'].includes(type)) throw new Error('无法识别扩展安装范围，请在酒馆扩展管理中检查更新。');
    return { extensionName: name, global: type === 'global' };
}
export async function checkInstalledExtension({ moduleUrl, types, headers, fetcher = fetch, signal }) {
    const location = installedLocation(moduleUrl, types);
    const response = await fetcher(hostPath('/api/extensions/version', moduleUrl), {
        method: 'POST', headers, body: JSON.stringify(location), cache: 'no-store', signal,
    });
    if (!response.ok) throw new Error(`更新检测失败（HTTP ${response.status}），请检查网络或安装目录后重试。`);
    const data = await readApiJson(response, '/api/extensions/version');
    if (!data.currentCommitHash || !data.remoteUrl) return { state: 'manual' };
    if (typeof data.isUpToDate !== 'boolean') throw new Error('酒馆返回的更新状态不完整，请重试。');
    return { state: data.isUpToDate ? 'current' : 'available', branch: String(data.currentBranchName || ''), commit: String(data.currentCommitHash) };
}

export function mountUpdateChecker(panel, { types, headers, moduleUrl = import.meta.url, fetcher = fetch }) {
    const section = document.createElement('section'); section.className = 'wb-extension-update';
    const version = document.createElement('div'); version.textContent = `当前扩展版本：${EXTENSION_VERSION}`;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'menu_button'; button.textContent = '检测扩展更新';
    const status = document.createElement('div'); status.setAttribute('role', 'status'); status.textContent = '点击检查扩展程序更新；与角色卡世界书更新无关。';
    const link = document.createElement('a'); link.href = REPOSITORY_URL; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看 GitHub 仓库';
    section.append(version, button, status, link); panel.querySelector('.inline-drawer-content').append(section);
    let controller, timer, disposed = false;
    async function check() {
        if (button.disabled || disposed) return;
        button.disabled = true; status.textContent = '正在检查扩展远端更新…';
        controller = new AbortController(); timer = setTimeout(() => controller.abort(), 30000);
        try {
            const result = await checkInstalledExtension({ moduleUrl, types, headers: headers(), fetcher, signal: controller.signal });
            if (disposed) return;
            status.textContent = result.state === 'available'
                ? `发现扩展更新（${result.branch || '当前分支'}）。请在酒馆扩展管理中更新“世界书管理器”，完成后刷新网页。`
                : result.state === 'manual'
                    ? '当前为非 Git 安装，无法进行 Git 更新检测。请通过仓库下载新版，或从酒馆扩展管理使用仓库链接安装。'
                    : `当前安装已与远端同步（${result.branch || '当前分支'}）。若刚更新过文件，请刷新网页加载新版。`;
        } catch (error) {
            if (!disposed) status.textContent = error.name === 'AbortError' ? '更新检测超时，请检查网络后重试。' : error.message;
        } finally { clearTimeout(timer); if (!disposed) button.disabled = false; }
    }
    button.addEventListener('click', check);
    return () => { disposed = true; controller?.abort(); clearTimeout(timer); button.removeEventListener('click', check); section.remove(); };
}
