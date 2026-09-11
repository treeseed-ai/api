import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { createHash } from 'node:crypto';
import { CapacityGovernanceError } from '../../../../database.ts';
import type { DurableCapacityWorkdayRun } from '../../../../repositories/capacity/workdays/workday-run.ts';
import type { WorkdayProject } from '../policy/workday-project-policy.ts';
import { canonicalTreeDxBranchRef, projectLibraryPath } from '../../../../../knowledge/gateway-treedx-connection.ts';
import { resolveWorkdayTreeDxConnection,type WorkdayTreeDxConnectionStore } from '../treedx/workday-treedx-connection.ts';

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
		projectId: project.id, runId: run.id,
		capabilities: ['repos:read', 'files:read', 'files:search'],
	});
	if (!connection) return [];
	const client = connection.client;
	const root = text(library?.contentPath);
	const selectedRef = text(library?.contentRepositoryRef) || text(library?.contentRepositoryDefaultBranch);
	if (!selectedRef) throw new CapacityGovernanceError('capacity_workday_content_ref_missing', 'The project library has no selected content ref.', 409, { projectId: project.id });
	let ref = /^[a-f0-9]{40}$/u.test(selectedRef) ? selectedRef : canonicalTreeDxBranchRef(selectedRef);
	let snapshot = /^[a-f0-9]{40}$/u.test(ref) ? ref : '';
	const selectedObjectives = new Set((Array.isArray(run.parameters.objectiveRefs) ? run.parameters.objectiveRefs : [])
		.map((value) => text(value).replace(/^objective:/u, '')).filter(Boolean));
	const sources: TreeDxPlanningDemandSource[] = [];
	try {
		for (const model of MODELS) {
			const response = await client.searchRepositoryFiles({
				ref, paths: [projectLibraryPath(root, model.directory, '**')], query: '', limit: 50,
				includeBody: true, includeFrontmatter: true,
			});
			const resolved = text(response.resolvedRef);
			if (!/^[a-f0-9]{40}$/u.test(resolved) || (snapshot && resolved !== snapshot)) throw new CapacityGovernanceError(
				'capacity_workday_content_snapshot_invalid', 'TreeDX planning collections must resolve to one immutable content revision.', 409,
				{ projectId: project.id, repositoryId: connection.repositoryId });
			ref = snapshot = resolved;
			const candidates = response.results ?? response.files ?? [];
			const digests = new Map<string, string>();
			if (model.model === 'proposal' && candidates.length) {
				const raw = await client.readRepositoryFiles({ ref: snapshot, paths: candidates.map((file: unknown) => text(record(file).path)), encoding: 'utf8', parseFrontmatter: false, allowProtected: true });
				if (raw.resolvedRef !== snapshot) throw new CapacityGovernanceError('capacity_workday_content_snapshot_invalid', 'Proposal bytes must match the planning snapshot.', 409, { projectId: project.id });
				for (const file of raw.files ?? []) if (typeof file.content === 'string') digests.set(text(file.path), createHash('sha256').update(file.content).digest('hex'));
			}
			for (const candidate of candidates) {
				const file = record(candidate); const frontmatter = record(file.frontmatter); const path = text(file.path);
				if (!path) continue;
				if (model.model === 'proposal' && !digests.has(path)) throw new CapacityGovernanceError('capacity_workday_content_snapshot_invalid', 'Proposal source bytes are missing from the planning snapshot.', 409, { projectId: project.id });
				const validation = validatePortableContentData(model.model, frontmatter);
				if (!validation.ok) throw new CapacityGovernanceError('capacity_workday_content_model_invalid', 'TreeDX planning content failed model validation.', 409, {
					projectId: project.id, repositoryId: connection.repositoryId, path, model: model.model, diagnostics: validation.diagnostics,
				});
				const status = text(frontmatter.status).toLowerCase();
				if (CLOSED.has(status)) continue;
				if (model.model === 'objective' && selectedObjectives.size && !selectedObjectives.has(id(path))) continue;
				const sourceType = model.model === 'question' && text(frontmatter.question_type ?? frontmatter.questionType).toLowerCase() === 'knowledge-gap'
					? 'knowledge-gap' : model.type;
				sources.push({
					sourceType, sourceId: `${model.model}:${id(path)}`, priority: model.priority,
					payload: { model: model.model, contentPath: path, contentBaseRef: snapshot, commitSha: snapshot, digest: digests.get(path), title: text(frontmatter.title), status: status || null,
						body: text(file.body), frontmatter, planningSource: 'treedx-content' },
				});
			}
		}
	} catch (error) {
		if (error instanceof CapacityGovernanceError) throw error;
		throw new CapacityGovernanceError('capacity_workday_treedx_demand_query_failed', 'TreeDX could not compile project planning demand.', 503, {
			projectId: project.id, repositoryId: connection.repositoryId, details: error instanceof Error ? error.message : String(error),
		});
	}
	return sources.sort((left, right) => right.priority - left.priority || left.sourceId.localeCompare(right.sourceId));
}
