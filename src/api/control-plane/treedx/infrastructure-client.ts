import type { TreeDxClient } from '@treeseed/treedx/treedx/client';
import { requireTreeDxOperation } from './upstream-operation.ts';

type Input = Record<string, any>;

/**
 * API-internal semantic adapter for the official TreeDX transport.
 *
 * This is deliberately not exported from the API package. It keeps application
 * services independent of generated adapter grouping while ensuring every
 * downstream call still goes through the authoritative TreeDX client.
 */
export class TreeDxInfrastructureClient {
	constructor(readonly upstream: TreeDxClient, private readonly defaultRepositoryId?: string) {}
	private repositoryId(value: unknown) {
		const repositoryId = typeof value === 'string' && value ? value : this.defaultRepositoryId;
		if (!repositoryId) throw new Error('TreeDX repository scope is required.');
		return repositoryId;
	}

	createWorkspace(input: Input) {
		const { repoId, ...body } = input;
		return this.upstream.workspaces.create(this.repositoryId(repoId), body) as Promise<any>;
	}
	closeWorkspace(workspaceId: string, input?: Input) { return this.upstream.workspaces.close(workspaceId, input) as Promise<any>; }
	readFile(input: Input) { const { workspaceId, ...query } = input; return this.upstream.files.read(String(workspaceId), query) as Promise<any>; }
	status(input: Input) { return this.upstream.files.status(String(input.workspaceId)) as Promise<any>; }
	diff(input: Input) { const { workspaceId, ...query } = input; return this.upstream.files.diff(String(workspaceId), query) as Promise<any>; }
	applyChangeset(input: Input) { const { workspaceId, ...body } = input; return this.upstream.files.changeset(String(workspaceId), body) as Promise<any>; }
	commit(input: Input) { const { workspaceId, ...body } = input; return this.upstream.files.commit(String(workspaceId), body) as Promise<any>; }

	getRepository(repoId: string) { return this.upstream.repositories.get(repoId) as Promise<any>; }
	push(input: Input) { const { repoId, ...body } = input; return this.upstream.repositories.push(String(repoId), body) as Promise<any>; }
	fetchRemote(input: Input) { const { repoId, ...body } = input; return this.upstream.repositories.sync(String(repoId), body) as Promise<any>; }
	promoteRef(input: Input) {
		const { repoId, ...body } = input;
		const operation = requireTreeDxOperation('promoteRepositoryRef');
		return this.upstream.operation<any>(operation.method, operation.path, { pathParams: { repo_id: repoId }, body });
	}
	retireRef(input: Input) {
		const { repoId, ...body } = input;
		const operation = requireTreeDxOperation('retireRepositoryRef');
		return this.upstream.operation<any>(operation.method, operation.path, { pathParams: { repo_id: repoId }, body });
	}
	getPlacement(repoId: string) { return this.upstream.registry.getPlacement(repoId) as Promise<any>; }

	readRepositoryFile(input: Input) { const { repoId, ...body } = input; return this.upstream.query.readFile(this.repositoryId(repoId), body) as Promise<any>; }
	readRepositoryFiles(input: Input) { const { repoId, ...body } = input; return this.upstream.query.repository(this.repositoryId(repoId), { ...body, type: body.type ?? 'files' }) as Promise<any>; }
	listRepositoryPaths(input: Input) { const { repoId, ...body } = input; return this.upstream.query.listPaths(this.repositoryId(repoId), body) as Promise<any>; }
	searchRepositoryFiles(input: Input) { const { repoId, ...body } = input; return this.upstream.query.searchFiles(this.repositoryId(repoId), body) as Promise<any>; }
	queryRepository(input: Input) { const { repoId, ...body } = input; return this.upstream.query.repository(this.repositoryId(repoId), body) as Promise<any>; }

	refreshGraph(input: Input) { const { repoId, ...body } = input; return this.upstream.graph.refresh(String(repoId), body) as Promise<any>; }
	getGraphRefreshJob(input: Input) { return this.upstream.graph.refreshJob(String(input.repoId), String(input.jobId)) as Promise<any>; }
	getRelated(input: Input) { const { repoId, ...body } = input; return this.upstream.graph.related(String(repoId), body) as Promise<any>; }
	searchGraphSections(input: Input) { const { repoId, ...body } = input; return this.upstream.graph.searchSections(String(repoId), body) as Promise<any>; }
	buildContext(input: Input) { const { repoId, ...body } = input; return this.upstream.context.build(String(repoId), body) as Promise<any>; }
	refreshSearchIndex(input: Input) { const { repoId, ...body } = input; return this.upstream.searchIndex.refresh(String(repoId), body) as Promise<any>; }
}
