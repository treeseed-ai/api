import type {
AgentCapacityContractDiagnostic,
AgentCapacityContractValidationResult,
ContentRef,
DecisionAssignmentGraph,
DecisionAssignmentGraphCompileResult,
DecisionAssignmentGraphEdge,
DecisionAssignmentGraphNode,
DecisionDependencySpec,
DeliverableContract,
DeliverableManifest,
EngineeringAssignmentGraphInput,
StructuredAgentEstimate,
} from '@treeseed/sdk/agent-capacity';

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function diagnostic(
	diagnostics: AgentCapacityContractDiagnostic[],
	code: string,
	message: string,
	path?: string,
	severity: AgentCapacityContractDiagnostic['severity'] = 'error',
) {
	diagnostics.push({ severity, code, message, path });
}

function validateNonEmptyString(diagnostics: AgentCapacityContractDiagnostic[], value: unknown, field: string, path = field) {
	if (typeof value !== 'string' || !value.trim()) diagnostic(diagnostics, 'required_string_missing', `${field} is required.`, path);
}

function validateNonNegativeNumber(diagnostics: AgentCapacityContractDiagnostic[], value: unknown, field: string, path = field) {
	if (!Number.isFinite(Number(value)) || Number(value) < 0) {
		diagnostic(diagnostics, 'non_negative_number_required', `${field} must be a non-negative number.`, path);
	}
}

function validationResult(diagnostics: AgentCapacityContractDiagnostic[]): AgentCapacityContractValidationResult {
	return { ok: diagnostics.every((entry) => entry.severity !== 'error'), diagnostics };
}

function dependencyToContractId(projectId: string, decisionId: string, dependency: DecisionDependencySpec): string {
	const deliverable = dependency.deliverableType || dependency.capability || dependency.id;
	return `${projectId}:${decisionId}:deliverable:${deliverable}`.replace(/[^a-zA-Z0-9:_-]+/gu, '-');
}

function edgeTypeForDependency(dependency: DecisionDependencySpec): DecisionAssignmentGraphEdge['edgeType'] {
	if (dependency.requiredBefore === 'complete' || dependency.requiredBefore === 'review') return 'blocks-completion';
	if (dependency.requiredBefore === 'release') return 'blocks-release';
	return 'blocks-start';
}

export function validateDecisionDependencySpec(dependency: DecisionDependencySpec, path = 'dependency'): AgentCapacityContractValidationResult {
	const diagnostics: AgentCapacityContractDiagnostic[] = [];
	validateNonEmptyString(diagnostics, dependency.id, 'id', `${path}.id`);
	if (!['artifact', 'capability', 'decision', 'external-resource', 'human-input'].includes(dependency.type)) {
		diagnostic(diagnostics, 'invalid_dependency_type', `Dependency ${dependency.id || '<unknown>'} has an invalid type.`, `${path}.type`);
	}
	if (!['start', 'complete', 'review', 'release'].includes(dependency.requiredBefore)) {
		diagnostic(diagnostics, 'invalid_dependency_required_before', `Dependency ${dependency.id || '<unknown>'} has an invalid requiredBefore value.`, `${path}.requiredBefore`);
	}
	if (dependency.type === 'artifact' && !dependency.deliverableType) diagnostic(diagnostics, 'artifact_dependency_missing_deliverable_type', 'Artifact dependencies must declare deliverableType.', `${path}.deliverableType`);
	if (dependency.type === 'capability' && !dependency.capability && !dependency.agentClass) diagnostic(diagnostics, 'capability_dependency_missing_capability', 'Capability dependencies must declare capability or agentClass.', `${path}.capability`);
	if (dependency.type === 'human-input') {
		const policy = dependency.humanInputPolicy;
		if (!policy || !['team-human', 'any-human', 'any-human-or-agent'].includes(policy.requiredFrom)) {
			diagnostic(diagnostics, 'human_input_policy_missing', 'Human-input dependencies must declare a valid humanInputPolicy.requiredFrom.', `${path}.humanInputPolicy.requiredFrom`);
		}
	}
	return validationResult(diagnostics);
}

export function validateStructuredAgentEstimate(estimate: StructuredAgentEstimate): AgentCapacityContractValidationResult {
	const diagnostics: AgentCapacityContractDiagnostic[] = [];
	if (estimate.schemaVersion !== undefined && ![1,2,3].includes(estimate.schemaVersion)) diagnostic(diagnostics, 'estimate_schema_version_invalid', 'schemaVersion must be 1, 2, or 3.', 'schemaVersion');
	validateNonEmptyString(diagnostics, estimate.id, 'id');
	validateNonEmptyString(diagnostics, estimate.teamId, 'teamId');
	validateNonEmptyString(diagnostics, estimate.projectId, 'projectId');
	validateNonEmptyString(diagnostics, estimate.agentClass, 'agentClass');
	if (!estimate.decisionId && !estimate.proposalId) diagnostic(diagnostics, 'estimate_missing_subject', 'Structured estimates must reference a decisionId or proposalId.', 'decisionId');
	validateNonNegativeNumber(diagnostics, estimate.minSeconds, 'minSeconds');
	validateNonNegativeNumber(diagnostics, estimate.expectedSeconds, 'expectedSeconds');
	validateNonNegativeNumber(diagnostics, estimate.maxSeconds, 'maxSeconds');
	if (Number(estimate.minSeconds) > Number(estimate.expectedSeconds) || Number(estimate.expectedSeconds) > Number(estimate.maxSeconds)) {
		diagnostic(diagnostics, 'estimate_time_bounds_invalid', 'Estimate time bounds must satisfy min <= expected <= max.', 'expectedSeconds');
	}
	if (!['low', 'medium', 'high'].includes(estimate.confidence)) diagnostic(diagnostics, 'estimate_confidence_invalid', 'Estimate confidence must be low, medium, or high.', 'confidence');
	if (!['low', 'medium', 'high'].includes(estimate.riskLevel)) diagnostic(diagnostics, 'estimate_risk_level_invalid', 'Estimate riskLevel must be low, medium, or high.', 'riskLevel');
	if (estimate.schemaVersion === 2 || estimate.schemaVersion === 3) {
		const breakdown=estimate.workBreakdown;
		if(!breakdown) diagnostic(diagnostics,'estimate_work_breakdown_required','Version 2 estimates require a complete work breakdown.','workBreakdown');
		else {
			for(const field of ['preparationSeconds','implementationSeconds','verificationSeconds','independentReviewSeconds','revisionSeconds','revisionVerificationSeconds','finalReviewSeconds','reportingSeconds','reserveSeconds'] as const) validateNonNegativeNumber(diagnostics,breakdown[field],`workBreakdown.${field}`);
			if(!Number.isInteger(breakdown.expectedRevisionCycles)||breakdown.expectedRevisionCycles<0) diagnostic(diagnostics,'estimate_revision_cycles_invalid','expectedRevisionCycles must be a non-negative integer.','workBreakdown.expectedRevisionCycles');
			if(breakdown.independentReviewSeconds<=0||breakdown.finalReviewSeconds<=0||breakdown.reportingSeconds<=0) diagnostic(diagnostics,'estimate_governed_phases_required','Independent review, final review, and reporting must receive positive capacity.','workBreakdown');
			const allocated=breakdown.preparationSeconds+breakdown.implementationSeconds+breakdown.verificationSeconds+breakdown.independentReviewSeconds+breakdown.revisionSeconds+breakdown.revisionVerificationSeconds+breakdown.finalReviewSeconds+breakdown.reportingSeconds+breakdown.reserveSeconds;
			if(allocated!==estimate.expectedSeconds) diagnostic(diagnostics,'estimate_work_breakdown_total_invalid','Work breakdown seconds must sum to expectedSeconds.','workBreakdown');
		}
	}
	if (estimate.schemaVersion === 3) {
		for (const [field, revision] of [['proposalRevision', estimate.proposalRevision], ['decisionRevision', estimate.decisionRevision]] as const) {
			if (!revision || !revision.id || !Number.isInteger(revision.version) || revision.version < 1 || !revision.digest) diagnostic(diagnostics, 'estimate_exact_governance_revision_required', `Version 3 estimates require exact ${field}.`, field);
		}
		if (!estimate.groupSnapshot) diagnostic(diagnostics, 'estimate_group_snapshot_required', 'Version 3 estimates require the frozen group membership snapshot.', 'groupSnapshot');
		if (!estimate.agentDefinitionRevision?.id || !Number.isInteger(estimate.agentDefinitionRevision.revision) || estimate.agentDefinitionRevision.revision < 1 || !estimate.agentDefinitionRevision.digest) diagnostic(diagnostics, 'estimate_agent_definition_revision_required', 'Version 3 estimates require exact agent-definition provenance.', 'agentDefinitionRevision');
		if (!estimate.requiredProviderCapabilities?.length) diagnostic(diagnostics, 'estimate_provider_capabilities_required', 'Version 3 estimates require provider capabilities.', 'requiredProviderCapabilities');
		if (!estimate.acceptableProviderClasses?.length) diagnostic(diagnostics, 'estimate_provider_classes_required', 'Version 3 estimates require acceptable provider classes.', 'acceptableProviderClasses');
		for (const [index, range] of (estimate.providerNativeRanges ?? []).entries()) {
			if (!range.unit || !Number.isFinite(range.minimum) || !Number.isFinite(range.expected) || !Number.isFinite(range.maximum) || range.minimum < 0 || range.minimum > range.expected || range.expected > range.maximum) diagnostic(diagnostics, 'estimate_provider_native_range_invalid', 'Provider-native ranges require unit and minimum <= expected <= maximum.', `providerNativeRanges.${index}`);
		}
	}
	for (const [index, dependency] of (estimate.dependencies ?? []).entries()) {
		diagnostics.push(...validateDecisionDependencySpec(dependency, `dependencies.${index}`).diagnostics);
	}
	return validationResult(diagnostics);
}

export function validateDeliverableContract(contract: DeliverableContract): AgentCapacityContractValidationResult {
	const diagnostics: AgentCapacityContractDiagnostic[] = [];
	validateNonEmptyString(diagnostics, contract.id, 'id');
	validateNonEmptyString(diagnostics, contract.teamId, 'teamId');
	validateNonEmptyString(diagnostics, contract.projectId, 'projectId');
	validateNonEmptyString(diagnostics, contract.decisionId, 'decisionId');
	validateNonEmptyString(diagnostics, contract.deliverableType, 'deliverableType');
	if (!Array.isArray(contract.producerAgentClasses) || contract.producerAgentClasses.length === 0) diagnostic(diagnostics, 'deliverable_contract_missing_producer', 'Deliverable contracts must declare at least one producerAgentClass.', 'producerAgentClasses');
	if (!['required', 'draft', 'submitted', 'approved', 'rejected', 'stale'].includes(contract.status)) diagnostic(diagnostics, 'deliverable_contract_status_invalid', 'Deliverable contract has an invalid status.', 'status');
	return validationResult(diagnostics);
}

export function validateDeliverableManifest(manifest: DeliverableManifest): AgentCapacityContractValidationResult {
	const diagnostics: AgentCapacityContractDiagnostic[] = [];
	validateNonEmptyString(diagnostics, manifest.id, 'id');
	validateNonEmptyString(diagnostics, manifest.deliverableContractId, 'deliverableContractId');
	validateNonEmptyString(diagnostics, manifest.projectId, 'projectId');
	validateNonEmptyString(diagnostics, manifest.decisionId, 'decisionId');
	if (!Array.isArray(manifest.producedRefs) || manifest.producedRefs.length === 0) diagnostic(diagnostics, 'deliverable_manifest_missing_refs', 'Deliverable manifests must map the contract to at least one produced content ref.', 'producedRefs');
	validateNonEmptyString(diagnostics, manifest.summary, 'summary');
	if (manifest.sourceAuthority) {
		validateNonEmptyString(diagnostics, manifest.sourceAuthority.assignmentId, 'sourceAuthority.assignmentId');
		validateNonEmptyString(diagnostics, manifest.sourceAuthority.modeRunId, 'sourceAuthority.modeRunId');
		for (const field of ['baseRef', 'effectiveRef'] as const) {
			const value = manifest.sourceAuthority[field];
			if (!/^[0-9a-f]{7,64}$/iu.test(value)) diagnostic(diagnostics, 'deliverable_source_ref_invalid', `${field} must be an immutable hexadecimal commit id.`, `sourceAuthority.${field}`);
		}
		const checkpoint = manifest.sourceAuthority.checkpointCommit;
		if (checkpoint != null && (!/^[0-9a-f]{7,64}$/iu.test(checkpoint) || checkpoint !== manifest.sourceAuthority.effectiveRef)) {
			diagnostic(diagnostics, 'deliverable_checkpoint_ref_invalid', 'checkpointCommit must be an immutable commit id equal to effectiveRef.', 'sourceAuthority.checkpointCommit');
		}
	}
	return validationResult(diagnostics);
}

export function validateDecisionAssignmentGraph(graph: DecisionAssignmentGraph): AgentCapacityContractValidationResult {
	const diagnostics: AgentCapacityContractDiagnostic[] = [];
	validateNonEmptyString(diagnostics, graph.id, 'id');
	validateNonEmptyString(diagnostics, graph.teamId, 'teamId');
	validateNonEmptyString(diagnostics, graph.projectId, 'projectId');
	validateNonEmptyString(diagnostics, graph.decisionId, 'decisionId');
	if (!Number.isInteger(graph.version) || graph.version < 1) diagnostic(diagnostics, 'graph_version_invalid', 'Decision assignment graph version must be a positive integer.', 'version');
	if (graph.compiledBy !== 'api-control-plane') diagnostic(diagnostics, 'graph_compiler_invalid', 'Decision assignment graphs must be compiled by api-control-plane.', 'compiledBy');
	const nodeIds = new Set(graph.nodes.map((node) => node.id));
	for (const [index, node] of graph.nodes.entries()) {
		validateNonEmptyString(diagnostics, node.id, 'node.id', `nodes.${index}.id`);
		validateNonEmptyString(diagnostics, node.targetAgentClass, 'node.targetAgentClass', `nodes.${index}.targetAgentClass`);
		validateNonNegativeNumber(diagnostics, node.capacity.expectedSeconds, 'node.capacity.expectedSeconds', `nodes.${index}.capacity.expectedSeconds`);
		validateNonNegativeNumber(diagnostics, node.capacity.maxSeconds, 'node.capacity.maxSeconds', `nodes.${index}.capacity.maxSeconds`);
	}
	for (const [index, edge] of graph.edges.entries()) {
		if (!nodeIds.has(edge.fromNodeId)) diagnostic(diagnostics, 'graph_edge_from_missing', `Edge ${index} references missing fromNodeId.`, `edges.${index}.fromNodeId`);
		if (!nodeIds.has(edge.toNodeId)) diagnostic(diagnostics, 'graph_edge_to_missing', `Edge ${index} references missing toNodeId.`, `edges.${index}.toNodeId`);
	}
	for (const [index, contract] of graph.deliverableContracts.entries()) {
		diagnostics.push(...validateDeliverableContract(contract).diagnostics.map((entry) => ({ ...entry, path: `deliverableContracts.${index}${entry.path ? `.${entry.path}` : ''}` })));
	}
	return validationResult(diagnostics);
}

export function compileDecisionAssignmentGraphFromEstimates(input: {
	id?: string;
	teamId: string;
	projectId: string;
	decisionId: string;
	version?: number;
	estimates: StructuredAgentEstimate[];
	executionMode?: 'simulation' | 'production';
	reviewersByAgentClass?: Record<string,string[]>;
	reportingAgentClass?: string;
	maximumRevisionCycles?: number;
	exactBaseRef?: string;
	compiledAt?: string | null;
}): DecisionAssignmentGraphCompileResult {
	const diagnostics: AgentCapacityContractDiagnostic[] = [];
	const estimates = [...(input.estimates ?? [])].sort((left, right) => (
		left.agentClass.localeCompare(right.agentClass)
		|| String(left.agentId ?? '').localeCompare(String(right.agentId ?? ''))
		|| left.id.localeCompare(right.id)
	));
	for (const [index, estimate] of estimates.entries()) {
		diagnostics.push(...validateStructuredAgentEstimate(estimate).diagnostics.map((entry) => ({ ...entry, path: `estimates.${index}${entry.path ? `.${entry.path}` : ''}` })));
	}
	const contractMap = new Map<string, DeliverableContract>();
	const deliverableProducerNodes = new Map<string, string>();
	const nodes: DecisionAssignmentGraphNode[] = [];
	const edges: DecisionAssignmentGraphEdge[] = [];
	for (const estimate of estimates) {
		for (const dependency of estimate.dependencies.filter((entry) => entry.type === 'artifact' && entry.deliverableType)) {
			const contractId = dependencyToContractId(input.projectId, input.decisionId, dependency);
			if (!contractMap.has(contractId)) {
				const producerClass = dependency.agentClass || dependency.capability || dependency.deliverableType || 'producer';
				contractMap.set(contractId, {
					id: contractId,
					teamId: input.teamId,
					projectId: input.projectId,
					decisionId: input.decisionId,
					deliverableType: dependency.deliverableType ?? dependency.id,
					producerAgentClasses: [producerClass],
					acceptanceCriteria: dependency.summary ? [dependency.summary] : [],
					status: 'required',
					metadata: { sourceDependencyId: dependency.id },
				});
				const producerNodeId = `${contractId}:produce`;
				deliverableProducerNodes.set(contractId, producerNodeId);
					nodes.push({
					id: producerNodeId,
					decisionId: input.decisionId,
					projectId: input.projectId,
					targetAgentClass: producerClass,
						activityType: 'acting',
						estimateId: estimate.id,
						groupSnapshot: estimate.groupSnapshot,
					handler: null,
					requiredCapabilities: uniqueStrings([dependency.capability ?? ''].filter(Boolean)),
					requiredDeliverableContractIds: [],
					inputRefs: [],
					outputRequirements: [{ id: `${contractId}:output`, outputType: dependency.deliverableType ?? dependency.id, description: dependency.summary, required: true }],
					capacity: { expectedSeconds: 900, maxSeconds: 900 },
					status: 'pending',
					metadata: { producesDeliverableContractId: contractId, generatedFromDependency: dependency.id },
				});
			}
		}
	}
	for (const estimate of estimates) {
		const nodeId = estimate.workUnitId || `estimate:${estimate.id}:work`;
		const outputContractId = `${input.projectId}:${input.decisionId}:estimate:${estimate.id}:deliverable`;
		const primaryOutput = estimate.expectedOutputs.find((output) => output.required !== false) ?? estimate.expectedOutputs[0];
		contractMap.set(outputContractId, {
			id: outputContractId,
			teamId: input.teamId,
			projectId: input.projectId,
			decisionId: input.decisionId,
			deliverableType: primaryOutput?.outputType ?? 'assignment_deliverable',
			producerAgentClasses: [estimate.agentClass],
			acceptanceCriteria: estimate.acceptanceCriteria,
			status: 'required',
			metadata: { sourceEstimateId: estimate.id, sourceNodeId: nodeId },
		});
		const artifactDependencies = estimate.dependencies.filter((dependency) => dependency.type === 'artifact' && dependency.deliverableType);
		const requiredDeliverableContractIds = artifactDependencies.map((dependency) => dependencyToContractId(input.projectId, input.decisionId, dependency));
		const inputRefs = estimate.dependencies.flatMap((dependency) => (dependency.contentRefs ?? []).map((ref): ContentRef => ({ model: 'note', collection: 'notes', slug: ref, id: ref })));
		nodes.push({
			id: nodeId,
			decisionId: input.decisionId,
			projectId: input.projectId,
			targetAgentClass: estimate.agentClass,
			activityType: 'acting',
			estimateId: estimate.id,
			groupSnapshot: estimate.groupSnapshot,
			handler: null,
			requiredCapabilities: uniqueStrings(estimate.dependencies.map((dependency) => dependency.capability ?? dependency.agentClass ?? '').filter(Boolean)),
			requiredDeliverableContractIds,
			inputRefs,
			outputRequirements: estimate.expectedOutputs,
			capacity: { expectedSeconds: estimate.expectedSeconds, maxSeconds: estimate.maxSeconds },
			status: 'pending',
			metadata: {
				stage: 'implementation',
				estimateId: estimate.id,
				producesDeliverableContractId: outputContractId,
				confidence: estimate.confidence,
				riskLevel: estimate.riskLevel,
				humanInputDependencies: estimate.dependencies.filter((dependency) => dependency.type === 'human-input'),
			},
		});
		const reviewerClasses = uniqueStrings(input.reviewersByAgentClass?.[estimate.agentClass]
			?? (Array.isArray(estimate.metadata?.reviewerAgentClasses) ? estimate.metadata.reviewerAgentClasses.map(String) : ['reviewer']));
		for (const reviewerClass of reviewerClasses) {
			if (reviewerClass === estimate.agentClass) diagnostic(diagnostics, 'graph_reviewer_not_independent', `Reviewer ${reviewerClass} cannot review its own acting assignment.`, `estimates.${estimate.id}.reviewerAgentClasses`);
			const reviewContractId = `${outputContractId}:review:${reviewerClass}`;
			const reviewNodeId = `${nodeId}:review:${reviewerClass}`;
			contractMap.set(reviewContractId, {
				id: reviewContractId, teamId: input.teamId, projectId: input.projectId, decisionId: input.decisionId,
				deliverableType: 'review_disposition', producerAgentClasses: [reviewerClass], reviewerAgentClasses: [reviewerClass],
				acceptanceCriteria: ['Review must bind the exact actor checkpoint, diff, verification, receipts, and accepted plan revision.'], status: 'required',
				metadata: { sourceEstimateId: estimate.id, reviewedContractId: outputContractId },
			});
			nodes.push({
				id: reviewNodeId, decisionId: input.decisionId, projectId: input.projectId, targetAgentClass: reviewerClass,
				activityType: 'reviewing', estimateId: estimate.id, groupSnapshot: estimate.groupSnapshot, handler: null,
				requiredCapabilities: ['independent-review'], requiredDeliverableContractIds: [outputContractId], inputRefs,
				outputRequirements: [{ id: reviewContractId, outputType: 'review_disposition', required: true }],
				capacity: { expectedSeconds: Math.max(1, estimate.workBreakdown?.independentReviewSeconds ?? 300), maxSeconds: Math.max(1, estimate.workBreakdown?.finalReviewSeconds ?? estimate.workBreakdown?.independentReviewSeconds ?? 300) },
				status: 'pending', metadata: { stage: 'review', reviewedNodeId: nodeId, reviewedContractId: outputContractId,
					producesDeliverableContractId: reviewContractId, exactCheckpointRequired: true, rejectionCreatesRevision: true,
					maximumRevisionCycles: input.maximumRevisionCycles ?? estimate.workBreakdown?.expectedRevisionCycles ?? 1 },
			});
			edges.push({ fromNodeId: nodeId, toNodeId: reviewNodeId, edgeType: 'blocks-start', reason: 'Independent review requires the exact acting checkpoint.' });
		}
		for (const dependency of artifactDependencies) {
			const contractId = dependencyToContractId(input.projectId, input.decisionId, dependency);
			const producerNodeId = deliverableProducerNodes.get(contractId);
			if (producerNodeId) edges.push({ fromNodeId: producerNodeId, toNodeId: nodeId, edgeType: edgeTypeForDependency(dependency), reason: dependency.summary ?? dependency.deliverableType });
		}
	}
	const reviewNodes = nodes.filter((node) => node.activityType === 'reviewing');
	const integrationContractId = `${input.projectId}:${input.decisionId}:platform-integration`;
	const integrationNodeId = `${input.projectId}:${input.decisionId}:platform-integration`;
	contractMap.set(integrationContractId, {
		id: integrationContractId, teamId: input.teamId, projectId: input.projectId, decisionId: input.decisionId,
		deliverableType: 'governed_integration_receipt', producerAgentClasses: ['platform-integration'],
		acceptanceCriteria: ['The platform must bind the exact approved checkpoint to a valid execution-authority receipt before reporting.'],
		status: 'required', metadata: { platformControlled: true },
	});
	nodes.push({
		id: integrationNodeId, decisionId: input.decisionId, projectId: input.projectId, targetAgentClass: 'platform-integration',
		activityType: 'acting', handler: 'platform-integration', requiredCapabilities: ['governed-integration'],
		requiredDeliverableContractIds: reviewNodes.map((node) => String(node.metadata?.producesDeliverableContractId)), inputRefs: [],
		outputRequirements: [{ id: integrationContractId, outputType: 'governed_integration_receipt', required: true }],
		capacity: { expectedSeconds: 1, maxSeconds: 1 }, status: 'pending',
		metadata: { stage: 'integration', platformControlled: true, producesDeliverableContractId: integrationContractId },
	});
	for (const reviewNode of reviewNodes) edges.push({ fromNodeId: reviewNode.id, toNodeId: integrationNodeId, edgeType: 'blocks-start', reason: 'Platform integration waits for every exact review approval.' });
	const reportContractId = `${input.projectId}:${input.decisionId}:workflow-report`;
	const reportNodeId = `${input.projectId}:${input.decisionId}:report`;
	contractMap.set(reportContractId, { id: reportContractId, teamId: input.teamId, projectId: input.projectId, decisionId: input.decisionId,
		deliverableType: 'assignment_workflow_report', producerAgentClasses: [input.reportingAgentClass ?? 'reporter'],
		acceptanceCriteria: ['Report must preserve terminal repository outcomes, reviews, failures, usage, settlement, remaining work, and cleanup evidence.'], status: 'required', metadata: { terminalOnly: true } });
	nodes.push({ id: reportNodeId, decisionId: input.decisionId, projectId: input.projectId, targetAgentClass: input.reportingAgentClass ?? 'reporter',
		activityType: 'reporting', handler: 'reporter', requiredCapabilities: ['terminal-reporting'],
		requiredDeliverableContractIds: [integrationContractId], inputRefs: [],
		outputRequirements: [{ id: reportContractId, outputType: 'assignment_workflow_report', required: true }],
		capacity: { expectedSeconds: Math.max(1, ...estimates.map((estimate) => estimate.workBreakdown?.reportingSeconds ?? 300)), maxSeconds: Math.max(1, ...estimates.map((estimate) => estimate.workBreakdown?.reportingSeconds ?? 300)) },
		status: 'pending', metadata: { stage: 'reporting', terminalOnly: true, producesDeliverableContractId: reportContractId } });
	edges.push({ fromNodeId: integrationNodeId, toNodeId: reportNodeId, edgeType: 'blocks-start', reason: 'Reporting waits for governed integration.' });
	const graph: DecisionAssignmentGraph = {
		id: input.id ?? `${input.projectId}:${input.decisionId}:graph:v${input.version ?? 1}`,
		teamId: input.teamId,
		projectId: input.projectId,
		decisionId: input.decisionId,
		version: input.version ?? 1,
		status: diagnostics.some((entry) => entry.severity === 'error') ? 'blocked' : 'compiled',
		estimateIds: estimates.map((estimate) => estimate.id),
		deliverableContracts: [...contractMap.values()].sort((left, right) => left.id.localeCompare(right.id)),
		nodes: nodes.sort((left, right) => left.id.localeCompare(right.id)),
		edges: edges.sort((left, right) => left.fromNodeId.localeCompare(right.fromNodeId) || left.toNodeId.localeCompare(right.toNodeId) || left.edgeType.localeCompare(right.edgeType)),
		compiledAt: input.compiledAt ?? null,
		compiledBy: 'api-control-plane',
		executionMode: input.executionMode ?? 'simulation',
		metadata: { compiler: 'compileDecisionAssignmentGraphFromEstimates', maximumRevisionCycles: input.maximumRevisionCycles ?? 1, ...(input.exactBaseRef ? { exactBaseRef: input.exactBaseRef } : {}) },
	};
	diagnostics.push(...validateDecisionAssignmentGraph(graph).diagnostics);
	return { graph, diagnostics };
}

export function compileEngineeringAssignmentGraph(input: EngineeringAssignmentGraphInput): DecisionAssignmentGraphCompileResult {
	const version = input.version ?? 1;
	const graphId = input.id ?? `${input.projectId}:${input.decisionId}:engineering:v${version}`;
	const stages = [
		...(input.includeResearch && input.roles.researcher ? [{ key: 'research', role: input.roles.researcher, output: 'research_evidence' }] : []),
		...(input.includeArchitecture && input.roles.architect ? [{ key: 'architecture', role: input.roles.architect, output: 'architecture_plan' }] : []),
		{ key: 'test', role: input.roles.tester, output: 'failing_test_proof' },
		{ key: 'implementation', role: input.roles.engineer, output: 'implementation_change' },
		{ key: 'verification', role: input.roles.tester, output: 'passing_verification' },
		{ key: 'review', role: input.roles.reviewer, output: 'review_decision' },
		{ key: 'documentation', role: input.roles.technicalWriter, output: 'documentation_update' },
		{ key: 'release', role: input.roles.releaser, output: 'release_readiness' },
		...(input.roles.operations ? [{ key: 'operations', role: input.roles.operations, output: 'integration_handoff' }] : []),
	] as const;
	const contracts = stages.map((stage): DeliverableContract => ({
		id: `${graphId}:deliverable:${stage.output}`,
		teamId: input.teamId,
		projectId: input.projectId,
		decisionId: input.decisionId,
		deliverableType: stage.output,
		producerAgentClasses: [stage.role],
		reviewerAgentClasses: stage.key === 'review' ? [input.roles.reviewer] : undefined,
		acceptanceCriteria: [`${stage.output} must preserve exact decision and source-ref provenance.`],
		status: 'required',
		metadata: { workflowKind: 'engineering-test-first', stage: stage.key },
	}));
	const nodes = stages.map((stage, index): DecisionAssignmentGraphNode => {
		const previous = contracts[index - 1];
		return {
			id: `${graphId}:node:${stage.key}`,
			decisionId: input.decisionId,
			projectId: input.projectId,
			targetAgentClass: stage.role,
			activityType: stage.key === 'review' ? 'reviewing' : 'acting',
			handler: null,
			requiredCapabilities: [`engineering:${stage.key}`],
			requiredDeliverableContractIds: previous ? [previous.id] : [],
			inputRefs: [],
			outputRequirements: [{ id: contracts[index]!.id, outputType: stage.output, required: true }],
			capacity: { expectedSeconds: Math.max(1, input.seconds?.[stage.key] ?? 900), maxSeconds: Math.max(1, input.seconds?.[stage.key] ?? 900) },
			status: index === 0 ? 'ready' : 'pending',
			metadata: {
				workflowKind: 'engineering-test-first',
				stage: stage.key,
				exactBaseRef: input.exactBaseRef,
				producesDeliverableContractId: contracts[index]!.id,
				...(stage.key === 'implementation' ? { requiresFailingTestIntegrationRef: true, testMutationForbidden: true } : {}),
				...(stage.key === 'test' ? { implementationMutationForbidden: true } : {}),
				...(stage.key === 'review' ? { rejectionCreatesRevision: true } : {}),
				...(stage.key === 'release' ? { hostedReleaseFailClosed: true } : {}),
			},
		};
	});
	const edges = nodes.slice(1).map((node, index): DecisionAssignmentGraphEdge => ({
		fromNodeId: nodes[index]!.id,
		toNodeId: node.id,
		edgeType: node.metadata?.stage === 'release' || node.metadata?.stage === 'operations' ? 'blocks-release' : 'blocks-start',
		reason: `Engineering stage ${String(nodes[index]!.metadata?.stage)} must be approved before ${String(node.metadata?.stage)}.`,
	}));
	const graph: DecisionAssignmentGraph = {
		id: graphId,
		teamId: input.teamId,
		projectId: input.projectId,
		decisionId: input.decisionId,
		version,
		status: 'compiled',
		estimateIds: [],
		deliverableContracts: contracts,
		nodes,
		edges,
		compiledAt: input.compiledAt ?? null,
		compiledBy: 'api-control-plane',
		metadata: { compiler: 'compileEngineeringAssignmentGraph', workflowKind: 'engineering-test-first', exactBaseRef: input.exactBaseRef },
	};
	const diagnostics = validateDecisionAssignmentGraph(graph).diagnostics;
	if (!input.exactBaseRef.trim()) diagnostic(diagnostics, 'engineering_exact_base_ref_required', 'Engineering graphs require an exact base ref.', 'exactBaseRef');
	return { graph: { ...graph, status: diagnostics.some((entry) => entry.severity === 'error') ? 'blocked' : 'compiled' }, diagnostics };
}

export function advanceDecisionAssignmentGraph(
	graph: DecisionAssignmentGraph,
	completedContractId: string,
	approvedContractIds: ReadonlySet<string>,
): DecisionAssignmentGraph {
	const producingNode = graph.nodes.find((node) => node.metadata?.producesDeliverableContractId === completedContractId);
	if (!producingNode) return graph;
	const completedNodes = new Set(graph.nodes.filter((node) => node.status === 'completed').map((node) => node.id));
	completedNodes.add(producingNode.id);
	const nodes = graph.nodes.map((node): DecisionAssignmentGraphNode => {
		if (node.id === producingNode.id) return { ...node, status: 'completed' };
		if (node.status !== 'pending') return node;
		const predecessors = graph.edges.filter((edge) => edge.toNodeId === node.id).map((edge) => edge.fromNodeId);
		const dependenciesComplete = predecessors.every((id) => completedNodes.has(id));
		const contractsApproved = node.requiredDeliverableContractIds.every((id) => approvedContractIds.has(id));
		return dependenciesComplete && contractsApproved ? { ...node, status: 'ready' } : node;
	});
	const complete = nodes.length > 0 && nodes.every((node) => node.status === 'completed');
	return {
		...graph,
		status: complete ? 'completed' : graph.status,
		nodes,
		deliverableContracts: graph.deliverableContracts.map((contract) => contract.id === completedContractId ? { ...contract, status: 'approved' } : contract),
	};
}

export function activateDecisionAssignmentGraph(graph: DecisionAssignmentGraph): DecisionAssignmentGraph {
	const incoming = new Set(graph.edges.map((edge) => edge.toNodeId));
	return {
		...graph,
		status: 'ready',
		nodes: graph.nodes.map((node) => (
			node.status === 'pending' && !incoming.has(node.id) && node.requiredDeliverableContractIds.length === 0
				? { ...node, status: 'ready' }
				: node
		)),
	};
}
