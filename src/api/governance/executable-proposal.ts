import { createHash } from 'node:crypto';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { estimateSchema, exactEntityReferenceSchema, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { projectLibraryPath, resolveKnowledgeGatewayConnection } from '../knowledge/gateway-treedx-connection.ts';
import { parseFrontmatterDocument, serializeFrontmatterDocument } from '../content/frontmatter.ts';
import { applyTextChangeset } from '../knowledge/changesets/apply-text-changeset.ts';
import { openDiscussionWorkspace } from '../discussions/discussion-workspace.ts';
import { listOpenTreeDxWorkspaces, recordTreeDxWorkspaceState } from '../capacity/services/treedx/repositories/treedx-authoring-journal.ts';
import { canonicalJson } from '../capacity/security.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
};
const text = (...values: unknown[]): string => String(values.find((value) => typeof value === 'string' && value.trim()) ?? '').trim();

/** External approval survives estimate-only TreeDX revisions, never changes to
 * the objective, work graph, or other authored proposal content. */
export function proposalApprovalFingerprint(proposal: Row): string {
	const plan = record(proposal.executionPlan);
	const items = Array.isArray(plan.workItems) ? plan.workItems.map((value: unknown) => {
		const { estimate: _estimate, reviewEstimate: _reviewEstimate, ...item } = record(value);
		return item;
	}) : [];
	const { status: _status, executionPlan: _plan, ...content } = proposal;
	const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
		: value && typeof value === 'object' ? `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
	return createHash('sha256').update(canonical({ ...content, executionPlan: { ...plan, workItems: items } })).digest('hex');
}

/** A draft may enter the graph only after its work units have genuine bounded
 * estimates. Readiness and source selection must use the same structural gate. */
export function hasCompleteExecutablePlan(proposal: Row): boolean {
	if (!validatePortableContentData('proposal', proposal).ok) return false;
	const plan = record(proposal.executionPlan);
	return Array.isArray(plan.workItems) && plan.workItems.length > 0 && plan.workItems.every((value: unknown) => {
		const item = record(value);
		return estimateSchema.safeParse(item.estimate).success
			&& (item.review !== 'required' || estimateSchema.safeParse(item.reviewEstimate).success);
	});
}

function repositoryFile(value: unknown): Row {
	const response = record(value);
	return record(response.file ?? (Array.isArray(response.files) ? response.files[0] : null));
}

export async function readExactProposal(store: any, proposal: Row, frozen?: ExactEntityReference) {
	const metadata = record(proposal.metadata ?? proposal.metadata_json);
	const provenance = record(metadata.contentProvenance);
	const projectId = text(proposal.projectId, proposal.project_id);
	const proposalId = text(proposal.id, proposal.proposal_id);
	if (frozen && (frozen.store !== 'treedx' || frozen.model !== 'proposal' || frozen.id !== proposalId)) {
		throw Object.assign(new Error('Frozen proposal identity does not match its governance record.'), { status: 409, code: 'proposal_identity_mismatch' });
	}
	const repository = frozen ? text(frozen.repository) : text(provenance.repositoryId);
	const path = frozen ? text(frozen.path) : text(provenance.contentPath);
	const commit = frozen ? text(frozen.commit) : text(provenance.commitSha);
	const sourceDigest = frozen ? text(frozen.digest).replace(/^sha256:/u, '') : text(provenance.digest);
	const activeDigest = frozen ? sourceDigest : text(proposal.activeContentHash, proposal.active_content_hash, proposal.proposal_content_hash).replace(/^sha256:/u, '');
	const revision = frozen ? Number(frozen.revision) : Number(proposal.activeVersion ?? proposal.active_version ?? proposal.proposal_version);
	if (!projectId || !proposalId || !repository || !path || !/^[a-f0-9]{40}$/u.test(commit)
		|| !/^[a-f0-9]{64}$/u.test(sourceDigest) || !Number.isInteger(revision) || revision < 1) {
		throw Object.assign(new Error(`Proposal ${proposalId || '(unknown)'} lacks exact TreeDX provenance.`), {
			status: 409, code: 'proposal_exact_source_missing',
		});
	}
	const connection = await resolveKnowledgeGatewayConnection(store, {
		projectId, write: false, relationPaths: true, readRefs: [commit],
	});
	if (!connection || connection.repositoryId !== repository) throw Object.assign(
		new Error('The proposal repository binding changed.'), { status: 409, code: 'proposal_repository_changed' },
	);
	const response = record(await connection.client.readRepositoryFile({
		repoId: repository, ref: commit, path, encoding: 'utf8', parseFrontmatter: true, allowProtected: true,
	}));
	if (text(response.resolvedRef) !== commit) throw Object.assign(
		new Error('The proposal content changed while it was read.'), { status: 409, code: 'proposal_snapshot_moved' },
	);
	const file = repositoryFile(response);
	const source = typeof file.content === 'string' ? file.content : '';
	const observedDigest = createHash('sha256').update(source).digest('hex');
	if (observedDigest !== sourceDigest || (activeDigest && activeDigest !== sourceDigest)) throw Object.assign(
		new Error('The proposal bytes do not match their recorded digest.'), { status: 409, code: 'proposal_digest_mismatch' },
	);
	const validation = validatePortableContentData('proposal', record(file.frontmatter));
	if (!validation.ok || !validation.data) throw Object.assign(
		new Error(`Proposal ${path} is not executable.`), { status: 422, code: 'proposal_execution_plan_invalid', diagnostics: validation.diagnostics },
	);
	const definition = record(validation.data);
	if (text(definition.id) !== proposalId || text(definition.projectId) !== projectId) throw Object.assign(
		new Error('The proposal content identity does not match its governance record.'), { status: 409, code: 'proposal_identity_mismatch' },
	);
	const ref: ExactEntityReference = {
		store: 'treedx', model: 'proposal', id: proposalId, revision,
		digest: `sha256:${observedDigest}`, repository, commit, path,
	};
	return { source, definition, ref };
}

/** SQL is an index of this governed content, not a substitute for the Decision. */
export async function readExactDecision(store: any, row: Row) {
	const decisionRecord = record(row.decision_record_json ?? row.decisionRecord), ref = record(decisionRecord.decisionRef);
	const projectId = text(row.project_id, row.projectId), decisionId = text(row.id);
	if (ref.store !== 'treedx' || ref.model !== 'decision' || ref.id !== decisionId || !Number.isInteger(ref.revision) || Number(ref.revision) < 1
		|| !/^[a-f0-9]{40}$/u.test(text(ref.commit)) || !/^sha256:[a-f0-9]{64}$/u.test(text(ref.digest)) || !text(ref.repository) || !text(ref.path)) {
		throw Object.assign(new Error('The accepted decision lacks exact classed TreeDX content.'), { status: 409, code: 'governance_decision_content_missing' });
	}
	const connection = await resolveKnowledgeGatewayConnection(store, { projectId, write: false, workspacePaths: [text(ref.path)], readRefs: [text(ref.commit)] });
	if (!connection || connection.repositoryId !== ref.repository) throw Object.assign(new Error('The decision repository binding changed.'), { status: 409, code: 'governance_decision_repository_changed' });
	const response = record(await connection.client.readRepositoryFile({ repoId: ref.repository, ref: ref.commit, path: ref.path, encoding: 'utf8', parseFrontmatter: false, allowProtected: true }));
	const file = repositoryFile(response), source = typeof file.content === 'string' ? file.content : '';
	const parsed = parseFrontmatterDocument(source), validation = validatePortableContentData('decision', parsed.frontmatter);
	const definition = record(validation.data);
	if (response.resolvedRef !== ref.commit || file.path !== ref.path || `sha256:${createHash('sha256').update(source).digest('hex')}` !== ref.digest
		|| !validation.ok || !validation.data || definition.id !== decisionId || definition.projectId !== projectId
		|| definition.decisionClass !== 'proposal' || definition.disposition !== 'approved'
		|| canonicalJson(definition.subjectRef) !== canonicalJson(decisionRecord.proposalRef)) {
		throw Object.assign(new Error('The governed Decision bytes or subject disagree with their exact authority.'), { status: 409, code: 'governance_decision_content_invalid' });
	}
	return { source, definition, ref: exactEntityReferenceSchema.parse(ref) };
}

/** Publish only a reserved governance row; retry keeps its identity and clock. */
export async function publishProposalDecision(store: any, proposal: Row, row: Row, votes: Row[]) {
	const decisionRecord = record(row.decision_record_json), proposalRef = record(decisionRecord.proposalRef);
	const id = text(row.id), projectId = text(row.project_id), branchName = `refs/heads/knowledge/${id}`;
	const initial = await resolveKnowledgeGatewayConnection(store, { projectId, write: true, workspaceRefs: [branchName, text(proposalRef.commit)] });
	if (!initial || initial.repositoryId !== proposalRef.repository) throw new Error('The accepted proposal repository binding changed before Decision publication.');
	const path = projectLibraryPath(initial.contentPath, 'decisions', `${id}.mdx`);
	const connection = await resolveKnowledgeGatewayConnection(store, { projectId, write: true, workspaceRefs: [branchName, text(proposalRef.commit)], workspacePaths: [path] });
	if (!connection) throw new Error('Decision publication requires the original project binding.');
	const authority = proposal.closedReason === 'admin_approved';
	const userRef = (userId: string) => ({ store: 'postgresql', model: 'user', id: userId });
	const decidedByRefs = authority ? [userRef(text(row.created_by_id))] : votes.map(vote => userRef(text(vote.userId)));
	const definition = { schemaVersion: 'treeseed.decision/v1', id, projectId, decisionClass: 'proposal',
		decisionMethod: authority ? 'authority' : 'vote', subjectRef: proposalRef, disposition: 'approved',
		rationale: text(decisionRecord.rationale), authorityRefs: decidedByRefs, decidedByRefs,
		...(!authority ? { positions: votes.map(vote => ({ actorRef: userRef(text(vote.userId)),
			position: vote.vote === 'support' ? 'approve' : vote.vote === 'object' ? 'reject' : 'abstain',
			...(text(vote.reason) ? { rationale: text(vote.reason) } : {}), recordedAt: vote.updatedAt })) } : {}),
		decidedAt: row.created_at };
	const validation = validatePortableContentData('decision', definition);
	if (!validation.ok) throw Object.assign(new Error('The actual governance disposition cannot form a canonical Decision.'), { status: 409, code: 'governance_decision_content_invalid', diagnostics: validation.diagnostics });
	const source = serializeFrontmatterDocument(definition), digest = `sha256:${createHash('sha256').update(source).digest('hex')}`;
	const existing = await connection.client.readRepositoryFile({ repoId: connection.repositoryId, ref: branchName, path, encoding: 'utf8', parseFrontmatter: false, allowProtected: true })
		.catch((error: { status?: number }) => { if (error.status === 404) return null; throw error; });
	if (existing) {
		if (repositoryFile(existing).content !== source || !/^[a-f0-9]{40}$/u.test(text(existing.resolvedRef))) throw new Error('The reserved Decision branch contains different bytes.');
		// A verified completed immutable publication permits cleanup recovery;
		// missing/denied/changed bytes never authorize closing another writer.
		for (const prior of await listOpenTreeDxWorkspaces(store, { projectId, repositoryId: connection.repositoryId, operationKey: `decision:${id}` })) {
			await connection.client.closeWorkspace(prior.workspaceId).catch((error: { status?: number }) => { if (error.status !== 404) throw error; });
			await recordTreeDxWorkspaceState(store, 'closed', { projectId, repositoryId: connection.repositoryId, workspaceId: prior.workspaceId,
				operationKey: `decision:${id}`, ref: branchName, actorType: 'service', actorId: 'governance-decision-recovery' });
		}
		return { store: 'treedx' as const, model: 'decision', id, revision: 1, repository: connection.repositoryId, commit: existing.resolvedRef, path, digest };
	}
	const session = await openDiscussionWorkspace({ store, projectId, connection: { ...connection, allowedPaths: [path] },
		baseRef: text(proposalRef.commit), branchName, operationKey: `decision:${id}` });
	const workspace = session.workspace;
	try {
		await applyTextChangeset({ client: connection.client, workspace, changes: [{ path, before: null, after: source }], idempotencyKey: id });
		const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: `Governed proposal Decision ${id}`, author: { name: text(row.created_by_id, 'Governance'), email: 'governance@users.treeseed.local' } });
		const reader = await resolveKnowledgeGatewayConnection(store, { projectId, write: false, readRefs: [commit.commitSha], workspacePaths: [path] });
		if (!reader) throw new Error('Decision exact readback binding is missing.');
		const observed = await reader.client.readRepositoryFile({ repoId: connection.repositoryId, ref: commit.commitSha, path, encoding: 'utf8', parseFrontmatter: false, allowProtected: true });
		if (observed.resolvedRef !== commit.commitSha || repositoryFile(observed).path !== path || repositoryFile(observed).content !== source) throw new Error('Decision native publication did not pass exact readback.');
		return { store: 'treedx' as const, model: 'decision', id, revision: 1, repository: connection.repositoryId, commit: commit.commitSha, path, digest };
	} finally { await session.close(); }
}
