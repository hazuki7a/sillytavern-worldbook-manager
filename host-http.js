// Respect a reverse proxy prefix when the extension itself is served below it.
export function isTauriHost(host = globalThis) {
    return !!host.__TAURITAVERN__ || host.__TAURI_RUNNING__ === true;
}
export async function readWorldNames(postJson, tauri = isTauriHost()) {
    if (tauri) {
        const data = await postJson('/api/settings/get', {});
        if (!Array.isArray(data?.world_names) || data.world_names.some(name => typeof name !== 'string')) throw new Error('TauriTavern 返回的世界书列表无效，已停止操作。');
        return [...new Set(data.world_names)];
    }
    const list = await postJson('/api/worldinfo/list', {});
    if (!Array.isArray(list) || list.some(item => typeof item?.file_id !== 'string')) throw new Error('世界书列表读取失败，已停止操作。');
    return [...new Set(list.map(item => item.file_id))];
}
export function hostPath(path, moduleUrl = import.meta.url) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('酒馆请求地址无效。');
    const pathname = new URL(moduleUrl).pathname;
    const marker = pathname.indexOf('/scripts/extensions/');
    const base = marker >= 0 ? pathname.slice(0, marker) : '';
    return base && !path.startsWith(`${base}/`) ? `${base}${path}` : path;
}
function responsePath(response, fallback) {
    try { return new URL(response.url).pathname; } catch { return fallback; }
}
export function assertApiResponse(response, path) {
    const url = responsePath(response, path);
    const type = response.headers?.get('content-type') || '';
    if (/text\/html|application\/xhtml/i.test(type)) {
        throw new Error(`酒馆接口 ${path} 返回了网页而不是 JSON（HTTP ${response.status || 200}，返回路径 ${url}）。请检查手机访问地址、登录状态或反向代理；本次操作已停止。`);
    }
    if (!response.ok) throw new Error(`酒馆接口 ${path} 请求失败（HTTP ${response.status}）。请检查服务端版本、登录状态或访问路径。`);
}
export async function readApiJson(response, path) {
    assertApiResponse(response, path);
    if (typeof response.text !== 'function') return response.json(); // Injectable test adapter.
    const text = await response.text();
    if (/^\s*</.test(text)) throw new Error(`酒馆接口 ${path} 返回了 HTML 网页，无法读取世界书数据。请检查访问路径、登录状态或反向代理；本次操作已停止。`);
    try { return JSON.parse(text); }
    catch { throw new Error(`酒馆接口 ${path} 返回无效 JSON（HTTP ${response.status || 200}）。请检查服务端响应；本次操作已停止。`); }
}
