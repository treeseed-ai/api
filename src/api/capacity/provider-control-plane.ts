import { normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import { CapacityGovernanceError, type CapacityGovernanceDatabase } from './database.ts';
import { ProviderAssignmentLifecycleService } from './services/assignment-lifecycle-service.ts';
import { leaseNextProviderAssignment as leaseProviderAssignment } from './services/assignment-lease-service.ts';
import { admitSynthesizedProviderAssignment as admitSynthesizedAssignment } from './services/assignment-admission-service.ts';
import type { ProviderLeasePrincipal } from './services/lease-authority-service.ts';
import { CapacityGrantService } from './services/grant-service.ts';
import { CapacityAllocationService } from './services/allocation-service.ts';
import { ProjectAgentClassService } from './services/project-agent-class-service.ts';
import {
	AvailabilitySessionService,
	type ProviderAvailabilityPrincipal,
} from './services/availability-session-service.ts';
import { resolveProviderSynthesisContext } from './services/provider-synthesis-context-service.ts';
import type { ProviderSynthesisRequest } from './services/assignment-synthesis-service.ts';
import { CapacityProviderIdentityRepository } from './repositories/provider-identity.ts';
import { ProviderAssignmentRepository } from './repositories/assignment.ts';
import { listCapacityExecutionProviders } from './repositories/execution-provider.ts';
import {
	listAgentModeRunsPage as readAgentModeRunsPage,
	persistAgentModeRun,
	readAgentModeRun,
} from './repositories/mode-run.ts';
import { listExecutionRunsForTeamPage as readExecutionRunsForTeamPage } from './repositories/execution-run.ts';

type JsonRecord = Record<string, unknown>;

interface PageFilters extends JsonRecord {
	limit?: number | string | null;
	cursor?: string | null;
	providerId?: string | null;
	status?: string | null;
}

export interface ProviderControlPlaneContext extends CapacityGovernanceDatabase {
	getCapacityProvider(teamId: string, providerId: string): Promise<unknown>;
}

export class ProviderControlPlane {
	private readonly assignmentRepository: ProviderAssignmentRepository;
	private readonly allocationService: CapacityAllocationService;
	private readonly agentClassService: ProjectAgentClassService;
	private readonly availabilityService: AvailabilitySessionService;

	constructor(private readonly providerContext: ProviderControlPlaneContext) {
		this.assignmentRepository = new ProviderAssignmentRepository(providerContext);
		this.allocationService = new CapacityAllocationService(providerContext);
		this.agentClassService = new ProjectAgentClassService(providerContext);
		this.availabilityService = new AvailabilitySessionService(providerContext);
	}

	async listTeamCapacityProviders(teamId: string) {
		return new CapacityProviderIdentityRepository(this.providerContext).listTeamMemberships(teamId);
	}

	async getCapacityProvider(teamId: string, providerId: string) {
		return new CapacityProviderIdentityRepository(this.providerContext).getTeamMembership(teamId, providerId);
	}

	async listProviderExecutionSnapshots(teamId: string, providerId: string) {
		await this.providerContext.ensureInitialized();
		if (!(await this.getCapacityProvider(teamId, providerId))) return [];
		return listCapacityExecutionProviders(this.providerContext, providerId);
	}

	async listCapacityGrantsPage(teamId: string, filters: PageFilters = {}) {
		return new CapacityGrantService(this.providerContext).listPage(teamId, filters);
	}

	async createCapacityAllocationSet(teamId: string, input: JsonRecord = {}) {
		const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
		if (!idempotencyKey) throw new CapacityGovernanceError('capacity_idempotency_key_required', 'An idempotency key is required.', 400);
		const { idempotencyKey: _idempotencyKey, ...policy } = input;
		return this.allocationService.create(teamId, policy, typeof input.createdById === 'string' ? input.createdById : null, idempotencyKey);
	}

	async listCapacityAllocationSetsPage(teamId: string, { limit, cursor }: PageFilters = {}) {
		return this.allocationService.listPage(teamId, { limit, cursor });
	}

	nextCapacityAllocationVersion(teamId: string) {
		return this.allocationService.nextVersion(teamId);
	}

	getCapacityAllocationSet(teamId: string, allocationSetId: string) {
		return this.allocationService.get(teamId, allocationSetId);
	}

	getActiveCapacityAllocationSet(teamId: string) {
		return this.allocationService.getActive(teamId);
	}

	activateCapacityAllocationSet(teamId: string, allocationSetId: string, idempotencyKey: string) {
		return this.allocationService.activate(teamId, allocationSetId, idempotencyKey);
	}

	listProjectAgentClassesPage(projectId: string, filters: PageFilters = {}) {
		return this.agentClassService.listPage(projectId, {
			limit: normalizeCapacityPageLimit(filters.limit),
			cursor: filters.cursor ?? null,
		});
	}

	getProjectAgentClass(projectId: string, classId: string) {
		return this.agentClassService.get(projectId, classId);
	}

	createProviderAvailabilitySession(principal: ProviderAvailabilityPrincipal, input: JsonRecord = {}) {
		return this.availabilityService.open(principal, input);
	}

	refreshProviderAvailabilitySession(principal: ProviderAvailabilityPrincipal, sessionId: string, input: JsonRecord = {}) {
		return this.availabilityService.refresh(principal, sessionId, input);
	}

	closeProviderAvailabilitySession(principal: ProviderAvailabilityPrincipal, sessionId: string) {
		return this.availabilityService.close(principal, sessionId);
	}

	listProviderAvailabilitySessionsPage(teamId: string, filters: PageFilters = {}) {
		return this.availabilityService.listPage(teamId, {
			providerId: filters.providerId ?? null,
			status: filters.status ?? null,
			limit: normalizeCapacityPageLimit(filters.limit),
			cursor: filters.cursor ?? null,
		});
	}

	getProviderAvailabilitySession(teamId: string, sessionId: string) {
		return this.availabilityService.get(teamId, sessionId);
	}

	resolveProviderSynthesisContext(principal: ProviderLeasePrincipal, input: ProviderSynthesisRequest = {}) {
		return resolveProviderSynthesisContext(this.providerContext, principal, input);
	}

	listProviderAssignmentsPage(teamId: string, filters: PageFilters = {}) {
		return this.assignmentRepository.list(teamId, filters);
	}

	getProviderAssignment(teamId: string, assignmentId: string) {
		return this.assignmentRepository.get(teamId, assignmentId);
	}

	admitSynthesizedProviderAssignment(
		principal: ProviderLeasePrincipal,
		input: Parameters<typeof admitSynthesizedAssignment>[2],
	) {
		return admitSynthesizedAssignment(this.providerContext, principal, input);
	}

	leaseNextProviderAssignment(principal: ProviderLeasePrincipal, input: JsonRecord = {}) {
		return leaseProviderAssignment(this.providerContext, principal, input);
	}

	renewProviderAssignmentLease(principal: ProviderLeasePrincipal, assignmentId: string, input: JsonRecord = {}) {
		return new ProviderAssignmentLifecycleService(this.providerContext).renew(principal, assignmentId, input);
	}

	returnProviderAssignment(principal: ProviderLeasePrincipal, assignmentId: string, input: JsonRecord = {}) {
		return new ProviderAssignmentLifecycleService(this.providerContext).return(principal, assignmentId, input);
	}

	completeProviderAssignment(principal: ProviderLeasePrincipal, assignmentId: string, input: JsonRecord = {}) {
		return new ProviderAssignmentLifecycleService(this.providerContext).complete(principal, assignmentId, input);
	}

	failProviderAssignment(principal: ProviderLeasePrincipal, assignmentId: string, input: JsonRecord = {}) {
		return new ProviderAssignmentLifecycleService(this.providerContext).fail(principal, assignmentId, input);
	}

	createAgentModeRun(input: JsonRecord = {}) {
		return persistAgentModeRun(this.providerContext, input);
	}

	listAgentModeRunsPage(projectId: string, filters: PageFilters = {}) {
		return readAgentModeRunsPage(this.providerContext, projectId, filters);
	}

	listExecutionRunsForTeamPage(teamId: string, filters: PageFilters = {}) {
		return readExecutionRunsForTeamPage(this.providerContext, teamId, filters);
	}

	getAgentModeRun(teamId: string, modeRunId: string) {
		return readAgentModeRun(this.providerContext, teamId, modeRunId);
	}
}
