import { createControlPlanePostgresDatabase } from '../../src/api/support/control-plane-postgres.js';
import { pathToFileURL } from 'node:url';
import { resolveApiDatabaseUrl } from '../../src/api/configuration/runtime-config.ts';

export async function main() {
	if (process.env.TREESEED_DEVELOPMENT_MODE === 'live') {
		throw new Error('live_migration_apply_forbidden: run the reviewed migration outside the live service session.');
	}
	const databaseUrl = resolveApiDatabaseUrl(process.env);
	if (!databaseUrl?.trim()) {
		throw new Error('A managed database file or explicit database URL is required to apply TreeSeed PostgreSQL migrations.');
	}

	const database = createControlPlanePostgresDatabase(databaseUrl, { migrationMode: 'apply' });
	try {
		await database.migrate();
		console.log('Applied TreeSeed PostgreSQL migrations.');
	} finally {
		await database.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
