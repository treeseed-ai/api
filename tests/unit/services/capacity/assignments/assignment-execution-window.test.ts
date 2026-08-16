import { describe,expect,it } from 'vitest';
import { compileAssignmentCloseoutWindow,compileAssignmentExecutionWindow } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-execution-window-service.ts';

describe('assignment execution window transition',()=>{
	const assignment={ metadata:{ operationalState:'preparing' },capacityEnvelope:{ budget:{ schemaVersion:'treeseed.capacity-budget/v2',deadline:'2026-08-14T12:05:00.000Z',time:{ requestedSeconds:600,executionSeconds:600,preparationSeconds:180,closeoutSeconds:120,reservedSeconds:600,activeSeconds:0,elapsedSeconds:0,releasedSeconds:0,overrunSeconds:0,preparationStartedAt:'2026-08-14T12:00:00.000Z',preparationDeadlineAt:'2026-08-14T12:03:00.000Z',closeoutDeadlineAt:'2026-08-14T12:05:00.000Z' },tokens:{ inputTokens:0,cachedInputTokens:0,reasoningTokens:0,outputTokens:0,hardLimitEnforceable:true },maxAttempts:1 } } } as never;
	it('starts a full execution duration after preparation and reserves closeout afterward',()=>{
		const result=compileAssignmentExecutionWindow({ ...assignment,metadata:{ ...assignment.metadata,minimumAssignmentDuration:{ requirement:{ amount:600,unit:'seconds' },minimumWindowSeconds:600,startedAt:null,minimumDeadlineAt:null } } } as never,'2026-08-14T12:02:00.000Z',{ id:'assignment-plan:a',path:'src/content/assignment-plans/a.mdx' });
		expect(result.capacityEnvelope.budget).toMatchObject({ deadline:'2026-08-14T12:14:00.000Z',time:{ executionStartedAt:'2026-08-14T12:02:00.000Z',executionDeadlineAt:'2026-08-14T12:12:00.000Z',closeoutDeadlineAt:'2026-08-14T12:14:00.000Z',hardDeadlineAt:'2026-08-14T12:14:00.000Z' } });
		expect(result.metadata.minimumAssignmentDuration).toMatchObject({ startedAt:'2026-08-14T12:02:00.000Z',minimumDeadlineAt:'2026-08-14T12:12:00.000Z',minimumWindowSeconds:600 });
	});
	it('rejects a plan that misses bounded preparation',()=>{
		expect(()=>compileAssignmentExecutionWindow(assignment,'2026-08-14T12:03:01.000Z',{ id:'assignment-plan:a',path:'a.mdx' })).toThrow('bounded preparation window');
	});
	it('releases unused productive time and grants closeout outside execution',()=>{
		const executing=compileAssignmentExecutionWindow(assignment,'2026-08-14T12:02:00.000Z',{ id:'assignment-plan:a',path:'a.mdx' });
		const result=compileAssignmentCloseoutWindow(executing as never,'2026-08-14T12:07:00.000Z');
		expect(result.capacityEnvelope.budget).toMatchObject({ deadline:'2026-08-14T12:09:00.000Z',time:{ executionDeadlineAt:'2026-08-14T12:07:00.000Z',closeoutStartedAt:'2026-08-14T12:07:00.000Z',closeoutDeadlineAt:'2026-08-14T12:09:00.000Z',releasedSeconds:300 } });
	});
	it('does not grant a fresh closeout when execution has already expired',()=>{
		const executing=compileAssignmentExecutionWindow(assignment,'2026-08-14T12:02:00.000Z',{ id:'assignment-plan:a',path:'a.mdx' });
		const result=compileAssignmentCloseoutWindow(executing as never,'2026-08-14T12:13:00.000Z');
		expect(result.capacityEnvelope.budget).toMatchObject({ deadline:'2026-08-14T12:14:00.000Z',time:{ closeoutStartedAt:'2026-08-14T12:12:00.000Z',closeoutDeadlineAt:'2026-08-14T12:14:00.000Z',releasedSeconds:0 } });
	});
});
