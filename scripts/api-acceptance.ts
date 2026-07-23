import { pathToFileURL } from 'node:url';
import { main } from './api-acceptance-support/index.js';
export * from './api-acceptance-support/index.js';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
