import { createWorldbookEditor } from '/editor.js';
const { schema, keyMap, template } = await (await fetch('/tests/host-schema.json')).json();
const books = new Map();
function makeBook(count, label) {
    return { entries: Object.fromEntries(Array.from({ length: count }, (_, i) => [i, {
        ...structuredClone(template), uid: i, displayIndex: i, comment: `${label} · ${String(i + 1).padStart(4, '0')}`,
        key: ['示例词', `线索${i + 1}`], content: `这是第 ${i + 1} 个虚构条目，用来检查阅读和编辑效果。\n每次只渲染当前条目的表单。`,
        disable: i % 7 === 0, constant: i % 13 === 0,
    }])) };
}
books.set('林间小镇 1.1', makeBook(2400, '小镇设定'));
books.set('角色补充设定', makeBook(80, '补充设定'));
books.set('全局写作约定', makeBook(12, '写作约定'));
books.set('不应出现在界面的无关书', makeBook(5, '无关'));
let scope = { primary: '林间小镇 1.1', extra: ['角色补充设定'], global: ['全局写作约定'], names: [...books.keys()] };
const editor = createWorldbookEditor({
    schema, keyMap, template, assertActive() {},
    characterName: () => '预览角色', scope: async () => structuredClone(scope),
    read: async name => structuredClone(books.get(name)),
    backup: async (name, value) => { window.previewBackup = structuredClone(value); },
    write: async (name, value) => books.set(name, structuredClone(value)),
    notifySaved: async () => {}, lock: task => task(),
    confirm: async (title, message) => confirm(`${title}\n${message}`),
});
window.preview = { books, editor, get scope() { return scope; } };
document.getElementById('open').onclick = () => editor.open();
document.getElementById('outside').onclick = () => {
    books.get('林间小镇 1.1').entries[0].content = '来自外部的修改';
    editor.externalUpdate('林间小镇 1.1');
};
document.getElementById('scope').onclick = () => {
    scope = { ...scope, primary: '', extra: [] }; editor.scopeChanged();
};
await editor.open();
// Synthetic test controls inside the modal, so conflict paths can be exercised through UI.
const demos = document.createElement('div');
demos.style.cssText = 'display:flex;gap:8px;padding:8px 20px;font-size:12px;border-top:1px solid #555';
for (const [text, action] of [
    ['模拟外部修改', document.getElementById('outside').onclick],
    ['模拟切换角色', document.getElementById('scope').onclick],
]) {
    const btn = document.createElement('button'); btn.textContent = text;
    btn.onclick = action; demos.append(btn);
}
if (!new URLSearchParams(location.search).has('clean')) document.querySelector('#st-worldbook-editor').append(demos);
