import { createHash,randomUUID } from 'node:crypto';
import { serializeFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import { validateProposalTypeContract } from '@treeseed/sdk/agent-capacity';
import { parse as parseYaml } from 'yaml';
import { resolveKnowledgeGatewayConnection } from '../../../knowledge/gateway-treedx-connection.ts';
import { projectTreeDxCommitSignals } from '../../../capacity/services/treedx/repositories/treedx-change-projector.ts';
import { applyTextChangeset } from '../../../knowledge/changesets/apply-text-changeset.ts';

type Row = Record<string, unknown>;
function object(value: unknown): Row { if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row; if (typeof value === 'string') try { return object(JSON.parse(value)); } catch { return {}; } return {}; }
function text(...values: unknown[]) { return String(values.find((value) => typeof value === 'string' && value.trim()) ?? '').trim(); }
function list(value: unknown) { return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean) : []; }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'proposal'; }

export async function commitProposalVersionContent(input: { store: any; proposal: Row; principal: Row; update: Row }) {
	const projectId = text(input.proposal.projectId, input.proposal.project_id); const metadata = object(input.proposal.metadata); const provenance = object(metadata.contentProvenance); const version = Number(input.proposal.activeVersion ?? input.proposal.active_version) + 1;
	const connection = await resolveKnowledgeGatewayConnection(input.store, { projectId, write: true, relationPaths: true, authoringPaths: true });
	if (!connection) throw Object.assign(new Error('The project TreeDX repository is unavailable for proposal authoring.'), { status: 503, code: 'proposal_treedx_unavailable' });
	const title = text(input.update.title, input.proposal.title); const summary = text(input.update.summary, input.proposal.summary); const body = text(input.update.body, input.proposal.body); const types = list(input.update.proposalTypes).length ? list(input.update.proposalTypes) : list(input.proposal.proposalTypes ?? input.proposal.proposal_types_json);
	const path = text(provenance.contentPath) || `${connection.contentPath}/proposals/governance/${slug(title)}.mdx`; const branchName = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, '')}`;
	const workspace = await connection.client.createWorkspace({ workspaceId: `proposal-version-${randomUUID()}`, repoId: connection.repositoryId, baseRef: branchName, branchName, mode: 'writable', allowedPaths: connection.allowedPaths, ttlSeconds: 600 });
	const expectedBase = text(input.update.expectedTreeDxBase);
	if (expectedBase && expectedBase !== workspace.baseCommitSha) { await connection.client.closeWorkspace(workspace.workspaceId).catch(() => undefined); throw Object.assign(new Error('The proposal content branch changed. Compare and rebase before publishing.'), { status: 409, code: 'proposal_treedx_base_stale', currentBase: workspace.baseCommitSha }); }
	if (!types.length) { await connection.client.closeWorkspace(workspace.workspaceId).catch(() => undefined); throw Object.assign(new Error('Select at least one repository proposal type before publishing.'), { status: 422, code: 'proposal_type_required' }); }
	const contractPaths = types.map((id) => `.treeseed/governance/proposal-types/${id}.yaml`);
	const contractRead = await connection.client.readRepositoryFiles({ repoId: connection.repositoryId, ref: workspace.baseCommitSha, paths: contractPaths, encoding: 'utf8', parseFrontmatter: false, allowProtected: true });
	const contracts = new Map((contractRead.files ?? []).map((file: unknown) => [text(object(file).path), text(object(file).content)]));
	const invalid = contractPaths.filter((contractPath,index) => { try { const validation = validateProposalTypeContract(parseYaml(contracts.get(contractPath) ?? '')); return !validation.ok || validation.value?.id !== types[index]; } catch { return true; } });
	if (invalid.length) { await connection.client.closeWorkspace(workspace.workspaceId).catch(() => undefined); throw Object.assign(new Error('One or more proposal types are missing or invalid at the authoring commit.'), { status: 422, code: 'proposal_type_contract_invalid', paths: invalid }); }
	const nextMetadata = { ...metadata, ...(object(input.update.metadata)), proposalTypes: types, relatedObjectives: input.update.relatedObjectives ?? metadata.relatedObjectives ?? [], evidenceRefs: input.update.evidenceRefs ?? metadata.evidenceRefs ?? [], plan: input.update.plan ?? metadata.plan ?? {} };
	const source = serializeFrontmatterDocument({ id: text(input.proposal.id), title, description: summary, summary, date: text(input.proposal.createdAt, input.proposal.created_at, new Date().toISOString()), status: 'in progress', draft: false, proposalTypes: types, relatedObjectives: nextMetadata.relatedObjectives, evidenceRefs: nextMetadata.evidenceRefs, plan: nextMetadata.plan }, `${body}\n`);
	try {
		const existing = await connection.client.readRepositoryFile({ repoId: connection.repositoryId, ref: workspace.baseCommitSha, path, encoding: 'utf8', parseFrontmatter: false }).catch(() => null);
		const before = existing ? text(object(existing.file).content) : null;
		const changeset = await applyTextChangeset({ client: connection.client, workspace, changes: [{ path, before, after: source }] });
		const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: `governance: proposal ${text(input.proposal.id)} version ${version} — ${text(input.update.changeReason)}`, author: { name: text(input.principal.name, input.principal.id, 'Team member'), email: text(input.principal.email, 'governance@users.treeseed.local') } });
		await projectTreeDxCommitSignals(input.store, { projectId, commitSha: commit.commitSha, immutableRef: commit.branchName, changedPaths: commit.changedPaths, changeSummary: text(input.update.changeReason), actorType: 'user', actorId: text(input.principal.id) });
		return { receipt: { path, commitSha: commit.commitSha, branchName: commit.branchName, changedPaths: commit.changedPaths, digest: createHash('sha256').update(source).digest('hex'), proposalVersion: version, changeset: { ...changeset, resultCommitSha: commit.commitSha } }, update: { ...input.update, title, summary, body, proposalTypes: types, metadata: nextMetadata, contentProvenance: { repositoryId: connection.repositoryId, contentPath: path, commitSha: commit.commitSha, digest: createHash('sha256').update(source).digest('hex') } } };
	} catch (error) { await connection.client.closeWorkspace(workspace.workspaceId).catch(() => undefined); throw error; }
}
