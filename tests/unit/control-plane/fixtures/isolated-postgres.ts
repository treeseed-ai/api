import { PGlite } from '@electric-sql/pglite';

// Cache only initdb's pristine bytes. Every caller owns a new database and still
// applies its original migrations; no schema, rows, or live connection is shared.
let pristine: Promise<Blob> | undefined;

async function emptyDatabase(): Promise<Blob> {
	const database = new PGlite();
	try {
		await database.waitReady;
		return await database.dumpDataDir('none');
	} finally {
		await database.close();
	}
}

export async function isolatedPostgres(): Promise<PGlite> {
	const image = await (pristine ??= emptyDatabase());
	const database = new PGlite({ loadDataDir: image });
	try {
		await database.waitReady;
		return database;
	} catch (error) {
		await database.close();
		throw error;
	}
}
