import { createServer } from 'node:http';

export function startHealthServer(config, state: any = {}) {
    if (!config.port)
        return null;
    const server = createServer((request, response) => {
        if (request.url === '/healthz') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: true, service: 'operations-runner', state: state.status ?? 'booting' }));
            return;
        }
        if (request.url === '/readyz') {
            const ready = state.ready === true;
            response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                ok: ready,
                service: 'operations-runner',
                state: state.status ?? 'booting',
                error: state.error ?? null,
            }));
            return;
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'Not found.' }));
    });
    server.listen(config.port);
    return server;
}
