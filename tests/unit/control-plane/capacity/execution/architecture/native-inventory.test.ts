import { serializeProviderAssignmentRow } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { describe, expect, it } from 'vitest';
import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { verifyNativeInventory, verifyNativeGraphRevisionInventory, verifyNativeSettlementReadback, verifyNativeAssignmentReadback, verifyNativeCommunicationEdges, verifyNativeModelExecutionInventory, verifyNativeReporterCloseout } from '../../../../../acceptance/execution-inventory.ts';
import { assignment } from '../fixtures/assignment.ts';
import { graphProjection, graphState } from '../graph/architecture/living/living-graph-fixture.ts';
import { compileWorkday, DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';
import { now as reportClock, reportRef, reportResult } from '../graph/architecture/closeout-sql-fixture.ts';

const clock = '2026-10-09T12:00:00.000Z';
const native = [{ id: 'first', created_at: clock }, { id: 'second', created_at: clock }];
const rows = [{ id: 'second', createdAt: clock, retained: 'actual second' }, { id: 'first', createdAt: clock, retained: 'actual first' }];
const cursor = encodeCapacityPageCursor({ id: 'second', createdAt: clock });
const pages = [{ items: [rows[0]], page: { limit: 1, hasMore: true, nextCursor: cursor } },
	{ items: [rows[1]], page: { limit: 1, hasMore: false, nextCursor: null } }];
const scope = { id: assignment.workdayId, teamId: assignment.teamId };
// Controlled projection inputs; real owning PostgreSQL produces these separately.
const envelope = { requestedSeconds: assignment.limits.maximumSeconds, reservedSeconds: assignment.limits.maximumSeconds,
	teamId: assignment.teamId, projectId: assignment.projectId, workDayId: assignment.workdayId,
	capacityProviderId: assignment.provider.providerId, executionProviderId: assignment.provider.executionProviderId,
	reservationId: assignment.reservationId, projectAgentClassId: 'class', mode: 'acting', limits: assignment.limits };
const explanation = { teamId: assignment.teamId, assignmentId: assignment.id, metadata: { allocation: { allocatedSeconds: assignment.limits.maximumSeconds } } };

const nativeAssignment = { id: assignment.id, team_id: assignment.teamId, project_id: assignment.projectId,
	work_day_id: assignment.workdayId, membership_id: 'membership', capacity_provider_id: assignment.provider.providerId,
	mode: 'acting', lane_id: 'workday', lane_purpose: 'workday', status: 'pending', lease_state: 'unleased', reservation_id: assignment.reservationId, execution_kind: 'workday',
	project_agent_class_id: 'class',
	execution_node_id: assignment.nodeId, execution_node_revision: assignment.nodeRevision, graph_revision: assignment.graphRevision,
	assignment_attempt_json: JSON.stringify(assignment), assignment_result_json: null, lifecycle_output_json: '{}',
	capacity_envelope_json: JSON.stringify(envelope), explanation_json: JSON.stringify(explanation) };
const publicAssignment = { id: assignment.id, teamId: assignment.teamId, projectId: assignment.projectId,
	workDayId: assignment.workdayId, membershipId: 'membership', capacityProviderId: assignment.provider.providerId,
	laneId: 'workday', lanePurpose: 'workday', status: 'pending', leaseState: 'unleased', reservationId: assignment.reservationId, assignmentAttempt: assignment, assignmentResult: null,
	projectAgentClassId: 'class', lifecycleOutput: {}, capacityEnvelope: envelope, explanation,
	executionNodeId: assignment.nodeId, executionNodeRevision: assignment.nodeRevision, graphRevision: assignment.graphRevision };
const nativeReservation = { id: assignment.reservationId, assignment_id: assignment.id, team_id: assignment.teamId,
	project_id: assignment.projectId, work_day_id: assignment.workdayId, membership_id: 'membership',
	capacity_provider_id: assignment.provider.providerId, execution_provider_id: assignment.provider.executionProviderId,
	reserved_seconds: assignment.limits.maximumSeconds, state: 'reserved', mode: 'acting', idempotency_key: assignment.idempotencyKey,
	project_agent_class_id: 'class', policy_snapshot_json: '{}', metadata_json: '{}',
	requested_seconds: assignment.limits.maximumSeconds, active_seconds: 0, elapsed_seconds: 0, released_seconds: 0, overrun_seconds: 0,
	created_at: assignment.createdAt, updated_at: assignment.createdAt };

describe('independent native producer inventory reconciliation', () => {
	it('denies omitted duplicated or reclassified original settlements for the complete issued assignment inventory without rewriting failed observations', () => {
		// Controlled readback fixture; owning PostgreSQL produces the canonical records separately.
		const exact = { assignments: [{ id: assignment.id }], ledger: [{ id: 'settlement', assignment_id: assignment.id,
			phase: 'task_completed_actual_settlement', metadata_json: JSON.stringify({ usageSettlement: { id: 'settlement' } }) }],
			visible: [{ id: 'settlement', usageSettlement: { id: 'settlement' } }] };
		const inspect = (value: typeof exact) => verifyNativeSettlementReadback(value.ledger, value.visible, value.assignments);
		const held = structuredClone(exact); inspect(exact); expect(exact).toEqual(held);
		const disguised = structuredClone(exact); disguised.ledger[0]!.phase = 'reservation_released';
		const missing = structuredClone(exact); missing.ledger = []; missing.visible = [];
		const duplicate = structuredClone(exact); duplicate.ledger.push({ ...duplicate.ledger[0]!, id: 'second-settlement' });
		const foreign = structuredClone(exact); Reflect.set(foreign.ledger[0]!, 'assignment_id', 'foreign-assignment');
		const empty = structuredClone(exact); empty.assignments = [];
		const repeated = structuredClone(exact); repeated.assignments.push({ ...repeated.assignments[0]! });
		for (const denied of [disguised, missing, duplicate, foreign, empty, repeated]) {
			const original = structuredClone(denied); expect(() => inspect(denied)).toThrow('ACCEPTANCE_NATIVE_SETTLEMENT');
			expect(denied).toEqual(original);
		}
		inspect(exact); expect(exact).toEqual(held);
	});

	it('denies missing duplicated foreign malformed or later native report publication without rewriting completed records or retained audit history', () => {
		const compiled = compileWorkday({ id: scope.id, teamId: scope.teamId, policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', startsAt: '2026-10-02T21:00:00.000Z', agentIds: [], policy: DEFAULT_WORKDAY_POLICY });
		const exact = { run: { ...scope, parameters: { appliedPlan: { ...compiled, state: 'ended', endedAt: reportClock, reportRef } } },
			assignments: [{ ...nativeAssignment, id: reportResult.assignmentId, status: 'completed', execution_node_id: 'report-node',
				completed_at: reportClock, assignment_result_json: JSON.stringify(reportResult) }],
			nodes: [{ id: 'report-node', team_id: scope.teamId, workday_id: scope.id, project_id: reportRef.projectId, kind: 'reporting', status: 'completed' }],
			audits: [{ id: 'original-integration', target_id: reportResult.assignmentId, target_type: 'capacity_provider_assignment',
				event_type: 'assignment.content.integrated', created_at: reportClock,
				data_json: JSON.stringify({ resultId: reportResult.id, references: reportResult.references, publication: false }) }] };
		const inspect = (value: typeof exact) => verifyNativeReporterCloseout(value.run, value.assignments, value.nodes, value.audits);
		const before = structuredClone(exact); expect(() => inspect(exact)).not.toThrow(); expect(exact).toEqual(before);
		const changes: Array<(value: typeof exact) => void> = [
			value => { value.assignments = []; }, value => { value.nodes = []; }, value => { value.audits = []; },
			value => { value.assignments.push(value.assignments[0]!); }, value => { value.nodes.push(value.nodes[0]!); }, value => { value.audits.push(value.audits[0]!); },
			value => { Reflect.set(value.assignments[0]!, 'team_id', 'foreign'); }, value => { Reflect.set(value.assignments[0]!, 'work_day_id', 'foreign'); },
			value => { Reflect.set(value.assignments[0]!, 'project_id', 'foreign'); }, value => { value.assignments[0]!.status = 'failed'; },
			value => { Reflect.set(value.nodes[0]!, 'team_id', 'foreign'); }, value => { Reflect.set(value.nodes[0]!, 'workday_id', 'foreign'); }, value => { value.nodes[0]!.status = 'running'; },
			value => { value.audits[0]!.created_at = 'invalid'; }, value => { value.audits[0]!.created_at = '2026-10-02T21:02:00.000Z'; },
			value => { value.audits[0]!.target_id = 'foreign'; }, value => { value.audits[0]!.data_json = '{'; },
			value => { value.audits[0]!.data_json = JSON.stringify({ resultId: 'foreign', references: reportResult.references }); },
			value => { value.audits[0]!.data_json = JSON.stringify({ resultId: reportResult.id, references: [{ ...reportRef, commit: 'b'.repeat(40) }] }); },
			value => { value.assignments[0]!.assignment_result_json = '{'; }, value => { value.assignments[0]!.completed_at = '2026-10-02T21:02:00.000Z'; },
			value => { value.assignments[0]!.assignment_result_json = JSON.stringify({ ...reportResult, assignmentId: 'foreign' }); },
			value => { value.assignments[0]!.assignment_result_json = JSON.stringify({ ...reportResult, references: [{ ...reportRef, commit: 'b'.repeat(40) }] }); },
		];
		for (const change of changes) { const denied = structuredClone(exact); change(denied); const held = structuredClone(denied);
			expect(() => inspect(denied)).toThrow(); expect(denied).toEqual(held); }
		expect(() => inspect(exact)).not.toThrow(); expect(exact).toEqual(before);
	});
	it('selects every original native model start independently of public sandbox markers and denies incomplete foreign duplicated or interrupted custody', () => {

		const measured = { input_tokens: 7, output_tokens: 3, activeSeconds: 0.5, elapsedSeconds: 1.25,
			cpuUserMicros: 123, cpuSystemMicros: 45, peakRssBytes: 1024 };
		const usage = { elapsedSeconds: 2, modelInputTokens: 7, modelOutputTokens: 3, native: measured };
		const result = { ...reportResult, assignmentId: nativeAssignment.id, usage };
		const observation = { model: 'arbitrary-configured-model', usage: [{ ...measured, input_tokens: undefined, output_tokens: undefined,
			inputTokens: 7, outputTokens: 3, provenance: 'execution-provider', nativeUsage: measured }],
			timing: { elapsedSeconds: measured.elapsedSeconds }, resources: { cpuUserMicros: 123, cpuSystemMicros: 45, peakRssBytes: 1024 } };
		const owner = { ...nativeAssignment, status: 'completed', assignment_result_json: JSON.stringify(result) };
		const started = { id: 'started', event_index: 0, run_id: scope.id, team_id: scope.teamId, workday_id: scope.id,
			project_id: owner.project_id, assignment_id: owner.id, event_type: 'provider.execution.started',
			context_json: JSON.stringify({ model: 'arbitrary-configured-model', isolation: 'microvm' }), metadata_json: '{}', created_at: clock };
		const terminal = { ...started, id: 'terminal', event_index: 1, event_type: 'provider.execution.completed',
			context_json: JSON.stringify(observation), metadata_json: JSON.stringify({ protectedPayloadEnvelope: { original: 'ciphertext' } }) };
		const events = [started, terminal], held = structuredClone({ owner, events });
		expect([...verifyNativeModelExecutionInventory([owner], events, scope)]).toEqual([owner.id]);
		for (const field of Object.keys(measured)) {
			const changed = structuredClone(result); Reflect.set(changed.usage.native, field, measured[field as keyof typeof measured] + 1);
			const corrupt = { ...owner, assignment_result_json: JSON.stringify(changed) }, before = structuredClone(corrupt);
			expect.soft(() => verifyNativeModelExecutionInventory([corrupt], events, scope)).toThrow('ACCEPTANCE_NATIVE_USAGE');
			expect(corrupt).toEqual(before);
		}
		for (const field of ['elapsedSeconds', 'modelInputTokens', 'modelOutputTokens'] as const) {
			const changed = structuredClone(result); changed.usage[field]++;
			expect.soft(() => verifyNativeModelExecutionInventory([{ ...owner, assignment_result_json: JSON.stringify(changed) }], events, scope))
				.toThrow('ACCEPTANCE_NATIVE_USAGE');
		}
		for (const context of [{}, { ...observation, usage: [] }, { ...observation, usage: [...observation.usage, ...observation.usage] },
			{ ...observation, timing: { elapsedSeconds: 9 } }, { ...observation, resources: { ...observation.resources, peakRssBytes: 9 } }]) {
			const changed = [started, { ...terminal, context_json: JSON.stringify(context) }], before = structuredClone(changed);
			expect.soft(() => verifyNativeModelExecutionInventory([owner], changed, scope)).toThrow('ACCEPTANCE_NATIVE_USAGE');
			expect(changed).toEqual(before);
		}

		const sandbox = { ...owner, lifecycle_output_json: JSON.stringify({ sandboxId: 'native-sandbox' }) };
		expect([...verifyNativeModelExecutionInventory([sandbox], events, scope)]).toEqual([owner.id]);
		for (const observed of [[], [started], [terminal], [...events, started], [...events, { ...terminal, id: 'duplicate', event_index: 2 }],
			[{ ...started, context_json: '{}' }, terminal], [{ ...started, context_json: JSON.stringify({ model: '' }) }, terminal],
			[started, { ...terminal, metadata_json: '{}' }], [{ ...started, assignment_id: 'foreign' }, terminal],
			[{ ...started, event_index: 2 }, terminal], [{ ...started, created_at: 'invalid' }, terminal],
			[{ ...started, created_at: '2026-10-09T12:00:01.000Z' }, terminal]]) {
			const before = structuredClone(observed);
			expect(() => verifyNativeModelExecutionInventory([sandbox], observed, scope)).toThrow(); expect(observed).toEqual(before);
		}
		for (const column of ['team_id', 'run_id', 'workday_id', 'project_id'])
			for (const index of [0, 1]) {
				const observed = structuredClone(events); Reflect.set(observed[index]!, column, 'foreign');
				expect(() => verifyNativeModelExecutionInventory([owner], observed, scope)).toThrow();
			}
		for (const column of ['context_json', 'metadata_json']) for (const malformed of ['{', 'null', '[]', 'true', '1']) {
			const observed = structuredClone(events); Reflect.set(observed[0]!, column, malformed);
			expect(() => verifyNativeModelExecutionInventory([owner], observed, scope)).toThrow();
		}
		const omitted = { ...sandbox, id: 'omitted-model' };
		expect(() => verifyNativeModelExecutionInventory([owner, omitted], events, scope)).toThrow('ACCEPTANCE_NATIVE_MODEL_MISSING_START');
		expect(() => verifyNativeModelExecutionInventory([owner, owner], events, scope)).toThrow('ACCEPTANCE_NATIVE_MODEL_OWNER');
		// A failed preparation has no model start; it cannot fabricate a model execution.
		expect([...verifyNativeModelExecutionInventory([owner, { ...omitted, status: 'failed' }], events, scope)]).toEqual([owner.id]);
		expect({ owner, events }).toEqual(held);
	});
	it('retains original native lifecycle output and denies missing substituted or malformed public model custody without rewriting observations', () => {
		const output = { sandboxId: 'native-model-sandbox', retained: { source: 'original-native-output' } };
		const original = { ...nativeAssignment, lifecycle_output_json: JSON.stringify(output) };
		const visible = { ...publicAssignment, lifecycleOutput: output };
		const held = structuredClone({ original, visible });
		expect(verifyNativeAssignmentReadback(original, visible, scope, [nativeReservation], [original])).toEqual(assignment);
		for (const lifecycleOutput of [undefined, null, {}, { sandboxId: 'foreign' }, { ...output, retained: { source: 'substituted' } }]) {
			const changed = { ...visible, lifecycleOutput }, before = structuredClone(changed);
			expect.soft(() => verifyNativeAssignmentReadback(original, changed, scope, [nativeReservation], [original])).toThrow();
			expect(changed).toEqual(before);
		}
		for (const lifecycle_output_json of ['{', 'null', '[]', 'true', '""', '1']) {
			const changed = { ...original, lifecycle_output_json }, before = structuredClone(changed);
			expect.soft(() => verifyNativeAssignmentReadback(changed, visible, scope, [nativeReservation], [changed])).toThrow();
			expect(changed).toEqual(before);
		}
  for (const field of ['laneId', 'lanePurpose']) for (const value of [undefined, null, '', 'foreign', {}, 7]) {
   const changed = { ...visible, [field]: value }, before = structuredClone(changed);
   expect.soft(() => verifyNativeAssignmentReadback(original, changed, scope, [nativeReservation], [original]))
    .toThrow('ACCEPTANCE_NATIVE_LANE');
   expect(changed).toEqual(before);
  }
  const chatNodes = [{ id: 'chat-node', team_id: scope.teamId, workday_id: scope.id, kind: 'communication' }];
  const chatBefore = structuredClone(chatNodes);
  expect(() => verifyNativeCommunicationEdges(chatNodes, [], scope, ['chat-node'])).not.toThrow();
  for (const edges of [[{ id: 'active-edge', from_node_id: 'chat-node', to_node_id: 'other' }],
   [{ id: 'removed-edge', from_node_id: 'other', to_node_id: 'chat-node', graph_revision_removed: 7 }]]) {
   const before = structuredClone(edges); expect(() => verifyNativeCommunicationEdges(chatNodes, edges, scope, ['chat-node']))
    .toThrow('ACCEPTANCE_NATIVE_CHAT_EDGE'); expect(edges).toEqual(before);
  }
  for (const ids of [[], ['foreign'], ['chat-node', 'chat-node']])
   expect(() => verifyNativeCommunicationEdges(chatNodes, [], scope, ids)).toThrow('ACCEPTANCE_NATIVE_CHAT_INVENTORY');
  for (const nodes of [[], [...chatNodes, ...chatNodes], [{ ...chatNodes[0]!, team_id: 'foreign' }],
   [{ ...chatNodes[0]!, workday_id: 'foreign' }], [{ ...chatNodes[0]!, kind: 'acting' }]])
   expect(() => verifyNativeCommunicationEdges(nodes, [], scope, ['chat-node'])).toThrow();
  expect(chatNodes).toEqual(chatBefore);
		expect({ original, visible }).toEqual(held);
	});
	it('reads exactly every native identity through complete public pages without changing original observations', async () => {
		// Exercise every real owning serializer path before expensive native replay.
		const serializedRaw = { ...nativeAssignment, execution_provider_id: assignment.provider.executionProviderId,
			agent_id: assignment.agentClass, attempt_count: assignment.attempt, created_at: assignment.createdAt, updated_at: assignment.createdAt };
		expect(serializeProviderAssignmentRow(serializedRaw, true)?.assignmentAttempt).toEqual(assignment);
		for (const field of ['requestedSeconds', 'reservedSeconds', 'allocatedSeconds', 'teamId', 'projectId', 'workDayId',
			'capacityProviderId', 'executionProviderId', 'reservationId', 'projectAgentClassId', 'mode', 'limits', 'explanation.teamId', 'explanation.assignmentId']) {
			const column = field === 'allocatedSeconds' || field.startsWith('explanation.') ? 'explanation_json' : 'capacity_envelope_json';
			const corrupted = structuredClone(serializedRaw), material = JSON.parse(corrupted[column]);
			if (field === 'allocatedSeconds') material.metadata.allocation.allocatedSeconds++;
			else if (field.startsWith('explanation.')) material[field.slice('explanation.'.length)] = 'foreign';
			else if (field === 'requestedSeconds' || field === 'reservedSeconds') material[field]++; else material[field] = 'foreign';
			corrupted[column] = JSON.stringify(material); const original = structuredClone(corrupted);
			if (field === 'mode') expect(() => serializeProviderAssignmentRow(corrupted, true)).toThrow(expect.objectContaining({
				code: 'agent_capacity_envelope_mode_invalid', details: expect.objectContaining({ assignmentId: assignment.id, path: 'capacityEnvelope.mode' }) }));
			else {
				const projected = serializeProviderAssignmentRow(corrupted, true)!;
				if (projected.assignmentAttempt === null) {
					expect(projected.assignmentResult).toBeNull(); expect(column).toBe('capacity_envelope_json');
					expect(projected.explanation.snapshotValidation).toMatchObject({ valid: false, assignmentId: assignment.id, path: 'capacityEnvelope.' + field });
				}
				const held = structuredClone(projected);
				expect(() => verifyNativeAssignmentReadback(corrupted, { ...projected }, scope, [nativeReservation], [corrupted])).toThrow('ACCEPTANCE_NATIVE_ALLOCATION');
				expect(projected).toEqual(held);
			}
			expect(corrupted).toEqual(original);
		}
		for (const field of ['capacityEnvelope', 'explanation'] as const) for (const value of [undefined, null, [], {}, false, 0, { foreign: true }]) {
			const observed = structuredClone(publicAssignment); Reflect.set(observed, field, value); const held = structuredClone(observed);
			expect.soft(() => verifyNativeAssignmentReadback(nativeAssignment, observed, scope, [nativeReservation], [nativeAssignment]))
				.toThrow('ACCEPTANCE_NATIVE_ALLOCATION'); expect(observed).toEqual(held);
		}
		for (const field of ['capacity_envelope_json', 'explanation_json']) for (const value of [undefined, null, '', '{', 'null', '[]', '7']) {
			const original = structuredClone(nativeAssignment); Reflect.set(original, field, value); const held = structuredClone(original);
			expect.soft(() => verifyNativeAssignmentReadback(original, publicAssignment, scope, [nativeReservation], [original])).toThrow();
			expect(original).toEqual(held);
		}
		for (const field of ['teamId', 'projectId', 'workDayId', 'capacityProviderId', 'executionProviderId', 'reservationId', 'projectAgentClassId', 'mode', 'limits']) {
			const original = structuredClone(nativeAssignment), observed = structuredClone(publicAssignment);
			Reflect.set(observed.capacityEnvelope, field, 'foreign'); original.capacity_envelope_json = JSON.stringify(observed.capacityEnvelope);
			const held = structuredClone({ original, observed });
			expect.soft(() => verifyNativeAssignmentReadback(original, observed, scope, [nativeReservation], [original])).toThrow('ACCEPTANCE_NATIVE_ALLOCATION');
			expect({ original, observed }).toEqual(held);
		}
		for (const field of ['teamId', 'assignmentId']) {
			const original = structuredClone(nativeAssignment), observed = structuredClone(publicAssignment);
			Reflect.set(observed.explanation, field, 'foreign'); original.explanation_json = JSON.stringify(observed.explanation);
			const held = structuredClone({ original, observed });
			expect.soft(() => verifyNativeAssignmentReadback(original, observed, scope, [nativeReservation], [original])).toThrow('ACCEPTANCE_NATIVE_ALLOCATION');
			expect({ original, observed }).toEqual(held);
		}
		for (const field of ['requestedSeconds', 'reservedSeconds', 'allocatedSeconds']) {
			const original = structuredClone(nativeAssignment), observed = structuredClone(publicAssignment);
			if (field === 'allocatedSeconds') {
				observed.explanation.metadata.allocation.allocatedSeconds++; original.explanation_json = JSON.stringify(observed.explanation);
			} else { observed.capacityEnvelope[field as keyof typeof envelope]++; original.capacity_envelope_json = JSON.stringify(observed.capacityEnvelope); }
			const held = structuredClone({ original, observed });
			expect.soft(() => verifyNativeAssignmentReadback(original, observed, scope, [nativeReservation], [original])).toThrow('ACCEPTANCE_NATIVE_ALLOCATION');
			expect({ original, observed }).toEqual(held);
		}

		expect(verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [nativeReservation], [nativeAssignment])).toEqual(assignment);
		for (const requested_seconds of [0, assignment.limits.maximumSeconds - 1, assignment.limits.maximumSeconds + 1,
			String(assignment.limits.maximumSeconds + 1)]) {
			const changed = { ...nativeReservation, requested_seconds }, retained = structuredClone(changed);
			expect(() => verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [changed], [nativeAssignment])).toThrow('ACCEPTANCE_NATIVE_RESERVATION');
			expect(changed).toEqual(retained);
		}
		expect(verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope,
			[{ ...nativeReservation, requested_seconds: String(assignment.limits.maximumSeconds), reserved_seconds: String(assignment.limits.maximumSeconds) }], [nativeAssignment])).toEqual(assignment);
		for (const writablePaths of [['**'], ['src'], ['.', 'src'], ['.', '.']]) {
			const attempt = { ...assignment, workspace: { ...assignment.workspace, writablePaths } };
			const original = { ...nativeAssignment, assignment_attempt_json: JSON.stringify(attempt) }, visible = { ...publicAssignment, assignmentAttempt: attempt };
			const held = structuredClone({ original, visible });
			expect.soft(() => verifyNativeAssignmentReadback(original, visible, { ...scope, executionMode: 'simulation' }, [nativeReservation], [original]))
				.toThrow(writablePaths.length === 2 && writablePaths[1] === '.' ? 'Values must be unique.' : 'ACCEPTANCE_NATIVE_SIMULATION_WORKSPACE');
			expect({ original, visible }).toEqual(held);
		}
		const root = { ...assignment, workspace: { ...assignment.workspace, writablePaths: ['.'] } };
		expect(verifyNativeAssignmentReadback({ ...nativeAssignment, assignment_attempt_json: JSON.stringify(root) },
			{ ...publicAssignment, assignmentAttempt: root }, { ...scope, executionMode: 'simulation' }, [nativeReservation], [{ ...nativeAssignment, assignment_attempt_json: JSON.stringify(root) }])).toEqual(root);
		expect(verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, { ...scope, executionMode: 'production' }, [nativeReservation], [nativeAssignment])).toEqual(assignment);
		const retainedAssignment = structuredClone({ nativeAssignment, publicAssignment, nativeReservation });
		for (const state of ['reserved', 'consuming', 'consumed', 'released', 'expired', 'failed', 'overran_pending_approval', 'continuation_required'])
			expect(verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [{ ...nativeReservation, state }], [nativeAssignment])).toEqual(assignment);
		expect(verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [{ ...nativeReservation, reserved_seconds: '3' }], [nativeAssignment])).toEqual(assignment);
		const unrelated = { ...nativeReservation, id: 'another-reservation', assignment_id: 'another-assignment' };
		expect(() => Reflect.apply(verifyNativeAssignmentReadback, undefined, [nativeAssignment, publicAssignment, scope, [unrelated, nativeReservation], [nativeAssignment]]))
			.toThrow('ACCEPTANCE_NATIVE_ISSUANCE');
		const secondAttempt = { ...assignment, id: 'second-issued', idempotencyKey: 'second-issued', nodeId: 'second-node',
			reservationId: 'second-reservation', leaseId: 'second-lease' };
		const second = { ...nativeAssignment, id: secondAttempt.id, execution_node_id: secondAttempt.nodeId,
			reservation_id: secondAttempt.reservationId, assignment_attempt_json: JSON.stringify(secondAttempt) };
		const secondReservation = { ...nativeReservation, id: secondAttempt.reservationId, assignment_id: secondAttempt.id, idempotency_key: secondAttempt.idempotencyKey };
		const exactCohort = [nativeAssignment, second], exactReservations = [nativeReservation, secondReservation];
		const inspect = (cohort: unknown, reservations: unknown) => Reflect.apply(verifyNativeAssignmentReadback, undefined,
			[nativeAssignment, publicAssignment, scope, reservations, cohort]);
		const heldCohort = structuredClone({ exactCohort, exactReservations });
		expect(() => inspect(exactCohort, exactReservations)).not.toThrow();
		for (const cohort of [undefined, null, [], [nativeAssignment, nativeAssignment], [second],
			[nativeAssignment, { ...second, team_id: 'foreign' }],
			[nativeAssignment, { ...second, assignment_attempt_json: JSON.stringify({ ...secondAttempt, leaseId: assignment.leaseId }) }],
			[nativeAssignment, { ...second, assignment_attempt_json: JSON.stringify({ ...secondAttempt, reservationId: assignment.reservationId }) }],
			[nativeAssignment, { ...second, assignment_attempt_json: JSON.stringify({ ...secondAttempt, idempotencyKey: assignment.idempotencyKey }) }],
			[nativeAssignment, { ...second, assignment_attempt_json: JSON.stringify({ ...secondAttempt, nodeId: assignment.nodeId }) }]]) {
			const held = structuredClone(cohort); expect.soft(() => inspect(cohort, exactReservations)).toThrow('ACCEPTANCE_NATIVE_ISSUANCE'); expect(cohort).toEqual(held);
		}
		for (const reservations of [[], [nativeReservation], [...exactReservations, unrelated]]) {
			const held = structuredClone(reservations); expect.soft(() => inspect(exactCohort, reservations)).toThrow(reservations.length ? 'ACCEPTANCE_NATIVE_ISSUANCE' : 'ACCEPTANCE_NATIVE_RESERVATION'); expect(reservations).toEqual(held);
		}
		expect(() => inspect(exactCohort, exactReservations)).not.toThrow(); expect({ exactCohort, exactReservations }).toEqual(heldCohort);
		expect({ nativeAssignment, publicAssignment, nativeReservation }).toEqual(retainedAssignment);
		// New independent producer proof, not another runner or an inferred exit-zero assertion.
		const inspectGraph = verifyNativeGraphRevisionInventory;
		const inspectState: unknown = Reflect.get(await import('../../../../../acceptance/execution-inventory.ts'), 'verifyNativeGraphReadback');
		expect(typeof inspectState).toBe('function'); if (typeof inspectState !== 'function') throw new Error('Native graph state proof is missing');
		const published = graphState(graphProjection());
		const nativeNodes = published.nodes.map(node => ({ id: node.id, team_id: node.teamId, project_id: node.projectId,
			workday_id: node.workdayId, work_item_id: node.workItemId, kind: node.kind, pair_role: node.pairRole,
			source_ref_json: JSON.stringify(node.sourceRef), authority_refs_json: JSON.stringify(node.authorityRefs),
			rule_revision: node.ruleRevision, node_revision: node.nodeRevision, agent_class: node.agentClass, status: node.status,
			priority: node.priority, estimate_json: node.estimate && JSON.stringify(node.estimate),
			required_capabilities_json: node.requiredCapabilities && JSON.stringify(node.requiredCapabilities),
			requested_permissions_json: node.requestedPermissions && JSON.stringify(node.requestedPermissions),
			workspace: node.workspace, acceptance_criteria_json: node.acceptanceCriteria && JSON.stringify(node.acceptanceCriteria),
			maximum_review_cycles: node.maximumReviewCycles, condition_json: node.condition && JSON.stringify(node.condition),
			graph_revision_created: node.graphRevisionCreated, graph_revision_updated: node.graphRevisionUpdated }));
		const nativeEdges = published.edges.map(edge => ({ id: edge.id, team_id: edge.teamId, from_node_id: edge.fromNodeId,
			to_node_id: edge.toNodeId, provenance: edge.provenance, source_ref_json: JSON.stringify(edge.sourceRef),
			graph_revision_created: edge.graphRevisionCreated, graph_revision_removed: edge.graphRevisionRemoved }));
		const state = structuredClone({ published, nativeNodes, nativeEdges });
		Reflect.apply(inspectState, undefined, [nativeNodes, nativeEdges, { teamId: published.teamId, revision: published.revision, graphDigest: published.digest }, published]);
		for (const mode of ['node-missing', 'node-duplicate', 'node-status', 'node-authority', 'edge-missing', 'edge-duplicate', 'edge-provenance', 'edge-removed', 'digest', 'revision', 'team', 'extra']) {
			const denied = structuredClone(published);
			if (mode === 'node-missing') denied.nodes.pop(); if (mode === 'node-duplicate') denied.nodes.push(denied.nodes[0]!);
			if (mode === 'node-status') denied.nodes[0]!.status = denied.nodes[0]!.status === 'completed' ? 'ready' : 'completed'; if (mode === 'node-authority') denied.nodes[0]!.sourceRef = { ...denied.nodes[0]!.sourceRef, id: 'substituted-native-authority' };
			if (mode === 'edge-missing') denied.edges.pop(); if (mode === 'edge-duplicate') denied.edges.push(denied.edges[0]!);
			if (mode === 'edge-provenance') denied.edges[0]!.provenance = denied.edges[0]!.provenance === 'treedx-link' ? 'review-pair' : 'treedx-link';
			if (mode === 'edge-removed') denied.edges[0]!.graphRevisionRemoved = published.revision;
			if (mode === 'digest') denied.digest = 'sha256:' + 'f'.repeat(64); if (mode === 'revision') denied.revision++;
			if (mode === 'team') denied.teamId = 'foreign'; if (mode === 'extra') Reflect.set(denied, 'alternateAuthority', true);
			const held = structuredClone(denied);
			expect(() => Reflect.apply(inspectState, undefined, [nativeNodes, nativeEdges, { teamId: published.teamId, revision: published.revision, graphDigest: published.digest }, denied]), mode).toThrow();
			expect(denied).toEqual(held);
		}
		expect({ published, nativeNodes, nativeEdges }).toEqual(state);
		for (const invalid of [0, -1, published.revision + 1, 'invalid', '1', true]) {
			const denied = [...nativeEdges, { ...nativeEdges[0]!, id: 'retained-malformed-removed-edge', graph_revision_removed: invalid }];
			const held = structuredClone(denied);
			expect(() => Reflect.apply(inspectState, undefined, [nativeNodes, denied, { teamId: published.teamId, revision: published.revision, graphDigest: published.digest }, published]), String(invalid)).toThrow();
			expect(denied).toEqual(held);
		}


		const firstRevision = graphProjection().revision, graphRecords = [firstRevision, { ...firstRevision, revision: 2, createdAt: '2026-10-03T00:00:01.000Z' }];
		const nativeGraph = graphRecords.map(value => ({ team_id: value.teamId, revision: value.revision, rule_revision: value.ruleRevision,
			changed_source_refs_json: JSON.stringify(value.changedSourceRefs), graph_digest: value.graphDigest, changes_json: JSON.stringify(value.changes), created_at: value.createdAt }));
		const graphPage = (cursor: string) => ({ items: graphRecords.slice(Number(cursor), Number(cursor) + 1), nextCursor: String(Math.min(Number(cursor) + 1, graphRecords.length)) });
		const originalGraph = structuredClone({ nativeGraph, graphRecords });
		expect(await Reflect.apply(inspectGraph, undefined, [nativeGraph, scope.teamId, graphPage])).toEqual(graphRecords);
		const changes: Array<(value: Record<string, unknown>) => void> = [
			value => { value.teamId = 'foreign'; }, value => { value.revision = 2; }, value => { value.ruleRevision = 2; },
			value => { value.graphDigest = 'sha256:' + 'f'.repeat(64); }, value => { value.createdAt = '2026-10-03T00:00:02.000Z'; },
			value => { value.changedSourceRefs = []; }, value => { value.changes = { ...firstRevision.changes, added: ['substituted-node'] }; },
			value => { value.extraAuthority = true; }, value => { delete value.graphDigest; },
		];
		for (const change of changes) {
			const value = structuredClone(firstRevision); change(value); const held = structuredClone(value);
			await expect(Reflect.apply(inspectGraph, undefined, [nativeGraph, scope.teamId, (cursor: string) => cursor === '0' ? { items: [value], nextCursor: '1' } : graphPage(cursor)])).rejects.toThrow();
			expect(value).toEqual(held);
		}
		for (const fetch of [
			() => ({ items: [], nextCursor: '0' }), () => ({ items: [firstRevision], nextCursor: '0' }),
			() => ({ items: [firstRevision, firstRevision], nextCursor: '1' }),
			(cursor: string) => cursor === '1' ? { items: [], nextCursor: cursor } : graphPage(cursor),
			(cursor: string) => cursor === '2' ? { items: [], nextCursor: '3' } : graphPage(cursor),
			(cursor: string) => { if (cursor === '1') throw new Error('retained native graph interruption'); return graphPage(cursor); },
			() => ({ nextCursor: '0' }), () => ({ items: 'malformed', nextCursor: '0' }),
		]) await expect(Reflect.apply(inspectGraph, undefined, [nativeGraph, scope.teamId, fetch])).rejects.toThrow();
		for (const rows of [undefined, null, [], [nativeGraph[1]], [nativeGraph[0], nativeGraph[0]],
			[{ ...nativeGraph[0], team_id: 'foreign' }, nativeGraph[1]], [{ ...nativeGraph[0], revision: '1' }, nativeGraph[1]],
			[{ ...nativeGraph[0], changed_source_refs_json: '{' }, nativeGraph[1]], [{ ...nativeGraph[0], changes_json: 'null' }, nativeGraph[1]]])
			await expect(Reflect.apply(inspectGraph, undefined, [rows, scope.teamId, graphPage])).rejects.toThrow();
		expect(await Reflect.apply(inspectGraph, undefined, [nativeGraph, scope.teamId, graphPage])).toEqual(graphRecords);
		expect({ nativeGraph, graphRecords }).toEqual(originalGraph);
		const supplied = structuredClone(native), received = structuredClone(pages), calls: Array<string | undefined> = [];
		expect(await verifyNativeInventory(supplied, value => { calls.push(value); return received[calls.length - 1]; }, 1)).toEqual(rows);
		expect(calls).toEqual([undefined, cursor]); expect(supplied).toEqual(native); expect(received).toEqual(pages);
		expect(await verifyNativeInventory([], () => ({ items: [], page: { limit: 1, hasMore: false, nextCursor: null } }), 1)).toEqual([]);
		expect(await verifyNativeInventory(native, () => ({ items: rows, page: { limit: 200, hasMore: false, nextCursor: null } }), 200)).toEqual(rows);
		const ascending = [...rows].reverse(), next = encodeCapacityPageCursor({ id: 'first', createdAt: clock }); let index = 0;
		expect(await verifyNativeInventory(native, () => ({ items: [ascending[index++]], page: { limit: 1, hasMore: index < 2, nextCursor: index < 2 ? next : null } }), 1, 'ascending')).toEqual(ascending);
	});
	it('denies malformed missing duplicated reordered foreign truncated or interrupted public inventories without repairing failed pages', async () => {
		const before = structuredClone({ nativeAssignment, publicAssignment });
		expect(() => Reflect.apply(verifyNativeAssignmentReadback, undefined,
			[nativeAssignment, publicAssignment, scope, [], []])).toThrow('ACCEPTANCE_NATIVE_RESERVATION');
		expect({ nativeAssignment, publicAssignment }).toEqual(before);
		for (const supplied of [undefined, null, {}, [], [null], [[]], ['malformed'], [nativeReservation, nativeReservation],
			[{ ...nativeReservation, id: 'foreign', assignment_id: 'foreign' }],
			[nativeReservation, { ...nativeReservation, id: 'duplicate-assignment-reservation' }]]) {
			const original = structuredClone(supplied);
			expect(() => Reflect.apply(verifyNativeAssignmentReadback, undefined, [nativeAssignment, publicAssignment, scope, supplied])).toThrow();
			expect(supplied).toEqual(original);
		}
		for (const field of Object.keys(nativeReservation)) for (const invalid of [undefined, null, '', false, {}, [], 'foreign']) {
			const changed = structuredClone(nativeReservation); Reflect.set(changed, field, invalid); const original = structuredClone(changed);
			const validOpaque = ['metadata_json', 'policy_snapshot_json'].includes(field) && invalid && typeof invalid === 'object' && !Array.isArray(invalid);
			const observe = () => verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [changed], [nativeAssignment]);
			if (validOpaque) expect.soft(observe).not.toThrow();
			else expect.soft(observe, `${field}=${JSON.stringify(invalid)}`).toThrow();
			expect(changed).toEqual(original);
		}
		for (const field of ['requested_seconds', 'reserved_seconds', 'active_seconds', 'elapsed_seconds', 'released_seconds', 'overrun_seconds'])
			for (const invalid of [-1, NaN, Infinity, -Infinity, 'NaN', 'Infinity', '0x3']) {
				const changed = structuredClone(nativeReservation); Reflect.set(changed, field, invalid);
				expect(() => verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [changed], [nativeAssignment])).toThrow();
			}
		expect(() => verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope,
			[{ ...nativeReservation, updated_at: '2026-09-13T11:00:00.000Z' }], [nativeAssignment])).toThrow('ACCEPTANCE_NATIVE_RESERVATION');
		for (const [originalNative, originalPublic, fields] of [
			[nativeAssignment, publicAssignment, ['reservation_id', 'capacity_provider_id', 'project_id', 'work_day_id', 'membership_id', 'project_agent_class_id', 'lease_state', 'execution_node_id', 'execution_node_revision', 'graph_revision']],
			[publicAssignment, nativeAssignment, ['reservationId', 'projectId', 'projectAgentClassId', 'leaseState', 'executionNodeId', 'executionNodeRevision', 'graphRevision']],
		] as const) for (const field of fields) for (const invalid of [undefined, null, '', false, {}, [], 'foreign', 0]) {
			const changed = structuredClone(originalNative); Reflect.set(changed, field, invalid); const held = structuredClone(changed);
			expect.soft(() => field.includes('_') ? verifyNativeAssignmentReadback(changed, originalPublic, scope, [nativeReservation], [changed])
				: verifyNativeAssignmentReadback(originalPublic, changed, scope, [nativeReservation], [originalPublic])).toThrow();
			expect(changed).toEqual(held);
		}
		expect(verifyNativeAssignmentReadback(nativeAssignment, publicAssignment, scope, [nativeReservation], [nativeAssignment])).toEqual(assignment);
		for (const replacement of [undefined, null, {}, { items: rows }, { ...pages[0], items: null }, { ...pages[0], page: [] },
			{ ...pages[0], items: [null] }, { ...pages[0], items: [[]] }, { ...pages[0], items: ['malformed'] }, { items: [], page: pages[0]!.page },
			{ ...pages[0], items: [rows[1]] }, { ...pages[0], items: [rows[0], rows[0]] },
			{ ...pages[0], items: [{ ...rows[0], id: 'foreign' }] }, { ...pages[0], items: [{ ...rows[0], createdAt: '2026-10-09T11:00:00.000Z' }] },
			{ ...pages[0], page: { limit: 0, hasMore: true, nextCursor: cursor } },
			{ ...pages[0], page: { limit: '1', hasMore: true, nextCursor: cursor } }, { ...pages[0], page: { limit: 1, hasMore: 'true', nextCursor: cursor } },
			{ ...pages[0], page: { limit: 1, hasMore: false, nextCursor: null } },
			{ ...pages[0], page: { limit: 1, hasMore: true, nextCursor: null } },
			{ ...pages[0], page: { limit: 1, hasMore: true, nextCursor: 'malformed' } },
			{ ...pages[0], page: { limit: 1, hasMore: true, nextCursor: encodeCapacityPageCursor({ id: 'first', createdAt: clock }) } },
		]) {
			const retained = structuredClone(replacement);
			await expect(verifyNativeInventory(native, () => replacement, 1)).rejects.toThrow(); expect(replacement).toEqual(retained);
		}
		for (const tail of [undefined, { ...pages[1], items: [rows[0]] }, { ...pages[1], page: { limit: 1, hasMore: false, nextCursor: cursor } }]) {
			let index = 0; const received = [pages[0], tail], before = structuredClone(received);
			await expect(verifyNativeInventory(native, () => received[index++], 1)).rejects.toThrow(); expect(received).toEqual(before);
		}
		for (const original of [new Error('original public boundary interruption'), Object.assign(new Error('original permission denial'), { status: 403 }), new DOMException('original cancellation', 'AbortError')]) {
			let index = 0;
			await expect(verifyNativeInventory(native, () => index++ ? Promise.reject(original) : pages[0], 1)).rejects.toBe(original);
		}
	});
	it('denies incomplete ambiguous native authority before querying the public boundary', async () => {
		for (const supplied of [undefined, {}, [null], [{ id: '', created_at: clock }], [{ id: 'first' }],
			[{ id: 'first', created_at: 'invalid' }], [native[0], native[0]]]) {
			let calls = 0; const before = structuredClone(supplied);
			await expect(verifyNativeInventory(supplied, () => { calls++; return pages[0]; }, 1)).rejects.toThrow();
			expect(calls).toBe(0); expect(supplied).toEqual(before);
		}
		for (const limit of [0, -1, 1.5, NaN, Infinity, 201]) await expect(verifyNativeInventory(native, () => pages[0], limit)).rejects.toThrow();
		await expect(verifyNativeInventory(native, () => pages[0], 1, 'unknown' as never)).rejects.toThrow();
	});
});
