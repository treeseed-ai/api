import { CapacityGovernanceError } from '../../../capacity/database.ts';
import { validateExecutionAuthorityReceipt } from '../../../governance/decision-authority.ts';
import { authorizeCapacityProject, type CapacityPrincipal } from './capacity-authorization.ts';
import { CapacityOperationError } from './capacity-operation-error.ts';

function translate(error: unknown): never {
	if (error instanceof CapacityOperationError) throw error;
	if (error instanceof CapacityGovernanceError) throw new CapacityOperationError(error.status, error.code, error.message);
	throw error;
}

function projectId(body: Record<string, unknown>) {
	const value = typeof body.projectId === 'string' ? body.projectId.trim() : '';
	if (!value) throw new CapacityOperationError(400, 'project_id_required', 'projectId is required.');
	return value;
}

function active(value: unknown): boolean | undefined {
	if (value == null || value === '') return undefined;
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new CapacityOperationError(400, 'decision_assignment_graph_active_filter_invalid', 'active must be true or false.');
}

export function createAgentGovernanceService(store: any) {
	return {
		async validateAuthorities(principal: CapacityPrincipal, body: Record<string, unknown>) {
			const authorities = Array.isArray(body.authorities) ? body.authorities : [];
			if (!authorities.length || authorities.length > 200) throw new CapacityOperationError(400,
				'governance_execution_authorities_invalid', 'One to 200 execution authorities are required.');
			const results = [];
			for (const value of authorities) {
				const authority = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
				const authorityProjectId = projectId(authority);
				await authorizeCapacityProject(store, principal, authorityProjectId, 'projects:read:team');
				try {
					results.push({ authorityId: typeof authority.authorityId === 'string' ? authority.authorityId : null,
						...(await validateExecutionAuthorityReceipt(store, authority)) });
				} catch (error) { translate(error); }
			}
			return { items: results };
		},
		async compileGraph(principal: CapacityPrincipal, decisionId: string, body: Record<string, unknown>) {
			await authorizeCapacityProject(store, principal, projectId(body), 'projects:manage:team');
			try {
				const graph = await store.createDecisionAssignmentGraph(decisionId, body);
				if (!graph) throw new CapacityOperationError(404, 'project_not_found', 'Project not found.');
				return body.activate === false ? graph : await store.activateDecisionAssignmentGraphVersion(graph.id) ?? graph;
			} catch (error) { translate(error); }
		},
		async graphs(principal: CapacityPrincipal, decisionId: string, query: Record<string, unknown>) {
			try {
				const items = await store.listDecisionAssignmentGraphsForDecision(decisionId, { active: active(query.active) });
				const planning = items.length ? null : await store.getDecisionPlanningStatus(decisionId);
				const graphProjectId = items[0]?.projectId ?? planning?.projectId;
				if (!graphProjectId) throw new CapacityOperationError(404, 'decision_planning_not_found', 'Decision planning status not found.');
				await authorizeCapacityProject(store, principal, graphProjectId, 'projects:read:team');
				return { items, cursor: null };
			} catch (error) { translate(error); }
		},
		async graph(principal: CapacityPrincipal, graphId: string) {
			const value = await store.getDecisionAssignmentGraph(graphId);
			if (!value) throw new CapacityOperationError(404, 'assignment_graph_not_found', 'Decision assignment graph not found.');
			await authorizeCapacityProject(store, principal, value.projectId, 'projects:read:team');
			return value;
		},
		async manifest(principal: CapacityPrincipal, manifestId: string) {
			const value = await store.getDeliverableManifest(manifestId);
			if (!value) throw new CapacityOperationError(404, 'deliverable_manifest_not_found', 'Deliverable manifest not found.');
			await authorizeCapacityProject(store, principal, value.projectId, 'projects:read:team');
			return value;
		},
		async createManifest(principal: CapacityPrincipal, contractId: string, body: Record<string, unknown>) {
			const contract = await store.getDeliverableContract(contractId);
			if (!contract) throw new CapacityOperationError(404, 'deliverable_contract_not_found', 'Deliverable contract not found.');
			await authorizeCapacityProject(store, principal, contract.projectId, 'projects:manage:team');
			try {
				const value = await store.submitDeliverableManifest(contractId, body);
				if (!value) throw new CapacityOperationError(404, 'deliverable_contract_not_found', 'Deliverable contract not found.');
				return value;
			} catch (error) { translate(error); }
		},
		async transitionContract(principal: CapacityPrincipal, contractId: string, status: 'approved' | 'rejected', body: Record<string, unknown>) {
			const contract = await store.getDeliverableContract(contractId);
			if (!contract) throw new CapacityOperationError(404, 'deliverable_contract_not_found', 'Deliverable contract not found.');
			await authorizeCapacityProject(store, principal, contract.projectId, 'projects:manage:team');
			try {
				const value = status === 'approved'
					? await store.markDeliverableContractApproved(contractId, body)
					: await store.markDeliverableContractRejected(contractId, body);
				if (!value) throw new CapacityOperationError(404, 'deliverable_contract_not_found', 'Deliverable contract not found.');
				return value;
			} catch (error) { translate(error); }
		},
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
