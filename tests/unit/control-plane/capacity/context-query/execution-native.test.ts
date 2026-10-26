import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { stringify } from 'yaml';
import { TreeDxClient } from '@treeseed/treedx/treedx/client';
import { validateContentFrontmatter } from '@treeseed/sdk/content-validation';
import { ContextQueryCheckService } from '../../../../../src/api/capacity/services/capacity/agents/context-query-check-service.ts';
import { TreeDxDelegationAuthority } from '../../../../../src/api/control-plane/treedx/delegation-authority.ts';
import { requireTreeDxOperation } from '../../../../../src/api/control-plane/treedx/upstream-operation.ts';
import { splitPostgresSqlStatements } from '../../../../../src/api/persistence/postgres-sql-statements.ts';
import { cancellationDatabase } from '../../providers/assignments/architecture/cancellation-fixture.ts';
import { projectTreeDxCommitSignals } from '../../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts';

const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Native object response required.');
	return value as Record<string, unknown>;
};

// Real signed TreeDX, native graph/context engine and original SQL check records.
// This proves the owning context boundary, not a live model or simulated release.
it('executes checked global and activity queries on new native data without expanding bounded text or persisting query payloads as check evidence', async () => {
	const baseUrl = process.env.TREEDX_BASE_URL;
	if (!baseUrl || !process.env.API_NATIVE_TREEDX_ROOT || !process.env.TREESEED_TREEDX_DELEGATION_PRIVATE_KEY)
		throw new Error('The original disposable signed native TreeDX prerequisite is required.');
	const operations = ['createRepository', 'listRepositoryRefs', 'createWorkspace', 'writeWorkspaceFile', 'commitWorkspace', 'getWorkspace', 'closeWorkspace', 'retireRepository'];
	const authority = new TreeDxDelegationAuthority(process.env);
	const token = authority.mint({ actorId: 'treeseed-api', tenantId: 'treeseed-control-plane', projectId: 'disposable-conformance',
		connectionId: 'disposable-conformance', scope: { repositoryIds: ['*'], capabilities: [...new Set(operations.flatMap(id => requireTreeDxOperation(id).requiredCapabilities))], refs: ['*'], paths: ['**'] } }).token;
	const native = new TreeDxClient({ baseUrl, token });
	const created = object(await native.repositories.create({ repositoryName: `query-context-${randomUUID()}` }));
	const repositoryId = String(object(created.repo).repoId ?? '');
	if (!repositoryId) throw new Error('Allocated native repository required.');
	let workspaceId: string | undefined;
	const f = await cancellationDatabase();
	try {
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of ['projects', 'treedx_project_libraries', 'agent_context_query_checks', 'project_agent_classes']) {
			const source = ddl.filter(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
			expect(source, `Original ${table} schema required.`).toHaveLength(1); await f.db.exec(source[0]!);
		}
		for (const file of ['0006_treedx_commit_replication.sql', '0017_remove_git_backup_replication.sql', '0018_repair_git_backup_column_removal.sql'])
			await f.db.exec(readFileSync(`drizzle/control-plane/${file}`, 'utf8'));
		const at = new Date().toISOString();
		await f.owner.run("INSERT INTO teams(id,slug,name,created_at,updated_at) VALUES('team','team','Native context',?,?)", [at, at]);
		await f.owner.run("INSERT INTO projects(id,team_id,slug,name,created_at,updated_at) VALUES('project','team','api','API context',?,?)", [at, at]);
		await f.owner.run("INSERT INTO treedx_project_libraries(id,team_id,project_id,instance_id,library_id,repository_id,content_path,created_at,updated_at) VALUES('library','team','project','isolated-native-connection','library',?,'.',?,?)", [repositoryId, at, at]);
		const refs = object(await native.repositories.refs(repositoryId)).refs as Array<{ name: string; target: string }>;
		const base = refs.find(ref => ref.name === 'refs/heads/main')?.target;
		if (!base) throw new Error('Native initialized main required.');
		const workspace = object(await native.workspaces.create(repositoryId, { mode: 'writable', baseRef: base,
			branchName: 'refs/heads/knowledge/context-repair', allowedPaths: ['knowledge/**', 'agents/**', 'agent-context-queries/**', 'agent-tests/**'] }));
		workspaceId = String(workspace.workspaceId ?? ''); if (!workspaceId) throw new Error('Native workspace required.');
		const query = { id: 'context-repair', title: 'Context repair history', description: 'Read prior retained-claim repair findings.',
			revision: 1, maturity: 'validated', purpose: 'implement', query: 'retained claims',
			target: { kind: 'content', paths: ['/knowledge/context-repair.mdx'] }, depth: 0, relations: [], resultLimit: 5,
			contextBudget: { maxItems: 5 }, tokenBudget: 32, sources: [{ scope: 'current-project' }], requirement: 'required', priority: 80, summarization: 'none' };
		const check = { id: 'context-repair-check', agent: 'project/engineer', kind: 'context-query', queryRef: { id: query.id, revision: 1 },
			testRef: 'context-repair-v1', expectedIdentities: [], expectedRelations: [], expectedPaths: ['knowledge/context-repair.mdx'],
			expectedSchemaVersions: [], resultBounds: { min: 1, max: 5 }, budget: { maxContextItems: 5, maxTokens: 32 } };
		expect(validateContentFrontmatter('agent_context_query', query).ok).toBe(true);
		expect(validateContentFrontmatter('agent_test', check).ok).toBe(true);
		const write = (path: string, value: unknown, body = '') => native.files.write(workspaceId!, { path, content: `---\n${stringify(value)}---\n${body}`, encoding: 'utf8' });
		await write('agent-context-queries/context-repair.mdx', query);
		await write('agent-tests/context-repair-check.mdx', check);
		const definition = { schemaVersion: 'treeseed.agent/v1', id: 'project/engineer', name: 'Context contributor',
			agentClass: 'maintenance', purpose: 'Use relevant retained history.', responsibilities: ['Preserve existing work.'],
			capabilities: ['source.read'], context: { include: ['project-objectives'] }, contextQueryRefs: [{ id: query.id, revision: 1 }],
			activityProfiles: { acting: { handler: 'actor', prompt: { system: 'Use governed context and prior experience.' },
				permissions: { content: { read: ['knowledge'], write: [] }, tools: [] }, contextQueryRefs: [{ id: query.id, revision: 1 }] } } };
		expect(validateContentFrontmatter('agent', definition).ok).toBe(true);
		await write('agents/contributor.mdx', definition);
		const oldBody = '# Retained claims\nPreserve retained products and unknown usage.\n';
		await write('knowledge/context-repair.mdx', { id: 'context-repair', schemaVersion: 'treeseed.knowledge-page/v2' }, oldBody);
		const commit = async (message: string) => String(object(await native.files.commit(workspaceId!, { message,
			author: { name: 'Native context fixture', email: 'native@example.invalid' } })).commitSha ?? '');
		const definitionRef = await commit('Record context query and historical repair findings');
		const store = { ...f.owner, config: { TREESEED_ENVIRONMENT: 'test', TREESEED_TREEDX_URL: baseUrl },
			getProjectTreeDxLibrary: async () => ({ repositoryId, instanceId: 'isolated-native-connection', contentPath: '.', contentRepositoryRef: definitionRef }) };
		const service = new ContextQueryCheckService(store as never);
		const signal = { projectId: 'project', commitSha: definitionRef, changedPaths: ['agents/contributor.mdx'],
			changeSummary: 'Configure exact history queries.', actorType: 'user' as const };
		await projectTreeDxCommitSignals(store as never, signal);
		const checkRows = await f.owner.all('SELECT * FROM agent_context_query_checks ORDER BY id');
		expect(checkRows).toHaveLength(1);
		expect(checkRows[0]).toMatchObject({ status: 'passing', definition_commit: definitionRef });
		const classes = await f.owner.all('SELECT * FROM project_agent_classes ORDER BY id');
		expect(classes).toHaveLength(1);
		expect(JSON.parse(String(classes[0]!.handler_refs_json))).toMatchObject({ agents: [definition] });
		await projectTreeDxCommitSignals(store as never, signal);
		expect(await f.owner.all('SELECT * FROM agent_context_query_checks ORDER BY id')).toEqual(checkRows);
		// A committed native workspace is no longer writable. Later history is a
		// separate normal workspace based on the exact committed definition.
		await native.workspaces.close(workspaceId);
		expect(object(await native.workspaces.get(workspaceId)).status).toBe('closed');
		const later = object(await native.workspaces.create(repositoryId, { mode: 'writable', baseRef: definitionRef,
			branchName: 'refs/heads/knowledge/context-repair-later', allowedPaths: ['knowledge/**'] }));
		workspaceId = String(later.workspaceId ?? ''); if (!workspaceId) throw new Error('Later native workspace required.');
		const newBody = '# Retained claims\nNew repair: preserve the original deadline and usage while exposing the original recovery receipt.\n' + 'Retained product custody matters. '.repeat(200);
		await write('knowledge/context-repair.mdx', { id: 'context-repair', schemaVersion: 'treeseed.knowledge-page/v2' }, newBody);
		const dataRef = await commit('Retain later native repair history for execution');
		expect(dataRef).not.toBe(definitionRef);
		const layer = { queryRefs: [{ id: query.id, revision: query.revision }], querySetRefs: [] };
		const input = { teamId: 'team', projectId: 'project', definitionRef, dataRef, allowedModels: ['knowledge'], layers: { agent: layer, activity: layer } };
		const resolved = await service.resolveForAssignment(input);
		expect(resolved.authorizedContext.length).toBeGreaterThan(0);
		expect(resolved.references.every(ref => ref.commit === dataRef && ref.repository === repositoryId && ref.path === 'knowledge/context-repair.mdx' && ref.anchor && ref.digest)).toBe(true);
		const text = resolved.authorizedContext.map(item => String(object(object(item.value).entry).text)).join('\n');
		expect(text).toContain('New repair'); expect(text).not.toContain('Preserve retained products and unknown usage.');
		expect(text.length).toBeLessThan(newBody.length);
		expect(resolved.checks.map(value => value.layer)).toEqual(['agent', 'activity']);
		expect(resolved.checks.every(value => object(value.stats).tokens as number <= query.tokenBudget)).toBe(true);
		await expect(service.resolveForAssignment({ ...input, allowedModels: ['objective'] })).rejects.toMatchObject({ code: 'assignment_context_query_permission_denied' });
		expect(await f.owner.all('SELECT * FROM agent_context_query_checks ORDER BY id')).toEqual(checkRows);
		expect(JSON.stringify(checkRows)).not.toContain('New repair');
		await native.workspaces.close(workspaceId);
		const rejected = object(await native.workspaces.create(repositoryId, { mode: 'writable', baseRef: dataRef,
			branchName: 'refs/heads/knowledge/context-repair-rejected', allowedPaths: ['agents/**', 'agent-tests/**'] }));
		workspaceId = String(rejected.workspaceId ?? ''); if (!workspaceId) throw new Error('Rejected profile workspace required.');
		await write('agent-tests/context-repair-check.mdx', { ...check, expectedPaths: ['knowledge/missing-history.mdx'] });
		await write('agents/contributor.mdx', { ...definition, name: 'Unready context contributor' });
		const rejectedRef = await commit('Retain a failing required context check');
		await expect(projectTreeDxCommitSignals(store as never, { ...signal, commitSha: rejectedRef })).rejects.toThrow('did not pass');
		expect(await f.owner.all('SELECT * FROM project_agent_classes ORDER BY id')).toEqual(classes);
		const failed = await f.owner.all('SELECT * FROM agent_context_query_checks WHERE definition_commit=?', [rejectedRef]);
		expect(failed).toHaveLength(1); expect(failed[0]).toMatchObject({ status: 'failing', definition_commit: rejectedRef });
		expect(await f.owner.all('SELECT * FROM agent_context_query_checks WHERE definition_commit=? ORDER BY id', [definitionRef])).toEqual(checkRows);
	} finally {
		try { if (workspaceId) { await native.workspaces.close(workspaceId); expect(object(await native.workspaces.get(workspaceId)).status).toBe('closed'); } }
		finally { try { await native.repositories.retire(repositoryId); } finally { await f.db.close(); } }
	}
}, 120_000);
