import { describe,expect,it } from 'vitest';
import { loadPlanningGraphEvidence,selectedPlanningGraphInputs } from '../../../../../src/api/capacity/services/build/planning-graph-evidence.ts';

describe('planning graph evidence', () => {
	it('keeps typed contracts attached to their exact producing node and durable record', async () => {
		const store = {
			all: async () => [{
				id: 'signal-1', contract_id: 'evidence-ready', subject_id: 'objective:guide', agent_id: 'evidence-researcher', activity_type: 'planning', assignment_id: 'assignment-1',
				payload_json: JSON.stringify({ evidenceType: 'research', changedPaths: ['src/content/notes/evidence.mdx'] }), commit_sha: 'abc', immutable_ref: 'abc', digest: 'digest', evidence_ref: 'treedx:abc', causation_id: 'assignment-1', correlation_id: 'objective:guide',
			}],
		} as never;
		const evidence = await loadPlanningGraphEvidence(store, {
			id: 'run-1', teamId: 'team-1', parameters: {},
		} as never, 'project-1');
		expect(evidence).toHaveLength(1);
		expect(evidence[0]?.nodeId).toBe('evidence-researcher:planning');
		expect(evidence[0]?.references.map((reference) => reference.contractId)).toEqual(['evidence-ready']);
		const inputs = selectedPlanningGraphInputs(evidence);
		expect(inputs[0]).toMatchObject({ kind: 'signal', contractId: 'evidence-ready', subjectId: 'objective:guide', metadata: { commitSha: 'abc' } });
	});
});
