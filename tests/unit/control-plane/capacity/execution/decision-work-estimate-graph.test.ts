import { describe, expect, it } from 'vitest';
import type { StructuredAgentEstimate } from '@treeseed/sdk/agent-capacity';
import { compileDecisionAssignmentGraphFromEstimates } from '../../../../../src/api/capacity/policy/decision-work.ts';

function estimate(overrides: Partial<StructuredAgentEstimate> & Pick<StructuredAgentEstimate, 'id' | 'agentClass' | 'workUnitId' | 'expectedOutputs'>): StructuredAgentEstimate {
	const value: StructuredAgentEstimate = {
		schemaVersion: 3,
		teamId: 'team',
		projectId: 'project',
		decisionId: 'decision',
		proposalId: 'proposal',
		minSeconds: 60,
		expectedSeconds: 120,
		maxSeconds: 180,
		confidence: 'high',
		riskLevel: 'low',
		assumptions: [],
		blockers: [],
		dependencies: [],
		acceptanceCriteria: ['The requested work is verified.'],
		completionEvidence: ['Exact assignment artifact manifest.'],
		proposalRevision: { id: 'proposal', version: 1, digest: 'sha256:proposal' },
		decisionRevision: { id: 'decision', version: 1, digest: 'sha256:decision' },
		groupSnapshot: { projectId: 'project', directGroupIds: [], effectiveGroupIds: [], provenance: [], graphRevision: 'graph-1', immutableRef: 'a'.repeat(40), digest: 'sha256:groups', capturedAt: '2026-09-12T00:00:00.000Z' },
		agentDefinitionRevision: { id: 'agent-definition', revision: 1, digest: 'sha256:agent' },
		requiredProviderCapabilities: ['treeseed.engineering.code-change'],
		acceptableProviderClasses: ['local-kata'],
		...overrides,
	};
	value.workBreakdown ??= {
		preparationSeconds: 0, implementationSeconds: value.expectedSeconds - 3, verificationSeconds: 0,
		independentReviewSeconds: 1, revisionSeconds: 0, revisionVerificationSeconds: 0,
		finalReviewSeconds: 1, reportingSeconds: 1, reserveSeconds: 0, expectedRevisionCycles: 1,
	};
	return value;
}

describe('estimate-derived decision assignment graph', () => {
	it('preserves accepted work units, durations, dependencies, and provenance', () => {
		const testing = estimate({
			id: 'estimate-testing', agentClass: 'testing', workUnitId: 'write-failing-test', expectedSeconds: 150, maxSeconds: 240,
			expectedOutputs: [{ id: 'failing-test', outputType: 'failing_test_proof', required: true }],
		});
		const implementation = estimate({
			id: 'estimate-implementation', agentClass: 'engineering', workUnitId: 'implement-change', expectedSeconds: 420, maxSeconds: 600,
			dependencies: [{ id: 'failing-test', type: 'artifact', requiredBefore: 'start', deliverableType: 'failing_test_proof' }],
			expectedOutputs: [{ id: 'implementation', outputType: 'implementation_change', required: true }],
		});
		const result = compileDecisionAssignmentGraphFromEstimates({
			teamId: 'team', projectId: 'project', decisionId: 'decision', exactBaseRef: 'a'.repeat(40),
			estimates: [implementation, testing], executionMode: 'production', compiledAt: '2026-09-12T00:00:00.000Z',
		});

		expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
		expect(result.graph.estimateIds).toEqual(['estimate-implementation', 'estimate-testing']);
		expect(result.graph.metadata).toEqual(expect.objectContaining({ workflowKind: 'estimate-derived', compilerVersion: 3 }));
		const testNode = result.graph.nodes.find((node) => node.id === 'write-failing-test')!;
		const implementationNode = result.graph.nodes.find((node) => node.id === 'implement-change')!;
		expect(testNode.capacity).toEqual({ expectedSeconds: 150, maxSeconds: 240 });
		expect(testNode.requiredCapabilities).toEqual(['treeseed.engineering.code-change']);
		expect(implementationNode.capacity).toEqual({ expectedSeconds: 420, maxSeconds: 600 });
		expect(implementationNode.metadata?.contributingEstimateIds).toEqual(['estimate-implementation']);
		expect(result.graph.edges).toContainEqual(expect.objectContaining({ fromNodeId: 'write-failing-test', toNodeId: 'implement-change', edgeType: 'blocks-start' }));
		expect(result.graph.nodes.some((node) => node.metadata?.stage === 'documentation' || node.metadata?.stage === 'release')).toBe(false);
	});

	it('fails closed when a required artifact is absent from accepted estimates', () => {
		const result = compileDecisionAssignmentGraphFromEstimates({
			teamId: 'team', projectId: 'project', decisionId: 'decision', exactBaseRef: 'b'.repeat(40),
			estimates: [estimate({
				id: 'estimate-implementation', agentClass: 'engineering', workUnitId: 'implement-change',
				dependencies: [{ id: 'missing-test', type: 'artifact', requiredBefore: 'start', deliverableType: 'failing_test_proof' }],
				expectedOutputs: [{ outputType: 'implementation_change', required: true }],
			})],
		});
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'graph_artifact_dependency_unresolved', severity: 'error' }));
		expect(result.graph.status).toBe('blocked');
	});

	it('routes estimate dependencies to their declared lifecycle gates', () => {
		const producer = estimate({
			id: 'estimate-producer', agentClass: 'testing', workUnitId: 'produce-evidence',
			expectedOutputs: [{ id: 'evidence', outputType: 'test_evidence', required: true }],
		});
		const consumer = estimate({
			id: 'estimate-consumer', agentClass: 'engineering', workUnitId: 'consume-evidence',
			dependencies: [
				{ id: 'evidence', type: 'artifact', requiredBefore: 'complete', deliverableType: 'test_evidence' },
				{ id: 'evidence', type: 'artifact', requiredBefore: 'review', deliverableType: 'test_evidence' },
				{ id: 'evidence', type: 'artifact', requiredBefore: 'release', deliverableType: 'test_evidence' },
			],
			expectedOutputs: [{ id: 'change', outputType: 'implementation_change', required: true }],
		});
		const result = compileDecisionAssignmentGraphFromEstimates({
			teamId: 'team', projectId: 'project', decisionId: 'decision', exactBaseRef: 'c'.repeat(40),
			estimates: [consumer, producer], executionMode: 'production',
		});

		expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
		expect(result.graph.edges).toEqual(expect.arrayContaining([
			expect.objectContaining({ fromNodeId: 'produce-evidence', toNodeId: 'consume-evidence', edgeType: 'blocks-completion' }),
			expect.objectContaining({ fromNodeId: 'produce-evidence', toNodeId: 'consume-evidence:review:review', edgeType: 'blocks-start' }),
			expect.objectContaining({ fromNodeId: 'produce-evidence', toNodeId: 'project:decision:platform-integration', edgeType: 'blocks-release' }),
		]));
	});

	it('uses seeded governance classes and rejects an empty estimate authority set', () => {
		const result = compileDecisionAssignmentGraphFromEstimates({
			teamId: 'team', projectId: 'project', decisionId: 'decision', estimates: [],
		});
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'graph_estimates_required', severity: 'error' }));
		expect(result.graph.status).toBe('blocked');

		const populated = compileDecisionAssignmentGraphFromEstimates({
			teamId: 'team', projectId: 'project', decisionId: 'decision',
			estimates: [estimate({ id: 'estimate-work', agentClass: 'engineering', workUnitId: 'work', expectedOutputs: [{ outputType: 'change', required: true }] })],
		});
		expect(populated.graph.nodes).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: 'work:review:review', targetAgentClass: 'review' }),
		]));
		expect(populated.graph.nodes.some((node) => node.activityType === 'reporting')).toBe(false);
	});
});
