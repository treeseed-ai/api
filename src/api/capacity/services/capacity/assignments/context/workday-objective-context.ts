import { createHash } from 'node:crypto';
import type { ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { validateContentFrontmatter } from '@treeseed/sdk/content-validation';
import { CapacityGovernanceError } from '../../../../database.ts';
import { parseFrontmatterDocument } from '../../../../../content/frontmatter.ts';
import { projectLibraryPath, resolveKnowledgeGatewayConnection } from '../../../../../knowledge/gateway-treedx-connection.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const invalid = (message: string): never => {
	throw new CapacityGovernanceError('execution_node_workday_objective_invalid', message, 409);
};

/** Resolve objective identities at the workday's existing immutable project view. */
export async function workdayObjectiveContext(store: any, projectId: string, selectors: unknown,
	context: ExactEntityReference): Promise<ExactEntityReference[]> {
	if (selectors === undefined) return [];
	if (!Array.isArray(selectors) || selectors.some(id => typeof id !== 'string' || !id || id !== id.trim())) {
		return invalid('Selected workday objectives must be exact nonempty identifiers.');
	}
	if (!selectors.length) return [];
	if (context.store !== 'treedx' || !context.repository || !/^[a-f0-9]{40}$/u.test(context.commit ?? '')) {
		return invalid('Selected workday objectives require the original exact project context.');
	}
	const connection = await resolveKnowledgeGatewayConnection(store, {
		projectId, write: false, relationPaths: true, readRefs: [context.commit!],
	});
	if (!connection || connection.repositoryId !== context.repository) {
		return invalid('The selected workday objective repository binding is unavailable or changed.');
	}
	const root = projectLibraryPath(connection.contentPath, 'objectives');
	const references: ExactEntityReference[] = [];
	for (const id of new Set<string>(selectors)) {
		const response = record(await connection.client.queryRepository({ repoId: context.repository,
			ref: context.commit, type: 'frontmatter', paths: [`${root}/**`],
			filters: [{ field: 'frontmatter.id', op: 'eq', value: id }], limit: 2 }));
		const results = Array.isArray(response.results) ? response.results.map(record) : [];
		const page = record(response.page);
		if (response.resolvedRef !== context.commit || results.length !== 1 || page.hasMore === true || page.nextCursor) {
			return invalid('A selected workday objective did not resolve to one exact project document.');
		}
		const path = results[0]!.path;
		if (typeof path !== 'string' || !path.startsWith(`${root}/`) || path.includes('\\')
			|| path.split('/').some(part => !part || part === '.' || part === '..')) {
			return invalid('The selected workday objective returned a path outside its project collection.');
		}
		const read = record(await connection.client.readRepositoryFile({ repoId: context.repository,
			ref: context.commit, path, encoding: 'utf8', parseFrontmatter: true, allowProtected: true }));
		const file = record(read.file), source = file.content;
		if (read.resolvedRef !== context.commit || file.path !== path || typeof source !== 'string' || !source) {
			return invalid('The selected workday objective changed during exact source read-back.');
		}
		const definition = record(parseFrontmatterDocument(source).frontmatter);
		if (!validateContentFrontmatter('objective', definition).ok || definition.id !== id || definition.projectId !== projectId) {
			return invalid('The selected workday objective does not match its canonical identity and project.');
		}
		references.push({ store: 'treedx', model: 'objective', id, repository: context.repository,
			commit: context.commit, path, digest: `sha256:${createHash('sha256').update(source).digest('hex')}` });
	}
	return references;
}
