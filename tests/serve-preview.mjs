import http from 'node:http';
import fs from 'node:fs';
const allowed = new Set(['editor.js', 'editor-model.js', 'editor.css', 'core.js', 'tests/preview.html', 'tests/preview.js', 'tests/host-schema.json']);
const root = new URL('../', import.meta.url);
http.createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).slice(1) || 'tests/preview.html';
    if (!allowed.has(path)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(fs.readFileSync(new URL(path, root)));
}).listen(17891, '127.0.0.1', () => console.log('Synthetic editor preview: http://127.0.0.1:17891'));
