import { describe,expect,it } from 'vitest';
import {
	assignmentContentIntegrationReadySql,
	contentIntegrationRequirementOperation,
	provisionalMutationReceipts,
} from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-integration-requirement.ts';

describe('assignment content integration requirement',()=>{
	it('derives an atomic requirement only from durable provisional mutation receipts',()=>{
		const lifecycleOutput={ artifactManifest:{ mutationReceipts:[
			{ id:'receipt-a',phase:'provisional',effectiveRef:'a'.repeat(40) },
			{ id:'receipt-b',phase:'integrated',effectiveRef:'b'.repeat(40) },
		] } };
		expect(provisionalMutationReceipts(lifecycleOutput)).toEqual([
			expect.objectContaining({ id:'receipt-a',phase:'provisional' }),
		]);
		const operation=contentIntegrationRequirementOperation({ assignmentId:'assignment-a',capacityProviderId:'provider-a',stateVersion:5,lifecycleOutput,now:'2026-08-15T23:00:00.000Z' });
		expect(operation?.query).toContain("status = 'completed' AND state_version = ?");
		expect(operation?.params).toEqual(expect.arrayContaining(['assignment-content-integration-required:assignment-a:5','assignment.content.integration_required','assignment-a',5]));
		expect(contentIntegrationRequirementOperation({ assignmentId:'assignment-a',capacityProviderId:'provider-a',stateVersion:5,lifecycleOutput:{},now:'2026-08-15T23:00:00.000Z' })).toBeNull();
	});

	it('requires integration for conversations or an explicit mutation requirement',()=>{
		const sql=assignmentContentIntegrationReadySql();
		expect(sql).toContain("integration_required.id IS NULL");
		expect(sql).toContain("assignment.execution_kind <> 'conversation'");
		expect(sql).toContain('integrated_assignment.id IS NOT NULL');
	});
});
