import type { DecisionExecutionInputStatus, StructuredAgentEstimateStatus } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import { authorizeCapacityProject, type CapacityPrincipal } from './capacity-authorization.ts';
import { CapacityOperationError } from './capacity-operation-error.ts';

const EXECUTION_STATUSES = new Set<DecisionExecutionInputStatus>(['proposed', 'accepted', 'revision_requested', 'rejected', 'stale']);
const ESTIMATE_STATUSES = new Set<StructuredAgentEstimateStatus>(['submitted', 'accepted', 'rejected', 'superseded']);

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredProjectId(body: Record<string, unknown>) {
	const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
	if (!projectId) throw new CapacityOperationError(400, 'project_id_required', 'projectId is required.');
	return projectId;
}

function selectedStatus<T extends string>(value: unknown, allowed: Set<T>, code: string): T | null {
	if (value == null || value === '') return null;
	const status = String(value) as T;
	if (!allowed.has(status)) throw new CapacityOperationError(400, code, `Unknown status ${status}.`);
	return status;
}

function translate(error: unknown): never {
	if (error instanceof CapacityOperationError) throw error;
	if (error instanceof CapacityGovernanceError) throw new CapacityOperationError(error.status, error.code, error.message);
	throw error;
}

export function createPlanningAndEstimateService(store: any) {
	return {
		async planningStatus(principal: CapacityPrincipal, decisionId: string) {
			const value = await store.getDecisionPlanningStatus(decisionId);
			if (!value) throw new CapacityOperationError(404, 'decision_planning_not_found', 'Decision planning status not found.');
			await authorizeCapacityProject(store, principal, value.projectId, 'projects:read:team');
			return value;
		},
		async requestPlanningInput(principal: CapacityPrincipal, decisionId: string, body: Record<string, unknown>) {
			const projectId = requiredProjectId(body);
			await authorizeCapacityProject(store, principal, projectId, 'projects:manage:team');
			try {
				const value = await store.createPlanningInputRequest(decisionId, body);
				if (!value) throw new CapacityOperationError(404, 'project_not_found', 'Project not found.');
				return value;
			} catch (error) { translate(error); }
		},
		async executionInputs(principal: CapacityPrincipal, decisionId: string, query: Record<string, unknown>) {
			const planning = await store.getDecisionPlanningStatus(decisionId);
			if (!planning) throw new CapacityOperationError(404, 'decision_planning_not_found', 'Decision planning status not found.');
			await authorizeCapacityProject(store, principal, planning.projectId, 'projects:read:team');
			try {
				return { items: await store.listDecisionExecutionInputs(decisionId, {
					status: selectedStatus(query.status, EXECUTION_STATUSES, 'decision_execution_input_status_invalid'),
				}), cursor: null };
			} catch (error) { translate(error); }
		},
		async createExecutionInput(principal: CapacityPrincipal, decisionId: string, body: Record<string, unknown>) {
			const projectId = requiredProjectId(body);
			await authorizeCapacityProject(store, principal, projectId, 'projects:manage:team');
			try {
				const value = await store.createDecisionExecutionInput(decisionId, body);
				if (!value) throw new CapacityOperationError(404, 'project_not_found', 'Project not found.');
				return value;
			} catch (error) { translate(error); }
		},
		async transitionExecutionInput(principal: CapacityPrincipal, inputId: string,
			status: 'accepted' | 'revision_requested', body: Record<string, unknown>) {
			const existing = await store.getDecisionExecutionInput(inputId);
			if (!existing) throw new CapacityOperationError(404, 'decision_execution_input_not_found', 'Decision execution input not found.');
			await authorizeCapacityProject(store, principal, existing.projectId, 'projects:manage:team');
			try {
				const value = await store.updateDecisionExecutionInputStatus(inputId, status, record(body));
				if (!value) throw new CapacityOperationError(404, 'decision_execution_input_not_found', 'Decision execution input not found.');
				return value;
			} catch (error) { translate(error); }
		},
		async createEstimate(principal: CapacityPrincipal, decisionId: string, body: Record<string, unknown>) {
			const projectId = requiredProjectId(body);
			await authorizeCapacityProject(store, principal, projectId, 'projects:manage:team');
			try {
				const value = await store.createStructuredAgentEstimate(decisionId, body);
				if (!value) throw new CapacityOperationError(404, 'project_not_found', 'Project not found.');
				return value;
			} catch (error) { translate(error); }
		},
		async estimates(principal: CapacityPrincipal, decisionId: string, query: Record<string, unknown>) {
			try {
				const items = await store.listStructuredAgentEstimatesForDecision(decisionId, {
					status: selectedStatus(query.status, ESTIMATE_STATUSES, 'structured_agent_estimate_status_invalid'),
				});
				const planning = items.length ? null : await store.getDecisionPlanningStatus(decisionId);
				const projectId = items[0]?.projectId ?? planning?.projectId;
				if (!projectId) throw new CapacityOperationError(404, 'decision_planning_not_found', 'Decision planning status not found.');
				await authorizeCapacityProject(store, principal, projectId, 'projects:read:team');
				return { items, cursor: null };
			} catch (error) { translate(error); }
		},
		async transitionEstimate(principal: CapacityPrincipal, estimateId: string,
			status: 'accepted' | 'rejected', body: Record<string, unknown>) {
			const existing = await store.getStructuredAgentEstimate(estimateId);
			if (!existing) throw new CapacityOperationError(404, 'structured_agent_estimate_not_found', 'Structured agent estimate not found.');
			await authorizeCapacityProject(store, principal, existing.projectId, 'projects:manage:team');
			try {
				const value = await store.updateStructuredAgentEstimateStatus(estimateId, status, record(body));
				if (!value) throw new CapacityOperationError(404, 'structured_agent_estimate_not_found', 'Structured agent estimate not found.');
				return value;
			} catch (error) { translate(error); }
		},
	};
}
