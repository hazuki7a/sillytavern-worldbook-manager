import fs from 'node:fs';
import vm from 'node:vm';
const native = fs.readFileSync('D:/sillytaverns/SillyTavern/public/scripts/world-info.js', 'utf8');
const extract = name => {
    const start = native.indexOf(`export const ${name} = `);
    if (start < 0) throw new Error(`Missing native definition ${name}`);
    const from = start + `export const ${name} = `.length;
    const to = native.indexOf('\n};', from);
    return native.slice(from, to + 2);
};
const sandbox = { world_info_logic: { AND_ANY: 0 }, DEFAULT_DEPTH: 4, DEFAULT_WEIGHT: 100 };
const schema = vm.runInNewContext(`(${extract('newWorldInfoEntryDefinition')})`, sandbox);
const keyMap = vm.runInNewContext(`(${extract('originalWIDataKeyMap')})`);
const template = Object.fromEntries(Object.entries(schema).filter(([, def]) => !def.excludeFromTemplate).map(([key, def]) => [key, def.default]));
fs.writeFileSync(new URL('./host-schema.json', import.meta.url), JSON.stringify({ schema, keyMap, template }, null, 2));
console.log(`Preview schema: ${Object.keys(schema).length} native fields; synthetic data only.`);
