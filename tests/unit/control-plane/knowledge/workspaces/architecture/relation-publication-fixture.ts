import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relationAuthoringDatabase } from './relation-authoring-fixture.ts';
import { createLocalKnowledgePublicationStorage } from '../../../../../../src/api/knowledge/publication-storage.ts';
import { createKnowledgePublicationExecutor, completedGraphRefresh } from '../../../../../../src/operations-runner/knowledge/publication-executor.ts';
import { DirectControlPlaneRunnerClient } from '../../../../../../src/operations-runner/client/direct-control-plane-runner-client.ts';
import { runPlatformOperationOnce } from '../../../../../../src/operations-runner/entrypoint-support/operations/operation-execution.ts';
import { loadTeamExactDependencyLinks } from '../../../../../../src/api/capacity/services/capacity/execution/exact-dependency-links.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../../src/api/knowledge/gateway-treedx-connection.ts';

// Same native fixture, official SDK, original SQL and existing local runner/storage.
// Only these fresh managed repositories are in scope. No external publication,
// alternate executor, mocked checkpoint, fabricated review or provider outcome.
export async function relationPublicationDatabase() {
	const root = await mkdtemp(join(tmpdir(), 'api-relation-publication-'));
	const originalRoot = process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT;
	process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT = root;
	let fixture: Awaited<ReturnType<typeof relationAuthoringDatabase>> | undefined;
	const restore = () => { if (originalRoot === undefined) delete process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT;
		else process.env.TREESEED_PUBLISHED_KNOWLEDGE_ROOT = originalRoot; };
	try {
		const f = await relationAuthoringDatabase(); fixture = f;
		const storage = createLocalKnowledgePublicationStorage();
		const client = new DirectControlPlaneRunnerClient(f.store, false), runnerId = 'isolated-relation-publication';
		await client.register({ runnerId, environment: 'local', capabilities: ['knowledge:publish_review'], maxConcurrentJobs: 1 });
		const executor = createKnowledgePublicationExecutor({ controlPlaneStore: f.store, environment: 'local', knowledgePublicationStorage: storage });
		const submit = (workspace: { id: string; version: number }) => f.service.submit(f.principal, workspace.id,
			{ version: workspace.version, message: 'Publish exact native dependency Note' });
		const run = (operationId: string) => runPlatformOperationOnce({ client, runnerId, operationId, executors: [executor], environment: 'local' });
		const load = async () => {
			// The unchanged selected secondary library also needs its real empty index;
			// never supply a graph response to the owning loader.
			const secondary = await resolveKnowledgeGatewayConnection(f.store, { projectId: 'dependent', write: true }); assert.ok(secondary);
			await completedGraphRefresh(secondary.client, { repoId: secondary.repositoryId, ref: secondary.publicationRef, paths: ['notes/**'] });
			return loadTeamExactDependencyLinks(f.store, f.sources);
		};
		const close = async () => {
			const failures: unknown[] = [];
			try { await f.close(); } catch (error) { failures.push(error); }
			try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
			restore(); if (failures.length) throw new AggregateError(failures, 'Relation publication cleanup failed');
		};
		return { ...f, storage, runnerClient: client, submit, run, load, root, close };
	} catch (error) {
		const failures: unknown[] = [error];
		try { await fixture?.close(); } catch (cleanup) { failures.push(cleanup); }
		try { await rm(root, { recursive: true, force: true }); } catch (cleanup) { failures.push(cleanup); }
		restore(); throw new AggregateError(failures, 'Native relation publication setup failed');
	}
}
