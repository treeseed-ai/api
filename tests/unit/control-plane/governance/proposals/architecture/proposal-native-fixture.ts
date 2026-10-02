import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { parse, stringify } from 'yaml';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';

/** Real owning SQL + official HTTP client + committed native Git bytes.
 * The remote files/read endpoint and library binding are isolated fixtures,
 * NOT a TreeDX server, protected manager, or production permission proof. */
export async function proposalNativeFixture() {
	const root = mkdtempSync(join(tmpdir(), 'api-proposal-readiness-'));
	const db = new PGlite();
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
	let fault: 'none' | 'moved' | 'denied' = 'none';
	const requests: Array<{ ref: string; path: string }> = [];
	const server = createServer(async (request, response) => {
		try {
			if (request.method !== 'POST' || request.url !== '/api/v1/repos/repository/files/read') throw new Error('Unexpected boundary');
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const input = JSON.parse(Buffer.concat(chunks).toString()) as { ref: string; path: string };
			if (!/^[a-f0-9]{40}$/u.test(input.ref) || !/^(proposals|decisions)\/[a-z0-9-]+\.mdx$/u.test(input.path)) throw new Error('Unsafe source');
			requests.push({ ref: input.ref, path: input.path });
			if (fault === 'denied') { response.writeHead(403); response.end(JSON.stringify({ error: 'forbidden' })); return; }
			const content = execFileSync('git', ['show', `${input.ref}:${input.path}`], { cwd: root, encoding: 'utf8' });
			const frontmatter = parse(content.split('---\n')[1]!) as Record<string, unknown>;
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ resolvedRef: fault === 'moved' ? 'f'.repeat(40) : input.ref,
				file: { path: input.path, content, frontmatter } }));
		} catch { response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' })); }
	});
	try {
		git('init', '--quiet'); git('config', 'user.name', 'Native architecture fixture');
		git('config', 'user.email', 'architecture-fixture@example.invalid');
		mkdirSync(join(root, 'proposals'));
		const initial = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of ['governance_proposals', 'governance_decisions', 'governance_events', 'capacity_provider_assignments']) {
			const statements = initial.filter(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
			if (statements.length !== 1) throw new Error(`Missing original DDL: ${table}`);
			await db.exec(statements[0]!);
		}
		await db.exec(readFileSync('drizzle/control-plane/0023_living_execution_graph.sql', 'utf8'));
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('No native HTTP endpoint');
		const query = async (sql: string, parameters: unknown[] = []) => {
			let index = 0;
			return db.query<Record<string, unknown>>(sql.replace(/\?/gu, () => `$${++index}`), parameters);
		};
		const store = { config: { TREESEED_TREEDX_URL: `http://127.0.0.1:${address.port}` },
			getProjectTreeDxLibrary: async () => ({ repositoryId: 'repository', contentPath: '.', contentRepositoryDefaultBranch: 'staging', topology: {} }),
			first: async (sql: string, parameters: unknown[] = []) => (await query(sql, parameters)).rows[0] ?? null,
			all: async (sql: string, parameters: unknown[] = []) => (await query(sql, parameters)).rows };
		const publishContent = (path: string, definition: Record<string, unknown>) => {
			if (!/^(proposals|decisions)\/[a-z0-9-]+\.mdx$/u.test(path)) throw new Error('Unsafe fixture path');
			mkdirSync(join(root, path.split('/')[0]!), { recursive: true });
			const source = `---\n${stringify(definition)}---\n`;
			writeFileSync(join(root, path), source);
			git('add', path); git('commit', '--quiet', '--allow-empty', '-m', 'Governed fixture input');
			return { source, commit: git('rev-parse', 'HEAD'), digest: createHash('sha256').update(source).digest('hex') };
		};
		const publish = async (definition: Record<string, unknown>) => {
			const { source, commit, digest } = publishContent('proposals/proposal.mdx', definition);
			await query('DELETE FROM governance_proposals');
			await query(`INSERT INTO governance_proposals (id,team_id,project_id,title,summary,body,active_content_hash,
				governance_provider_id,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
				['proposal', 'team', 'project', definition.title, definition.summary, definition.request, digest, 'default',
					JSON.stringify({ contentProvenance: { repositoryId: 'repository', contentPath: 'proposals/proposal.mdx', commitSha: commit, digest } }),
					'2026-10-02T21:00:00.000Z', '2026-10-02T21:00:00.000Z']);
			return { source, commit, digest };
		};
		const snapshot = async () => {
			const rows: Record<string, unknown> = {};
			for (const table of ['governance_proposals', 'governance_decisions', 'governance_events', 'execution_nodes', 'execution_edges', 'capacity_provider_assignments']) {
				rows[table] = (await query(`SELECT * FROM ${table} ORDER BY id`)).rows;
			}
			return { rows, head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain') };
		};
		return { store, publish, publishContent, snapshot, query, requests, setFault: (value: typeof fault) => { fault = value; },
			close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
				await db.close(); rmSync(root, { recursive: true, force: true }); } };
	} catch (error) { server.closeAllConnections(); if (server.listening) server.close(); await db.close(); rmSync(root, { recursive: true, force: true }); throw error; }
}
