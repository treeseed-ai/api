import { describe, expect, it } from 'vitest';
import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { admissionWriteGuard, dependencyUnitInput } from './dependency-admission-fixture.ts';
import { admitLivingExecutionAssignment } from '../../../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';
import { CapacityGovernanceError } from '../../../../../../../../src/api/capacity/database.ts';
import { invalidAdmissionBindings } from '../initial-admission-fixture.ts';

describe('dependency custody at admission authority', () => {
	it('rejects malformed canonical capability and predecessor identifiers before any SQL with exact owning failure and immutable inputs', async () => {
		const outcomes = [];
		for (const field of ['requiredCapabilities', 'predecessorResultIds'] as const) {
			for (const value of [[' '], [' padded '], ['a b'], ['é'], ['a'.repeat(201)], ['same', 'same'], ['valid', null], [1], null, 'id']) {
				const input = dependencyUnitInput(); Object.assign(input.assignment, { [field]: value });
				const held = structuredClone(input), guard = admissionWriteGuard();
				let failure: unknown; try { await admitLivingExecutionAssignment(guard.store, input); } catch (error) { failure = error; }
				outcomes.push({ owned: failure instanceof CapacityGovernanceError,
					code: failure instanceof CapacityGovernanceError ? failure.code : undefined,
					status: failure instanceof CapacityGovernanceError ? failure.status : undefined, reads: guard.reads(), writes: guard.writes() });
				expect(input).toEqual(held);
			}
		}
		expect(outcomes).toEqual(Array.from({ length: 20 }, () => ({ owned: true,
			code: 'execution_assignment_authority_mismatch', status: 409, reads: 0, writes: 0 })));
	});
	it('rejects undeclared tool-group authority through the canonical assignment validator before any SQL with caller bytes retained', async () => {
		const input = dependencyUnitInput(); Object.assign(input.assignment.grant, { tools: [...input.assignment.grant.tools, 'invented-authority'] });
		const held = structuredClone(input), guard = admissionWriteGuard();
		let failure: unknown; try { await admitLivingExecutionAssignment(guard.store, input); } catch (error) { failure = error; }
		expect({ owned: failure instanceof CapacityGovernanceError, code: failure instanceof CapacityGovernanceError ? failure.code : undefined,
			status: failure instanceof CapacityGovernanceError ? failure.status : undefined, reads: guard.reads(), writes: guard.writes() })
			.toEqual({ owned: true, code: 'execution_assignment_authority_mismatch', status: 409, reads: 0, writes: 0 });
		expect(input).toEqual(held);
	});
	it('rejects duplicate canonical assignment and result references through owning validators before SQL without normalizing supplied authority', async () => {
		const outcomes = [];
		for (const mode of ['authority', 'context', 'read-grant', 'result'] as const) {
			const input = dependencyUnitInput();
			if (mode === 'authority') input.assignment.authorityRefs.push(structuredClone(input.assignment.authorityRefs[0]!));
			if (mode === 'context') input.assignment.contextRefs.push(structuredClone(input.assignment.contextRefs[0]!));
			if (mode === 'read-grant') input.assignment.grant.contentRead.push(structuredClone(input.assignment.grant.contentRead[0]!));
			if (mode === 'result') {
				const result = assignmentResultSchema.parse(input.predecessorResults[0]);
				input.predecessorResults[0] = { ...result, references: [...result.references, structuredClone(result.references[0]!)] };
			}
			const held = structuredClone(input), guard = admissionWriteGuard();
			let failure: unknown; try { await admitLivingExecutionAssignment(guard.store, input); } catch (error) { failure = error; }
			outcomes.push({ mode, owned: failure instanceof CapacityGovernanceError,
				code: failure instanceof CapacityGovernanceError ? failure.code : undefined,
				status: failure instanceof CapacityGovernanceError ? failure.status : undefined,
				reads: guard.reads(), writes: guard.writes() });
			expect(input).toEqual(held);
		}
		expect(outcomes).toEqual(['authority', 'context', 'read-grant', 'result'].map(mode => ({ mode, owned: true,
			code: mode === 'result' ? 'assignment_predecessor_authority_mismatch' : 'execution_assignment_authority_mismatch',
			status: 409, reads: 0, writes: 0 })));
	});
	it('denies conflicting or malformed immutable provider execution bindings before SQL without turning a collaborator error into an authority refusal', async () => {
		const original = dependencyUnitInput(), before = structuredClone(original), outcomes = [];
		for (const variant of invalidAdmissionBindings(original)) {
			const guard = admissionWriteGuard(), inputBefore = structuredClone(variant.input);
			let failure: unknown; try { await admitLivingExecutionAssignment(guard.store, variant.input); } catch (error) { failure = error; }
			outcomes.push({ name: variant.name, owned: failure instanceof CapacityGovernanceError,
				code: failure instanceof CapacityGovernanceError ? failure.code : undefined,
				status: failure instanceof CapacityGovernanceError ? failure.status : undefined,
				reads: guard.reads(), writes: guard.writes() });
			expect(variant.input).toEqual(inputBefore);
		}
		expect(outcomes).toEqual(invalidAdmissionBindings(original).map(({ name }) => ({ name, owned: true,
			code: 'execution_assignment_authority_mismatch', status: 409, reads: 0, writes: 0 })));
		expect(original).toEqual(before);
	});
	it('denies missing extra duplicate and reused predecessor result identities before any admission write', async () => {
		const mutations: Array<(input: ReturnType<typeof dependencyUnitInput>) => void> = [
			value => { value.predecessorResults = []; },
			value => { value.predecessorResults = value.predecessorResults.slice(0, 1); },
			value => { value.predecessorResults.push(structuredClone(value.predecessorResults[0])); },
			value => { value.assignment.predecessorResultIds = ['producer-result', 'producer-result']; },
			value => { value.assignment.predecessorResultIds.push('unbound-result'); },
		];
		for (const change of mutations) {
			const input = dependencyUnitInput(); change(input); const original = structuredClone(input), guard = admissionWriteGuard();
			await expect(admitLivingExecutionAssignment(guard.store, input)).rejects.toThrow(); expect(guard.writes()).toBe(0); expect(guard.reads()).toBe(0); expect(input).toEqual(original);
		}
	});
	it('denies failed malformed and Actor self-review predecessor inputs before any admission write', async () => {
		const mutations: Array<(input: ReturnType<typeof dependencyUnitInput>) => void> = [
			value => { value.predecessorResults[0] = { ...assignmentResultSchema.parse(value.predecessorResults[0]), status: 'failed' }; },
			value => { value.predecessorResults[1] = { ...assignmentResultSchema.parse(value.predecessorResults[1]), assignmentId: '' }; },
			value => { value.predecessorResults[1] = { ...assignmentResultSchema.parse(value.predecessorResults[1]), assignmentId: 'producer-attempt' }; },
		];
		for (const change of mutations) {
			const input = dependencyUnitInput(); change(input); const original = structuredClone(input), guard = admissionWriteGuard();
			await expect(admitLivingExecutionAssignment(guard.store, input)).rejects.toThrow(); expect(guard.writes()).toBe(0); expect(guard.reads()).toBe(0); expect(input).toEqual(original);
		}
	});
	it('denies missing exact predecessor read authority rather than admitting a stripped dependency context', async () => {
		for (const drop of ['context', 'grant'] as const) {
			const input = dependencyUnitInput();
			if (drop === 'context') input.assignment.contextRefs = input.assignment.contextRefs.filter(ref => ref.id !== 'producer-review');
			else input.assignment.grant.contentRead = input.assignment.grant.contentRead.filter(ref => ref.id !== 'producer-review');
			const original = structuredClone(input), guard = admissionWriteGuard();
			await expect(admitLivingExecutionAssignment(guard.store, input)).rejects.toThrow(); expect(guard.writes()).toBe(0); expect(guard.reads()).toBe(0); expect(input).toEqual(original);
		}
	});
});
