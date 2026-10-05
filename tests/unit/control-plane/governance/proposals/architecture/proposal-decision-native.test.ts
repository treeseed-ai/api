import { describe, expect, it } from 'vitest';
import { validateDecisionAuthority, validateExecutionAuthorityReceipt } from '../../../../../../src/api/governance/decision-authority.ts';
import { readyProposal } from './ready-proposal-fixture.ts';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { parseFrontmatterDocument } from '../../../../../../src/api/content/frontmatter.ts';
import { relationAuthoringDatabase, object } from '../../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { TreeDxInfrastructureClient } from '../../../../../../src/api/control-plane/treedx/infrastructure-client.ts';
import { completedGraphRefresh } from '../../../../../../src/operations-runner/knowledge/publication-executor.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import assert from 'node:assert/strict';
import { decodeExecutionNode } from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-storage.ts';
import { listReadyExecutionNodes } from '../../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import { serializeCapacityWorkdayRunRow } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import { allocateWorkdayCapacity, compileWorkday, selectFairReadyNode } from '@treeseed/sdk/agent-capacity';
import { buildAssignmentAttempt } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { provider as suppliedProvider, canonicalOfferBuildInput, signSuppliedOffer } from '../../../capacity/execution/fixtures/assignment-attempt-fixtures.ts';
import { AvailabilitySessionService } from '../../../../../../src/api/capacity/services/accounts/availability-session-service.ts';
import { resolveProviderSynthesisContext } from '../../../../../../src/api/capacity/services/capacity/providers/provider-synthesis-context-service.ts';
import { admitLivingExecutionAssignment } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';
import { leaseNextProviderAssignment } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lease-service.ts';
import { createCapacityControlPlane } from '../../../../../../src/api/capacity/control-plane.ts';
import { createWorkdayService } from '../../../../../../src/api/control-plane/repositories/capacity/workday-service.ts';
import { canonicalJson } from '../../../../../../src/api/capacity/security.ts';
import { createGovernanceService } from '../../../../../../src/api/control-plane/governance/governance-service.ts';
import { createDiscussionService } from '../../../../../../src/api/discussions/discussion-service.ts';
import { SessionEventService } from '../../../../../../src/api/realtime/session-events.ts';
describe('native proposal Decision authority', () => {
	it('original governance acceptance publishes one native classed Decision for the exact proposal and preserves that content and original history through decision creation replay', async () => {
		// Native proposal bytes and the administrative principal are INPUTS. The
		// Decision must be produced by the ORIGINAL governance method, not seeded
		// by this test. This is not authenticated operator HTTP or managed dispatch.
		for (const canonicalSupply of [false, true]) {
		const f = await relationAuthoringDatabase(true), extraWorkspaces = new Set<string>(); assert.ok(f.peerStore);
		let teamRepository: string | undefined;
		try {
			// Existing postgresGraph owns a fresh UUID database, ALL original
			// migrations, two independent pools, and its own exact cleanup.
			// The original integrated Discussion journal advances this binding via
			// its owning store method, which requires the represented instance row.
			// This is a disposable connection INPUT, not service provisioning.
			const instanceAt = new Date().toISOString();
			await f.query(`INSERT INTO treedx_instances (id,team_id,kind,provider,name,base_url,status,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,?)`, ['native-conformance', 'team', 'local', 'treedx', 'Disposable native authority fixture',
					process.env.TREEDX_BASE_URL, 'active', instanceAt, instanceAt]);
			const repository = f.sources[0]!.repository, projectId = f.sources[0]!.projectId;
			const declaration = { ...readyProposal(), id: `proposal-${randomUUID()}`, projectId };
			if (canonicalSupply) for (const workItem of declaration.executionPlan.workItems) {
				workItem.requiredCapabilities = ['treeseed.research.verification'];
				workItem.requestedPermissions.content.read.push('decision');
			}
			const originalInputs = structuredClone({ declaration, principal: f.principal, sources: f.sources });
			const path = `proposals/${declaration.id}.mdx`, raw = `---\n${stringify(declaration)}---\n`;
			const profiles = Object.values(f.profiles).filter(value => f.profiles[`${projectId}:${value.agentClass}`] === value)
				.map(value => {
					const definition = structuredClone(value);
					if (canonicalSupply) {
						definition.capabilities = ['treeseed.research.verification'];
						for (const profile of Object.values(definition.activityProfiles)) if (profile) profile.permissions.content.read.push('decision');
					}
					return definition;
				});
			const profileInputs = profiles.map(definition => ({ definition, path: `agents/${definition.agentClass}.md`,
				raw: `---\n${stringify(definition)}---\n` }));
			const profileInputsBefore = structuredClone(profileInputs);
			const refsBefore = object(await f.client.repositories.refs(repository));
			assert.ok(Array.isArray(refsBefore.refs));
			const staging = refsBefore.refs.map(object).find(ref => ref.name === 'refs/heads/staging'); expect(staging).toBeDefined(); const base = String(staging!.target ?? staging!.sha ?? ''); expect(base).toMatch(/^[a-f0-9]{40}$/u);
			const workspace = object(await f.client.workspaces.create(repository, { baseRef: base,
				branchName: `refs/heads/${declaration.id}`, mode: 'writable', allowedPaths: [path, ...profileInputs.map(profile => profile.path)] }));
			const workspaceId = String(workspace.workspaceId ?? ''); expect(workspaceId).not.toBe(''); extraWorkspaces.add(workspaceId);
			await f.client.files.write(workspaceId, { path, content: raw });
			for (const profile of profileInputs) await f.client.files.write(workspaceId, { path: profile.path, content: profile.raw });
			const committed = object(await f.client.files.commit(workspaceId, { message: 'Controlled exact proposal input for original governance',
				author: { name: 'Governance fixture', email: 'governance-fixture@example.invalid' } }));
			const commit = String(committed.commitSha ?? ''); expect(commit).toMatch(/^[a-f0-9]{40}$/u);
			await f.client.workspaces.close(workspaceId); extraWorkspaces.delete(workspaceId);
			const digest = createHash('sha256').update(raw).digest('hex');
			const proposal = await f.store.createGovernanceProposal(f.principal, { id: declaration.id, teamId: 'team', projectId,
				title: declaration.title, summary: declaration.summary, request: declaration.request,
				contentProvenance: { repositoryId: repository, contentPath: path, commitSha: commit, digest } });
			expect(proposal).toBeDefined();
			// Bind the supplied native source hash, not a fabricated accepted Decision.
			await f.query('UPDATE governance_proposals SET active_content_hash=? WHERE id=?', [digest, declaration.id]);
			await f.query('UPDATE governance_proposal_versions SET content_hash=? WHERE proposal_id=?', [digest, declaration.id]);
			const profileTime = new Date().toISOString();
			await f.query('UPDATE treedx_project_libraries SET content_repository_ref=? WHERE project_id=?', [commit, projectId]);
			for (const { definition, path: definitionPath } of profileInputs) {
				await f.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,metadata_json,created_at,updated_at)
					VALUES (?,?,?,?,?,?,?,?,?)`, [`${projectId}:${definition.agentClass}`, 'team', projectId, definition.agentClass,
						definition.name, JSON.stringify({ agents: [definition] }),
						JSON.stringify({ source: 'project-library', immutableRef: commit, definitionPaths: [definitionPath] }), profileTime, profileTime]);
			}
			// The ORIGINAL ready reader requires a Team Library binding. Allocate
			// only this native fixture repository; no existing portfolio binding.
			const teamName = `api-governance-ready-team-${randomUUID()}`;
			const teamRepo = object(object(await f.client.repositories.create({ repositoryName: teamName })).repo);
			teamRepository = String(teamRepo.repoId ?? ''); expect(teamRepository).not.toBe('');
			expect(teamRepo).toMatchObject({ repositoryName: teamName, storageKind: 'managed' }); expect(teamRepo.remoteUrl).toBeFalsy();
			const teamRefs = object(await f.client.repositories.refs(teamRepository)); assert.ok(Array.isArray(teamRefs.refs));
			const teamMain = teamRefs.refs.map(object).find(ref => ref.name === 'refs/heads/main'); assert.ok(teamMain);
			const teamCommit = String(teamMain.target ?? teamMain.sha ?? ''); expect(teamCommit).toMatch(/^[a-f0-9]{40}$/u);
			await f.query('INSERT INTO projects (id,team_id,slug,name,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
				['team-context', 'team', 'team', 'Isolated native readiness Team Library', '{}', profileTime, profileTime]);
			await f.query(`INSERT INTO treedx_project_libraries (id,team_id,project_id,instance_id,library_id,repository_id,content_path,content_repository_ref,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,?,?)`, ['team-context-binding', 'team', 'team-context', 'native-conformance', 'team-context', teamRepository, '.', teamCommit, profileTime, profileTime]);
			for (const source of f.sources) {
				const connection = await resolveKnowledgeGatewayConnection(f.store, { projectId: source.projectId, write: true }); expect(connection).not.toBeNull();
				await completedGraphRefresh(connection!.client, { repoId: source.repository, ref: 'refs/heads/staging', paths: ['notes/**'] });
			}
			const input = { status: 'approved', reason: 'Authorize the exact bounded proposal input.', expectedProposalVersion: 1 };
			if (canonicalSupply) {
				const subjectRef = { store: 'treedx', model: 'proposal', id: declaration.id, revision: 1, digest: `sha256:${digest}`, repository, commit, path };
				const question = { schemaVersion: 'treeseed.question/v1', id: `question-${declaration.id}`, projectId, subjectRef,
					question: 'Has the exact requested boundary been resolved before execution authority is issued?', status: 'open', askedAt: new Date().toISOString() };
				const questionPath = `questions/${question.id}.mdx`, questionRaw = `---\n${stringify(question)}---\n`;
				expect(validatePortableContentData('question', question).ok).toBe(true);
				const created = object(await f.client.workspaces.create(repository, { baseRef: commit,
					branchName: `refs/heads/${question.id}`, mode: 'writable', allowedPaths: [questionPath] }));
				const questionWorkspace = String(created.workspaceId ?? ''); expect(questionWorkspace).not.toBe(''); extraWorkspaces.add(questionWorkspace);
				await f.client.files.write(questionWorkspace, { path: questionPath, content: questionRaw });
				const committedQuestion = object(await f.client.files.commit(questionWorkspace, { message: 'Native unresolved exact proposal question',
					author: { name: 'Governance fixture', email: 'governance-fixture@example.invalid' } }));
				const questionCommit = String(committedQuestion.commitSha ?? ''); expect(questionCommit).toMatch(/^[a-f0-9]{40}$/u);
				await f.client.workspaces.close(questionWorkspace); extraWorkspaces.delete(questionWorkspace);
				const questionRef = { store: 'treedx', model: 'question', id: question.id, revision: 1,
					digest: `sha256:${createHash('sha256').update(questionRaw).digest('hex')}`, repository, commit: questionCommit, path: questionPath };
				const feedback = await f.store.recordGovernanceEvent({ eventType: 'proposal.discussion', actorType: 'user', actorId: 'independent-input-author',
					teamId: 'team', projectId, proposalId: declaration.id, proposalVersion: 1, message: question.question,
					evidence: { kind: 'question', questionRef, contentPath: questionPath, commitSha: questionCommit, digest: questionRef.digest, proposalVersion: 1 } });
				const readiness = await f.store.governanceProposalReadiness(declaration.id); expect(readiness).toMatchObject({ votingReady: false, executionPlanReady: true, unresolvedBlockerCount: 1 }); expect(readiness!.missingVoting).toContain('resolved blocking questions and concerns');
				const blocked = await f.snapshot(), blockedEvents = await f.store.all('SELECT * FROM governance_events ORDER BY id');
				const blockedService = createGovernanceService(f.store, createDiscussionService({ store: f.store, capacity: f.store, sessionEvents: new SessionEventService(f.store) }));
				await expect(blockedService.evaluate(f.principal, projectId, declaration.id, { expectedProposalVersion: 1 }, '1')).rejects.toMatchObject({ status: 409, code: 'governance_proposal_not_ready' }); expect(await f.snapshot()).toEqual(blocked); expect(await f.store.all('SELECT * FROM governance_events ORDER BY id')).toEqual(blockedEvents);
				await expect(f.store.adminDecideGovernanceProposal(f.principal, declaration.id, input))
					.rejects.toMatchObject({ status: 409, code: 'governance_proposal_not_ready' });
				expect(await f.snapshot()).toEqual(blocked); expect(await f.store.all('SELECT * FROM governance_events ORDER BY id')).toEqual(blockedEvents);
				const nativeQuestion = new TreeDxInfrastructureClient(f.client);
				const readQuestion = object(await nativeQuestion.readRepositoryFile({ repoId: repository, ref: questionCommit, path: questionPath, encoding: 'utf8', parseFrontmatter: false })); expect(readQuestion.resolvedRef).toBe(questionCommit); expect(object(readQuestion.file).content).toBe(questionRaw);
				const discussions = createDiscussionService({ store: f.store, capacity: f.store, sessionEvents: new SessionEventService(f.store) });
				const service = createGovernanceService(f.store, discussions), resolutionInput = { expectedProposalVersion: 1,
					message: 'The supplied exact boundary question has been reviewed and resolved; retain its original native bytes and history.' };
				const resolution = await service.resolveProposalFeedback(f.principal, projectId, declaration.id, String(feedback.id), resolutionInput, '1'); expect(resolution.idempotentReplay).toBe(false); expect(resolution.readiness).toMatchObject({ votingReady: true, unresolvedBlockerCount: 0 });
				const resolvedEvents = await f.store.all('SELECT * FROM governance_events ORDER BY id'), resolvedSnapshot = await f.snapshot();
				const retry = await service.resolveProposalFeedback(f.principal, projectId, declaration.id, String(feedback.id), resolutionInput, '1');
				expect(retry.idempotentReplay).toBe(true); expect(retry.resolution).toEqual(resolution.resolution); expect(await f.store.all('SELECT * FROM governance_events ORDER BY id')).toEqual(resolvedEvents); expect(await f.snapshot()).toEqual(resolvedSnapshot);
				expect(resolvedEvents.filter(event => event.id === feedback.id)).toEqual(blockedEvents.filter(event => event.id === feedback.id));
				expect(object((await nativeQuestion.readRepositoryFile({ repoId: repository, ref: questionCommit, path: questionPath, encoding: 'utf8', parseFrontmatter: false })).file).content).toBe(questionRaw);
				// Native Question and original Discussion/Governance publication, not
				// a genuine Researcher finding or external authenticated decision-maker.
			}
			const originalInput = structuredClone(input), before = await f.snapshot();
			let interruptedDecision: Record<string, unknown> | undefined, interruptedRefs: Record<string, unknown> | undefined;
			if (!canonicalSupply) {
				await f.db.exec(`CREATE FUNCTION reject_decision_created() RETURNS trigger AS $$ BEGIN
					IF NEW.event_type='decision.created' THEN RAISE EXCEPTION 'controlled Decision projection interruption'; END IF;
					RETURN NEW; END; $$ LANGUAGE plpgsql;
					CREATE TRIGGER reject_decision_created BEFORE INSERT ON governance_events FOR EACH ROW EXECUTE FUNCTION reject_decision_created();`);
				await expect(f.store.adminDecideGovernanceProposal(f.principal, declaration.id, input)).rejects.toThrow('controlled Decision projection interruption');
				const retained = await f.store.all('SELECT * FROM governance_decisions ORDER BY id'); expect(retained).toHaveLength(1);
				interruptedDecision = retained[0]!; expect(interruptedDecision.status).toBe('creating');
				expect((await f.store.getGovernanceProposal(declaration.id)).decisionId).toBeNull(); expect((await f.store.all('SELECT * FROM governance_events ORDER BY id')).filter(event => event.event_type === 'decision.created')).toEqual([]);
				interruptedRefs = object(await f.client.repositories.refs(repository));
				await f.db.exec('DROP TRIGGER reject_decision_created ON governance_events; DROP FUNCTION reject_decision_created();');
				// Retry two real owning calls against the retained native publication.
				// Each original store uses a different native PostgreSQL pool.
				for (const result of await Promise.all([f.store.createGovernanceDecisionFromProposal(declaration.id, { actorType: 'user', actorId: f.principal.id }),
					f.peerStore.createGovernanceDecisionFromProposal(declaration.id, { actorType: 'user', actorId: f.principal.id })])) expect(result.id).toBe(interruptedDecision.id);
			}
			const accepted = await f.store.adminDecideGovernanceProposal(f.principal, declaration.id, input);
			const receivedAt = Date.now();
			expect(accepted).toMatchObject({ status: 'accepted', id: declaration.id });
			const decisionId = String(accepted.decisionId ?? ''); expect(decisionId).not.toBe('');
			const decision = await f.store.getGovernanceDecision(decisionId); expect(decision).toMatchObject({ status: 'accepted', proposalId: declaration.id, proposalVersion: 1, proposalContentHash: digest });
			if (interruptedDecision) {
				expect(decision.id).toBe(interruptedDecision.id); expect(decision.createdAt).toBe(interruptedDecision.created_at); expect(object(await f.client.repositories.refs(repository))).toEqual(interruptedRefs);
			}
			const proposalRef = { store: 'treedx', model: 'proposal', id: declaration.id, revision: 1, digest: `sha256:${digest}`,
				repository, commit, path };
			expect(decision.decisionRecord.proposalRef).toEqual(proposalRef);
			const workspaceJournal = (await f.store.all('SELECT * FROM treedx_project_proxy_audit ORDER BY id'))
				.filter(entry => object(JSON.parse(String(entry.metadata_json))).operationKey === `decision:${decisionId}`);
			const openedWorkspaces = workspaceJournal.filter(entry => entry.result_status === 'authoring_workspace_open'); expect(openedWorkspaces.length).toBeGreaterThan(0);
			for (const opened of openedWorkspaces) {
				const workspaceIdentity = object(JSON.parse(String(opened.metadata_json))).workspaceId; expect(typeof workspaceIdentity).toBe('string');
				expect(workspaceJournal.filter(entry => entry.result_status === 'authoring_workspace_closed'
					&& object(JSON.parse(String(entry.metadata_json))).workspaceId === workspaceIdentity)).toHaveLength(1);
				// Native close retains its immutable public metadata; it is not a
				// catalog deletion or independent physical sandbox teardown proof.
				expect(await f.client.workspaces.get(String(workspaceIdentity))).toMatchObject({ workspaceId: workspaceIdentity, repoId: repository, status: 'closed' });
			}
			const native = new TreeDxInfrastructureClient(f.client), contents = new Map<string, { commit: string; path: string; raw: string }>();
			const readDecisions = async () => {
				const refs = object(await f.client.repositories.refs(repository)); assert.ok(Array.isArray(refs.refs));
				for (const ref of refs.refs.map(object)) {
					const pinned = String(ref.target ?? ref.sha ?? ''); expect(pinned).toMatch(/^[a-f0-9]{40}$/u);
					const listed = object(await native.listRepositoryPaths({ repoId: repository, ref: pinned,
						paths: ['decisions/**'], extensions: ['.md', '.mdx'], limit: 500, allowProtected: true }));
					expect(listed.resolvedRef).toBe(pinned); assert.ok(Array.isArray(listed.entries)); expect(object(listed.page).hasMore).toBe(false);
					for (const entry of listed.entries.map(object)) {
						const decisionPath = String(entry.path ?? ''); expect(decisionPath).toMatch(/^decisions\//u);
						const read = object(await native.readRepositoryFile({ repoId: repository, ref: pinned,
							path: decisionPath, encoding: 'utf8', parseFrontmatter: false, allowProtected: true }));
						expect(read.resolvedRef).toBe(pinned); const file = object(read.file); expect(file.path).toBe(decisionPath); expect(typeof file.content).toBe('string'); if (typeof file.content !== 'string') throw new Error('Native Decision bytes missing');
						const parsed = parseFrontmatterDocument(file.content);
						if (parsed.frontmatter.id !== decisionId) continue;
						const validated = validatePortableContentData('decision', parsed.frontmatter);
						expect(validated.ok).toBe(true); expect(validated.data).toMatchObject({ id: decisionId, projectId,
							decisionClass: 'proposal', disposition: 'approved', decisionMethod: 'authority', subjectRef: proposalRef });
						const definition = object(validated.data); assert.ok(Array.isArray(definition.decidedByRefs));
						expect(definition.decidedByRefs.map(object)).toContainEqual(expect.objectContaining({ model: 'user', id: f.principal.id })); expect(Date.parse(String(definition.decidedAt))).toBeGreaterThanOrEqual(Date.parse(proposal.createdAt));
						expect(Date.parse(String(definition.decidedAt))).toBeLessThanOrEqual(receivedAt);
						const key = `${decisionPath}:${createHash('sha256').update(file.content).digest('hex')}`;
						contents.set(key, { commit: pinned, path: decisionPath, raw: file.content });
					}
				}
				return contents;
			};
			await readDecisions(); expect(contents.size).toBe(1);
			const retainedContent = [...contents.values()][0]!;
			const projected = (await f.store.all('SELECT * FROM execution_nodes WHERE team_id=? ORDER BY id', ['team']))
				.map(decodeExecutionNode).filter(node => node.sourceRef.id === declaration.id);
			expect(projected.filter(node => node.pairRole === 'actor')).toHaveLength(1); expect(projected.filter(node => node.pairRole === 'reviewer')).toHaveLength(1);
			for (const node of projected.filter(value => value.pairRole !== null)) {
				expect(node.sourceRef).toEqual(proposalRef);
				const authorities = node.authorityRefs.filter(ref => ref.model === 'decision'); expect(authorities).toHaveLength(1);
				const authority = authorities[0]!;
				expect(authority).toMatchObject({ store: 'treedx', model: 'decision', id: decisionId, repository,
					path: retainedContent.path, digest: `sha256:${createHash('sha256').update(retainedContent.raw).digest('hex')}` });
				expect(authority.commit).toMatch(/^[a-f0-9]{40}$/u);
				const read = object(await native.readRepositoryFile({ repoId: repository, ref: authority.commit,
					path: authority.path, encoding: 'utf8', parseFrontmatter: false }));
				expect(read.resolvedRef).toBe(authority.commit); expect(object(read.file).content).toBe(retainedContent.raw);
			}
			const content = structuredClone([...contents]), refsAccepted = object(await f.client.repositories.refs(repository));
			assert.ok(Array.isArray(refsAccepted.refs));
			expect(refsAccepted.refs.map(object).filter(ref => ref.name === 'refs/heads/main'))
				.toEqual(refsBefore.refs.map(object).filter(ref => ref.name === 'refs/heads/main'));
			const history = await f.store.all('SELECT * FROM governance_events ORDER BY id'); expect(history.filter(event => event.event_type === 'decision.created' && event.decision_id === decisionId)).toHaveLength(1);
			const rows = await f.store.all('SELECT * FROM governance_decisions ORDER BY id'); expect(rows).toHaveLength(1);
			expect(await f.peerStore.all('SELECT * FROM governance_events ORDER BY id')).toEqual(history); expect(await f.peerStore.all('SELECT * FROM governance_decisions ORDER BY id')).toEqual(rows);
			const graph = { nodes: await f.store.all('SELECT * FROM execution_nodes ORDER BY id'),
				edges: await f.store.all('SELECT * FROM execution_edges ORDER BY id'),
				revisions: await f.store.all('SELECT * FROM execution_graph_revisions ORDER BY team_id,revision') };
			// The original scheduling authority consumer must read the actual
			// governance-produced Decision, not a seeded accepted substitute.
			const expectedAuthority = { teamId: 'team', projectId, decisionId, proposalId: declaration.id,
				proposalVersion: 1, proposalContentHash: digest, decisionDependencies: [],
				proposalRef: { id: declaration.id, revision: 1, digest: `sha256:${digest}`, repository, commit, path } };
			const authorityInput = { teamId: 'team', projectId, decisionId, proposalId: declaration.id,
				proposalVersion: 1, proposalContentHash: digest, decisionDependencies: [] };
			const authorityBefore = structuredClone(authorityInput);
			for (const validation of await Promise.all([
				validateDecisionAuthority(f.store, decisionId, { teamId: 'team', projectId }),
				validateExecutionAuthorityReceipt(f.store, authorityInput),
				validateExecutionAuthorityReceipt(f.store, structuredClone(authorityInput)),
			])) expect(validation).toEqual({ valid: true, code: null, message: null, current: expectedAuthority });
			expect(authorityInput).toEqual(authorityBefore);
			// Run selection is a supplied reader INPUT, not native Workday start,
			// provider authentication, admission, claiming or productive execution.
			const run = serializeCapacityWorkdayRunRow({ id: `ready-${declaration.id}`, team_id: 'team', scenario_id: 'native-governance-ready',
				status: 'running', environment: 'local', execution_kind: 'workday', trigger_kind: 'manual', execution_mode: 'simulation',
				created_at: profileTime, updated_at: profileTime, started_at: profileTime,
				parameters_json: JSON.stringify({ proposalIds: [declaration.id], decisionIds: [decisionId] }),
				summary_json: '{}', metrics_json: '{}', expected_json: '{}', actual_json: '{}', report_refs_json: '{}', error_json: '{}' });
			assert.ok(run); const runBefore = structuredClone(run), readyProject = { id: projectId, slug: projectId };
			const readerState = async () => ({ fixture: await f.snapshot(),
				assignments: await f.store.all('SELECT * FROM capacity_provider_assignments ORDER BY id'),
				reservations: await f.store.all('SELECT * FROM capacity_reservations ORDER BY id'),
				usage: await f.store.all('SELECT * FROM capacity_usage_actuals ORDER BY id'),
				classes: await f.store.all('SELECT * FROM project_agent_classes ORDER BY id'),
				bindings: await f.store.all('SELECT * FROM treedx_project_libraries ORDER BY id') });
			const readerBefore = await readerState();
			const currentBinding = readerBefore.bindings.find(binding => binding.project_id === projectId); assert.ok(currentBinding);
			const projectContextCommit = String(currentBinding.content_repository_ref); expect(projectContextCommit).toMatch(/^[a-f0-9]{40}$/u);
			expect(readerBefore.assignments).toEqual([]); expect(readerBefore.reservations).toEqual([]); expect(readerBefore.usage).toEqual([]);
			const actorNode = projected.find(node => node.pairRole === 'actor'); assert.ok(actorNode); expect(actorNode.status).toBe('ready');
			const actorRow = graph.nodes.find(row => row.id === actorNode.id); assert.ok(actorRow); assert.equal(typeof actorRow.updated_at, 'string');
			const actorProfile = profileInputs.find(profile => profile.definition.agentClass === actorNode.agentClass); assert.ok(actorProfile);
			const selectedProfile = actorProfile.definition.activityProfiles.acting; assert.ok(selectedProfile);
			const currentRevision = Math.max(...graph.revisions.map(revision => Number(revision.revision)));
			const expectedReady = [{ node: actorNode, graphRevision: currentRevision,
				projectAgentClassId: `${projectId}:${actorNode.agentClass}`, projectContentRepositoryId: repository,
				effectiveProfile: { handler: selectedProfile.handler, prompt: selectedProfile.prompt,
					...(selectedProfile.additionalContext ? { additionalContext: selectedProfile.additionalContext } : {}),
					...(selectedProfile.parameters ? { parameters: selectedProfile.parameters } : {}),
					profileRef: { store: 'treedx', model: 'agent', id: actorProfile.definition.id, repository, commit, path: actorProfile.path },
					activity: 'acting', handlerOrigin: selectedProfile.handler.includes('/') ? 'project-runtime' : 'agent-package', permissionCeiling: selectedProfile.permissions },
				sourceRepositories: [], predecessorResults: [], readyAt: actorRow.updated_at,
				contextRefs: [proposalRef, ...actorNode.authorityRefs,
					{ store: 'treedx', model: 'knowledge', id: 'team-context:team-readme', repository: teamRepository, commit: teamCommit, path: 'README.md' },
					{ store: 'treedx', model: 'objective', id: 'team-context:team-objective', repository: teamRepository, commit: teamCommit, path: 'objectives/core' },
					{ store: 'treedx', model: 'objective', id: `${projectId}:project-objective`, repository, commit: projectContextCommit, path: 'objectives/core' }] }];
			for (const selected of await Promise.all([listReadyExecutionNodes(f.store, run, readyProject),
				listReadyExecutionNodes(f.store, structuredClone(run), readyProject)])) expect(selected).toEqual(expectedReady);
			for (const parameters of [{ ...run.parameters, decisionIds: [`missing-${decisionId}`] },
				{ ...run.parameters, proposalIds: [`missing-${declaration.id}`] }]) {
				const deniedRun = { ...run, parameters }, deniedBefore = structuredClone(deniedRun); expect(await listReadyExecutionNodes(f.store, deniedRun, readyProject)).toEqual([]); expect(deniedRun).toEqual(deniedBefore); expect(await readerState()).toEqual(readerBefore);
			}
			expect(await listReadyExecutionNodes(f.store, run, readyProject)).toEqual(expectedReady); expect(run).toEqual(runBefore); expect(await readerState()).toEqual(readerBefore);
			for (const profile of profileInputs) {
				const read = object(await native.readRepositoryFile({ repoId: repository, ref: commit, path: profile.path, encoding: 'utf8', parseFrontmatter: false })); expect(read.resolvedRef).toBe(commit); expect(object(read.file)).toMatchObject({ path: profile.path, content: profile.raw });
			}
			expect(profileInputs).toEqual(profileInputsBefore); expect(object(await f.client.repositories.refs(teamRepository))).toEqual(teamRefs); expect(await f.store.all('SELECT * FROM governance_events ORDER BY id')).toEqual(history);
			expect(await f.store.all('SELECT * FROM governance_decisions ORDER BY id')).toEqual(rows);
			expect({ nodes: await f.store.all('SELECT * FROM execution_nodes ORDER BY id'),
				edges: await f.store.all('SELECT * FROM execution_edges ORDER BY id'),
				revisions: await f.store.all('SELECT * FROM execution_graph_revisions ORDER BY team_id,revision') }).toEqual(graph);
			expect(object(await f.client.repositories.refs(repository))).toEqual(refsAccepted);
			for (let retry = 0; retry < 2; retry++) expect(await f.store.createGovernanceDecisionFromProposal(declaration.id,
				{ actorType: 'user', actorId: f.principal.id })).toEqual(decision);
			expect(await f.store.all('SELECT * FROM governance_events ORDER BY id')).toEqual(history); expect(await f.store.all('SELECT * FROM governance_decisions ORDER BY id')).toEqual(rows);
			expect({ nodes: await f.store.all('SELECT * FROM execution_nodes ORDER BY id'),
				edges: await f.store.all('SELECT * FROM execution_edges ORDER BY id'),
				revisions: await f.store.all('SELECT * FROM execution_graph_revisions ORDER BY team_id,revision') }).toEqual(graph);
			expect(object(await f.client.repositories.refs(repository))).toEqual(refsAccepted);
			contents.clear(); await readDecisions(); expect([...contents]).toEqual(content);
			const sourceRead = object(await native.readRepositoryFile({ repoId: repository, ref: commit, path, parseFrontmatter: false })); expect(sourceRead.resolvedRef).toBe(commit); expect(object(sourceRead.file).content).toBe(raw); expect((await f.snapshot()).ledger).toEqual(before.ledger);
			expect({ declaration, principal: f.principal, sources: f.sources }).toEqual(originalInputs); expect(input).toEqual(originalInput);
			// The legacy partial offer is deliberately INVALID supply, not an
			// attestation or a native registered provider. Do not use its absence
			// of qualification fields to manufacture a positive admission proof.
			const readyNodes = await listReadyExecutionNodes(f.store, run, readyProject); expect(readyNodes).toHaveLength(1);
			const selectedReady = readyNodes[0]!, compileNow = new Date().toISOString();
			const plan = { ...compileWorkday({ id: run.id, teamId: 'team', policyId: 'default', policyRevision: 1,
				executionMode: 'simulation', startsAt: new Date(Date.parse(compileNow) - 20_000).toISOString(), agentIds: [],
				policy: { durationSeconds: 60, planningPercent: 20, maximumConcurrency: 1, communicationConcurrency: 1 } }), state: 'active' as const };
			const opportunity = allocateWorkdayCapacity({ now: compileNow, remainingSeconds: 9,
				workdays: [{ plan, committedSeconds: 0, planningCommittedSeconds: 0, maximumAdditionalSeconds: 9, actingReady: true }] })[plan.id]; assert.ok(opportunity);
			const buildInput: Parameters<typeof buildAssignmentAttempt>[0] = { candidate: selectedReady,
				run: { ...run, parameters: { ...run.parameters, appliedPlan: plan } },
				principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership' }, providerSessionId: 'session',
				providers: [], allocationInputs: { [suppliedProvider.id]: { measurements: [], constraints: [], opportunity } }, attempt: 1, now: compileNow };
			const observation = { day: compileNow.slice(0, 10), observedAt: compileNow, healthy: true, activeSeconds: 0, reservedSeconds: 0 };
			Object.assign(buildInput, { providers: [{ ...suppliedProvider, capabilities: ['verification'],
				accountingLimits: { modelConfigurationId: suppliedProvider.accountingLimits.modelConfigurationId, dailyActiveSecondsLimit: 10,
					capabilityLimits: { verification: { dailyActiveSecondsLimit: 10, maximumAssignmentSeconds: 3 } } },
				accountingObservation: { modelUsage: observation, capabilityUsage: { verification: observation } },
				lanes: [{ ...suppliedProvider.lanes[0]!, purpose: 'workday', capabilities: ['verification'] }],
				offers: [{ offerId: 'invalid-partial-governance-offer', capabilities: [{ id: 'verification' }] }] }] });
			const buildBefore = structuredClone(buildInput);
			for (const supplied of [buildInput, structuredClone(buildInput)]) {
				expect(() => buildAssignmentAttempt(supplied)).toThrow(expect.objectContaining({ code: 'capacity_execution_provider_unavailable', status: 409 })); expect(supplied).toEqual(buildBefore); expect(await readerState()).toEqual(readerBefore);
			}
			if (canonicalSupply) {
				const supply = canonicalOfferBuildInput(compileNow, 'treeseed.research.verification');
				const qualifiedInput = { ...buildInput, providers: supply.providers }, qualifiedBefore = structuredClone(qualifiedInput);
				const frozen = buildAssignmentAttempt(qualifiedInput), attempt = frozen.assignment;
				expect(attempt.sourceRef).toEqual(proposalRef); expect(attempt.authorityRefs).toEqual(actorNode.authorityRefs); expect(attempt.effectiveProfile).toEqual(selectedReady.effectiveProfile);
				expect(attempt.graphRevision).toBe(currentRevision); expect(attempt.nodeId).toBe(actorNode.id); expect(attempt.nodeRevision).toBe(actorNode.nodeRevision); expect(attempt.projectId).toBe(projectId);
				expect(attempt.requiredCapabilities).toEqual(['treeseed.research.verification']);
				expect(attempt.provider).toEqual({ providerId: 'provider', executionProviderId: 'codex', offerId: 'canonical-code-change',
					modelConfigurationId: 'terra-medium', executionCapabilityId: 'treeseed.research.verification', offerRevision: 1, runtimeBuild: suppliedProvider.runtimeBuild });
				expect(attempt.grant.contentRead).toContainEqual(proposalRef);
				for (const authority of actorNode.authorityRefs) expect(attempt.grant.contentRead).toContainEqual(authority);
				expect(attempt.grant.contentWrite).toEqual([]); expect(attempt.grant.sourceWrite).toEqual([]); expect(attempt.workspace).toEqual({ mode: 'read-only' }); expect(attempt.predecessorResultIds).toEqual([]);
				expect(attempt.createdAt).toBe(compileNow); expect(attempt.limits.maximumSeconds).toBe(3); expect(attempt.deadline).toBe(plan.endsAt);
				for (let retry = 0; retry < 2; retry++) expect(buildAssignmentAttempt(structuredClone(qualifiedInput))).toEqual(frozen);
				expect(qualifiedInput).toEqual(qualifiedBefore); expect(await readerState()).toEqual(readerBefore);
				// Genuine native Decision and exact native profiles reach the original
				// compiler. Offer qualification remains supplied input; this creates
				// no native enrolled provider, reservation, claim or managed execution.
			}
			expect(await listReadyExecutionNodes(f.store, run, readyProject)).toEqual(expectedReady); expect(await f.store.all('SELECT * FROM governance_events ORDER BY id')).toEqual(history);
			expect(await f.store.all('SELECT * FROM governance_decisions ORDER BY id')).toEqual(rows);
			expect({ nodes: await f.store.all('SELECT * FROM execution_nodes ORDER BY id'),
				edges: await f.store.all('SELECT * FROM execution_edges ORDER BY id'),
				revisions: await f.store.all('SELECT * FROM execution_graph_revisions ORDER BY team_id,revision') }).toEqual(graph);
			expect(object(await f.client.repositories.refs(repository))).toEqual(refsAccepted);
			// Consume the SAME genuinely produced Decision through the original
			// public Workday preflight. Provider membership is a supplied FK input,
			// not authenticated enrollment or qualified native execution supply.
			const providerId = `preflight-provider-${randomUUID()}`, membershipId = `membership-${randomUUID()}`;
			const registeredKey = generateKeyPairSync('ed25519').privateKey;
			const publicJwk = signSuppliedOffer(canonicalOfferBuildInput(new Date().toISOString()).providers[0]!.offers[0]!, registeredKey).publicJwk;
			const suppliedAt = new Date().toISOString();
			await f.query('INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)',
				[providerId, createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex'), JSON.stringify(publicJwk), 'Isolated preflight FK input', suppliedAt, suppliedAt]);
			await f.query('INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
				[membershipId, 'team', providerId, suppliedAt, f.principal.id, suppliedAt, suppliedAt]);
			const preflightBefore = await readerState(), originalReceipts = await f.store.all('SELECT * FROM capacity_operation_receipts ORDER BY id');
			const capacity = createCapacityControlPlane(f.store), service = createWorkdayService(capacity);
			const intent = { schemaVersion: 'treeseed.workday-intent/v1', teamId: 'team', profileId: 'default', projects: [projectId],
				executionMode: 'production', startsAt: suppliedAt, durationSeconds: 60, planningOnly: false, decisionIds: [decisionId],
				operatorConstraints: { providerIds: [providerId], maxConcurrency: 1 } };
			const intentBefore = structuredClone(intent), receipt = await service.preflight(f.principal, 'team', intent);
			expect(receipt.selectedDemands).toEqual([expect.objectContaining({ sourceType: 'execution-node', sourceId: actorNode.id,
				projectId, mode: 'acting', actingAuthority: { decisionId, decisionRevision: actorNode.authorityRefs.find(ref => ref.model === 'decision')!.revision,
					executionNodeId: actorNode.id, executionNodeRevision: actorNode.nodeRevision, graphRevision: currentRevision, sourceDigest: actorNode.sourceRef.digest } })]);
			const storedRows = await f.store.all('SELECT * FROM capacity_operation_receipts WHERE resource_type=? AND resource_id=?', ['workday_preflight', receipt.id]);
			expect(storedRows).toHaveLength(1); const persisted = object(JSON.parse(String(storedRows[0]!.response_json))); expect(persisted.receipt).toEqual(receipt); expect(persisted.intent).toEqual(intent);
			expect(object(object(persisted.runInput).parameters).decisionIds).toEqual([decisionId]);
			const hash = (value: unknown) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('base64url')}`;
			expect(receipt.intentDigest).toBe(hash(intent)); expect(storedRows[0]!.request_digest).toBe(receipt.intentDigest); expect(receipt.demandSetDigest).toBe(hash({ selectedDemands: receipt.selectedDemands, objectives: [], proposalIds: [], decisionIds: [decisionId] }));
			const { preflightDigest, ...payload } = receipt; expect(preflightDigest).toBe(hash(payload));
			expect(await readerState()).toEqual(preflightBefore); expect(await f.store.all('SELECT * FROM capacity_operation_receipts WHERE resource_id<>? ORDER BY id', [receipt.id])).toEqual(originalReceipts);
			expect(intent).toEqual(intentBefore); expect(await listReadyExecutionNodes(f.store, run, readyProject)).toEqual(expectedReady); expect(await f.store.all('SELECT * FROM governance_events ORDER BY id')).toEqual(history);
			expect(await f.store.all('SELECT * FROM governance_decisions ORDER BY id')).toEqual(rows);
			const exactContent = object(await native.readRepositoryFile({ repoId: repository, ref: retainedContent.commit,
				path: retainedContent.path, encoding: 'utf8', parseFrontmatter: false, allowProtected: true }));
			expect(exactContent.resolvedRef).toBe(retainedContent.commit); expect(object(exactContent.file).content).toBe(retainedContent.raw);
			const allReceipts = await f.store.all('SELECT * FROM capacity_operation_receipts ORDER BY id');
			const incomplete = { ...intent, decisionIds: [decisionId, `missing-${randomUUID()}`] }, incompleteBefore = structuredClone(incomplete);
			await expect(service.preflight(f.principal, 'team', incomplete)).rejects.toMatchObject({ status: 409, code: 'governance_decision_missing' });
			expect(incomplete).toEqual(incompleteBefore); expect(await readerState()).toEqual(preflightBefore); expect(await f.store.all('SELECT * FROM capacity_operation_receipts ORDER BY id')).toEqual(allReceipts);
			expect(await f.store.all('SELECT * FROM governance_events ORDER BY id')).toEqual(history); expect(await f.store.all('SELECT * FROM governance_decisions ORDER BY id')).toEqual(rows);
			if (canonicalSupply) {
				// Same actual governed Decision and native profile, now consumed by
				// owning availability, compiler and transactional admission. Workday
				// policy and approved provider enrollment remain explicit INPUTS.
				const supply = canonicalOfferBuildInput(new Date().toISOString(), 'treeseed.research.verification'), adapter = supply.providers[0]!;
				const unsigned = structuredClone(adapter.offers[0]!); unsigned.conformance[0]!.providerId = providerId;
				const signed = signSuppliedOffer(unsigned, registeredKey), principal = { teamId: 'team', capacityProviderId: providerId, membershipId };
				const publication = { adapters: [{ id: adapter.id, runtimeBuild: adapter.runtimeBuild, offers: [signed.offer], capabilities: adapter.capabilities,
					status: 'available', maxConcurrentWorkers: 1, activeWorkers: 0, laneIds: ['communication', 'platform', 'workday'],
					nativeLimits: adapter.accountingLimits, accountingObservation: adapter.accountingObservation }],
					lanes: ['communication', 'platform', 'workday'].map(purpose => ({ id: purpose, purpose, priority: 1,
						maxConcurrentWorkers: 1, capabilities: adapter.capabilities })) };
				const publicationBefore = structuredClone(publication), availability = new AvailabilitySessionService(capacity),
					opened = await availability.open(principal, publication); assert.ok(opened);
				const admittedAt = new Date().toISOString(), activePlan = { ...compileWorkday({ id: run.id, teamId: 'team',
					policyId: 'default', policyRevision: 1, executionMode: 'simulation', startsAt: new Date(Date.parse(admittedAt) - 20_000).toISOString(),
					agentIds: [], policy: { durationSeconds: 60, planningPercent: 20, maximumConcurrency: 1, communicationConcurrency: 1 } }), state: 'active' as const };
				await f.query(`INSERT INTO capacity_workday_runs (id,team_id,capacity_provider_id,scenario_id,status,environment,execution_kind,
					trigger_kind,execution_mode,parameters_json,started_at,created_at,updated_at) VALUES (?,?,?,'native-governed-admission','running','local','workday','manual','simulation',?,?,?,?)`,
					[run.id, 'team', providerId, JSON.stringify({ ...run.parameters, scheduledProjectIds: [projectId], appliedPlan: activePlan }),
						activePlan.startsAt, admittedAt, admittedAt]);
				const context = await resolveProviderSynthesisContext(capacity, principal, { sessionId: opened.id, now: admittedAt }); expect(context.executionProviders).toHaveLength(1); expect(context.executionProviders[0]!.offers).toEqual([signed.offer]);
				const opportunity = allocateWorkdayCapacity({ now: admittedAt, remainingSeconds: 9,
					workdays: [{ plan: activePlan, committedSeconds: 0, planningCommittedSeconds: 0, maximumAdditionalSeconds: 9, actingReady: true }] })[run.id]; assert.ok(opportunity);
				const compilerInput = { ...buildInput, principal, providerSessionId: opened.id, providers: context.executionProviders, now: admittedAt,
					run: { ...run, parameters: { ...run.parameters, scheduledProjectIds: [projectId], appliedPlan: activePlan } },
					allocationInputs: { [adapter.id]: { measurements: [], constraints: [], opportunity } } };
				const compilerBefore = structuredClone(compilerInput), frozen = buildAssignmentAttempt(compilerInput), attempt = frozen.assignment;
				expect(attempt.sourceRef).toEqual(proposalRef); expect(attempt.authorityRefs).toEqual(actorNode.authorityRefs); expect(attempt.effectiveProfile).toEqual(selectedReady.effectiveProfile); expect(attempt.provider.providerId).toBe(providerId);
				expect(attempt.limits.maximumSeconds).toBe(3); expect(attempt.deadline).toBe(activePlan.endsAt);
				const admission = { ...frozen, principal, projectAgentClassId: selectedReady.projectAgentClassId, providerSessionId: opened.id,
					allocation: { ...frozen.allocation, opportunity, selection: selectFairReadyNode([{ id: actorNode.id, projectId,
						agentClass: actorNode.agentClass, readyAt: selectedReady.readyAt }], [], activePlan.policySnapshot) },
					executionKind: 'workday' as const, workdayConcurrencyLimit: 1, predecessorResults: selectedReady.predecessorResults,
					treedxProxyHandle: { id: `native-proxy-${attempt.id}`, repositoryId: repository, expiresAt: attempt.deadline,
						allowedReadPaths: attempt.grant.contentRead.flatMap(ref => ref.path ? [ref.path] : []), allowedWritePaths: [] }, now: admittedAt };
				const admissionBefore = structuredClone(admission); expect(Date.now()).toBeLessThan(Date.parse(attempt.deadline));
				const admitted = await admitLivingExecutionAssignment(capacity, admission); expect(Date.now()).toBeLessThan(Date.parse(attempt.deadline));
				expect(admitted.assignmentAttempt).toEqual(attempt); expect(admitted).toMatchObject({ id: attempt.id, membershipId, capacityProviderId: providerId,
					providerSessionId: opened.id, executionProviderId: adapter.id, executionNodeId: actorNode.id, executionNodeRevision: actorNode.nodeRevision });
				expect(admitted.workspaceContext.predecessorResults).toEqual([]);
				const state = async () => ({ assignments: await f.store.all('SELECT * FROM capacity_provider_assignments ORDER BY id'),
					reservations: await f.store.all('SELECT * FROM capacity_reservations ORDER BY id'), proxies: await f.store.all('SELECT * FROM treedx_proxy_handles ORDER BY id'),
					counters: await f.store.all('SELECT * FROM capacity_admission_counters ORDER BY id'), claims: await f.store.all('SELECT * FROM capacity_reservation_counter_claims ORDER BY reservation_id,counter_id'),
					nodes: await f.store.all('SELECT * FROM execution_nodes ORDER BY id'), usage: await f.store.all('SELECT * FROM capacity_usage_actuals ORDER BY id'),
					ledger: await f.store.all('SELECT * FROM capacity_ledger_entries ORDER BY id') });
				const committed = await state(); expect(committed.assignments).toHaveLength(1); expect(committed.reservations).toHaveLength(1);
				expect(committed.proxies).toHaveLength(1); expect(committed.claims).toHaveLength(2); expect(committed.counters).toHaveLength(2); for (const counter of committed.counters) expect(counter).toMatchObject({ hard_limit: 10, committed_amount: 3 });
				expect(committed.reservations[0]).toMatchObject({ assignment_id: attempt.id, reserved_seconds: 3, expires_at: attempt.deadline });
				expect(committed.nodes.find(node => node.id === actorNode.id)?.status).toBe('assigned'); expect(committed.usage).toEqual([]); expect(committed.ledger).toEqual(before.ledger);
				for (const replay of await Promise.all([admitLivingExecutionAssignment(capacity, admission), admitLivingExecutionAssignment(capacity, structuredClone(admission))]))
					expect(replay.assignmentAttempt).toEqual(attempt);
				expect(await state()).toEqual(committed); expect(admission).toEqual(admissionBefore); expect(compilerInput).toEqual(compilerBefore); expect(publication).toEqual(publicationBefore);
				const leaseInput = { providerSessionId: opened.id, runnerId: 'native-governed-runner', leaseSeconds: 30,
					laneId: frozen.laneId, lanePurpose: 'workday' as const }, leaseBefore = structuredClone(leaseInput), calledAt = Date.now();
				expect(calledAt).toBeLessThan(Date.parse(attempt.deadline));
				const claims = await Promise.all([leaseNextProviderAssignment(capacity, principal, leaseInput),
					leaseNextProviderAssignment(capacity, principal, { ...leaseInput, runnerId: 'native-competing-runner' })]);
				const winners = claims.filter(value => value.assignment); expect(winners).toHaveLength(1);
				const winner = winners[0]!; expect({ id: winner.assignment?.id, status: winner.assignment?.status,
					leaseState: winner.assignment?.leaseState, membershipId: winner.assignment?.membershipId })
					.toEqual({ id: attempt.id, status: 'leased', leaseState: 'leased', membershipId });
				expect(winner.assignment?.assignmentAttempt).toEqual(attempt); expect(typeof winner.leaseToken).toBe('string'); expect(Boolean(winner.leaseToken)).toBe(true); expect(winner.assignment?.leaseToken === winner.leaseToken).toBe(true);
				const expiry = Date.parse(winner.assignment?.leaseExpiresAt ?? ''); expect(expiry).toBeGreaterThan(calledAt); expect(expiry).toBeLessThanOrEqual(Date.parse(attempt.deadline)); expect(Date.now()).toBeLessThanOrEqual(Date.parse(attempt.deadline));
				for (const loser of claims.filter(value => !value.assignment)) expect(loser.leaseToken).toBeNull();
				const claimed = await state(); expect(claimed.assignments).toHaveLength(1);
				for (const field of ['reservations', 'proxies', 'counters', 'claims', 'nodes', 'usage', 'ledger'] as const) expect(claimed[field]).toEqual(committed[field]);
				expect((await capacity.getProviderAssignment('team', attempt.id))?.leaseToken === winner.leaseToken).toBe(true); expect(leaseInput).toEqual(leaseBefore); expect(admission).toEqual(admissionBefore); expect(publication).toEqual(publicationBefore);
				expect(await f.store.all('SELECT * FROM governance_events ORDER BY id')).toEqual(history); expect(await f.store.all('SELECT * FROM governance_decisions ORDER BY id')).toEqual(rows);
				expect(await f.store.all('SELECT * FROM capacity_operation_receipts ORDER BY id')).toEqual(allReceipts);
				const readback = object(await native.readRepositoryFile({ repoId: repository, ref: retainedContent.commit, path: retainedContent.path, encoding: 'utf8', parseFrontmatter: false, allowProtected: true }));
				expect(readback.resolvedRef).toBe(retainedContent.commit); expect(object(readback.file).content).toBe(retainedContent.raw);
				// A genuine content producer reaches native atomic admission; signed
				// conformance is still supplied qualification, not a suite receipt,
				// authenticated enrollment/public HTTP, model or usage proof. Native
				// claim promises share one PGlite connection, not independent PG pools.
			}
		} finally {
			const cleanupErrors: unknown[] = [];
			for (const workspace of extraWorkspaces) try { await f.client.workspaces.close(workspace); } catch (error) { cleanupErrors.push(error); }
			if (teamRepository) try {
				await f.client.repositories.retire(teamRepository);
				try { await f.client.repositories.get(teamRepository); cleanupErrors.push(new Error('Allocated Team Library remains readable after retirement')); }
				catch (error) { if (object(error).status !== 404) cleanupErrors.push(error); }
			} catch (error) { cleanupErrors.push(error); }
			try { await f.close(); } catch (error) { cleanupErrors.push(error); }
			if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Native governance readiness fixture cleanup failed');
		}
		}
	});
});
