import { createHash } from 'node:crypto';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import type { ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { resolveKnowledgeGatewayConnection } from '../knowledge/gateway-treedx-connection.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
};
const text = (...values: unknown[]): string => String(values.find((value) => typeof value === 'string' && value.trim()) ?? '').trim();

/** A draft may enter the graph only after its work units have genuine bounded
 * estimates. Readiness and source selection must use the same structural gate. */
export function hasCompleteExecutablePlan(proposal: Row): boolean {
	const plan = record(proposal.executionPlan);
	return Array.isArray(plan.workItems) && plan.workItems.length > 0 && plan.workItems.every((value: unknown) => {
		const item = record(value);
		return Number(record(item.estimate).minimumSeconds) > 0
			&& (item.review !== 'required' || Number(record(item.reviewEstimate).minimumSeconds) > 0);
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
	if (text(validation.data.id) !== proposalId || text(validation.data.projectId) !== projectId) throw Object.assign(
		new Error('The proposal content identity does not match its governance record.'), { status: 409, code: 'proposal_identity_mismatch' },
	);
	const ref: ExactEntityReference = {
		store: 'treedx', model: 'proposal', id: proposalId, revision,
		digest: `sha256:${observedDigest}`, repository, commit, path,
	};
	return { source, definition: validation.data as Row, ref };
}
