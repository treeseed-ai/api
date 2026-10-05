import { describe, expect, it } from 'vitest';
import { graphProjection, livingGraphDatabase } from './living-graph-fixture.ts';

async function history() {
	const f = await livingGraphDatabase();
	try {
		const reference = graphProjection().revision;
		for (const teamId of ['team', 'other-team']) for (let revision = 1; revision <= 101; revision++) {
			await f.query(`INSERT INTO execution_graph_revisions
				(team_id,revision,rule_revision,changed_source_refs_json,graph_digest,changes_json,created_at) VALUES (?,?,1,?,?,?,?)`,
				[teamId, revision, JSON.stringify(reference.changedSourceRefs), `sha256:${revision.toString(16).padStart(64, '0')}`,
					JSON.stringify(reference.changes), new Date(Date.parse(reference.createdAt) + revision).toISOString()]);
		}
		return f;
	} catch (error) { await f.db.close(); throw error; }
}
describe('native owning graph watch complete pagination', () => {
	it('returns exact hundred tail and explicit terminal watch pages with foreign team isolation and unchanged SQL', async () => {
		const f = await history(); try {
			const before = await f.snapshot(), all = [];
			for (const cursor of ['0', '100', '101']) {
				const page = await f.service.watch(f.principal, 'team', { cursor }); all.push(...page.items);
				expect(page.items).toHaveLength(cursor === '0' ? 100 : cursor === '100' ? 1 : 0);
				expect(page.nextCursor).toBe(cursor === '0' ? '100' : '101'); expect(page.items.every(item => item.teamId === 'team')).toBe(true);
			}
			expect(all.map(record => record.revision)).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
			await Promise.all([f.service.watch(f.principal, 'team', { cursor: '100' }), f.service.watch(f.principal, 'team', { cursor: '100' })]);
			expect(await f.snapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
	it('denies absent principal and malformed watch cursors rather than silently restarting from old history', async () => {
		const f = await history(); try {
			const before = await f.snapshot(), outcomes = [];
			outcomes.push(await f.service.watch(null, 'team', { cursor: '0' }).then(() => 'admitted', () => 'denied'));
			for (const cursor of ['-1', 'NaN', '1.5', '1garbage']) outcomes.push(await f.service.watch(f.principal, 'team', { cursor }).then(() => 'admitted', () => 'denied'));
			expect(outcomes).toEqual(['denied', 'denied', 'denied', 'denied', 'denied']); expect(await f.snapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
});
