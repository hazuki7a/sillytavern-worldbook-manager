export function actionForm(title, fields, description = '', signal) {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog'); dialog.className = 'wb-action-dialog';
        dialog.dataset.theme = document.getElementById('st-worldbook-editor')?.dataset.theme || 'day';
        dialog.setAttribute('aria-label', title);
        const form = document.createElement('form'); form.method = 'dialog';
        const heading = document.createElement('h3'); heading.textContent = title; form.append(heading);
        if (description) { const p = document.createElement('p'); p.textContent = description; form.append(p); }
        const controls = {};
        for (const field of fields) {
            const label = document.createElement('label'); label.textContent = field.label;
            const control = document.createElement(field.type === 'select' ? 'select' : 'input');
            if (field.type === 'select') {
                for (const value of field.options) { const o = document.createElement('option'); o.value = value; o.textContent = value; control.append(o); }
                control.value = field.value || field.options[0];
            } else {
                control.type = field.type || 'text';
                if (control.type === 'checkbox') control.checked = !!field.value;
                else if (control.type === 'file') { control.accept = '.json,application/json'; control.required = true; }
                else { control.value = field.value || ''; control.required = field.required !== false; }
            }
            control.name = field.name; control.setAttribute('aria-label', field.label); controls[field.name] = control; label.append(control); form.append(label);
        }
        const error = document.createElement('p'); error.className = 'wb-error'; error.setAttribute('role', 'status'); form.append(error);
        const yes = document.createElement('button'); yes.type = 'submit'; yes.textContent = '确认';
        const no = document.createElement('button'); no.type = 'button'; no.textContent = '取消';
        const previousFocus = document.activeElement;
        let finished = false;
        const finish = result => {
            if (finished) return; finished = true;
            signal?.removeEventListener('abort', abort);
            dialog.close(); dialog.remove(); previousFocus?.isConnected && previousFocus.focus(); resolve(result);
        };
        const abort = () => finish();
        if (signal?.aborted) { finish(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        no.onclick = () => finish();
        form.append(yes, no); dialog.append(form);
        form.addEventListener('submit', async event => {
            event.preventDefault(); if (!form.reportValidity()) return;
            yes.disabled = true;
            try {
                const result = {};
                for (const [name, control] of Object.entries(controls)) {
                    if (control.type === 'checkbox') result[name] = control.checked;
                    else if (control.type === 'file') {
                        const file = control.files[0];
                        if (file.size > 50 * 1024 * 1024) throw new Error('文件超过 50 MB，请先检查文件。');
                        result[name] = JSON.parse(await file.text()); result.filename = file.name.replace(/\.json$/i, '');
                    } else result[name] = control.value.trim();
                }
                finish(result);
            } catch (e) { error.textContent = e.message; yes.disabled = false; }
        });
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
        document.body.append(dialog); dialog.showModal();
    });
}
