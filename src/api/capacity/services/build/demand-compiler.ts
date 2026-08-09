import { evaluatePlanningGraphNodeInstances } from '@treeseed/sdk/agent-capacity';
import { createHash } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { CapacityWorkdayDemandRepository } from '../../repositories/capacity/workdays/workday-demand.ts';
import { CapacityWorkdayParticipationRepository } from '../../repositories/capacity/workdays/workday-participation.ts';
import { CapacityWorkdayRunRepository,type DurableCapacityWorkdayRun } from '../../repositories/capacity/workdays/workday-run.ts';
import type { ProviderLeasePrincipal } from '../accounts/lease-authority-service.ts';
import { resolveCapacityWorkdayAssignmentIntent } from '../capacity/workdays/assignments/workday-assignment-context-service.ts';
import { capacityWorkdayPlanningStage,capacityWorkdayRequiredSignals } from '../capacity/workdays/policy/workday-agent-policy.ts';
import { decodeWorkdayPlanningGraphSnapshot } from '../capacity/workdays/policy/workday-planning-graph-policy.ts';
import {
capacityWorkdayContentRoot,
capacityWorkdayRepositoryId,
capacityWorkdayRequestedProjectSlugs,
resolveCapacityWorkdayProjects,
type WorkdayProject,
} from '../capacity/workdays/policy/workday-project-policy.ts';
import { listActingDemandSources } from '../support/acting-demand-source.ts';
import { resolvePlanningDemandSource } from '../support/planning-demand-source.ts';
import { loadPlanningGraphEvidence,planningGraphGroupContext,selectedPlanningGraphInputs } from './planning-graph-evidence.ts';
import { currentCooperativePlanningWave } from '../capacity/workdays/scheduling/cooperative-planning-session-service.ts';

interface DemandCompilerStore extends CapacityGovernanceDatabase {
	listTeamProjects(teamId: string): Promise<WorkdayProject[]>;
}

function id(prefix: string, value: string): string {
	return `${prefix}_${createHash('sha256').update(value).digest('base64url').slice(0, 32)}`;
}
function text(value: unknown): string {
	return typeof value === 'string' && value.trim() ? value.trim() : '';
}
function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function jsonRecord(value: unknown) { if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; } return record(value); }
function profileCapacityEnvelope(agent: { execution: Record<string, unknown> }) {
	const execution = record(agent.execution); const totalTokens = Number(execution.maxTotalTokens); const warningTokens = Number(execution.warningTokens); const maxCost = Number(execution.maxCostAmount);
	return { budget: {
		schemaVersion: 'treeseed.capacity-budget/v2',
		tokens: { hardLimitTokens: Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 136_000, warningTokens: Number.isFinite(warningTokens) && warningTokens > 0 ? warningTokens : 100_000, hardLimitEnforceable: true },
		...(Number.isFinite(maxCost) && maxCost >= 0 ? { cost: { amount: 0, currency: text(execution.costCurrency) || 'USD', hardLimitAmount: maxCost, hardLimitEnforceable: execution.enforcementConfidence === 'exact' } } : {}),
		native: Array.isArray(execution.nativeLimits) ? execution.nativeLimits.map((entry) => { const limit = record(entry); return { unit: text(limit.unit), observed: 0, cap: Number(limit.amount), capEnforceable: limit.enforceable === true }; }).filter((entry) => entry.unit && Number.isFinite(entry.cap)) : [],
		pricingGeneration: text(execution.pricingGeneration) || null, enforcementConfidence: text(execution.enforcementConfidence) || 'bounded',
		maxAttempts: Math.max(1, Number(execution.maxRetries ?? 0) + 1), maxConcurrency: 1,
	} };
}
export function capacityWorkdayContentBaseRef(environment: string, branchPolicy: Record<string, unknown>): string {
	if (environment === 'local') return 'refs/heads/main';
	const base = text(branchPolicy.base);
	if (!base) return 'refs/heads/main';
	return base.startsWith('refs/') || /^[0-9a-f]{40}$/iu.test(base) ? base : `refs/heads/${base}`;
}
function deadlineOpen(run: DurableCapacityWorkdayRun, now: string): boolean {
	const configured = run.parameters.deadlineAt;
	if (configured === null || configured === undefined || configured === '') return true;
	const parsed = Date.parse(String(configured));
	if (!Number.isFinite(parsed)) throw new CapacityGovernanceError('capacity_workday_synthesis_parameter_invalid', 'Capacity workday deadlineAt is invalid.', 500, { runId: run.id, deadlineAt: configured });
	return parsed > Date.parse(now);
}

function nestedNumber(value: unknown, ...keys: string[]) { let current: unknown = value; for (const key of keys) current = record(current)[key]; const parsed = Number(current); return Number.isFinite(parsed) && parsed > 0 ? parsed : 0; }
export async function estimateRequestedAgentSeconds(store: CapacityGovernanceDatabase, agent: { activityType: string; execution: Record<string, unknown> }, payload: Record<string, unknown>) {
	const override = Number(payload.requestedSeconds);
	if (Number.isInteger(override) && override > 0) return { seconds: override, method: 'assignment-override', sampleSize: 0 };
	const timebox = Number(agent.execution.timeboxSeconds);
	if (Number.isInteger(timebox) && timebox > 0) return { seconds: timebox, method: 'activity-profile-timebox', sampleSize: 0 };
	const targetContextBytes = Number(payload.contextSizeBytes ?? payload.contextBytes) || nestedNumber(payload, 'contextPack', 'totalBytes');
	const rows = await store.all(`SELECT usage.active_seconds,usage.input_tokens,usage.output_tokens,usage.cached_input_tokens,usage.reasoning_tokens,usage.actual_usd,usage.execution_provider_id,usage.model_name,usage.metadata_json,run.selected_input_json FROM capacity_usage_actuals usage
		JOIN capacity_workday_demands demand ON demand.assignment_id = usage.assignment_id
		LEFT JOIN agent_mode_runs run ON run.id = usage.mode_run_id
		WHERE demand.activity_type = ? AND usage.active_seconds > 0 ORDER BY usage.created_at DESC LIMIT 200`, [agent.activityType]);
	const samples = rows.filter((row) => {
		if (!targetContextBytes) return true; const metadata = jsonRecord(row.metadata_json); const selected = jsonRecord(row.selected_input_json); const observed = Number(metadata.contextSizeBytes ?? metadata.contextBytes) || nestedNumber(selected, 'contextPack', 'totalBytes'); return observed > 0 && observed >= targetContextBytes * .5 && observed <= targetContextBytes * 2;
	});
	const percentile = (values: number[], quantile: number) => { const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] : null; };
	const seconds = samples.map((row) => Number(row.active_seconds)).filter((value) => Number.isInteger(value) && value > 0);
	const tokenTotals = samples.map((row) => Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0) + Number(row.reasoning_tokens ?? 0));
	const costs = samples.map((row) => Number(row.actual_usd)).filter((value) => Number.isFinite(value) && value >= 0);
	if (samples.length >= 5) return { seconds: percentile(seconds, .9)!, method: 'historical-p90', sampleSize: samples.length, contextSizeBytes: targetContextBytes || null, recommendations: { p50Seconds: percentile(seconds, .5), p90Seconds: percentile(seconds, .9), p50Tokens: percentile(tokenTotals, .5), p90Tokens: percentile(tokenTotals, .9), p50Cost: percentile(costs, .5), p90Cost: percentile(costs, .9) } };
	const configured = Number(agent.execution.maxRuntimeSeconds);
	return { seconds: Number.isInteger(configured) && configured > 0 ? configured : 900, method: configured > 0 ? 'conservative-profile-default' : 'conservative-system-default', sampleSize: samples.length, recommendations: null };
}

async function activeEnvelope(database: CapacityGovernanceDatabase, run: DurableCapacityWorkdayRun, projectId: string) {
	const rows = await database.all(
		`SELECT id FROM workday_capacity_envelopes WHERE team_id = ? AND project_id = ? AND workday_run_id = ? AND status = 'active' ORDER BY id ASC LIMIT 2`,
		[run.teamId, projectId, run.id],
	);
	if (rows.length > 1) throw new CapacityGovernanceError('capacity_workday_envelope_ambiguous', 'A workday run has multiple active envelopes for one project.', 500, { runId: run.id, projectId });
	return rows[0]?.id ? String(rows[0].id) : null;
}

async function completedEquivalentPlanningDemand(
	store: CapacityGovernanceDatabase,
	input: { runId: string; projectId: string; agentId: string; activityType: string; sourceType: string; sourceId: string },
) {
	return Boolean(await store.first(
		`SELECT id FROM capacity_workday_demands
		 WHERE workday_run_id = ? AND project_id = ? AND agent_id = ? AND activity_type = ?
		   AND source_type = ? AND source_id = ? AND status = 'completed'
		 LIMIT 1`,
		[input.runId, input.projectId, input.agentId, input.activityType, input.sourceType, input.sourceId],
	));
}

async function compilePlanningDemands(
	store: DemandCompilerStore,
	run: DurableCapacityWorkdayRun,
	project: WorkdayProject,
	workdayId: string,
	now: string,
	wave: { id: string; round: number; nodeIds: string[]; snapshotRef?: string; snapshot?: Record<string, unknown> } | null,
) {
	const snapshot = decodeWorkdayPlanningGraphSnapshot(record(run.parameters.planningGraphByProjectId)[project.id], project.id);
	const { agents, graph } = snapshot;
	const graphEvidence = await loadPlanningGraphEvidence(store, run, project.id);
	const groupContext = planningGraphGroupContext(project.id, snapshot);
	const instances = new Map(agents.flatMap((agent) => {
		const graphNodeId = agent.nodeId;
		if (wave && !wave.nodeIds.includes(`${project.id}:${graphNodeId}`)) return [];
		return evaluatePlanningGraphNodeInstances(graph, graphNodeId, graphEvidence, groupContext).map((instance) => {
			const participationId = instance.instanceKey === 'single' ? graphNodeId : `${graphNodeId}@${id('instance', instance.instanceKey)}`;
			return [participationId, { agent, graphNodeId, ...instance }] as const;
		});
	}));
	const participation = new CapacityWorkdayParticipationRepository(store);
	const { cycle, entries } = await participation.ensureOpenCycle({
		teamId: run.teamId, projectId: project.id, workdayRunId: run.id, now,
		agents: [...instances.entries()].map(([participationId, instance]) => ({
			agentId: participationId, projectAgentClassId: instance.agent.projectAgentClassId,
			eligible: Boolean(instance.agent.projectAgentClassId && instance.agent.handler),
			reasonCode: instance.agent.projectAgentClassId && instance.agent.handler ? null : 'agent_activity_profile_invalid',
			metadata: { agentId: instance.agent.slug, activityType: instance.agent.activityType, handlerId: instance.agent.handler,
				planningStage: capacityWorkdayPlanningStage(instance.agent), planningGraphNodeId: instance.graphNodeId, planningGraphInstanceKey: instance.instanceKey },
		})),
	});
	const demandRepository = new CapacityWorkdayDemandRepository(store);
	let created = 0;
	for (const entry of entries.filter((value) => value.status === 'pending' && !value.demandId)) {
		const instance = instances.get(entry.agentId);
		if (!instance) continue;
		const { agent, graphNodeId } = instance;
		const planningStage = capacityWorkdayPlanningStage(agent);
		const graphInputs = selectedPlanningGraphInputs(instance.matched);
		const intent = await resolveCapacityWorkdayAssignmentIntent(store, run, project, agent, graphInputs);
		const resolvedSource = await resolvePlanningDemandSource(store, run, project, agent, intent);
		const source = instance.instanceKey === 'single' ? resolvedSource : {
			...resolvedSource,
			sourceType: 'handoff' as const,
			sourceId: `planning-graph:${instance.instanceKey}`,
			payload: { ...resolvedSource.payload, planningGraphInputRecordId: instance.instanceKey },
		};
		if (await completedEquivalentPlanningDemand(store, {
			runId: run.id,
			projectId: project.id,
			agentId: agent.slug,
			activityType: agent.activityType,
			sourceType: source.sourceType,
			sourceId: source.sourceId,
		})) continue;
		const idempotencyKey = `workday:${run.id}:${project.id}:${wave ? `wave:${wave.id}` : `cycle:${cycle.cycleNumber}`}:node:${entry.agentId}`;
		const sessionTimebox = Number(record(run.parameters.planningSession).assignmentTimeboxSeconds);
		const estimate = await estimateRequestedAgentSeconds(store, agent, source.payload);
		const requestedSeconds = Number.isInteger(sessionTimebox) && sessionTimebox > 0 ? Math.min(estimate.seconds, sessionTimebox) : estimate.seconds;
		const demand = await demandRepository.create({
			id: id('demand', idempotencyKey), teamId: run.teamId, projectId: project.id, workdayRunId: run.id, workdayId,
			sourceType: source.sourceType, sourceId: source.sourceId, mode: 'planning',
			projectAgentClassId: agent.projectAgentClassId, agentId: agent.slug, handlerId: agent.handler,
			activityType: agent.activityType, decisionId: source.decisionId, priority: source.priority,
			requestedSeconds, idempotencyKey,
			payload: {
				...source.payload, stageInstructions: agent.promptTask, repositoryId: capacityWorkdayRepositoryId(project, run.parameters),
				capacityEnvelope: profileCapacityEnvelope(agent),
				contentRoot: capacityWorkdayContentRoot(project), agentContentPath: agent.contentPath,
				contentBaseRef: capacityWorkdayContentBaseRef(run.environment, agent.branchPolicy),
				contentBranchPolicy: agent.branchPolicy,
				contentAccess: agent.contentAccess,
				signalPolicy: agent.signalPolicy,
				signalContracts: Object.fromEntries([
					...capacityWorkdayRequiredSignals(agent),
					...(Array.isArray(record(agent.signalPolicy).publishes) ? record(agent.signalPolicy).publishes as string[] : []),
				].map((contractId) => [contractId, snapshot.signalContracts[contractId]]).filter((entry) => Boolean(entry[1]))),
				outputContract: agent.outputContract,
				planningGraph: { revision: snapshot.revision, nodeId: graphNodeId, instanceKey: instance.instanceKey, predecessorNodeIds: instance.matched.map((value) => value.nodeId), inputs: graphInputs },
				cooperativePlanning: wave ? { sessionWaveId: wave.id, round: wave.round, snapshotRef: wave.snapshotRef, snapshot: wave.snapshot } : null,
				cycle: cycle.cycleNumber,
			},
			metadata: { participationCycleId: cycle.id, participationEntryId: entry.id, environment: run.environment, agentClassSlug: agent.projectAgentClassSlug, requiredCapabilities: Array.isArray(agent.execution.requiredCapabilities) ? agent.execution.requiredCapabilities : [], planningStage, planningGraphNodeId: graphNodeId, planningWaveId: wave?.id ?? null, planningRound: wave?.round ?? null, planningSnapshotRef: wave?.snapshotRef ?? null, admissionEstimate: { ...estimate, requestedSeconds, sessionCapSeconds: Number.isInteger(sessionTimebox) && sessionTimebox > 0 ? sessionTimebox : null } }, availableAt: now, now,
		});
		await participation.bindDemand(entry.id, demand.id, now);
		created += 1;
	}
	return created;
}

async function compileActingDemands(
	store: DemandCompilerStore,
	run: DurableCapacityWorkdayRun,
	project: WorkdayProject,
	workdayId: string,
	now: string,
) {
	const repository = new CapacityWorkdayDemandRepository(store);
	let created = 0;
	for (const source of await listActingDemandSources(store, run, project, workdayId)) {
		const idempotencyKey = `workday:${run.id}:capacity-plan:${source.capacityPlanId}:unit:${source.sourceId}`;
		await repository.create({
			id: id('demand', idempotencyKey), teamId: run.teamId, projectId: project.id, workdayRunId: run.id, workdayId,
			sourceType: source.sourceType, sourceId: source.sourceId, mode: 'acting',
			projectAgentClassId: source.projectAgentClassId, agentId: source.agentId, handlerId: source.handlerId,
			activityType: source.activityType, decisionId: source.decisionId, capacityPlanId: source.capacityPlanId,
			priority: source.priority, requestedSeconds: source.requestedSeconds, idempotencyKey,
			payload: {
				...source.payload, repositoryId: capacityWorkdayRepositoryId(project, run.parameters),
				contentRoot: capacityWorkdayContentRoot(project),
			},
			metadata: { requiredCapabilities: source.requiredCapabilities, environment: run.environment }, availableAt: now, now,
		});
		created += 1;
	}
	return created;
}

export async function compileProviderWorkdayDemand(
	store: DemandCompilerStore,
	principal: ProviderLeasePrincipal,
	now = new Date().toISOString(),
): Promise<{ consideredRuns: number; compiledDemands: number }> {
	await store.ensureInitialized();
	const runs = await new CapacityWorkdayRunRepository(store).listActiveForSupply(principal.teamId, principal.capacityProviderId);
	let compiledDemands = 0;
	for (const run of runs) {
		if (!deadlineOpen(run, now)) continue;
		const planningWave = await currentCooperativePlanningWave(store, run.id, now);
		const cooperativePlanning = Object.keys(record(run.parameters.planningSession)).length > 0;
		const projects = resolveCapacityWorkdayProjects(capacityWorkdayRequestedProjectSlugs(run.parameters), await store.listTeamProjects(run.teamId));
		for (const project of projects) {
			const workdayId = await activeEnvelope(store, run, project.id);
			if (!workdayId) continue;
			if (planningWave || !cooperativePlanning) compiledDemands += await compilePlanningDemands(store, run, project, workdayId, now, planningWave);
			if (run.parameters.planningOnly !== true) compiledDemands += await compileActingDemands(store, run, project, workdayId, now);
		}
	}
	return { consideredRuns: runs.length, compiledDemands };
}
