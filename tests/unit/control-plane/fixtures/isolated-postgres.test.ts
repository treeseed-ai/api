import { expect, it } from 'vitest';
import { isolatedPostgres } from './isolated-postgres.ts';

it('restores independent empty databases without sharing mutations or closed state', async () => {
	const left = await isolatedPostgres(), right = await isolatedPostgres();
	try {
		await left.exec("CREATE TABLE owned (value text); INSERT INTO owned VALUES ('left');");
		expect((await right.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([]);
		await right.exec("CREATE TABLE owned (value text); INSERT INTO owned VALUES ('right');");
		expect((await left.query('SELECT * FROM owned')).rows).toEqual([{ value: 'left' }]);
		expect((await right.query('SELECT * FROM owned')).rows).toEqual([{ value: 'right' }]);
		await left.close();
		expect(left.closed).toBe(true);
		expect((await right.query('SELECT * FROM owned')).rows).toEqual([{ value: 'right' }]);
	} finally {
		if (!left.closed) await left.close();
		await right.close();
	}
	const later = await isolatedPostgres();
	try {
		expect((await later.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([]);
	} finally {
		await later.close();
	}
	expect([left.closed, right.closed, later.closed]).toEqual([true, true, true]);
});
