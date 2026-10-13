const KEY = 'st_worldbook_manager_launcher';
export function mountLauncher(open) {
    document.getElementById('st-worldbook-launcher')?.remove();
    const button = document.createElement('button');
    button.id = 'st-worldbook-launcher'; button.type = 'button';
    button.textContent = '世界书'; button.setAttribute('aria-label', '打开世界书管理器');
    button.setAttribute('aria-controls', 'st-worldbook-editor');
    button.title = '点击打开世界书；拖动可移动';
    let placement = { x: .95, y: .65 };
    try {
        const saved = JSON.parse(localStorage.getItem(KEY));
        if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) placement = saved;
    } catch { /* Use a visible fallback. */ }
    let gesture;
    let suppressClick = false;
    const viewport = () => ({ x: window.visualViewport?.offsetLeft || 0, y: window.visualViewport?.offsetTop || 0,
        w: window.visualViewport?.width || innerWidth, h: window.visualViewport?.height || innerHeight });
    const clamp = (x, y) => {
        const v = viewport();
        return { x: Math.max(v.x + 8, Math.min(x, v.x + v.w - button.offsetWidth - 8)),
            y: Math.max(v.y + 8, Math.min(y, v.y + v.h - button.offsetHeight - 8)) };
    };
    const move = (x, y) => {
        const p = clamp(x, y); button.style.left = `${p.x}px`; button.style.top = `${p.y}px`;
    };
    function restore() {
        const v = viewport(); move(v.x + placement.x * (v.w - button.offsetWidth), v.y + placement.y * (v.h - button.offsetHeight));
    }
    button.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        const rect = button.getBoundingClientRect();
        gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
        button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
        if (gesture?.id !== event.pointerId) return;
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5) gesture.moved = true;
        if (gesture.moved) move(gesture.left + event.clientX - gesture.x, gesture.top + event.clientY - gesture.y);
    });
    function finish(event) {
        if (gesture?.id !== event.pointerId) return;
        suppressClick = gesture.moved || event.type === 'pointercancel';
        if (gesture.moved) {
            const rect = button.getBoundingClientRect(), v = viewport();
            placement = { x: (rect.left - v.x) / Math.max(1, v.w - button.offsetWidth), y: (rect.top - v.y) / Math.max(1, v.h - button.offsetHeight) };
            try { localStorage.setItem(KEY, JSON.stringify(placement)); } catch { /* Position still works. */ }
        }
        gesture = undefined;
    }
    button.addEventListener('pointerup', finish); button.addEventListener('pointercancel', finish);
    button.addEventListener('click', event => {
        if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
        suppressClick = false; open();
    });
    document.body.append(button); restore();
    window.addEventListener('resize', restore); window.visualViewport?.addEventListener('resize', restore);
    return () => { button.remove(); window.removeEventListener('resize', restore); window.visualViewport?.removeEventListener('resize', restore); };
}
