// Pure transaction logic. Host operations are injected and tested without real cards.
export function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().filter(k => value[k] !== undefined)
            .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export const equal = (a, b) => canonical(a) === canonical(b);
export const linkOf = character => character?.data?.extensions?.world || '';
export const clone = value => structuredClone(value);

export function validBook(book) {
    return !!book && typeof book === 'object' && !!book.entries
        && typeof book.entries === 'object' && !Array.isArray(book.entries);
}

export function makePlan({ character, incoming, name, previous, names }) {
    if (!validBook(incoming) || !character?.avatar || !name) throw new Error('角色或世界书数据不完整。');
    const current = linkOf(character);
    // Previous binding is necessary when the replacement card already points to its new name.
    const oldName = previous?.world && names.includes(previous.world) ? previous.world : current;
    return {
        avatar: character.avatar,
        characterName: character.name || character.avatar,
        originalLink: current,
        oldName: names.includes(oldName) ? oldName : '',
        newName: name,
        incoming: clone(incoming),
    };
}

/** Save and verify the new world, bind and verify the character, then delete the old world.
 *  All backups finish before the first destructive write. On failure we retain the old file.
 *  Server-side compare-and-swap is unavailable; rechecks reduce, but cannot eliminate,
 *  the cross-browser race between a final read and a host write.
 */
export async function applyPlan(host, plan) {
    host.assertActive();
    const sourceCharacter = await host.getCharacter(plan.avatar);
    if (linkOf(sourceCharacter) !== plan.originalLink
        || !equal(host.convert(sourceCharacter.data.character_book), plan.incoming)) {
        throw new Error('角色卡或世界书关联已变化，请重新检查。');
    }
    const names = await host.listNames();
    const before = new Map();
    for (const name of new Set([plan.oldName, plan.newName].filter(Boolean))) {
        if (names.includes(name)) before.set(name, await host.readBook(name));
    }
    const targetRefs = await host.references(plan.newName, plan.avatar, { target: true });
    if (targetRefs.length && !equal(before.get(plan.newName), plan.incoming)) {
        throw new Error(`新世界书名称已被其他用途使用，已停止覆盖：${targetRefs.join('；')}。请先改名或解除共享。`);
    }
    for (const [name, book] of before) {
        if (!validBook(book)) throw new Error(`无法读取旧世界书「${name}」，未开始更新。`);
        await host.backup(name, book, plan.avatar);
    }
    // Re-read after backups, as their upload can take time.
    for (const [name, book] of before) {
        if (!equal(await host.readBook(name), book)) throw new Error('备份期间世界书被修改，已停止更新。');
    }
    if (!before.has(plan.newName) && (await host.listNames()).includes(plan.newName)) {
        throw new Error('备份期间出现了同名世界书，已停止更新。');
    }
    host.assertActive();
    const latest = await host.getCharacter(plan.avatar);
    if (linkOf(latest) !== plan.originalLink
        || !equal(host.convert(latest.data.character_book), plan.incoming)) {
        throw new Error('备份期间角色卡被修改，已停止更新。');
    }
    let wroteTarget = false;
    let bound = false;
    try {
        if (!equal(before.get(plan.newName), plan.incoming)) {
            wroteTarget = true;
            await host.writeBook(plan.newName, plan.incoming);
            if (!equal(await host.readBook(plan.newName), plan.incoming)) {
                throw new Error('新版世界书写入后回读不一致。');
            }
        }
        host.assertActive();
        // Prevent binding a newer replacement card to this transaction's older book.
        const current = await host.getCharacter(plan.avatar);
        if (linkOf(current) !== plan.originalLink
            || !equal(host.convert(current.data.character_book), plan.incoming)) {
            throw new Error('写入期间角色卡被修改，旧书未删除。');
        }
        await host.bind(plan.avatar, plan.newName);
        if (linkOf(await host.getCharacter(plan.avatar)) !== plan.newName) {
            throw new Error('新版世界书关联未保存，旧书未删除。');
        }
        bound = true;
    } catch (error) {
        // A failed bind can still have reached the server. If uncertain, retain the new file.
        // Compensate a same-name overwrite only when both the card and file remain unchanged.
        if (wroteTarget && before.has(plan.newName)) {
            try {
                const current = await host.getCharacter(plan.avatar);
                if (!bound && linkOf(current) === plan.originalLink
                    && equal(host.convert(current.data.character_book), plan.incoming)
                    && equal(await host.readBook(plan.newName), plan.incoming)) {
                    await host.writeBook(plan.newName, before.get(plan.newName));
                }
            } catch { /* Verified backup is retained for manual recovery. */ }
        }
        throw error;
    }
    let deleted = false;
    let warning = '';
    if (plan.oldName && plan.oldName !== plan.newName && before.has(plan.oldName)) {
        host.assertActive();
        const refs = [...new Set(await host.references(plan.oldName, plan.avatar))];
        if (refs.length) {
            warning = `新版已启用；旧书仍被 ${refs.join('；')} 使用，因此保留。`;
        } else if (!equal(await host.readBook(plan.oldName), before.get(plan.oldName))) {
            warning = '新版已启用；旧书在更新期间被修改，因此保留。';
        } else {
            host.assertActive();
            const finalCard = await host.getCharacter(plan.avatar);
            if (linkOf(finalCard) !== plan.newName
                || !equal(host.convert(finalCard.data.character_book), plan.incoming)
                || !equal(await host.readBook(plan.newName), plan.incoming)) {
                throw new Error('删除前检查发现新版或关联变化，旧书保留。');
            }
            await host.deleteBook(plan.oldName);
            deleted = !(await host.listNames()).includes(plan.oldName);
            if (!deleted) throw new Error('新版已启用，但旧书删除未成功。');
        }
    }
    return { deleted, warning, sameName: plan.oldName === plan.newName };
}
