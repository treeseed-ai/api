import { parseBook, parseKnowledgePage, validateKnowledgeCatalog } from './runtime/catalog.ts';
import type { KnowledgeSnapshotProject } from './packs/knowledge-pack-builder.ts';
import { projectLibraryPath, resolveKnowledgeGatewayConnection } from './gateway-treedx-connection.ts';
import { listKnowledgeContentPaths } from './read-model/repository-paths.ts';

async function documents(connection: any, resolvedRef: string, paths: string[]) {
	const files: any[] = [];
	for (let index = 0; index < paths.length; index += 100) {
		const response = await connection.client.readRepositoryFiles({
			repoId: connection.repositoryId, ref: resolvedRef, paths: paths.slice(index, index + 100), parseFrontmatter: false,
		});
		if (String(response.resolvedRef ?? '') !== resolvedRef) {
			throw new Error('The knowledge source changed while the snapshot was loading.');
		}
		files.push(...(response.files ?? []));
	}
	return files;
}

export async function loadKnowledgeSnapshotProjects(store: any, input: {
	teamId: string; projectIds?: Set<string>;
}): Promise<KnowledgeSnapshotProject[]> {
	// Publication is a team-level control-plane operation. Its source closure must
	// not shrink because the requesting author's membership changes while the
	// operation is running.
	const projects = (await store.listTeamProjects(input.teamId))
		.filter((project: any) => !input.projectIds || input.projectIds.has(project.id));
	const snapshots: KnowledgeSnapshotProject[] = [];
	for (const project of projects) {
		const observedConnection = await resolveKnowledgeGatewayConnection(store, { projectId: project.id, write: false });
		if (!observedConnection) {
			throw new Error(`TreeDX repository is unavailable for team project ${project.id}; the federated publication was not changed.`);
		}
		const listed = await listKnowledgeContentPaths(observedConnection);
		const commitSha = listed.resolvedRef;
		if (!commitSha) throw new Error(`TreeDX did not resolve an exact source commit for project ${project.id}.`);
		const connection = await resolveKnowledgeGatewayConnection(store, {
			projectId: project.id, write: false, readRefs: [commitSha],
		});
		if (!connection || connection.repositoryId !== observedConnection.repositoryId
			|| connection.contentPath !== observedConnection.contentPath) {
			throw new Error(`The knowledge repository binding changed while project ${project.id} was loading.`);
		}
		const paths = (listed.entries ?? []).map((entry: any) => String(entry.path ?? '')).filter(Boolean);
		const bookRoot = `${projectLibraryPath(connection.contentPath, 'books')}/`;
		const pageRoot = `${projectLibraryPath(connection.contentPath, 'knowledge')}/`;
		const [bookFiles, pageFiles] = await Promise.all([
			documents(connection, commitSha, paths.filter((path: string) => path.startsWith(bookRoot))),
			documents(connection, commitSha, paths.filter((path: string) => path.startsWith(pageRoot))),
		]);
		const books = bookFiles.map((file) => parseBook({ path: String(file.path), raw: String(file.content ?? '') }));
		const pages = pageFiles.map((file) => ({
			definition: parseKnowledgePage({ path: String(file.path), raw: String(file.content ?? ''), sourcePackage: project.id }),
			source: String(file.content ?? ''), sourcePath: String(file.path),
		}));
		validateKnowledgeCatalog(books, pages.map((page) => page.definition));
		snapshots.push({
			teamId: input.teamId, projectId: project.id, repositoryId: connection.repositoryId, commitSha,
			books, pages, bookSourcePaths: Object.fromEntries(bookFiles.map((file, index) => [books[index]!.id, String(file.path)])),
		});
	}
	return snapshots;
}
