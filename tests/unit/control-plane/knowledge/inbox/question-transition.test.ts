import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { createInboxService } from '../../../../../src/api/control-plane/inbox/inbox-service.ts';
import { executePostgresBatch, translateControlPlaneSqlToPostgres } from '../../../../../src/api/support/control-plane-postgres.ts';
import { splitPostgresSqlStatements } from '../../../../../src/api/persistence/postgres-sql-statements.ts';
vi.mock('../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts', () => ({ reconcileExecutionGraph: vi.fn() }));
vi.mock('../../../../../src/api/discussions/content.ts', () => ({ loadDiscussions: async () => ({ messages: [] }) }));
vi.mock('../../../../../src/api/control-plane/inbox/question-content.ts', async original => ({
	...await original<object>(), readInboxQuestionAnswer: async () => ({ store: 'treedx', model: 'discussion-message', id: 'answer', revision: 1,
		digest: `sha256:${'b'.repeat(64)}`, repository: 'library', path: 'discussion-messages/topic/answer.mdx', commit: 'b'.repeat(40) }),
}));

// SQL storage unit boundary: original DDL, SQL translation and batch executor.
// Discussion/readback are controlled dependencies; native TreeDX and concurrent
// PostgreSQL are proved separately in the existing native governance case.
it.each(['normal', 'reopened', 'source-edited'] as const)('commits exact lifecycle proof only against unchanged question authority: %s', async mode => {
	const db = new PGlite();
	try {
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of ['teams', 'projects']) {
			const statement = ddl.find(sql => sql.startsWith(`CREATE TABLE "${table}" (`)); if (!statement) throw new Error('Original owner DDL required'); await db.exec(statement);
		}
		await db.exec(readFileSync('drizzle/control-plane/0005_governance_inbox.sql', 'utf8'));
		const query = (sql: string, params: unknown[] = []) => db.query<Record<string, unknown>>(translateControlPlaneSqlToPostgres(sql), params);
		const now = '2026-10-25T01:00:00.000Z';
		await query('INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES (?,?,?,?,?)', ['team','team','Team',now,now]);
		await query('INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES (?,?,?,?,?,?)', ['project','team','project','Project',now,now]);
		await query(`INSERT INTO inbox_items (id,team_id,project_id,kind,title,markdown,status,author_id,author_label,discussion_id,
			repository_id,content_path,commit_sha,digest,created_at,updated_at) VALUES (?,?,?,'question',?,?,'outstanding',?,?,?,?,?,?,?,?,?)`,
			['handoff','team','project','Reviewed runtime handoff','Keep integration held.','coordinator','Coordinator','topic','library','questions/handoff.mdx','a'.repeat(40),'a'.repeat(64),now,now]);
		const store = { run: query, first: async (sql: string, params: unknown[] = []) => (await query(sql, params)).rows[0] ?? null,
			all: async (sql: string, params: unknown[] = []) => (await query(sql, params)).rows,
			batch: (operations: Parameters<typeof executePostgresBatch>[1]) => db.transaction(tx => executePostgresBatch(tx as unknown as Parameters<typeof executePostgresBatch>[0], operations)),
			getProjectDetails: async () => ({ project: { slug: 'project' } }) };
		let intervene: (() => Promise<void>) | undefined;
		const discussions = { create: async () => { await intervene?.(); return { discussion: { id: 'topic' }, message: { path: 'discussion-messages/topic/answer.mdx' }, commitSha: 'b'.repeat(40) }; } };
		const inbox = createInboxService({ store, discussions, communications: {}, governance: {} });
		const principal = { id: 'coordinator', roles: ['admin'] };
		const view = () => store.first('SELECT * FROM inbox_items WHERE id=?', ['handoff']);
		const tag = async () => { const row = (await view())!; return `inbox:${row.id}:${row.version}:${new Date(String(row.updated_at)).toISOString()}`; };
		const first = await inbox.action(principal,'team','handoff',{action:'answer',markdown:'Reviewed input.'},'first-answer',await tag());
		expect(first.item.status).toBe('answered');
		const suppliedTag = first.item.etag;
		if (mode === 'reopened') intervene = async () => {
			intervene = undefined; await inbox.action(principal,'team','handoff',{action:'reopen'},'reopen',suppliedTag);
		};
		if (mode === 'source-edited') intervene = async () => {
			intervene = undefined; await query('UPDATE inbox_items SET commit_sha=?,digest=? WHERE id=?', ['c'.repeat(40),'c'.repeat(64),'handoff']);
		};
		const answer = inbox.action(principal,'team','handoff',{action:'answer',markdown:'Late evaluated input.'},'later-answer',suppliedTag);
		if (mode === 'normal') await expect(answer).resolves.toMatchObject({ item: { status: 'answered' } });
		else await expect(answer).rejects.toMatchObject({ status: 412, code: 'inbox_item_precondition_failed' });
		const events = await store.all("SELECT event_type,payload_json FROM inbox_events WHERE event_type='question.answered' ORDER BY sequence");
		expect(events).toHaveLength(mode === 'normal' ? 2 : 1);
		expect(events[0]?.payload_json).toMatchObject({ questionRef: { model: 'question', commit: 'a'.repeat(40) }, answerRef: { model: 'discussion-message', commit: 'b'.repeat(40) } });
		if (mode === 'reopened') expect((await view())?.status).toBe('outstanding');
	} finally { await db.close(); }
});
