import { createWorldbookEditor } from '/editor.js';
import { createManagerHost } from '/manager-host.js';
import { mountLauncher } from '/launcher.js';
import { actionForm } from '/manager-ui.js';
const { schema, keyMap, template } = await (await fetch('/tests/host-schema.json')).json();
const books = new Map();
function makeBook(count, label) {
    return { entries: Object.fromEntries(Array.from({ length: count }, (_, i) => [i, {
        ...structuredClone(template), uid: i, displayIndex: i, comment: `${i % 13 === 0 ? '[mvu_update] ' : ''}${label} · ${String(i + 1).padStart(4, '0')}`,
        key: ['示例词', `线索${i + 1}`], content: `这是第 ${i + 1} 个虚构条目，用来检查阅读和编辑效果。\n每次只渲染当前条目的表单。`,
        disable: i % 7 === 0, constant: i % 13 === 0,
    }])) };
}
books.set('林间小镇 1.1', makeBook(2400, '小镇设定'));
books.set('角色补充设定', makeBook(80, '补充设定'));
books.set('全局写作约定', makeBook(12, '写作约定'));
books.set('不应出现在界面的无关书', makeBook(5, '无关'));
let scope = { primary: '林间小镇 1.1', extra: ['角色补充设定'], global: ['全局写作约定'], names: [...books.keys()] };
const configuration = { families: {} };
const context = { characters: [{ avatar: 'preview.png', data: { extensions: { world: scope.primary } } }], characterId: 0,
    chatId: '模拟对话1', chatMetadata: {}, saveMetadata: async () => {} };
let editor;
const manager = createManagerHost({
    context: () => context, settings: () => configuration, saveSettings() {}, assertActive() {},
    listNames: async () => [...books.keys()], name: async name => name,
    read: async name => structuredClone(books.get(name)), readCharacter: async () => structuredClone(context.characters[0]),
    write: async (name, value) => books.set(name, structuredClone(value)), backup: async () => {},
    references: async () => [], remove: async name => books.delete(name), convert: value => value,
    bind: async (_, name) => { context.characters[0].data.extensions.world = name; },
    activateGlobal: async name => { scope.global.push(name); }, changed: async () => editor.scopeChanged(),
    globals: () => [...scope.global], setGlobals: async names => { scope.global = [...names]; },
    retarget: async (old, name, guard) => {
        guard(); scope.global = scope.global.map(value => value === old ? name : value);
        scope.extra = scope.extra.map(value => value === old ? name : value);
        if (context.characters[0].data.extensions.world === old) context.characters[0].data.extensions.world = name;
    },
});
manager.family();
editor = createWorldbookEditor({
    schema, keyMap, template, manager, assertActive() {},
    characterName: () => '预览角色', scope: async () => ({ ...structuredClone(scope), primary: configuration.families['preview.png'].main,
        copies: configuration.families['preview.png'].copies, names: [...books.keys()], owner: 'preview.png', chat: context.chatId, selected: context.chatMetadata.world_info }),
    read: async name => structuredClone(books.get(name)),
    backup: async (name, value) => { window.previewBackup = structuredClone(value); },
    write: async (name, value) => books.set(name, structuredClone(value)),
    notifySaved: async () => {}, lock: task => task(),
    confirm: async (title, message) => !!await actionForm(title, [], message),
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
mountLauncher(() => editor.open());
if (!new URLSearchParams(location.search).has('open')) { /* Start with only the launcher. */ }
else await editor.open();
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
if (!new URLSearchParams(location.search).has('clean')) document.querySelector('#st-worldbook-editor')?.append(demos);
