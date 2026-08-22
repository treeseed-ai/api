import { createControlPlanePostgresDatabase } from '../../src/api/support/control-plane-postgres.js';
import { pathToFileURL } from 'node:url';

export async function main() {
	const databaseUrl = process.env.TREESEED_DATABASE_URL;
	if (!databaseUrl?.trim()) {
		throw new Error('TREESEED_DATABASE_URL is required to apply TreeSeed PostgreSQL migrations.');
	}

	const database = createControlPlanePostgresDatabase(databaseUrl);
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
