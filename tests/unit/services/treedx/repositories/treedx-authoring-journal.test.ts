import { describe,expect,it,vi } from 'vitest';
import { listUnpublishedTreeDxAuthoringState,reconcileSupersededTreeDxAuthoringState,recordTreeDxAuthoringState } from '../../../../../src/api/capacity/services/treedx/repositories/treedx-authoring-journal.ts';

describe('TreeDX authoring journal', () => {
	it('persists an idempotent exact unpublished commit before success is returned', async () => {
		const store={ getProject:vi.fn().mockResolvedValue({ teamId:'team-a' }),upsertProjectTreeDxLibrary:vi.fn(),run:vi.fn().mockResolvedValue({}) };
		const input={ projectId:'project-a',repositoryId:'repo-a',commitSha:'a'.repeat(40),ref:'refs/heads/staging',
			changedPaths:['src/content/guide.mdx'],assignmentId:'assignment-a',actorType:'capacity_provider',actorId:'provider-a' };
		const first=await recordTreeDxAuthoringState(store,'unpublished',input);
		const replay=await recordTreeDxAuthoringState(store,'unpublished',input);
		expect(replay.id).toBe(first.id);
		expect(store.run).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (id) DO NOTHING'),expect.arrayContaining([
			first.id,'team-a','project-a','assignment-a','capacity_provider','provider-a','refs/heads/staging','authoring_unpublished',
		]));
		expect(store.upsertProjectTreeDxLibrary).not.toHaveBeenCalled();
	});

	it('advances the exact authoritative content ref before recording integrated state', async () => {
		const commitSha='b'.repeat(40);
		const store={
			getProject:vi.fn().mockResolvedValue({ teamId:'team-a' }),
			upsertProjectTreeDxLibrary:vi.fn().mockResolvedValue({ repositoryId:'repo-a',contentRepositoryRef:commitSha }),
			run:vi.fn().mockResolvedValue({}),
		};
		await recordTreeDxAuthoringState(store,'integrated',{ projectId:'project-a',repositoryId:'repo-a',commitSha,
			ref:'refs/heads/staging',changedPaths:['src/content/guide.mdx'],actorType:'service',actorId:'publisher' });
		expect(store.upsertProjectTreeDxLibrary).toHaveBeenCalledWith('project-a',{
			repositoryId:'repo-a',contentRepositoryRef:commitSha,
		});
		expect(store.run).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (id) DO NOTHING'),expect.arrayContaining([
			'team-a','project-a','service','publisher','refs/heads/staging','authoring_integrated',
		]));
	});

	it('records simulation integration without advancing the authoritative project ref', async () => {
		const commitSha='c'.repeat(40);
		const store={ getProject:vi.fn().mockResolvedValue({ teamId:'team-a' }),upsertProjectTreeDxLibrary:vi.fn(),run:vi.fn().mockResolvedValue({}) };
		await recordTreeDxAuthoringState(store,'integrated',{ projectId:'project-a',repositoryId:'repo-a',commitSha,
			ref:'refs/heads/assignment-a',changedPaths:['src/content/notes/a.mdx'],assignmentId:'assignment-a',
			actorType:'user',actorId:'reviewer-a',advanceProjectContentRef:false });
		expect(store.upsertProjectTreeDxLibrary).not.toHaveBeenCalled();
		expect(JSON.parse(String(store.run.mock.calls[0]?.[1]?.[8]))).toMatchObject({ advanceProjectContentRef:false });
	});

	it('does not record integration when authoritative ref advancement fails', async () => {
		const store={ getProject:vi.fn().mockResolvedValue({ teamId:'team-a' }),
			upsertProjectTreeDxLibrary:vi.fn().mockResolvedValue({ repositoryId:'repo-a',contentRepositoryRef:'a'.repeat(40) }),
			run:vi.fn() };
		await expect(recordTreeDxAuthoringState(store as any,'integrated',{ projectId:'project-a',repositoryId:'repo-a',
			commitSha:'b'.repeat(40),ref:'refs/heads/staging',changedPaths:[],actorType:'service' }))
			.rejects.toThrow('did not advance');
		expect(store.run).not.toHaveBeenCalled();
	});

	it('rejects non-immutable authoring evidence', async () => {
		const store={ getProject:vi.fn(),upsertProjectTreeDxLibrary:vi.fn(),run:vi.fn() };
		await expect(recordTreeDxAuthoringState(store as any,'unpublished',{ projectId:'project-a',repositoryId:'repo-a',commitSha:'staging',ref:'refs/heads/staging',changedPaths:[],actorType:'user' }))
			.rejects.toThrow('exact commit SHA');
		expect(store.run).not.toHaveBeenCalled();
	});

	it('reports only exact commits that have not subsequently integrated or been abandoned', async () => {
		const first='a'.repeat(40); const second='b'.repeat(40);
		const store={all:vi.fn().mockResolvedValue([
			{result_status:'authoring_unpublished',metadata_json:JSON.stringify({commitSha:first,ref:'refs/heads/one'}),created_at:'2026-08-14T00:00:00Z'},
			{result_status:'authoring_unpublished',metadata_json:JSON.stringify({commitSha:second,ref:'refs/heads/two'}),created_at:'2026-08-14T00:00:01Z'},
			{result_status:'authoring_integrated',metadata_json:JSON.stringify({commitSha:first,ref:'refs/heads/one'}),created_at:'2026-08-14T00:00:02Z'},
			{result_status:'authoring_abandoned',metadata_json:JSON.stringify({commitSha:second,ref:'refs/heads/two'}),created_at:'2026-08-14T00:00:03Z'},
			{result_status:'authoring_unpublished',metadata_json:'not-json',created_at:'2026-08-14T00:00:03Z'},
		])};
		await expect(listUnpublishedTreeDxAuthoringState(store,'project-a')).resolves.toEqual([]);
		expect(store.all).toHaveBeenCalledWith(expect.stringContaining('ORDER BY created_at ASC'),['project-a']);
	});

	it('truthfully supersedes interrupted operator authoring after exact branch-head observation',async()=>{
		const stale='a'.repeat(40);const head='b'.repeat(40);
		const store={getProject:vi.fn().mockResolvedValue({teamId:'team-a'}),upsertProjectTreeDxLibrary:vi.fn(),run:vi.fn(),all:vi.fn()
			.mockResolvedValueOnce([{result_status:'authoring_unpublished',metadata_json:JSON.stringify({repositoryId:'repo-a',commitSha:stale,ref:'refs/heads/staging',changedPaths:['src/content/agents/a.mdx']}),created_at:'2026-08-14T00:00:00Z'}])};
		const result=await reconcileSupersededTreeDxAuthoringState(store,{projectId:'project-a',repositoryId:'repo-a',ref:'refs/heads/staging',observedHead:head,actorType:'service'});
		expect(result).toEqual({observedHead:head,supersededCommits:[stale]});
		expect(store.run).toHaveBeenCalledWith(expect.any(String),expect.arrayContaining(['authoring_superseded']));
		expect(JSON.parse(String(store.run.mock.calls[0]?.[1]?.[8]))).toMatchObject({commitSha:stale,supersededBy:head,advanceProjectContentRef:false});
		expect(store.upsertProjectTreeDxLibrary).not.toHaveBeenCalled();
	});
});
