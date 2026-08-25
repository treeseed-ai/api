import { createServer } from 'node:http';
import { registerWorkflowConfigurationDelivery } from '../../workflows/configuration-deliveries.ts';

async function readJson(request, maxBytes = 100_000) {
    const chunks: Buffer[] = []; let total = 0;
    for await (const chunk of request) {
        const bytes = Buffer.from(chunk); total += bytes.length;
        if (total > maxBytes) throw new Error('Request body is too large.');
        chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function startHealthServer(config, state: any = {}) {
    if (config.port === undefined || config.port === null)
        return null;
    const server = createServer(async (request, response) => {
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
        if (request.method === 'PUT' && request.url?.startsWith('/internal/workflow-configuration-deliveries/')) {
            const authorization = request.headers.authorization;
            if (!config.runnerSecret || authorization !== `Bearer ${config.runnerSecret}`) {
                response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                response.end(JSON.stringify({ ok: false, error: 'Unauthorized.' })); return;
            }
            try {
                const id = decodeURIComponent(request.url.slice(request.url.lastIndexOf('/') + 1));
                registerWorkflowConfigurationDelivery({ ...(await readJson(request)), id });
                response.writeHead(202, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                response.end(JSON.stringify({ ok: true }));
            } catch {
                response.writeHead(422, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                response.end(JSON.stringify({ ok: false, error: 'Invalid delivery.' }));
            }
            return;
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'Not found.' }));
    });
    server.listen(config.port);
    return server;
}
