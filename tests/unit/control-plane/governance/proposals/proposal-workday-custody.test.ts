import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commitProposalVersionContent } from '../../../../../src/api/control-plane/governance/proposal-version-content.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { CapacityWorkdayRunRepository } from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import { recordTreeDxAuthoringState } from '../../../../../src/api/capacity/services/treedx/repositories/treedx-authoring-journal.ts';
import { projectTreeDxCommitSignals } from '../../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts';
import { serializeProposalDocument } from '../../../../../src/api/governance/proposal-document.ts';
import { parseFrontmatterDocument, serializeFrontmatterDocument } from '../../../../../src/api/content/frontmatter.ts';
import { readyContributionProposal, readyProposal } from './architecture/ready-proposal-fixture.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', async original => ({
	...await original<typeof import('../../../../../src/api/knowledge/gateway-treedx-connection.ts')>(), resolveKnowledgeGatewayConnection: vi.fn(),
}));
vi.mock('../../../../../src/api/governance/proposal-document.ts', () => ({ serializeProposalDocument: vi.fn(() => 'next') }));
vi.mock('../../../../../src/api/knowledge/changesets/apply-text-changeset.ts', () => ({ applyTextChangeset: async () => ({
	files: [{ path: 'proposals/governance/example.mdx', afterSha256: createHash('sha256').update('next').digest('hex') }],
}) }));
vi.mock('../../../../../src/api/capacity/services/treedx/repositories/treedx-authoring-journal.ts', () => ({ recordTreeDxAuthoringState: vi.fn() }));
vi.mock('../../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts', () => ({ projectTreeDxCommitSignals: vi.fn() }));

function fixture(mode = 'simulation') {
	const base = 'a'.repeat(40), path = 'proposals/governance/example.mdx';
	const run = { id: 'workday-1', status: 'running', executionMode: mode, parameters: {
		appliedPlan: { state: 'active', endsAt: '2099-01-01T00:00:00.000Z' }, scheduledProjectIds: ['project-1'], proposalIds: ['proposal-1'],
		workdayContextByProjectId: { 'project-1': { store: 'treedx', model: 'knowledge', id: 'project-1:project-context', repository: 'repository-1', commit: base, path: 'README.md' } },
	} };
	vi.spyOn(CapacityWorkdayRunRepository.prototype, 'get').mockResolvedValue(run as never);
	const client = { createWorkspace: vi.fn(async (request: { branchName?: string; baseRef?: string }) => ({ workspaceId: 'workspace-1', baseCommitSha: /^[a-f0-9]{40}$/u.test(request.baseRef??'') ? request.baseRef : base })),
		readRepositoryFiles: vi.fn(async (request: {ref:string}) => ({ resolvedRef: /^[a-f0-9]{40}$/u.test(request.ref) ? request.ref : base, files: [{ path: '.treeseed/governance/proposal-types/implementation.yaml', content: JSON.stringify({
			schemaVersion: 'treeseed.proposal-type/v1', id: 'implementation', label: 'Implementation', description: 'Bounded change.',
		}) }] })), readRepositoryFile: vi.fn(async (request: {ref:string}) => ({ resolvedRef: /^[a-f0-9]{40}$/u.test(request.ref) ? request.ref : base, file: { content: 'before' } })),
		closeWorkspace: vi.fn(async () => undefined), commit: vi.fn(async () => ({ commitSha: 'b'.repeat(40), branchName: mode === 'simulation' ? 'refs/heads/workday-1' : 'refs/heads/staging', changedPaths: [path] })) };
	vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ client, contentPath: '.', repositoryId: 'repository-1', baseRef: base, authoringBranch: 'staging', allowedPaths: ['proposals/**'] } as never);
	const input = { store: {}, principal: { id: 'user-1' }, proposal: { id: 'proposal-1', teamId: 'team-1', projectId: 'project-1', activeVersion: 4,
		title: 'Example', proposalTypes: ['implementation'], metadata: { contentProvenance: { contentPath: path, commitSha: base } } }, update: { workdayId: run.id } };
	return { run, client, input, base, path };
}

describe('workday-scoped proposal authoring', () => {
	beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
	it('retains the exact active private plan and links on a body-only Inbox revision', async () => {
		const { input, client, base, path } = fixture('production'), active = 'c'.repeat(40);
		const definition = { ...readyProposal(), id: input.proposal.id, projectId: input.proposal.projectId,
			groupIds: ['provider-runtime'], objectiveRefs: [{ store: 'treedx', model: 'objective', id: 'real-objective', commit: base }],
			evidenceRefs: [{ store: 'git', model: 'repository', id: 'source', repository: 'treeseed-ai/agent', commit: base }],
			discussionRef: { store: 'treedx', model: 'discussion', id: 'planning', commit: base } };
		const source = serializeFrontmatterDocument(definition, '');
		const proposal = { ...input.proposal, activeContentHash: createHash('sha256').update(source).digest('hex'),
			metadata: { contentProvenance: { repositoryId: 'repository-1', contentPath: path,
				commitSha: active, digest: createHash('sha256').update(source).digest('hex') } } };
		client.readRepositoryFile.mockImplementation(async request => request.ref === active
			? { resolvedRef: active, file: { content: source, frontmatter: definition } }
			: { resolvedRef: base, file: { content: '---\ngroupIds: [older-group]\n---\n' } });
		await commitProposalVersionContent({ ...input, proposal, update: { body: 'Reviewer supplied corrected own estimate.' } });
		expect(serializeProposalDocument).toHaveBeenLastCalledWith(expect.objectContaining({
			request: 'Reviewer supplied corrected own estimate.', executionPlan: definition.executionPlan,
			groupIds: definition.groupIds, objectiveRefs: definition.objectiveRefs,
			evidenceRefs: definition.evidenceRefs, discussionRef: definition.discussionRef,
		}));
		const replacement = { workItems: definition.executionPlan.workItems.map(item => ({ ...item, objective: 'Revised scope.' })) };
		await commitProposalVersionContent({ ...input, proposal, update: { executionPlan: replacement,
			groupIds: [], objectiveRefs: [], evidenceRefs: [], discussionRef: null } });
		expect(serializeProposalDocument).toHaveBeenLastCalledWith(expect.objectContaining({
			executionPlan: replacement, groupIds: [], objectiveRefs: [], evidenceRefs: [], discussionRef: null,
		}));
	});
	it('retains proposal groups on partial edits and applies explicit membership revisions', async () => {
		const { input, client, base } = fixture();
		client.readRepositoryFile.mockResolvedValue({ resolvedRef: base,
			file: { content: '---\ngroupIds: [ui-snapshot-admin-chart]\n---\n' } });
		await commitProposalVersionContent(input);
		expect(serializeProposalDocument).toHaveBeenLastCalledWith(expect.objectContaining({ groupIds: ['ui-snapshot-admin-chart'] }));
		await commitProposalVersionContent({ ...input, update: { ...input.update, groupIds: ['service-design'] } });
		expect(serializeProposalDocument).toHaveBeenLastCalledWith(expect.objectContaining({ groupIds: ['service-design'] }));
		await commitProposalVersionContent({ ...input, update: { ...input.update, groupIds: [] } });
		expect(serializeProposalDocument).toHaveBeenLastCalledWith(expect.objectContaining({ groupIds: [] }));
	});
	it('revises private proposal bytes using only the original frozen governed contract even after the library moves', async () => {
		const {input,client,run,path}=fixture(), frozen='c'.repeat(40), source='b'.repeat(40);
		run.parameters.workdayContextByProjectId['project-1'].commit=frozen;
		input.proposal.metadata.contentProvenance.commitSha=source;
		const original=client.readRepositoryFiles.getMockImplementation()!;
		client.readRepositoryFiles.mockImplementation(async request=>{
			if(request.ref!==frozen)throw Object.assign(new Error('No type contract on private proposal or moving library'),{status:404});
			return original(request);
		});
		const result=await commitProposalVersionContent(input);
		expect(client.readRepositoryFiles).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ref:frozen}));
		expect(client.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({baseRef:source,allowedPaths:[path]}));
		expect(result.update.contentProvenance.commitSha).toBe('b'.repeat(40));
		expect(recordTreeDxAuthoringState).not.toHaveBeenCalled();expect(projectTreeDxCommitSignals).not.toHaveBeenCalled();
	});
	it.each(['missing','commit','repository','store','model'])('rejects %s frozen project contract authority before opening a simulation workspace', async invalid=>{
		const {input,client,run}=fixture();
		const context=run.parameters.workdayContextByProjectId['project-1'];
		if(invalid==='missing')Reflect.deleteProperty(run.parameters.workdayContextByProjectId,'project-1');
		if(invalid==='commit')context.commit='staging';
		if(invalid==='repository')context.repository='foreign-repository';
		if(invalid==='store')context.store='git';
		if(invalid==='model')context.model='proposal';
		await expect(commitProposalVersionContent(input)).rejects.toMatchObject({code:'proposal_simulation_contract_authority_required',status:409});
		expect(client.createWorkspace).not.toHaveBeenCalled();expect(client.commit).not.toHaveBeenCalled();
	});
	it('writes a simulation version from exact provenance to local workday custody without publication', async () => {
		const { input, client, base, path } = fixture();
		const result = await commitProposalVersionContent(input);
		const proposalBranch = `refs/heads/workday-1-proposal-${createHash('sha256').update('proposal-1').digest('hex').slice(0, 16)}`;
		expect(client.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ baseRef: base, branchName: proposalBranch, allowedPaths: [path] }));
		expect(client.readRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({ ref: base }));
		expect(result.update.contentProvenance).toMatchObject({ commitSha: 'b'.repeat(40), contentPath: path });
		expect(recordTreeDxAuthoringState).not.toHaveBeenCalled(); expect(projectTreeDxCommitSignals).not.toHaveBeenCalled();
		expect(client.closeWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1');
	});
	it('binds the canonical repository request field as the revised governance body', async () => {
		const { input } = fixture();
		const result = await commitProposalVersionContent({ ...input,
			update: { ...input.update, request: 'Revised exact proposal request.' } });
		expect(result.update.body).toBe('Revised exact proposal request.');
	});
	it('does not reuse an advanced discussion branch that lacks the proposal source', async () => {
		const { input, client, base } = fixture();
		client.createWorkspace.mockImplementationOnce(async request => {
			if (request.branchName === 'refs/heads/workday-1' && request.baseRef === base) {
				throw new Error('Workspace branch already exists at a different commit.');
			}
			return { workspaceId: 'workspace-1', baseCommitSha: base };
		});
		await expect(commitProposalVersionContent(input)).resolves.toMatchObject({ update: { contentProvenance: { commitSha: 'b'.repeat(40) } } });
		const request = client.createWorkspace.mock.calls[0]?.[0];
		expect(request).toBeDefined(); if (!request) throw new Error('Original workspace request required');
		expect(request.branchName).not.toBe('refs/heads/workday-1');
	});
	it('starts a later estimate version from its exact prior proposal commit on the same simulation branch', async () => {
		const { input, client } = fixture();
		input.proposal.metadata.contentProvenance.commitSha = 'b'.repeat(40);
		const first = await commitProposalVersionContent(input);
		const second = await commitProposalVersionContent(input);
		expect(client.createWorkspace).toHaveBeenCalledTimes(2);
		const firstRequest = client.createWorkspace.mock.calls[0]?.[0], secondRequest = client.createWorkspace.mock.calls[1]?.[0];
		expect(firstRequest).toBeDefined(); expect(secondRequest).toBeDefined();
		if (!firstRequest || !secondRequest) throw new Error('Both original workspace requests required');
		expect(firstRequest.branchName).toBe(secondRequest.branchName);
		expect(secondRequest.baseRef).toBe('b'.repeat(40));
		expect(first.update.contentProvenance.commitSha).toBe(second.update.contentProvenance.commitSha);
	});
	it('recovers a retained private publication head without changing canonical source or escaping the owned proposal branch', async () => {
		const { input, client, base, path } = fixture(), retained = 'c'.repeat(40), held = structuredClone(input);
		const conflict = Object.assign(new Error('Workspace branch already exists at a different commit.'), { status: 409, code: 'conflict' });
		client.createWorkspace.mockRejectedValueOnce(conflict).mockImplementationOnce(async () => ({ workspaceId: 'workspace-1', baseCommitSha: retained }));
		client.readRepositoryFile.mockResolvedValue({ resolvedRef: retained, file: { content: 'before' } });
		// Canonical bytes remain pinned even though the retained branch is ahead.
		const proposal = { ...readyProposal(), id: input.proposal.id, projectId: input.proposal.projectId };
		const source = serializeFrontmatterDocument(proposal, '');
		input.proposal = { ...input.proposal, activeContentHash: createHash('sha256').update(source).digest('hex') } as typeof input.proposal;
		Object.assign(input.proposal.metadata.contentProvenance, { repositoryId: 'repository-1', digest: createHash('sha256').update(source).digest('hex') });
		client.readRepositoryFile.mockImplementation(async request => request.ref === base
			? { resolvedRef: base, file: { content: source, frontmatter: proposal } }
			: { resolvedRef: retained, file: { content: 'before' } });
		const expectedInput = structuredClone(input), result = await commitProposalVersionContent(input);
		const branchName = `refs/heads/workday-1-proposal-${createHash('sha256').update('proposal-1').digest('hex').slice(0, 16)}`;
		expect(client.createWorkspace).toHaveBeenNthCalledWith(1, expect.objectContaining({ baseRef: base, branchName, allowedPaths: [path] }));
		expect(client.createWorkspace).toHaveBeenNthCalledWith(2, expect.objectContaining({ baseRef: branchName, branchName, allowedPaths: [path] }));
		expect(serializeProposalDocument).toHaveBeenLastCalledWith(expect.objectContaining({ executionPlan: proposal.executionPlan }));
		expect(result.update.contentProvenance.commitSha).toBe('b'.repeat(40));
		expect(input).toEqual(expectedInput); expect(input.proposal.metadata.contentProvenance.commitSha).toEqual(held.proposal.metadata.contentProvenance.commitSha);
		expect(client.closeWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1');
		expect(recordTreeDxAuthoringState).not.toHaveBeenCalled(); expect(projectTreeDxCommitSignals).not.toHaveBeenCalled();
	});
	it('retains identical authored bytes after recovery rather than serializing validator defaults into a new commit', async () => {
		const { input, client, base, path } = fixture(), retained='c'.repeat(40);
		const actual=await vi.importActual<typeof import('../../../../../src/api/governance/proposal-document.ts')>('../../../../../src/api/governance/proposal-document.ts');
		const definition={...readyContributionProposal(),id:input.proposal.id,projectId:input.proposal.projectId};
		const source=actual.serializeProposalDocument({...definition,status:'draft'});
		const after=actual.serializeProposalDocument({...definition,request:'Revised own contribution.',status:'draft'});
		const digest=createHash('sha256').update(source).digest('hex');
		const proposal={...input.proposal,title:definition.title,summary:definition.summary,body:definition.request,activeContentHash:digest,
			metadata:{contentProvenance:{repositoryId:'repository-1',contentPath:path,commitSha:base,digest}}};
		client.createWorkspace.mockRejectedValueOnce(Object.assign(new Error('Workspace branch already exists at a different commit.'),{status:409,code:'conflict'}))
			.mockResolvedValueOnce({workspaceId:'workspace-1',baseCommitSha:retained});
		client.readRepositoryFile.mockImplementation(async request=>request.ref===base
			?{resolvedRef:base,file:{content:source,frontmatter:parseFrontmatterDocument(source).frontmatter}}
			:{resolvedRef:retained,file:{content:after}});
		vi.mocked(serializeProposalDocument).mockImplementation(actual.serializeProposalDocument);
		try {
			const result=await commitProposalVersionContent({...input,proposal,update:{...input.update,request:'Revised own contribution.'}});
			expect(result.receipt.commitSha).toBe(retained); expect(result.receipt.changedPaths).toEqual([]);
			expect(result.receipt.digest).toBe(createHash('sha256').update(after).digest('hex'));
			expect(client.commit).not.toHaveBeenCalled(); expect(client.closeWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1');
		} finally { vi.mocked(serializeProposalDocument).mockImplementation(()=>'next'); }
	});
	it.each([
		['production',409,'conflict','Workspace branch already exists at a different commit.'],
		['simulation',403,'forbidden','Workspace branch already exists at a different commit.'],
		['simulation',409,'foreign-conflict','Workspace branch already exists at a different commit.'],
		['simulation',409,'conflict','conflict: writable lease already exists for this branch'],
	] as const)('does not reinterpret %s/%s/%s authoring failures', async (mode,status,code,message) => {
		const { input, client } = fixture(mode), failure=Object.assign(new Error(message),{status,code});
		client.createWorkspace.mockRejectedValueOnce(failure);
		await expect(commitProposalVersionContent(input)).rejects.toBe(failure);
		expect(client.createWorkspace).toHaveBeenCalledTimes(1); expect(client.commit).not.toHaveBeenCalled();
	});
	it('does not reset or create another branch when owned-head recovery also conflicts', async () => {
		const { input, client } = fixture(), failure=Object.assign(new Error('Workspace branch already exists at a different commit.'),{status:409,code:'conflict'});
		client.createWorkspace.mockRejectedValue(failure);
		await expect(commitProposalVersionContent(input)).rejects.toBe(failure);
		expect(client.createWorkspace).toHaveBeenCalledTimes(2);
		expect(client.createWorkspace.mock.calls[0]?.[0].branchName).toBe(client.createWorkspace.mock.calls[1]?.[0].branchName);
		expect(client.commit).not.toHaveBeenCalled();
	});
	it('closes recovery without publication when its private head moves before read-back', async () => {
		const { input, client } = fixture(),failure=Object.assign(new Error('Workspace branch already exists at a different commit.'),{status:409,code:'conflict'});
		client.createWorkspace.mockRejectedValueOnce(failure).mockResolvedValueOnce({workspaceId:'workspace-1',baseCommitSha:'c'.repeat(40)});
		await expect(commitProposalVersionContent(input)).rejects.toMatchObject({code:'proposal_content_base_stale'});
		expect(client.closeWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1'); expect(client.commit).not.toHaveBeenCalled();
	});
	it.each(['missing', 'terminal', 'project', 'proposal', 'expired'])('rejects %s workday scope before issuing a workspace', async invalid => {
		const { run, input, client } = fixture();
		if (invalid === 'missing') vi.mocked(CapacityWorkdayRunRepository.prototype.get).mockResolvedValue(null);
		if (invalid === 'terminal') run.status = 'completed';
		if (invalid === 'project') run.parameters.scheduledProjectIds = ['other'];
		if (invalid === 'proposal') run.parameters.proposalIds = ['other'];
		if (invalid === 'expired') run.parameters.appliedPlan.endsAt = '2000-01-01T00:00:00.000Z';
		await expect(commitProposalVersionContent(input)).rejects.toMatchObject({ code: 'proposal_workday_scope_invalid' });
		expect(client.createWorkspace).not.toHaveBeenCalled(); expect(client.commit).not.toHaveBeenCalled();
	});
	it.each(['', {}, null])('does not fall back to publication for malformed workday scope (%j)', async workdayId => {
		const { input, client } = fixture();
		await expect(commitProposalVersionContent({ ...input, update: { workdayId } })).rejects.toMatchObject({ code: 'proposal_workday_id_invalid' });
		expect(client.createWorkspace).not.toHaveBeenCalled();
	});
	it('rejects simulation authoring without an exact base before creating a workspace', async () => {
		const { input, client } = fixture(); input.proposal.metadata.contentProvenance.commitSha = 'staging';
		await expect(commitProposalVersionContent(input)).rejects.toMatchObject({ code: 'proposal_simulation_source_required' });
		expect(client.createWorkspace).not.toHaveBeenCalled();
	});
	it('retains the ordinary production authoring and replication path', async () => {
		const { input, client } = fixture('production'); await commitProposalVersionContent(input);
		expect(client.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ baseRef: 'refs/heads/staging', branchName: 'refs/heads/staging' }));
		expect(recordTreeDxAuthoringState).toHaveBeenCalledOnce(); expect(projectTreeDxCommitSignals).toHaveBeenCalledOnce();
	});
	it('uses the explicit proposal slug for initial source custody', async () => {
		const { input, client } = fixture('production');
		input.proposal.metadata.contentProvenance = {} as never;
		const proposal = { ...input.proposal, contentProposalSlug: 'unique-acceptance-proposal' };
		client.readRepositoryFile.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));
		await expect(commitProposalVersionContent({ ...input, proposal, initial: true })).rejects.toMatchObject({ code: 'proposal_changeset_digest_mismatch' });
		expect(client.readRepositoryFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'proposals/governance/unique-acceptance-proposal.mdx' }));
		expect(client.commit).not.toHaveBeenCalled();
	});
	it('rejects an occupied initial proposal path without changing its bytes', async () => {
		const { input, client } = fixture('production');
		input.proposal.metadata.contentProvenance = {} as never;
		const proposal = { ...input.proposal, contentProposalSlug: 'existing-proposal' };
		await expect(commitProposalVersionContent({ ...input, proposal, initial: true })).rejects.toMatchObject({
			status: 409, code: 'proposal_source_path_occupied', path: 'proposals/governance/existing-proposal.mdx',
		});
		expect(client.commit).not.toHaveBeenCalled();
		expect(client.closeWorkspace).toHaveBeenCalledExactlyOnceWith('workspace-1');
	});
});
