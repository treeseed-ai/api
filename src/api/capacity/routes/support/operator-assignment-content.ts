import type { Context,Hono } from 'hono';
import { abandonAssignmentContent } from '../../services/capacity/assignments/observability/assignment-content-abandonment-service.ts';
import { integrateAssignmentContent } from '../../services/capacity/assignments/observability/assignment-content-integration-service.ts';
import { readCapacityRequestObject } from './request-json.ts';
import type { CapacityOperatorStore } from './operator.ts';

type Access = { response?: Response | null; principal?: { id?: string } };
type Dependencies = {
	store: CapacityOperatorStore;
	manage(c: Context): Promise<Access>;
	operatorError(error: unknown): Response;
};

function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }

export function installOperatorAssignmentContentRoutes(app: Hono,dependencies: Dependencies) {
	app.post('/v1/teams/:teamId/capacity/assignments/:assignmentId/content-abandonment',async(c)=>{
		const access=await dependencies.manage(c);if(access.response)return access.response;
		try{
			const body=await readCapacityRequestObject(c);const idempotencyKey=text(body.idempotencyKey)||text(c.req.header('Idempotency-Key'));
			const payload=await abandonAssignmentContent({store:dependencies.store,teamId:c.req.param('teamId'),assignmentId:c.req.param('assignmentId'),
				actorId:text(access.principal?.id)||'team-operator',idempotencyKey,expectedCommitShas:Array.isArray(body.expectedCommitShas)?body.expectedCommitShas.map(String):[],
				reason:text(body.reason),workdayId:text(body.workdayId),simulateHuman:body.simulateHuman===true});
			return c.json({ok:true,payload});
		}catch(error){return dependencies.operatorError(error);}
	});
	app.post('/v1/teams/:teamId/capacity/assignments/:assignmentId/content-integration',async(c)=>{
		const access=await dependencies.manage(c); if(access.response)return access.response;
		try {
			const body=await readCapacityRequestObject(c);
			const idempotencyKey=text(body.idempotencyKey)||text(c.req.header('Idempotency-Key'));
			const payload=await integrateAssignmentContent({ store:dependencies.store,teamId:c.req.param('teamId'),assignmentId:c.req.param('assignmentId'),
				actorId:text(access.principal?.id)||'team-operator',idempotencyKey,expectedBaseRef:text(body.expectedBaseRef),
				expectedCommitSha:text(body.expectedCommitSha),reason:text(body.reason),workdayId:text(body.workdayId),simulateHuman:body.simulateHuman===true });
			return c.json({ ok:true,payload });
		} catch(error) { return dependencies.operatorError(error); }
	});
}
