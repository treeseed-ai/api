import { TreeDxClient } from '@treeseed/sdk/treedx/client';
import { CapacityGovernanceError } from '../database.ts';
import type { DurableCapacityWorkdayRun } from '../repositories/workday-run.ts';
import type { WorkdayProject } from './workday-project-policy.ts';
import { capacityWorkdayContentRoot, capacityWorkdayRepositoryId } from './workday-project-policy.ts';
import { resolveWorkdayTreeDxConnection, type WorkdayTreeDxConnectionStore } from './workday-treedx-connection.ts';

export type TreeDxPlanningSourceType = 'objective' | 'question' | 'proposal' | 'decision-review' | 'knowledge-gap';
export interface TreeDxPlanningDemandSource {
	sourceType: TreeDxPlanningSourceType;
	sourceId: string;
	priority: number;
	payload: Record<string, unknown>;
}

const MODELS = [
	{ model: 'objective', directory: 'objectives', type: 'objective', priority: 80 },
	{ model: 'question', directory: 'questions', type: 'question', priority: 75 },
	{ model: 'proposal', directory: 'proposals', type: 'proposal', priority: 70 },
	{ model: 'decision', directory: 'decisions', type: 'decision-review', priority: 65 },
] as const;
const CLOSED = new Set(['closed', 'complete', 'completed', 'decided', 'rejected', 'cancelled', 'archived', 'superseded']);

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function id(path: string): string { return path.replace(/^.*\//u, '').replace(/\.(md|mdx)$/u, ''); }

export async function listTreeDxPlanningDemandSources(
	store: WorkdayTreeDxConnectionStore,
	run: DurableCapacityWorkdayRun,
	project: WorkdayProject,
): Promise<TreeDxPlanningDemandSource[]> {
	const library = await store.getProjectTreeDxLibrary(project.id);
	const topology = record(library?.topology);
	const contentRepository = record(topology.contentRepository);
	const treeDx = record(contentRepository.treeDx);
	if (!text(library?.repositoryId ?? treeDx.repositoryId)) return [];
	const connection = await resolveWorkdayTreeDxConnection(store, {
		projectId: project.id, repositoryId: capacityWorkdayRepositoryId(project, run.parameters), runId: run.id,
		capabilities: ['repos:read', 'files:read', 'files:search'],
	});
	if (!connection) return [];
	const client = new TreeDxClient({ ...connection, repoId: connection.repositoryId, timeoutMs: 15_000, fetch: connection.fetchImpl });
	const root = capacityWorkdayContentRoot(project).replace(/\/+$/u, '');
	const sources: TreeDxPlanningDemandSource[] = [];
	try {
		for (const model of MODELS) {
			const response = await client.searchRepositoryFiles({
				ref: 'refs/heads/main', paths: [`${root}/${model.directory}/**`], query: '', limit: 50,
				includeBody: true, includeFrontmatter: true,
			});
			for (const candidate of response.results ?? response.files ?? []) {
				const file = record(candidate); const frontmatter = record(file.frontmatter);
				const status = text(frontmatter.status).toLowerCase();
				if (CLOSED.has(status)) continue;
				const path = text(file.path); if (!path) continue;
				const sourceType = model.model === 'question' && ['gap', 'knowledge-gap', 'research-gap'].includes(text(frontmatter.question_type ?? frontmatter.questionType).toLowerCase())
					? 'knowledge-gap' : model.type;
				sources.push({
					sourceType, sourceId: `${model.model}:${id(path)}`, priority: model.priority,
					payload: { model: model.model, contentPath: path, title: text(frontmatter.title), status: status || null,
						body: text(file.body), frontmatter, planningSource: 'treedx-content' },
				});
			}
		}
	} catch (error) {
		throw new CapacityGovernanceError('capacity_workday_treedx_demand_query_failed', 'TreeDX could not compile project planning demand.', 503, {
			projectId: project.id, repositoryId: connection.repositoryId, details: error instanceof Error ? error.message : String(error),
		});
	}
	return sources.sort((left, right) => right.priority - left.priority || left.sourceId.localeCompare(right.sourceId));
}
