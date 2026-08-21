import { createControlPlanePostgresDatabase } from '../../src/api/support/control-plane-postgres.js';

const databaseUrl = process.env.TREESEED_DATABASE_URL;
if (!databaseUrl?.trim()) {
	console.error('TREESEED_DATABASE_URL is required to apply Treeseed PostgreSQL Drizzle migrations.');
	process.exit(1);
}

const database = createControlPlanePostgresDatabase(databaseUrl);
try {
	await database.migrate();
	console.log('Applied Treeseed PostgreSQL Drizzle migrations.');
} finally {
	await database.close();
}
