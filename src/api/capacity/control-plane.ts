import { createHash } from 'node:crypto';
import type { CapacityGovernanceDatabase, CapacityDatabaseOperation } from './database.ts';
import { synthesizeProviderAssignments } from './services/capacity/assignments/context/assignment-synthesis-service.ts';
import { buildProjectCapacityDiagnostics } from './services/capacity/observability/project-capacity-diagnostics-service.ts';
import { scheduleCapacityWorkdayRun as scheduleWorkdayRun } from './services/capacity/workdays/scheduling/workday-scheduling-service.ts';
import { closeCapacityWorkdayAdmission as closeWorkdayAdmission, terminalizeCapacityWorkdayEnvelopes as terminalizeWorkdayEnvelopes } from './services/capacity/workdays/lifecycle/workday-envelope-terminalization-service.ts';
import { createConfiguredWorkdayTreeDxWorkspace } from './services/capacity/workdays/treedx/workday-treedx-workspace-service.ts';
import { collectProjectAgentArtifacts } from './services/projects/projects-core/project-agent-artifact-service.ts';
import { buildProjectAgentSummary } from './services/projects/agents/project-agent-summary-service.ts';
import { listProjectDeletionBlockers } from './services/projects/projects-core/project-deletion-blocker-service.ts';
import { aggregateCapacityCreditReservations } from './services/capacity/accounting/credit-reservation-aggregation-service.ts';
import { buildProjectCapacityRuntimeDiagnostics } from './services/runtime/runtime-diagnostics-query-service.ts';
import { buildWorkdayCapacitySummary } from './services/capacity/workdays/assignments/workday-summary-query-service.ts';
import { CapacityRuntimeEvidenceRepository } from './repositories/runtime/runtime-evidence.ts';
import { recordProviderAssignmentExplanation as persistProviderAssignmentExplanation } from './services/capacity/assignments/observability/assignment-explanation-service.ts';
import { terminalizeCapacityWorkdayAssignments as terminalizeWorkdayAssignments } from './services/capacity/workdays/lifecycle/workday-assignment-terminalization-service.ts';
import { CapacityWorkdayRunRepository } from './repositories/capacity/workdays/workday-run.ts';
import { CapacityWorkdayEventService } from './services/capacity/workdays/content/workday-event-service.ts';
import { CapacityWorkdayRunService } from './services/capacity/workdays/scheduling/workday-run-service.ts';
import { maintainCapacityWorkdayRuns as maintainWorkdayRuns } from './services/capacity/workdays/lifecycle/workday-recovery-service.ts';
import { WorkdayCapacityEnvelopeRepository } from './repositories/capacity/workdays/workday-envelope.ts';
import { AgentCapacityPlanService } from './services/capacity/planning/agent-capacity-plan-service.ts';
import { PlanningStateService } from './services/support/planning-state-service.ts';
import { CapacityReservationRepository } from './repositories/capacity/accounting/reservation.ts';
import { CapacityLedgerRepository } from './repositories/capacity/accounting/ledger.ts';
import { DerivedCapacityService } from './services/capacity/capacity-core/derived-capacity-service.ts';
import { CapacitySummaryService } from './services/capacity/observability/capacity-summary-service.ts';
import { CapacityOperationsQueryService } from './services/capacity/capacity-core/capacity-operations-query-service.ts';
import { StructuredAgentEstimateService } from './services/support/structured-estimate-service.ts';
import { DecisionWorkGraphService } from './services/treedx/graph/decision-work-graph-service.ts';
import { ResearchWorkflowService } from './services/operations/research-workflow-service.ts';
import { listRecentTaskUsageActuals, listTaskUsageActualsPage as readTaskUsageActualsPage } from './repositories/capacity/accounting/task-usage.ts';
import type { ProviderLeasePrincipal } from './services/accounts/lease-authority-service.ts';
import type { ProviderSynthesisRequest } from './services/capacity/assignments/context/assignment-synthesis-service.ts';
import type { DurableCapacityWorkdayRun } from './repositories/capacity/workdays/workday-run.ts';
import type { WorkdayProject } from './services/capacity/workdays/policy/workday-project-policy.ts';
import type { WorkdaySummaryOptions } from './services/capacity/workdays/assignments/workday-summary-query-service.ts';
import { ProviderControlPlane } from './provider-control-plane.ts';
import { tickCapacityWorkdayRun as tickWorkdayRun } from './services/capacity/workdays/scheduling/workday-tick-service.ts';
import { OperatorAssignmentService } from './services/capacity/assignments/observability/operator-assignment-service.ts';
import { recoverExpiredProviderAssignments as recoverExpiredAssignments } from './services/capacity/assignments/lifecycle/assignment-recovery-service.ts';
import { maintainCapacityRuntimeRetention as maintainRuntimeRetention } from './services/runtime/runtime-retention-service.ts';
export interface CapacityControlPlaneHost extends CapacityGovernanceDatabase {
	config: Record<string, unknown>;
	createTeam(input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	prepareTeamDeletion(teamId: string, confirmation: string): Promise<{ ok: boolean; team?: unknown; [key: string]: unknown }>;
	getProject(projectId: string): Promise<Record<string, unknown> | null>;
	getProjectDetails(projectId: string): Promise<Record<string, unknown> | null>;
	getProjectTreeDxLibrary(projectId: string): Promise<Record<string, unknown> | null>;
	listApprovalRequestsForProject(projectId: string, limit: number): Promise<Record<string, unknown>[]>;
	listTeamProjects(teamId: string): Promise<WorkdayProject[]>;
	getTeam(teamId: string): Promise<Record<string, unknown> | null>;
	listHubRepositories(projectId: string): Promise<Record<string, unknown>[]>;
	getProjectArchitecture(projectId: string): Promise<Record<string, unknown> | null>;
	requestProjectRuntime(projectId: string, principal: unknown, path: string, input?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}
type PublicSurface<T> = { [Key in keyof T]: T[Key] };
export type CapacityControlPlaneStore = PublicSurface<CapacityControlPlane>
	& PublicSurface<ProviderControlPlane>
	& CapacityControlPlaneHost;
type CapacityServiceStore = CapacityControlPlaneStore
	& ConstructorParameters<typeof AgentCapacityPlanService>[0]
	& ConstructorParameters<typeof PlanningStateService>[0]
	& ConstructorParameters<typeof StructuredAgentEstimateService>[0]
	& ConstructorParameters<typeof DecisionWorkGraphService>[0]
	& ConstructorParameters<typeof ResearchWorkflowService>[0]
	& ConstructorParameters<typeof CapacityOperationsQueryService>[0]
	& Parameters<typeof buildWorkdayCapacitySummary>[0]
	& Parameters<typeof buildProjectCapacityRuntimeDiagnostics>[0]
	& Parameters<typeof persistProviderAssignmentExplanation>[0]
	& Parameters<typeof createConfiguredWorkdayTreeDxWorkspace>[0]
	& Parameters<typeof scheduleWorkdayRun>[0]
	& Parameters<typeof synthesizeProviderAssignments>[0]
	& Parameters<typeof tickWorkdayRun>[0]
	& Parameters<typeof buildProjectCapacityDiagnostics>[0]
	& Parameters<typeof collectProjectAgentArtifacts>[0]
	& Parameters<typeof buildProjectAgentSummary>[0];
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
	private capacityContext!: CapacityServiceStore;
	private capacityRuntimeEvidenceRepository!: CapacityRuntimeEvidenceRepository;
	private workdayCapacityEnvelopeRepository!: WorkdayCapacityEnvelopeRepository;
	private agentCapacityPlanService!: AgentCapacityPlanService;
	private planningStateService!: PlanningStateService;
	private structuredAgentEstimateService!: StructuredAgentEstimateService;
	private decisionWorkGraphService!: DecisionWorkGraphService;
	private researchWorkflowService!: ResearchWorkflowService;
	constructor(private readonly host: CapacityControlPlaneHost) {}
	attach(context: CapacityControlPlaneStore) {
		const serviceContext = context as unknown as CapacityServiceStore;
		this.capacityContext = serviceContext;
		this.capacityRuntimeEvidenceRepository = new CapacityRuntimeEvidenceRepository(serviceContext);
		this.workdayCapacityEnvelopeRepository = new WorkdayCapacityEnvelopeRepository(serviceContext);
		this.agentCapacityPlanService = new AgentCapacityPlanService(serviceContext);
		this.planningStateService = new PlanningStateService(serviceContext);
		this.structuredAgentEstimateService = new StructuredAgentEstimateService(serviceContext);
		this.decisionWorkGraphService = new DecisionWorkGraphService(serviceContext);
		this.researchWorkflowService = new ResearchWorkflowService(serviceContext);
	}
	ensureInitialized() { return this.host.ensureInitialized(); }
	run(query: string, params: unknown[] = []) { return this.host.run(query, params); }
	first<T extends Record<string, unknown> = Record<string, unknown>>(query: string, params: unknown[] = []) { return this.host.first<T>(query, params); }
	all<T extends Record<string, unknown> = Record<string, unknown>>(query: string, params: unknown[] = []) { return this.host.all<T>(query, params); }
	batch(operations: CapacityDatabaseOperation[]) { return this.host.batch(operations); }
	scopeHash(value: unknown = {}) {
			return `scope_${createHash('sha256').update(JSON.stringify(value, Object.keys(objectValue(value)).sort())).digest('hex').slice(0, 16)}`;
		}
	async upsertDecisionPlanningStatus(input: Parameters<PlanningStateService['upsertPlanningStatus']>[0]) {
			return this.planningStateService.upsertPlanningStatus(input);
		}
	async getDecisionPlanningStatus(decisionId: string) {
			return this.planningStateService.getPlanningStatus(decisionId);
		}
	async createPlanningInputRequest(decisionId: string, input: Parameters<PlanningStateService['createPlanningRequest']>[1]) {
			return this.planningStateService.createPlanningRequest(decisionId, input);
		}
	async listPlanningInputRequests(decisionId: string) {
			return this.planningStateService.listPlanningRequests(decisionId);
		}
	async createDecisionExecutionInput(decisionId: string, input: Parameters<PlanningStateService['createExecutionInput']>[1]) {
			return this.planningStateService.createExecutionInput(decisionId, input);
		}
	async listDecisionExecutionInputs(decisionId: string, filters: Parameters<PlanningStateService['listExecutionInputs']>[1] = {}) {
			return this.planningStateService.listExecutionInputs(decisionId, filters);
		}
	async getDecisionExecutionInput(inputId: string) {
			return this.planningStateService.getExecutionInput(inputId);
		}
	async updateDecisionExecutionInputStatus(inputId: string, status: Parameters<PlanningStateService['transitionExecutionInput']>[1], input: Parameters<PlanningStateService['transitionExecutionInput']>[2] = {}) {
			return this.planningStateService.transitionExecutionInput(inputId, status, input);
		}
	async createStructuredAgentEstimate(decisionId: string, input: Parameters<StructuredAgentEstimateService['create']>[1]) {
			return this.structuredAgentEstimateService.create(decisionId, input);
		}
	async listStructuredAgentEstimatesForDecision(decisionId: string, filters: { status?: Parameters<StructuredAgentEstimateService['listDecision']>[1] } = {}) {
			return this.structuredAgentEstimateService.listDecision(decisionId, filters.status ?? null);
		}
	async getStructuredAgentEstimate(estimateId: string) {
			return this.structuredAgentEstimateService.get(estimateId);
		}
	async updateStructuredAgentEstimateStatus(estimateId: string, status: Parameters<StructuredAgentEstimateService['transition']>[1], input: Parameters<StructuredAgentEstimateService['transition']>[2] = {}) {
			if (status !== 'accepted' && status !== 'rejected') throw new Error(`Unsupported structured estimate transition ${status}.`);
			return this.structuredAgentEstimateService.transition(estimateId, status, input);
		}
	async acceptStructuredAgentEstimate(estimateId: string, input: Parameters<StructuredAgentEstimateService['transition']>[2] = {}) {
			return this.updateStructuredAgentEstimateStatus(estimateId, 'accepted', input);
		}
	async rejectStructuredAgentEstimate(estimateId: string, input: Parameters<StructuredAgentEstimateService['transition']>[2] = {}) {
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
	async getDeliverableManifest(manifestId: string) {
		return this.decisionWorkGraphService.getManifest(manifestId);
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
	async createAgentCapacityPlan(decisionId: string, input: Parameters<AgentCapacityPlanService['create']>[1]) {
			return this.agentCapacityPlanService.create(decisionId, input);
		}
	async listAgentCapacityPlans(decisionId: string, filters: Parameters<AgentCapacityPlanService['list']>[1] = {}) {
			return this.agentCapacityPlanService.list(decisionId, filters);
		}
	async getAgentCapacityPlan(planId: string) {
			return this.agentCapacityPlanService.get(planId);
		}
	async updateAgentCapacityPlanStatus(planId: string, status: Parameters<AgentCapacityPlanService['transition']>[1], input: Parameters<AgentCapacityPlanService['transition']>[2] = {}) {
			return this.agentCapacityPlanService.transition(planId, status, input);
		}
	async createWorkdayCapacityEnvelope(input: Parameters<WorkdayCapacityEnvelopeRepository['create']>[0], idempotencyKey?: string | null) {
			return this.workdayCapacityEnvelopeRepository.create(input, idempotencyKey);
		}
	async getWorkdayCapacityEnvelope(workdayId: string) {
			return this.workdayCapacityEnvelopeRepository.get(workdayId);
		}
	async listWorkdayCapacityEnvelopes(projectId: string, filters: Parameters<WorkdayCapacityEnvelopeRepository['list']>[1] = {}) {
			return this.workdayCapacityEnvelopeRepository.list(projectId, filters);
		}
	async updateWorkdayCapacityEnvelopeState(workdayId: string, status: string, idempotencyKey?: string | null) {
			return this.workdayCapacityEnvelopeRepository.transition(workdayId, status as Parameters<WorkdayCapacityEnvelopeRepository['transition']>[1], idempotencyKey);
		}
	async getWorkdayCapacitySummary(workdayId: string, options: WorkdaySummaryOptions = {}) {
			await this.ensureInitialized();
			return buildWorkdayCapacitySummary(this.capacityContext, workdayId, options);
		}
	async recordProviderAssignmentExplanation(teamId: string, assignmentId: string, input: Parameters<typeof persistProviderAssignmentExplanation>[3]) {
			return persistProviderAssignmentExplanation(this.capacityContext, teamId, assignmentId, input);
		}
	async getProjectCapacityRuntimeDiagnostics(projectId: string, teamId: string) {
			await this.ensureInitialized();
			return buildProjectCapacityRuntimeDiagnostics(this.capacityContext, projectId, teamId);
		}
	async recordAgentFallbackOutput(input: Parameters<CapacityRuntimeEvidenceRepository['recordFallbackOutput']>[0]) {
			return this.capacityRuntimeEvidenceRepository.recordFallbackOutput(input);
		}
	async listAgentFallbackOutputsPage(projectId: string, filters: Parameters<CapacityRuntimeEvidenceRepository['listFallbackOutputs']>[1] = {}) {
			return this.capacityRuntimeEvidenceRepository.listFallbackOutputs(projectId, filters);
		}
	async recordTreeDxProxyAudit(input: Parameters<CapacityRuntimeEvidenceRepository['recordProxyAudit']>[0]) {
			return this.capacityRuntimeEvidenceRepository.recordProxyAudit(input);
		}
	async issueTreeDxProxyHandle(input: Parameters<CapacityRuntimeEvidenceRepository['issueProxyHandle']>[0]) {
			return this.capacityRuntimeEvidenceRepository.issueProxyHandle(input);
		}
	async getTreeDxProxyHandle(teamId: string, projectId: string, handleId: string) {
			return this.capacityRuntimeEvidenceRepository.getProxyHandle(teamId, projectId, handleId);
		}
	async revokeTreeDxProxyHandle(teamId: string, projectId: string, handleId: string, input: JsonRecord = {}) {
			return this.capacityRuntimeEvidenceRepository.revokeProxyHandle(teamId, projectId, handleId, input);
		}
	async listTreeDxProxyAuditPage(projectId: string, filters: Parameters<CapacityRuntimeEvidenceRepository['listProxyAudit']>[1] = {}) {
			return this.capacityRuntimeEvidenceRepository.listProxyAudit(projectId, filters);
		}
	async createCapacityWorkdayTreeDxWorkspace(project: WorkdayProject, run: DurableCapacityWorkdayRun, input: Parameters<typeof createConfiguredWorkdayTreeDxWorkspace>[3]) {
			return createConfiguredWorkdayTreeDxWorkspace(this.capacityContext, project, run, input);
		}
	async scheduleCapacityWorkdayRun(run: DurableCapacityWorkdayRun) {
			return scheduleWorkdayRun(this.capacityContext, run);
		}
	async terminalizeCapacityWorkdayEnvelopes(teamId: string, runId: string, status: string) {
			return terminalizeWorkdayEnvelopes(this.capacityContext, teamId, runId, status);
		}
	async closeCapacityWorkdayAdmission(teamId: string, runId: string) {
		return closeWorkdayAdmission(this.capacityContext, teamId, runId);
		}
	async synthesizeProviderAssignments(principal: ProviderLeasePrincipal, input: ProviderSynthesisRequest = {}) {
			return synthesizeProviderAssignments(this.capacityContext, principal, input);
		}
	async tickCapacityWorkdayRun(teamId: string, runId: string, now = isoNow(), idempotencyKey?: string) {
		return tickWorkdayRun(this.capacityContext, teamId, runId, now, idempotencyKey);
		}
	async cancelCapacityAssignment(teamId: string, assignmentId: string, input: JsonRecord = {}) {
		return new OperatorAssignmentService(this.capacityContext).cancel(teamId, assignmentId, {
			idempotencyKey: String(input.idempotencyKey ?? ''), actorId: typeof input.actorId === 'string' ? input.actorId : null,
			reason: typeof input.reason === 'string' ? input.reason : null,
		});
		}
	async requeueCapacityAssignment(teamId: string, assignmentId: string, input: JsonRecord = {}) {
		return new OperatorAssignmentService(this.capacityContext).requeue(teamId, assignmentId, {
			idempotencyKey: String(input.idempotencyKey ?? ''), actorId: typeof input.actorId === 'string' ? input.actorId : null,
			reason: typeof input.reason === 'string' ? input.reason : null,
		});
		}
	async listCapacityReservationsForProjectPage(projectId: string, filters: Parameters<CapacityReservationRepository['listProjectPage']>[1] = {}) {
			return new CapacityReservationRepository(this.capacityContext).listProjectPage(projectId, filters);
		}
	async listCapacityLedgerEntriesPage(projectId: string, filters: Parameters<CapacityLedgerRepository['listProjectPage']>[1] = {}) {
			return new CapacityLedgerRepository(this.capacityContext).listProjectPage(projectId, filters);
		}
	async listTaskUsageActualsPage(projectId: string, filters: Parameters<typeof readTaskUsageActualsPage>[2] = {}) {
			return readTaskUsageActualsPage(this.capacityContext, projectId, filters);
		}
	async getCapacityProviderDerivedCapacity(teamId: string, providerId: string, options: PageFilters = {}) {
			return new DerivedCapacityService(this.capacityContext).provider(teamId, providerId, options);
		}
	async getTeamDerivedCapacity(teamId: string, options: PageFilters = {}) {
			return new DerivedCapacityService(this.capacityContext).team(teamId, options);
		}
	async listTaskUsageActualsForProject(projectId: string, limit: number = 50) {
			return listRecentTaskUsageActuals(this.capacityContext, { projectId, limit });
		}
	async getProjectCapacityDiagnostics(projectId: string, environment: Parameters<typeof buildProjectCapacityDiagnostics>[2] = 'staging') {
			return buildProjectCapacityDiagnostics(this.capacityContext, projectId, environment);
		}
	async getProjectCapacityOperations(projectId: string, environment: Parameters<CapacityOperationsQueryService['project']>[1] = 'staging') {
			return new CapacityOperationsQueryService(this.capacityContext).project(projectId, environment);
		}
	async getTeamCapacitySummary(teamId: string, options: PageFilters = {}) {
			return new CapacitySummaryService(this.capacityContext).team(teamId, options);
		}
	async getCapacityCreditReservationTotals(teamId: string, options: PageFilters = {}) {
			await this.ensureInitialized();
			return aggregateCapacityCreditReservations(this.capacityContext, {
				teamId,
				projectId: options.projectId ?? null,
				now: options.now,
			});
		}
	async getProjectCapacitySummary(projectId: string, environment: Parameters<CapacitySummaryService['project']>[1] = 'staging') {
			return new CapacitySummaryService(this.capacityContext).project(projectId, environment);
		}
	async createCapacityWorkdayRun(teamId: string, input: JsonRecord = {}) {
			return new CapacityWorkdayRunService(this.capacityContext).create(teamId, input);
		}
	async terminalizeCapacityWorkdayAssignments(teamId: string, runId: string, input: JsonRecord = {}) {
			return terminalizeWorkdayAssignments(this.capacityContext, teamId, runId, input);
		}
	async updateCapacityWorkdayRun(teamId: string, runId: string, input: JsonRecord = {}) {
			return new CapacityWorkdayRunService(this.capacityContext).update(teamId, runId, input);
		}
	async maintainCapacityWorkdayRuns(teamId: string | null = null, now: string = isoNow()) {
		return maintainWorkdayRuns(this.capacityContext, teamId, now);
	}
	async maintainCapacityRuntimeRetention(now: string = isoNow()) {
		return maintainRuntimeRetention(this.capacityContext, now);
	}
	async recoverExpiredProviderAssignments(input: { teamId?: string | null; providerId?: string | null; now?: string; limit?: number } = {}) {
		return recoverExpiredAssignments(this.capacityContext, input);
		}
	async getCapacityWorkdayRun(teamId: string, runId: string) {
			return new CapacityWorkdayRunRepository(this.capacityContext).get(teamId, runId);
		}
	async listCapacityWorkdayRunsPage(teamId: string, filters: Parameters<CapacityWorkdayRunRepository['list']>[1] = {}) {
			return new CapacityWorkdayRunRepository(this.capacityContext).list(teamId, filters);
		}
	async createCapacityWorkdayEvent(teamId: string, runId: string, input: JsonRecord = {}) {
			return new CapacityWorkdayEventService(this.capacityContext).create(teamId, runId, input);
		}
	async listCapacityWorkdayEventsPage(teamId: string, runId: string, filters: Parameters<CapacityWorkdayEventService['list']>[2] = {}) {
			return new CapacityWorkdayEventService(this.capacityContext).list(teamId, runId, filters);
		}
	async collectControlPlaneGeneratedArtifacts(projectId: string, modeRuns: JsonRecord[] = []) {
			return collectProjectAgentArtifacts(this.capacityContext, projectId, modeRuns.length ? modeRuns : undefined);
		}
	async getProjectAgentsSummary(projectId: string, principal: unknown = null) {
			return buildProjectAgentSummary(this.capacityContext, projectId, principal);
		}
	async evaluateProjectDeletionBlockers(projectId: string) {
			await this.ensureInitialized();
			return listProjectDeletionBlockers(this.capacityContext, projectId);
		}
}
export function createCapacityControlPlane(host: CapacityControlPlaneHost): CapacityControlPlaneStore {
	const target = new CapacityControlPlane(host);
	let provider!: ProviderControlPlane;
	const proxy = new Proxy(target as unknown as CapacityControlPlaneStore, {
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
