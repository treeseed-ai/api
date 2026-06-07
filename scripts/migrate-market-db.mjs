import { createMarketPostgresDatabase } from '../src/api/market-postgres.js';

const databaseUrl = process.env.TREESEED_MARKET_DATABASE_URL;
if (!databaseUrl?.trim()) {
	console.error('TREESEED_MARKET_DATABASE_URL is required to apply Market PostgreSQL Drizzle migrations.');
	process.exit(1);
}

const database = createMarketPostgresDatabase(databaseUrl);
try {
	await database.migrate();
	console.log('Applied Market PostgreSQL Drizzle migrations.');
} finally {
	await database.close();
}
