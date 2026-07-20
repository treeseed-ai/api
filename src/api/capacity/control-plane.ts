import { createHash } from 'node:crypto';
import type { CapacityGovernanceDatabase, CapacityDatabaseOperation } from './database.ts';
import { synthesizeProviderAssignments } from './services/assignment-synthesis-service.ts';
import { buildProjectCapacityDiagnostics } from './services/project-capacity-diagnostics-service.ts';
import { scheduleCapacityWorkdayRun as scheduleWorkdayRun } from './services/workday-scheduling-service.ts';
import { closeCapacityWorkdayAdmission as closeWorkdayAdmission, terminalizeCapacityWorkdayEnvelopes as terminalizeWorkdayEnvelopes } from './services/workday-envelope-terminalization-service.ts';
import { createConfiguredWorkdayTreeDxWorkspace } from './services/workday-treedx-workspace-service.ts';
import { collectProjectAgentArtifacts } from './services/project-agent-artifact-service.ts';
import { buildProjectAgentSummary } from './services/project-agent-summary-service.ts';
import { listProjectDeletionBlockers } from './services/project-deletion-blocker-service.ts';
import { aggregateCapacityCreditReservations } from './services/credit-reservation-aggregation-service.ts';
import { buildProjectCapacityRuntimeDiagnostics } from './services/runtime-diagnostics-query-service.ts';
import { buildWorkdayCapacitySummary } from './services/workday-summary-query-service.ts';
import { CapacityRuntimeEvidenceRepository } from './repositories/runtime-evidence.ts';
import { recordProviderAssignmentExplanation as persistProviderAssignmentExplanation } from './services/assignment-explanation-service.ts';
import { terminalizeCapacityWorkdayAssignments as terminalizeWorkdayAssignments } from './services/workday-assignment-terminalization-service.ts';
import { CapacityWorkdayRunRepository } from './repositories/workday-run.ts';
import { CapacityWorkdayEventService } from './services/workday-event-service.ts';
import { CapacityWorkdayRunService } from './services/workday-run-service.ts';
import { maintainCapacityWorkdayRuns as maintainWorkdayRuns } from './services/workday-recovery-service.ts';
import { WorkdayCapacityEnvelopeRepository } from './repositories/workday-envelope.ts';
import { AgentCapacityPlanService } from './services/agent-capacity-plan-service.ts';
import { PlanningStateService } from './services/planning-state-service.ts';
import { CapacityReservationRepository } from './repositories/reservation.ts';
import { CapacityLedgerRepository } from './repositories/ledger.ts';
import { DerivedCapacityService } from './services/derived-capacity-service.ts';
import { CapacitySummaryService } from './services/capacity-summary-service.ts';
import { CapacityOperationsQueryService } from './services/capacity-operations-query-service.ts';
import { StructuredAgentEstimateService } from './services/structured-estimate-service.ts';
import { DecisionWorkGraphService } from './services/decision-work-graph-service.ts';
import { ResearchWorkflowService } from './services/research-workflow-service.ts';
import { listRecentTaskUsageActuals, listTaskUsageActualsPage as readTaskUsageActualsPage } from './repositories/task-usage.ts';
import type { ProviderLeasePrincipal } from './services/lease-authority-service.ts';
import type { ProviderSynthesisRequest } from './services/assignment-synthesis-service.ts';
import type { DurableCapacityWorkdayRun } from './repositories/workday-run.ts';
import type { WorkdayProject } from './services/workday-project-policy.ts';
import type { WorkdaySummaryOptions } from './services/workday-summary-query-service.ts';
import { ProviderControlPlane } from './provider-control-plane.ts';
import { tickCapacityWorkdayRun as tickWorkdayRun } from './services/workday-tick-service.ts';
import { OperatorAssignmentService } from './services/operator-assignment-service.ts';
import { recoverExpiredProviderAssignments as recoverExpiredAssignments } from './services/assignment-recovery-service.ts';
import { maintainCapacityRuntimeRetention as maintainRuntimeRetention } from './services/runtime-retention-service.ts';
export interface CapacityControlPlaneHost extends CapacityGovernanceDatabase {
	config: Record<string, unknown>;
	getProject(projectId: string): Promise<Record<string, unknown> | null>;
	getProjectDetails(projectId: string): Promise<Record<string, unknown> | null>;
	getProjectTreeDxLibrary(projectId: string): Promise<Record<string, unknown> | null>;
	listApprovalRequestsForProject(projectId: string, limit: number): Promise<Record<string, unknown>[]>;
	listTeamProjects(teamId: string): Promise<Record<string, unknown>[]>;
	requestProjectRuntime(projectId: string, principal: unknown, path: string, input?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}
export type CapacityControlPlaneStore = CapacityControlPlane & ProviderControlPlane & CapacityControlPlaneHost;
type JsonRecord = Record<string, unknown>;
interface PageFilters extends JsonRecord {
	limit?: number | string | null;
	cursor?: string | null;
	providerId?: string | null;
	projectId?: string | null;
	status?: string | null;
	active?: boolean | null;
	now?: string;
}
function objectValue(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function isoNow() {
	return new Date().toISOString();
}
class CapacityControlPlane {
	private context!: CapacityControlPlaneStore;
	private capacityRuntimeEvidenceRepository!: CapacityRuntimeEvidenceRepository;
	private workdayCapacityEnvelopeRepository!: WorkdayCapacityEnvelopeRepository;
	private agentCapacityPlanService!: AgentCapacityPlanService;
	private planningStateService!: PlanningStateService;
	private structuredAgentEstimateService!: StructuredAgentEstimateService;
	private decisionWorkGraphService!: DecisionWorkGraphService;
	private researchWorkflowService!: ResearchWorkflowService;
	constructor(private readonly host: CapacityControlPlaneHost) {}
	attach(context: CapacityControlPlaneStore) {
		this.context = context;
		this.capacityRuntimeEvidenceRepository = new CapacityRuntimeEvidenceRepository(context);
		this.workdayCapacityEnvelopeRepository = new WorkdayCapacityEnvelopeRepository(context);
		this.agentCapacityPlanService = new AgentCapacityPlanService(context);
		this.planningStateService = new PlanningStateService(context);
		this.structuredAgentEstimateService = new StructuredAgentEstimateService(context);
		this.decisionWorkGraphService = new DecisionWorkGraphService(context);
		this.researchWorkflowService = new ResearchWorkflowService(context);
	}
	ensureInitialized() { return this.host.ensureInitialized(); }
	run(query: string, params: unknown[] = []) { return this.host.run(query, params); }
	first<T extends Record<string, unknown> = Record<string, unknown>>(query: string, params: unknown[] = []) { return this.host.first<T>(query, params); }
	all<T extends Record<string, unknown> = Record<string, unknown>>(query: string, params: unknown[] = []) { return this.host.all<T>(query, params); }
	batch(operations: CapacityDatabaseOperation[]) { return this.host.batch(operations); }
	scopeHash(value: unknown = {}) {
			return `scope_${createHash('sha256').update(JSON.stringify(value, Object.keys(objectValue(value)).sort())).digest('hex').slice(0, 16)}`;
		}
	async upsertDecisionPlanningStatus(input: JsonRecord = {}) {
			return this.planningStateService.upsertPlanningStatus(input);
		}
	async getDecisionPlanningStatus(decisionId: string) {
			return this.planningStateService.getPlanningStatus(decisionId);
		}
	async createPlanningInputRequest(decisionId: string, input: JsonRecord = {}) {
			return this.planningStateService.createPlanningRequest(decisionId, input);
		}
	async listPlanningInputRequests(decisionId: string) {
			return this.planningStateService.listPlanningRequests(decisionId);
		}
	async createDecisionExecutionInput(decisionId: string, input: JsonRecord = {}) {
			return this.planningStateService.createExecutionInput(decisionId, input);
		}
	async listDecisionExecutionInputs(decisionId: string, filters: PageFilters = {}) {
			return this.planningStateService.listExecutionInputs(decisionId, filters);
		}
	async getDecisionExecutionInput(inputId: string) {
			return this.planningStateService.getExecutionInput(inputId);
		}
	async updateDecisionExecutionInputStatus(inputId: string, status: string, input: JsonRecord = {}) {
			return this.planningStateService.transitionExecutionInput(inputId, status, input);
		}
	async createStructuredAgentEstimate(decisionId: string, input: JsonRecord = {}) {
			return this.structuredAgentEstimateService.create(decisionId, input);
		}
	async listStructuredAgentEstimatesForDecision(decisionId: string, filters: PageFilters = {}) {
			return this.structuredAgentEstimateService.listDecision(decisionId, filters.status ?? null);
		}
	async getStructuredAgentEstimate(estimateId: string) {
			return this.structuredAgentEstimateService.get(estimateId);
		}
	async updateStructuredAgentEstimateStatus(estimateId: string, status: string, input: JsonRecord = {}) {
			if (status !== 'accepted' && status !== 'rejected') throw new Error(`Unsupported structured estimate transition ${status}.`);
			return this.structuredAgentEstimateService.transition(estimateId, status, input);
		}
	async acceptStructuredAgentEstimate(estimateId: string, input: JsonRecord = {}) {
			return this.updateStructuredAgentEstimateStatus(estimateId, 'accepted', input);
		}
	async rejectStructuredAgentEstimate(estimateId: string, input: JsonRecord = {}) {
			return this.updateStructuredAgentEstimateStatus(estimateId, 'rejected', input);
		}
	async createDecisionAssignmentGraph(decisionId: string, input: JsonRecord = {}) {
			return this.decisionWorkGraphService.compile(decisionId, input);
		}
	async getDecisionAssignmentGraph(graphId: string) {
			return this.decisionWorkGraphService.getGraph(graphId);
		}
	async listDecisionAssignmentGraphsForDecision(decisionId: string, filters: PageFilters = {}) {
			return this.decisionWorkGraphService.listGraphs(decisionId, filters.active);
		}
	async activateDecisionAssignmentGraphVersion(graphId: string) {
			return this.decisionWorkGraphService.activate(graphId);
		}
	async getDeliverableContract(contractId: string) {
			return this.decisionWorkGraphService.getContract(contractId);
		}
	async submitDeliverableManifest(contractId: string, input: JsonRecord = {}) {
			return this.decisionWorkGraphService.submitManifest(contractId, input);
		}
	async markDeliverableContractApproved(contractId: string, input: JsonRecord = {}) {
			return this.decisionWorkGraphService.transitionContract(contractId, 'approved', input);
		}
	async markDeliverableContractRejected(contractId: string, input: JsonRecord = {}) {
			return this.decisionWorkGraphService.transitionContract(contractId, 'rejected', input);
		}
	async createResearchWorkflow(projectId: string, input: JsonRecord = {}) { return this.researchWorkflowService.create(projectId, input); }
	async getResearchWorkflow(id: string) { return this.researchWorkflowService.get(id); }
	async listResearchWorkflows(projectId: string, filters: PageFilters = {}) { return this.researchWorkflowService.list(projectId, filters.status ?? undefined); }
	async completeResearchWorkflowStage(id: string, stage: string, input: JsonRecord = {}) { return this.researchWorkflowService.completeStage(id, stage, input); }
	async createAgentCapacityPlan(decisionId: string, input: JsonRecord = {}) {
			return this.agentCapacityPlanService.create(decisionId, input);
		}
	async listAgentCapacityPlans(decisionId: string, filters: PageFilters = {}) {
			return this.agentCapacityPlanService.list(decisionId, filters);
		}
	async getAgentCapacityPlan(planId: string) {
			return this.agentCapacityPlanService.get(planId);
		}
	async updateAgentCapacityPlanStatus(planId: string, status: string, input: JsonRecord = {}) {
			return this.agentCapacityPlanService.transition(planId, status, input);
		}
	async createWorkdayCapacityEnvelope(input: JsonRecord = {}, idempotencyKey?: string | null) {
			return this.workdayCapacityEnvelopeRepository.create(input, idempotencyKey);
		}
	async getWorkdayCapacityEnvelope(workdayId: string) {
			return this.workdayCapacityEnvelopeRepository.get(workdayId);
		}
	async listWorkdayCapacityEnvelopes(projectId: string, filters: PageFilters = {}) {
			return this.workdayCapacityEnvelopeRepository.list(projectId, filters);
		}
	async updateWorkdayCapacityEnvelopeState(workdayId: string, status: string, idempotencyKey?: string | null) {
			return this.workdayCapacityEnvelopeRepository.transition(workdayId, status as Parameters<WorkdayCapacityEnvelopeRepository['transition']>[1], idempotencyKey);
		}
	async getWorkdayCapacitySummary(workdayId: string, options: WorkdaySummaryOptions = {}) {
			await this.ensureInitialized();
			return buildWorkdayCapacitySummary(this.context, workdayId, options);
		}
	async recordProviderAssignmentExplanation(teamId: string, assignmentId: string, input: JsonRecord = {}) {
			return persistProviderAssignmentExplanation(this.context, teamId, assignmentId, input);
		}
	async getProjectCapacityRuntimeDiagnostics(projectId: string, teamId: string) {
			await this.ensureInitialized();
			return buildProjectCapacityRuntimeDiagnostics(this.context, projectId, teamId);
		}
	async recordAgentFallbackOutput(input: JsonRecord = {}) {
			return this.capacityRuntimeEvidenceRepository.recordFallbackOutput(input);
		}
	async listAgentFallbackOutputsPage(projectId: string, filters: PageFilters = {}) {
			return this.capacityRuntimeEvidenceRepository.listFallbackOutputs(projectId, filters);
		}
	async recordTreeDxProxyAudit(input: JsonRecord = {}) {
			return this.capacityRuntimeEvidenceRepository.recordProxyAudit(input);
		}
	async issueTreeDxProxyHandle(input: JsonRecord = {}) {
			return this.capacityRuntimeEvidenceRepository.issueProxyHandle(input);
		}
	async getTreeDxProxyHandle(teamId: string, projectId: string, handleId: string) {
			return this.capacityRuntimeEvidenceRepository.getProxyHandle(teamId, projectId, handleId);
		}
	async revokeTreeDxProxyHandle(teamId: string, projectId: string, handleId: string, input: JsonRecord = {}) {
			return this.capacityRuntimeEvidenceRepository.revokeProxyHandle(teamId, projectId, handleId, input);
		}
	async listTreeDxProxyAuditPage(projectId: string, filters: PageFilters = {}) {
			return this.capacityRuntimeEvidenceRepository.listProxyAudit(projectId, filters);
		}
	async createCapacityWorkdayTreeDxWorkspace(project: WorkdayProject, run: DurableCapacityWorkdayRun, input: JsonRecord) {
			return createConfiguredWorkdayTreeDxWorkspace(this.context, project, run, input);
		}
	async scheduleCapacityWorkdayRun(run: DurableCapacityWorkdayRun) {
			return scheduleWorkdayRun(this.context, run);
		}
	async terminalizeCapacityWorkdayEnvelopes(teamId: string, runId: string, status: string) {
			return terminalizeWorkdayEnvelopes(this.context, teamId, runId, status);
		}
	async closeCapacityWorkdayAdmission(teamId: string, runId: string) {
		return closeWorkdayAdmission(this.context, teamId, runId);
		}
	async synthesizeProviderAssignments(principal: ProviderLeasePrincipal, input: ProviderSynthesisRequest = {}) {
			return synthesizeProviderAssignments(this.context, principal, input);
		}
	async tickCapacityWorkdayRun(teamId: string, runId: string, now = isoNow(), idempotencyKey?: string) {
		return tickWorkdayRun(this.context, teamId, runId, now, idempotencyKey);
		}
	async cancelCapacityAssignment(teamId: string, assignmentId: string, input: JsonRecord = {}) {
		return new OperatorAssignmentService(this.context).cancel(teamId, assignmentId, {
			idempotencyKey: String(input.idempotencyKey ?? ''), actorId: typeof input.actorId === 'string' ? input.actorId : null,
			reason: typeof input.reason === 'string' ? input.reason : null,
		});
		}
	async requeueCapacityAssignment(teamId: string, assignmentId: string, input: JsonRecord = {}) {
		return new OperatorAssignmentService(this.context).requeue(teamId, assignmentId, {
			idempotencyKey: String(input.idempotencyKey ?? ''), actorId: typeof input.actorId === 'string' ? input.actorId : null,
			reason: typeof input.reason === 'string' ? input.reason : null,
		});
		}
	async listCapacityReservationsForProjectPage(projectId: string, filters: PageFilters = {}) {
			return new CapacityReservationRepository(this).listProjectPage(projectId, filters);
		}
	async listCapacityLedgerEntriesPage(projectId: string, filters: PageFilters = {}) {
			return new CapacityLedgerRepository(this).listProjectPage(projectId, filters);
		}
	async listTaskUsageActualsPage(projectId: string, filters: PageFilters = {}) {
			return readTaskUsageActualsPage(this.context, projectId, filters);
		}
	async getCapacityProviderDerivedCapacity(teamId: string, providerId: string, options: PageFilters = {}) {
			return new DerivedCapacityService(this).provider(teamId, providerId, options);
		}
	async getTeamDerivedCapacity(teamId: string, options: PageFilters = {}) {
			return new DerivedCapacityService(this).team(teamId, options);
		}
	async listTaskUsageActualsForProject(projectId: string, limit: number = 50) {
			return listRecentTaskUsageActuals(this.context, { projectId, limit });
		}
	async getProjectCapacityDiagnostics(projectId: string, environment: string = 'staging') {
			return buildProjectCapacityDiagnostics(this.context, projectId, environment);
		}
	async getProjectCapacityOperations(projectId: string, environment: string = 'staging') {
			return new CapacityOperationsQueryService(this.context).project(projectId, environment);
		}
	async getTeamCapacitySummary(teamId: string, options: PageFilters = {}) {
			return new CapacitySummaryService(this).team(teamId, options);
		}
	async getCapacityCreditReservationTotals(teamId: string, options: PageFilters = {}) {
			await this.ensureInitialized();
			return aggregateCapacityCreditReservations(this.context, {
				teamId,
				projectId: options.projectId ?? null,
				now: options.now,
			});
		}
	async getProjectCapacitySummary(projectId: string, environment: string = 'staging') {
			return new CapacitySummaryService(this).project(projectId, environment);
		}
	async createCapacityWorkdayRun(teamId: string, input: JsonRecord = {}) {
			return new CapacityWorkdayRunService(this).create(teamId, input);
		}
	async terminalizeCapacityWorkdayAssignments(teamId: string, runId: string, input: JsonRecord = {}) {
			return terminalizeWorkdayAssignments(this.context, teamId, runId, input);
		}
	async updateCapacityWorkdayRun(teamId: string, runId: string, input: JsonRecord = {}) {
			return new CapacityWorkdayRunService(this).update(teamId, runId, input);
		}
	async maintainCapacityWorkdayRuns(teamId: string | null = null, now: string = isoNow()) {
		return maintainWorkdayRuns(this.context, teamId, now);
	}
	async maintainCapacityRuntimeRetention(now: string = isoNow()) {
		return maintainRuntimeRetention(this.context, now);
	}
	async recoverExpiredProviderAssignments(input: { teamId?: string | null; providerId?: string | null; now?: string; limit?: number } = {}) {
		return recoverExpiredAssignments(this.context, input);
		}
	async getCapacityWorkdayRun(teamId: string, runId: string) {
			return new CapacityWorkdayRunRepository(this).get(teamId, runId);
		}
	async listCapacityWorkdayRunsPage(teamId: string, filters: PageFilters = {}) {
			return new CapacityWorkdayRunRepository(this).list(teamId, filters);
		}
	async createCapacityWorkdayEvent(teamId: string, runId: string, input: JsonRecord = {}) {
			return new CapacityWorkdayEventService(this).create(teamId, runId, input);
		}
	async listCapacityWorkdayEventsPage(teamId: string, runId: string, filters: PageFilters = {}) {
			return new CapacityWorkdayEventService(this).list(teamId, runId, filters);
		}
	async collectControlPlaneGeneratedArtifacts(projectId: string, modeRuns: JsonRecord[] = []) {
			return collectProjectAgentArtifacts(this.context, projectId, modeRuns.length ? modeRuns : undefined);
		}
	async getProjectAgentsSummary(projectId: string, principal: unknown = null) {
			return buildProjectAgentSummary(this.context, projectId, principal);
		}
	async evaluateProjectDeletionBlockers(projectId: string) {
			await this.ensureInitialized();
			return listProjectDeletionBlockers(this.context, projectId);
		}
}
export function createCapacityControlPlane(host: CapacityControlPlaneHost): CapacityControlPlaneStore {
	const target = new CapacityControlPlane(host);
	let provider!: ProviderControlPlane;
	const proxy = new Proxy(target as CapacityControlPlaneStore, {
		get(instance, property, receiver) {
			const owner = Reflect.has(instance, property) ? instance : Reflect.has(provider, property) ? provider : host;
			const value = Reflect.get(owner, property, owner === instance ? receiver : owner);
			return typeof value === 'function' ? value.bind(owner) : value;
		},
	});
	provider = new ProviderControlPlane(proxy);
	target.attach(proxy);
	return proxy;
}
