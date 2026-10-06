import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createFeedbackOperations } from '../../../../src/api/control-plane/catalog/feedback/index.ts';
import { OperationRegistry } from '../../../../src/api/control-plane/catalog/operation-registry.ts';
import { createFeedbackOperationService } from '../../../../src/api/control-plane/feedback/feedback-operation-service.ts';
import { installControlPlaneProtocolRoutes } from '../../../../src/api/control-plane/http/protocol-routes.ts';
import { ControlPlaneStore } from '../../../../src/api/persistence/store.ts';
import { postgresGraph } from '../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';
import { vi } from 'vitest';
import { createLocalPrivateObjectStorage } from '../../../../src/api/storage/private-object-storage.ts';

describe('feedback catalog operations', () => {
	it('retains only canonical runtime environment values without deriving authority from caller context',async()=>{
		const prior=process.env.TREESEED_ENVIRONMENT,observations:Array<{actual:unknown;expected:unknown}>=[];
		try{
			for(const [value,expected] of [['local','local'],[' staging ','staging'],['production','production'],['preview',undefined],['development',undefined],['test',undefined]] as const){
				process.env.TREESEED_ENVIRONMENT=value;
				const store=new ControlPlaneStore({}, {prepare(){throw new Error('Unexpected unit SQL');}});
				vi.spyOn(store,'first').mockResolvedValue(null);const run=vi.spyOn(store,'run').mockResolvedValue({});vi.spyOn(store,'recordAuditEvent').mockResolvedValue(undefined);
				const body={type:'bug',message:'Original message',context:{environment:'production'}},held=structuredClone(body);
				await createFeedbackOperationService(store,{feedbackStorage:createLocalPrivateObjectStorage()}).create({id:'user'},body,'environment-request');
				const insert=run.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO feedback_submissions'));
				if(!insert?.[1])throw new Error('Original submission insert missing');
				observations.push({actual:JSON.parse(String(insert[1][12])).environment,expected});expect(body).toEqual(held);
			}
			for(const observation of observations)expect(observation.actual).toBe(observation.expected);
		}finally{if(prior===undefined)delete process.env.TREESEED_ENVIRONMENT;else process.env.TREESEED_ENVIRONMENT=prior;}
	});
	it('native submission persistence reads back canonical environment omission and preserves exact replay without extra audit',async()=>{
		const f=await postgresGraph(),prior=process.env.TREESEED_ENVIRONMENT;
		try{
			const store=new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},f.left);store.initializationPromise=Promise.resolve();
			await f.left.pool.query("INSERT INTO users(id,status,created_at,updated_at) VALUES('user','active',$1,$1)",['2026-10-06T00:00:00.000Z']);
			const observations:Array<{actual:unknown;expected:unknown}>=[];
			for(const [value,expected] of [['staging','staging'],['preview',undefined]] as const){
				process.env.TREESEED_ENVIRONMENT=value;const body={type:'bug',message:'Original message',context:{environment:'production'}},held=structuredClone(body),key=`environment-${value}`;
				const service=createFeedbackOperationService(store,{feedbackStorage:createLocalPrivateObjectStorage()}),result=await service.create({id:'user'},body,key);
				const rows=(await f.right.pool.query('SELECT * FROM feedback_submissions WHERE id=$1',[result.id])).rows;
				expect(rows).toHaveLength(1);observations.push({actual:JSON.parse(rows[0].context_json).environment,expected});
				observations.push({actual:rows[0].environment,expected:expected??null});
				const audits=(await f.right.pool.query('SELECT * FROM audit_events ORDER BY id')).rows;
				expect(await service.create({id:'user'},body,key)).toEqual({id:result.id,status:'new',replayed:true});
				expect((await f.right.pool.query('SELECT * FROM feedback_submissions WHERE id=$1',[result.id])).rows).toEqual(rows);
				expect((await f.right.pool.query('SELECT * FROM audit_events ORDER BY id')).rows).toEqual(audits);expect(body).toEqual(held);
			}
			for(const observation of observations)expect(observation.actual).toBe(observation.expected);
		}finally{if(prior===undefined)delete process.env.TREESEED_ENVIRONMENT;else process.env.TREESEED_ENVIRONMENT=prior;await f.close();}
	});
	it('binds the four retained SDK-owned feedback operations', () => {
		const operations = createFeedbackOperations({ feedback: {} as any });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.feedback.create,
			CONTROL_PLANE_OPERATIONS.feedback.list,
			CONTROL_PLANE_OPERATIONS.feedback.show,
			CONTROL_PLANE_OPERATIONS.feedback.updateStatus,
		]);
	});

	it('requires an authenticated principal for feedback submission', async () => {
		const service = createFeedbackOperationService({});
		await expect(service.create(undefined, {}, 'feedback-request-1234')).rejects.toMatchObject({ status: 401, code: 'authentication_required' });
	});

	it('authenticates feedback without requiring an unrelated coarse OAuth scope', async () => {
		const feedback = { async create(principal: any) { return { id: 'feedback-1', principalId: principal?.id }; } } as any;
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, async (token) => token === 'feedback-token' ? {
			principal: { id: 'user-1', scopes: [], roles: [], permissions: [] }, credential: { id: 'client-1' },
		} : null, undefined, new OperationRegistry(createFeedbackOperations({ feedback })));
		const request = (authorization?: string) => app.request('/v1/feedback', { method: 'POST', headers: {
			'content-type': 'application/json', 'idempotency-key': 'feedback-request-1234', ...(authorization ? { authorization } : {}),
		}, body: '{}' });
		expect((await request()).status).toBe(401);
		const accepted = await request('Bearer feedback-token');
		expect(accepted.status).toBe(200);
		expect(await accepted.json()).toEqual({ data: { id: 'feedback-1', principalId: 'user-1' } });
	});

	it('requires platform feedback authority for administration', async () => {
		const service = createFeedbackOperationService({});
		await expect(service.list({ id: 'user-1', permissions: [], roles: [] }, {})).rejects.toMatchObject({ status: 403, code: 'feedback_admin_forbidden' });
	});
});
