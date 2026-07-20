import { randomUUID } from 'node:crypto';
import type {
	DecisionAssignmentGraphRecord,
	DeliverableContractRecord,
	DeliverableManifestRecord,
	EngineeringAssignmentGraphRoles,
	StructuredAgentEstimate,
	StructuredAgentEstimateStatus,
} from '@treeseed/sdk/agent-capacity';
import { activateDecisionAssignmentGraph, advanceDecisionAssignmentGraph, compileDecisionAssignmentGraphFromEstimates, compileEngineeringAssignmentGraph, compileEngineeringRevisionCycle, validateDecisionAssignmentGraph, validateDeliverableManifest } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { DecisionWorkGraphRepository } from '../repositories/decision-work-graph.ts';
import { buildDecisionPlanningStatusRecord } from './planning-state-service.ts';

type JsonRecord = Record<string, unknown>;
interface DecisionWorkGraphStore extends CapacityGovernanceDatabase {
	getProject(projectId: string): Promise<{ id: string; teamId: string } | null>;
	scopeHash(value: unknown): string;
	listStructuredAgentEstimatesForDecision(decisionId: string, filters: { status: StructuredAgentEstimateStatus }): Promise<StructuredAgentEstimate[]>;
}

function record(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function idPart(value: string, fallback: string) { return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || fallback; }
function nextTransitionTimestamp(previous: string) {
	const candidate = new Date().toISOString();
	return candidate === previous ? new Date(Date.parse(previous) + 1).toISOString() : candidate;
}

function engineeringRoles(value: unknown): EngineeringAssignmentGraphRoles {
	const roles = record(value);
	return {
		tester: text(roles.tester), engineer: text(roles.engineer), reviewer: text(roles.reviewer),
		technicalWriter: text(roles.technicalWriter), releaser: text(roles.releaser),
		operations: text(roles.operations) || null, researcher: text(roles.researcher) || null, architect: text(roles.architect) || null,
	};
}

export class DecisionWorkGraphService {
	private readonly repository: DecisionWorkGraphRepository;
	constructor(private readonly store: DecisionWorkGraphStore) { this.repository = new DecisionWorkGraphRepository(store); }
	getGraph(id: string) { return this.repository.getGraph(id); }
	listGraphs(decisionId: string, active?: boolean) { return this.repository.listGraphs(decisionId, active); }
	getContract(id: string) { return this.repository.getContract(id); }

	async compile(decisionId: string, input: JsonRecord) {
		const projectId = text(input.projectId);
		if (!projectId) throw new CapacityGovernanceError('project_id_required', 'projectId is required.', 400);
		const project = await this.store.getProject(projectId);
		if (!project) return null;
		if (!decisionId) throw new CapacityGovernanceError('decision_id_required', 'decisionId is required.', 400);
		const version = input.version == null ? await this.repository.nextVersion(decisionId) : Number(input.version);
		if (!Number.isInteger(version) || version < 1) throw new CapacityGovernanceError('decision_assignment_graph_version_invalid', 'Graph version must be a positive integer.', 400);
		const now = new Date().toISOString();
		const workflowKind = text(input.workflowKind) || 'estimate-derived';
		if (workflowKind !== 'estimate-derived' && workflowKind !== 'engineering-test-first') {
			throw new CapacityGovernanceError('decision_assignment_graph_workflow_invalid', `Unsupported workflowKind ${workflowKind}.`, 400);
		}
		let compiled;
		if (workflowKind === 'engineering-test-first') {
			const roles = engineeringRoles(input.roles);
			const missingRoles = Object.entries(roles).filter(([key, value]) => !['operations', 'researcher', 'architect'].includes(key) && !value).map(([key]) => key);
			if (missingRoles.length) throw new CapacityGovernanceError('engineering_assignment_graph_roles_required', 'Engineering graphs require tester, engineer, reviewer, technicalWriter, and releaser roles.', 400, { missingRoles });
			compiled = compileEngineeringAssignmentGraph({
				id: text(input.id) || `dag_${idPart(decisionId, 'decision')}_v${version}`,
				teamId: project.teamId, projectId: project.id, decisionId, version, exactBaseRef: text(input.exactBaseRef), roles,
				includeResearch: input.includeResearch === true, includeArchitecture: input.includeArchitecture === true,
				credits: record(input.credits), compiledAt: now,
			});
		} else {
			const estimateStatus = (input.estimateStatus ?? 'accepted') as StructuredAgentEstimateStatus;
			const estimates = Array.isArray(input.estimates) ? input.estimates as StructuredAgentEstimate[] : await this.store.listStructuredAgentEstimatesForDecision(decisionId, { status: estimateStatus });
			if (!estimates.length) throw new CapacityGovernanceError('decision_assignment_graph_estimates_required', 'At least one accepted structured estimate is required to compile a decision assignment graph.', 409, { decisionId, estimateStatus });
			compiled = compileDecisionAssignmentGraphFromEstimates({ id: text(input.id) || `dag_${idPart(decisionId, 'decision')}_v${version}`, teamId: project.teamId, projectId: project.id, decisionId, version, estimates, compiledAt: now });
		}
		if (compiled.diagnostics.some((entry) => entry.severity === 'error')) throw new CapacityGovernanceError('decision_assignment_graph_invalid', 'Decision assignment graph compilation failed.', 400, { diagnostics: compiled.diagnostics });
		const requestedStatus = input.graphStatus ?? compiled.graph.status;
		if (requestedStatus !== 'draft' && requestedStatus !== 'compiled' && requestedStatus !== 'blocked') throw new CapacityGovernanceError('decision_assignment_graph_status_invalid', `Cannot create a graph in ${String(requestedStatus)} state.`, 400);
		const contractIds = new Map(compiled.graph.deliverableContracts.map((contract) => [contract.id, `${contract.id}:v${version}`]));
		const graph: DecisionAssignmentGraphRecord = {
			...compiled.graph,
			deliverableContracts: compiled.graph.deliverableContracts.map((contract) => ({ ...contract, id: contractIds.get(contract.id)! })),
			nodes: compiled.graph.nodes.map((node) => ({
				...node,
				requiredDeliverableContractIds: node.requiredDeliverableContractIds.map((id) => contractIds.get(id) ?? id),
				metadata: node.metadata ? {
					...node.metadata,
					...(node.metadata.producesDeliverableContractId ? { producesDeliverableContractId: contractIds.get(String(node.metadata.producesDeliverableContractId)) ?? node.metadata.producesDeliverableContractId } : {}),
				} : node.metadata,
			})),
			status: requestedStatus, active: false, createdAt: now, updatedAt: now,
			metadata: { ...(compiled.graph.metadata ?? {}), diagnostics: compiled.diagnostics, ...record(input.metadata) },
		};
		const validation = validateDecisionAssignmentGraph(graph);
		if (!validation.ok) throw new CapacityGovernanceError('decision_assignment_graph_invalid', 'Decision assignment graph is invalid.', 400, { diagnostics: validation.diagnostics });
		const contracts: DeliverableContractRecord[] = graph.deliverableContracts.map((contract) => ({
			...contract, metadata: { ...(contract.metadata ?? {}), graphId: graph.id, graphVersion: graph.version }, createdAt: now, updatedAt: now,
		}));
		return this.repository.createGraph(graph, contracts);
	}

	async activate(graphId: string) {
		const graph = await this.repository.getGraph(graphId);
		if (!graph) return null;
		if (graph.status !== 'draft' && graph.status !== 'compiled' && graph.status !== 'ready') throw new CapacityGovernanceError('decision_assignment_graph_activation_conflict', `Graph in ${graph.status} state cannot be activated.`, 409, { graphId });
		const now = new Date().toISOString();
		const planning = buildDecisionPlanningStatusRecord({
			teamId: graph.teamId, projectId: graph.projectId, decisionId: graph.decisionId, humanApprovalState: 'approved', executionReadiness: 'ready', planningInputsStatus: 'complete',
			scopeHash: this.store.scopeHash({ projectId: graph.projectId, decisionId: graph.decisionId, graphId, graphVersion: graph.version }), now,
			metadata: { source: 'decision_assignment_graph', activeGraphId: graphId, activeGraphVersion: graph.version },
		});
		return this.repository.activate({ ...activateDecisionAssignmentGraph(graph), active: graph.active, createdAt: graph.createdAt, updatedAt: now }, planning, now, graph.status);
	}

	async submitManifest(contractId: string, input: JsonRecord) {
		const contract = await this.repository.getContract(contractId);
		if (!contract) return null;
		const requestedId = text(input.id);
		if (requestedId) {
			const existing = await this.repository.getManifest(requestedId);
			if (existing) {
				if (existing.deliverableContractId !== contractId) throw new CapacityGovernanceError('deliverable_manifest_idempotency_conflict', 'Deliverable manifest id is already bound to another contract.', 409, { manifestId: requestedId, contractId });
				return existing;
			}
		}
		if (contract.status === 'approved') throw new CapacityGovernanceError('deliverable_contract_transition_conflict', 'An approved deliverable contract cannot accept another manifest.', 409, { contractId });
		const graphId = text(contract.metadata?.graphId);
		const graph = graphId ? await this.repository.getGraph(graphId) : null;
		const node = graph?.nodes.find((entry) => entry.metadata?.producesDeliverableContractId === contract.id);
		if (!graph || !graph.active || !node || !['ready', 'leased', 'running'].includes(node.status)) {
			throw new CapacityGovernanceError('deliverable_contract_not_ready', 'Deliverable manifests require an active ready graph node.', 409, { contractId, graphId: graph?.id ?? graphId ?? null, nodeStatus: node?.status ?? null });
		}
		const now = new Date().toISOString();
		const manifest: DeliverableManifestRecord = {
			id: requestedId || randomUUID(), deliverableContractId: contract.id, projectId: contract.projectId, decisionId: contract.decisionId,
			producedRefs: array(input.producedRefs) as DeliverableManifestRecord['producedRefs'], coverage: input.coverage == null ? undefined : record(input.coverage),
			summary: text(input.summary), readyForReview: input.readyForReview === true, submittedByAgentId: text(input.submittedByAgentId) || null,
			submittedAt: text(input.submittedAt) || now,
			sourceAuthority: input.sourceAuthority == null ? undefined : record(input.sourceAuthority) as unknown as DeliverableManifestRecord['sourceAuthority'],
			metadata: record(input.metadata), createdAt: now,
		};
		const validation = validateDeliverableManifest(manifest);
		if (!validation.ok) throw new CapacityGovernanceError('invalid_deliverable_manifest', 'Deliverable manifest is invalid.', 400, { diagnostics: validation.diagnostics });
		return this.repository.submitManifest(contract, manifest);
	}

	async transitionContract(contractId: string, to: 'approved' | 'rejected', input: JsonRecord) {
		const contract = await this.repository.getContract(contractId);
		if (!contract) return null;
		const graphId = text(contract.metadata?.graphId);
		const graph = graphId ? await this.repository.getGraph(graphId) : null;
		if (!graph) throw new CapacityGovernanceError('deliverable_contract_graph_missing', 'Deliverable contract is not attached to a durable assignment graph.', 500, { contractId });
		const now = nextTransitionTimestamp(graph.updatedAt);
		const reason = text(input.reason);
		const metadata = { ...(contract.metadata ?? {}), ...record(input.metadata), ...(to === 'approved' ? { approvedBy: text(input.approvedBy) || null } : { reason: reason || null }) };
		let updatedGraph: DecisionAssignmentGraphRecord;
		let newContracts: DeliverableContractRecord[] = [];
		if (to === 'approved') {
			const contractStates = await Promise.all(graph.deliverableContracts.map((entry) => this.repository.getContract(entry.id)));
			const approvedIds = new Set(contractStates.filter((entry) => entry?.status === 'approved').map((entry) => entry!.id));
			approvedIds.add(contract.id);
			updatedGraph = { ...advanceDecisionAssignmentGraph(graph, contract.id, approvedIds), active: graph.active, createdAt: graph.createdAt, updatedAt: now };
		} else {
			const revision = compileEngineeringRevisionCycle(graph, contract.id, reason || 'Reviewer requested revision.');
			if (revision) {
				updatedGraph = { ...revision.graph, active: graph.active, createdAt: graph.createdAt, updatedAt: now };
				newContracts = revision.newContracts.map((entry) => ({ ...entry, metadata: { ...(entry.metadata ?? {}), graphId: graph.id, graphVersion: graph.version }, createdAt: now, updatedAt: now }));
			} else {
				updatedGraph = {
					...graph,
					deliverableContracts: graph.deliverableContracts.map((entry) => entry.id === contract.id ? { ...entry, status: 'rejected' } : entry),
					nodes: graph.nodes.map((node) => node.metadata?.producesDeliverableContractId === contract.id ? { ...node, status: 'ready' } : node),
					updatedAt: now,
				};
			}
		}
		const validation = validateDecisionAssignmentGraph(updatedGraph);
		if (!validation.ok) throw new CapacityGovernanceError('decision_assignment_graph_transition_invalid', 'Deliverable transition would invalidate the assignment graph.', 500, { diagnostics: validation.diagnostics });
		return this.repository.transitionContract(contract, to, metadata, updatedGraph, graph.updatedAt, newContracts, now);
	}
}
