import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './entrypoint-support/index.js';
export * from './entrypoint-support/index.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    await main().catch((error) => {
        console.error(JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        }));
        process.exitCode = 1;
    });
}
