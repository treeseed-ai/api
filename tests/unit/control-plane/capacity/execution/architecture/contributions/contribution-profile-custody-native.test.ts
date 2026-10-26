import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { assignmentAttemptSchema, type AgentDefinition, type ExecutionNode } from '@treeseed/sdk/agent-capacity';
import { proposalNativeFixture } from '../../../../governance/proposals/architecture/proposal-native-fixture.ts';
import { contributionBindings } from '../../../../../../../src/api/capacity/policy/execution/contribution-bindings.ts';
import { effectiveProfile } from '../../../../../../../src/api/capacity/services/build/execution-node-profile.ts';
import { assignment as original } from '../../fixtures/assignment.ts';
import { splitPostgresSqlStatements } from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';

// Original PostgreSQL DDL, committed YAML and the official HTTP reader. Supplied
// estimate facts are controlled inputs, not live agent usage or release proof.
it('resolves current contribution fingerprints through native profile custody while retaining historical estimate authority', async () => {
	vi.stubEnv('TREESEED_TREEDX_URL', ''); vi.stubEnv('TREESEED_TREEDX_BASE_URL', ''); vi.stubEnv('TREESEED_ENVIRONMENT', 'test');
	const f = await proposalNativeFixture();
	try {
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'))
			.filter(sql => sql.startsWith('CREATE TABLE "project_agent_classes" ('));
		if (ddl.length !== 1) throw new Error('Original agent-class DDL required.');
		await f.query(ddl[0]!);
		const names = ['contract-owner', 'repair-owner'];
		const profile = (name: string, version: string) => ({ handler: 'writer',
			contextQueryRefs: [{ id: `${name}-context`, revision: version === 'old' ? 1 : 2 }],
			contextQuerySetRefs: [{ id: 'portfolio-history', revision: 3 }],
			permissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read'] },
			prompt: { system: `${name} ${version} governed contribution.` } });
		const definitions = names.map(name => ({ schemaVersion: 'treeseed.agent/v1', id: `project/${name}`, name,
			agentClass: 'maintenance', purpose: 'Repair current profile custody.', responsibilities: ['Own the accepted contribution.'],
			capabilities: ['source-repair'], context: { include: ['assignment-subject'] }, groupIds: ['backend-custody'],
			contextQueryRefs: [{ id: 'portfolio/objectives', revision: 3 }],
			contextQuerySetRefs: [{ id: 'portfolio/foundation', revision: 2 }],
			activityProfiles: { estimating: profile(name, 'old'), acting: profile(name, 'current'), reviewing: profile(name, 'current') },
		} as AgentDefinition));
		let oldCommit = '';
		for (const [index, definition] of definitions.entries()) oldCommit = f.publishContent(`agents/${names[index]}.mdx`, {
			...definition, activityProfiles: { estimating: profile(names[index]!, 'old'), acting: profile(names[index]!, 'old'), reviewing: profile(names[index]!, 'old') },
		}).commit;
		let currentCommit = '';
		for (const [index, definition] of definitions.entries()) currentCommit = f.publishContent(`agents/${names[index]}.mdx`, definition as never).commit;
		await f.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,metadata_json,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?)`, ['shared-class', 'team', 'project', 'maintenance', 'Shared allocation',
			JSON.stringify({ agents: definitions }), JSON.stringify({ source: 'project-library', immutableRef: currentCommit,
				definitionPaths: names.map(name => `agents/${name}.mdx`) }), original.createdAt, original.createdAt]);
		const attempts = definitions.map((definition, index) => assignmentAttemptSchema.parse({ ...original,
			id: `estimate-${names[index]}`, agentClass: 'maintenance', sourceRef: { ...original.sourceRef, model: 'proposal', id: 'proposal' },
			effectiveProfile: { ...original.effectiveProfile, activity: 'estimating', profileRef: { store: 'treedx', model: 'agent',
				id: definition.id, repository: 'repository', commit: oldCommit, path: `agents/${names[index]}.mdx` } },
		}));
		const workItems = attempts.map((attempt, index) => ({ id: names[index]!, review: 'required',
			estimateRef: { store: 'postgresql', model: 'assignment-attempt', id: attempt.id, revision: attempt.attempt },
			reviewEstimate: { expectedSeconds: 60, maximumSeconds: 120, rationale: 'Supplied independent peer budget.' } }));
		const source = { teamId: 'team', estimatingAttempts: attempts, frontmatter: { id: 'proposal', groupIds: ['backend-custody'], executionPlan: { workItems } } };
		const profiles = Object.fromEntries(definitions.map(definition => [`project:${definition.id}`, definition]));
		const held = structuredClone({ source, profiles }), before = await f.snapshot();
		const classes = await f.store.all('SELECT * FROM project_agent_classes ORDER BY id');
		const bindings = contributionBindings(source, profiles);
		for (const [index, item] of workItems.entries()) for (const kind of ['acting', 'reviewing'] as const) {
			const bound = kind === 'acting' ? bindings.acting.get(item.id)! : bindings.reviewing.get(item.id)!.profile;
			const owner = attempts.find(attempt => attempt.effectiveProfile.profileRef.id === bound.definition.id)!;
			expect(bound.estimateAuthority.id).toBe(owner.id);
			if (kind === 'reviewing') expect(bound.definition.id).toBe(definitions[index]!.id);
			const node = { id: `${kind}-${item.id}`, projectId: 'project', kind, agentClass: 'maintenance', authorityRefs: [bound.agentReference] } as ExecutionNode;
			const resolved = await effectiveProfile(f.store, node);
			expect(resolved.profile.profileRef).toEqual({ store: 'treedx', model: 'agent', id: bound.definition.id,
				repository: 'repository', commit: currentCommit, path: `agents/${bound.definition.name}.mdx` });
			expect(resolved.profile.prompt).toEqual(bound.definition.activityProfiles[kind]!.prompt);
			expect(resolved.profile.contextQueryRefs).toEqual([...bound.definition.contextQueryRefs!, ...bound.definition.activityProfiles[kind]!.contextQueryRefs!]);
			expect(resolved.profile.contextQuerySetRefs).toEqual([...bound.definition.contextQuerySetRefs!, ...bound.definition.activityProfiles[kind]!.contextQuerySetRefs!]);
			expect(resolved.profile.permissionCeiling).toEqual(bound.definition.activityProfiles[kind]!.permissions);
			await expect(effectiveProfile(f.store, { ...node, authorityRefs: [owner.effectiveProfile.profileRef] }))
				.rejects.toMatchObject({ code: 'execution_node_agent_identity_moved' });
			for (const fault of ['moved', 'denied'] as const) {
				f.setFault(fault); await expect(effectiveProfile(f.store, node)).rejects.toThrow(); f.setFault('none');
			}
		}
		expect({ source, profiles }).toEqual(held); expect(await f.snapshot()).toEqual(before);
		expect(await f.store.all('SELECT * FROM project_agent_classes ORDER BY id')).toEqual(classes);
	} finally { await f.close(); vi.unstubAllEnvs(); }
});
