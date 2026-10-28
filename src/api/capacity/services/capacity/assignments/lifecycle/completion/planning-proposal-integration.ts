import { createHash } from 'node:crypto';
import { assignmentAttemptSchema, assignmentPathAllowed, assignmentResultSchema, type AssignmentAttempt, type AssignmentResult } from '@treeseed/sdk/agent-capacity';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { CapacityGovernanceError } from '../../../../../database.ts';
import { parseFrontmatterDocument } from '../../../../../../content/frontmatter.ts';
import { bindInitialProposalContent } from '../../../../../../control-plane/governance/governance-service.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../../knowledge/gateway-treedx-connection.ts';
import { canonicalJson } from '../../../../../security.ts';
import type { ControlPlaneStore } from '../../../../../../persistence/store.ts';

type Row = Record<string, unknown>;
type Store = { all(sql: string, params?: unknown[]): Promise<Row[]> }
	& Partial<Pick<ControlPlaneStore, 'first' | 'batch' | 'createGovernanceProposal' | 'getGovernanceProposal'>>;
type Scope = { id: string; teamId: string; projectId: string; agentId?: string | null; assignmentAttempt?: AssignmentAttempt | null };
const record = (value: unknown): Row => typeof value === 'string' ? record(JSON.parse(value))
	: value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
function deny(message: string): never { throw new CapacityGovernanceError('assignment_planning_proposal_invalid', message, 409); }

/** Index the original completed planning product. Never reauthor its bytes. */
export async function integratePlanningProposal(store: Store, scope: Scope, result: AssignmentResult) {
	const attempt = scope.assignmentAttempt;
	if (attempt?.effectiveProfile.activity !== 'planning') return;
	const targets = attempt.grant.contentWrite.filter(target => target.model === 'proposal');
	const products = result.references.filter(reference => reference.kind === 'treedx'
		&& targets.some(target => target.repository === reference.repository
			&& typeof target.path === 'string' && assignmentPathAllowed(reference.path, [target.path])));
	if (!products.length) return;
	if (typeof store.createGovernanceProposal !== 'function' || typeof store.getGovernanceProposal !== 'function'
		|| typeof store.first !== 'function' || typeof store.batch !== 'function') {
		throw new CapacityGovernanceError('assignment_planning_integration_unavailable', 'Original governance creation and binding are required.', 503);
	}
	const [row] = await store.all(`SELECT agent_id,assignment_attempt_json,assignment_result_json FROM capacity_provider_assignments
		WHERE id=? AND team_id=? AND project_id=? AND status='completed'`, [scope.id, scope.teamId, scope.projectId]);
	if (!row || !scope.agentId || row.agent_id !== scope.agentId || attempt.effectiveProfile.profileRef.id !== scope.agentId
		|| canonicalJson(assignmentAttemptSchema.parse(record(row.assignment_attempt_json))) !== canonicalJson(attempt)
		|| canonicalJson(assignmentResultSchema.parse(record(row.assignment_result_json))) !== canonicalJson(result)) {
		deny('Planning integration requires the unchanged canonical completed assignment, result and agent identity.');
	}
	const receipt = await store.first(`SELECT id FROM audit_events WHERE id=? AND event_type='assignment.content.integrated'`,
		[`assignment-content-integrated:${scope.id}:${result.id}`]);
	if (receipt) return;
	for (const reference of products) {
		if (reference.kind !== 'treedx') continue;
		const workspace = attempt.workspace;
		const profile = attempt.effectiveProfile.profileRef;
		if (workspace.mode !== 'treedx' || workspace.repository !== reference.repository || workspace.workspaceId !== reference.workspaceId
			|| reference.projectId !== scope.projectId || !assignmentPathAllowed(reference.path, workspace.writablePaths)
			|| profile.store !== 'treedx' || profile.model !== 'agent' || profile.repository !== reference.repository
			|| !profile.commit || !profile.path || !attempt.grant.contentRead.some(grant => canonicalJson(grant) === canonicalJson(profile))) {
			deny('Planning proposal must come from its original authorized workspace.');
		}
		const connection = await resolveKnowledgeGatewayConnection(store, { projectId: scope.projectId,
			write: false, readRefs: [reference.commit, profile.commit], workspacePaths: [reference.path, profile.path] });
		if (!connection || connection.repositoryId !== reference.repository) deny('Planning proposal repository binding changed.');
		const observed = record(await connection.client.readRepositoryFiles({ repoId: reference.repository, ref: reference.commit,
			paths: [reference.path], encoding: 'utf8', parseFrontmatter: false, allowProtected: true }));
		const file = Array.isArray(observed.files) ? observed.files.map(record).find(file => file.path === reference.path) : undefined;
		if (observed.resolvedRef !== reference.commit || typeof file?.content !== 'string') deny('Exact planning proposal bytes are unavailable.');
		const source = file.content as string, parsed = parseFrontmatterDocument(source);
		const validation = validatePortableContentData('proposal', parsed.frontmatter), definition = record(validation.data);
		if (!validation.ok || definition.schemaVersion !== 'treeseed.proposal/v2' || definition.projectId !== scope.projectId || !['draft', 'discussing'].includes(String(definition.status))
			|| !targets.some(target => target.id === definition.id && target.repository === reference.repository
				&& typeof target.path === 'string' && assignmentPathAllowed(reference.path, [target.path]))) {
			deny('Planning content must be a draft proposal matching its admitted model, identity, project and path.');
		}
		const profileRead = record(await connection.client.readRepositoryFiles({ repoId: reference.repository, ref: profile.commit,
			paths: [profile.path], encoding: 'utf8', parseFrontmatter: false, allowProtected: true }));
		const profileFile = Array.isArray(profileRead.files) ? profileRead.files.map(record).find(file => file.path === profile.path) : undefined;
		if (profileRead.resolvedRef !== profile.commit || typeof profileFile?.content !== 'string') deny('Exact planning agent definition is unavailable.');
		const profileValidation = validatePortableContentData('agent', parseFrontmatterDocument(profileFile.content as string).frontmatter);
		const agent = record(profileValidation.data);
		if (!profileValidation.ok || agent.id !== scope.agentId || agent.agentClass !== attempt.agentClass
			|| !Array.isArray(agent.groupIds) || !Array.isArray(definition.groupIds)
			|| !definition.groupIds.every(group => (agent.groupIds as unknown[]).includes(group))) {
			deny('Planning proposals must use groups subscribed by the original frozen agent definition.');
		}
		const digest = createHash('sha256').update(source).digest('hex');
		const provenance = { repositoryId: reference.repository, contentPath: reference.path, commitSha: reference.commit, digest };
		const input = { id: definition.id, teamId: scope.teamId, projectId: scope.projectId, status: 'draft',
			title: definition.title, summary: definition.summary, request: definition.request, proposalTypes: definition.proposalTypes,
			createdByType: 'agent', createdById: scope.agentId, contentProvenance: provenance };
		let proposal = await store.getGovernanceProposal(String(definition.id));
		if (!proposal) {
			try { proposal = await store.createGovernanceProposal(null, input); }
			catch (error) {
				if (record(error).code !== '23505') throw error;
				// Another completion may win the same original atomic creation.
				proposal = await store.getGovernanceProposal(String(definition.id));
			}
		}
		if (!proposal || proposal.teamId !== scope.teamId || proposal.projectId !== scope.projectId
			|| proposal.createdByType !== 'agent' || proposal.createdById !== scope.agentId) {
			deny('An existing proposal has different authority or source; planning integration cannot replace it.');
		}
		const events = await store.all(`SELECT actor_type,actor_id,evidence_json FROM governance_events WHERE proposal_id=? AND event_type='proposal.created'`, [proposal.id]);
		const created = events[0];
		if (events.length !== 1 || created?.actor_type !== 'agent' || created.actor_id !== scope.agentId
			|| canonicalJson(record(created.evidence_json).contentProvenance) !== canonicalJson(provenance)) {
			deny('The original proposal creation does not identify this exact planning source.');
		}
		const version = await store.first('SELECT content_hash FROM governance_proposal_versions WHERE proposal_id=? AND version=1', [proposal.id]);
		// A lost receipt may be recovered after later discussion/approval. Never
		// reset an already bound proposal or its original creation clock/history.
		if (version?.content_hash === digest) continue;
		if (proposal.activeVersion !== 1 || proposal.status !== 'draft' || !version || version.content_hash !== proposal.activeContentHash
			|| proposal.title !== definition.title || proposal.summary !== (definition.summary ?? '') || proposal.body !== definition.request
			|| canonicalJson(record(proposal.metadata).contentProvenance) !== canonicalJson(provenance)) {
			deny('An unbound initial proposal changed before integration and cannot be replaced.');
		}
		const bound = await bindInitialProposalContent(store, proposal, { update: { ...input, body: definition.request }, receipt: { commitSha: reference.commit } });
		const boundVersion = await store.first('SELECT content_hash FROM governance_proposal_versions WHERE proposal_id=? AND version=1', [proposal.id]);
		if (bound.activeContentHash !== digest || boundVersion?.content_hash !== digest) deny('Initial planning source binding remains incomplete.');
	}
}
