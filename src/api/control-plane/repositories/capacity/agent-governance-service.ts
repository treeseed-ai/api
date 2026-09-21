import { CapacityGovernanceError } from '../../../capacity/database.ts';
import { authorizeCapacityProject, type CapacityPrincipal } from './capacity-authorization.ts';
import { CapacityOperationError } from './capacity-operation-error.ts';

function translate(error: unknown): never {
	if (error instanceof CapacityOperationError) throw error;
	if (error instanceof CapacityGovernanceError) throw new CapacityOperationError(error.status, error.code, error.message);
	throw error;
}

export function createAgentGovernanceService(store: any) {
	return {
		async createResearch(principal: CapacityPrincipal, researchProjectId: string, body: Record<string, unknown>) {
			await authorizeCapacityProject(store, principal, researchProjectId, 'projects:manage:team');
			try {
				const value = await store.createResearchWorkflow(researchProjectId, body);
				if (!value) throw new CapacityOperationError(404, 'research_workflow_not_found', 'Research workflow not found.');
				return value;
			} catch (error) { translate(error); }
		},
		async researchWorkflows(principal: CapacityPrincipal, researchProjectId: string, query: Record<string, unknown>) {
			await authorizeCapacityProject(store, principal, researchProjectId, 'projects:read:team');
			try { return { items: await store.listResearchWorkflows(researchProjectId, {
				status: typeof query.status === 'string' ? query.status : undefined }), cursor: null }; }
			catch (error) { translate(error); }
		},
		async researchWorkflow(principal: CapacityPrincipal, workflowId: string) {
			const value = await store.getResearchWorkflow(workflowId);
			if (!value) throw new CapacityOperationError(404, 'research_workflow_not_found', 'Research workflow not found.');
			await authorizeCapacityProject(store, principal, value.projectId, 'projects:read:team');
			return value;
		},
		async completeResearchStage(principal: CapacityPrincipal, workflowId: string, stage: string, body: Record<string, unknown>) {
			const workflow = await store.getResearchWorkflow(workflowId);
			if (!workflow) throw new CapacityOperationError(404, 'research_workflow_not_found', 'Research workflow not found.');
			await authorizeCapacityProject(store, principal, workflow.projectId, 'projects:manage:team');
			try {
				const value = await store.completeResearchWorkflowStage(workflowId, stage, body);
				if (!value) throw new CapacityOperationError(404, 'research_workflow_not_found', 'Research workflow not found.');
				return value;
			} catch (error) { translate(error); }
		},
	};
}
