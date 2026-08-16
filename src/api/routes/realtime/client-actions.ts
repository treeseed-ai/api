import { createHash,randomUUID } from 'node:crypto';

const ACTION_KINDS=new Set(['navigate','reveal-resource','set-view-filter','populate-draft','present-confirmation']);
const RESULTS=new Set(['completed','rejected','failed']);
function text(value:unknown){ return typeof value==='string'?value.trim():''; }
function object(value:unknown){ return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}; }
function digest(value:unknown){ return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function installClientActionRoutes(context:any){
	const { app,jsonError,requireProjectAccess,store }=context;
	app.post('/v1/client-sessions',async(c:any)=>{
		const principal=c.get('principal');
		if(!principal||c.get('actorType')==='service')return jsonError(c,401,'An authenticated user is required.',{code:'client_session_authentication_required'});
		const body=object(await c.req.json().catch(()=>({}))); const projectId=text(body.projectId); const route=text(body.route);
		const capabilities=Array.isArray(body.capabilities)?[...new Set(body.capabilities.map(String).filter((value)=>ACTION_KINDS.has(value)))]:[];
		if(!projectId||!route||!route.startsWith('/')||!capabilities.length)return jsonError(c,422,'Client session requires a project, application route, and supported semantic capabilities.',{code:'client_session_invalid'});
		const access=await requireProjectAccess(c,store,projectId,'projects:read:team'); if(access.response)return access.response;
		const id=text(body.sessionId)||randomUUID(); const now=new Date(); const expiresAt=new Date(now.getTime()+45_000).toISOString();
		await store.run(`INSERT INTO agent_client_sessions (id,user_id,team_id,project_id,route,capabilities_json,status,heartbeat_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?, 'active',?,?,?,?) ON CONFLICT (id) DO UPDATE SET route=EXCLUDED.route,capabilities_json=EXCLUDED.capabilities_json,status='active',heartbeat_at=EXCLUDED.heartbeat_at,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at WHERE agent_client_sessions.user_id=EXCLUDED.user_id AND agent_client_sessions.team_id=EXCLUDED.team_id AND agent_client_sessions.project_id=EXCLUDED.project_id`,[id,principal.id,access.details.project.teamId,projectId,route,JSON.stringify(capabilities),now.toISOString(),expiresAt,now.toISOString(),now.toISOString()]);
		const session=await store.first(`SELECT * FROM agent_client_sessions WHERE id=? AND user_id=? AND project_id=?`,[id,principal.id,projectId]);
		if(!session)return jsonError(c,409,'Client session identity is bound to another scope.',{code:'client_session_scope_conflict'});
		return c.json({ok:true,payload:session},201);
	});
	app.post('/v1/client-sessions/:sessionId/heartbeat',async(c:any)=>{
		const principal=c.get('principal'); if(!principal||c.get('actorType')==='service')return jsonError(c,401,'An authenticated user is required.');
		const now=new Date(); const result=await store.run(`UPDATE agent_client_sessions SET heartbeat_at=?,expires_at=?,updated_at=? WHERE id=? AND user_id=? AND status='active'`,[now.toISOString(),new Date(now.getTime()+45_000).toISOString(),now.toISOString(),c.req.param('sessionId'),principal.id]);
		if(!result.changes)return jsonError(c,404,'Unknown active client session.',{code:'client_session_not_found'});
		return c.json({ok:true,payload:await store.first(`SELECT * FROM agent_client_sessions WHERE id=?`,[c.req.param('sessionId')])});
	});
	app.get('/v1/client-sessions/:sessionId/actions',async(c:any)=>{
		const principal=c.get('principal'); if(!principal||c.get('actorType')==='service')return jsonError(c,401,'An authenticated user is required.');
		const session=await store.first(`SELECT * FROM agent_client_sessions WHERE id=? AND user_id=? AND status='active' AND expires_at>?`,[c.req.param('sessionId'),principal.id,new Date().toISOString()]);
		if(!session)return jsonError(c,404,'Unknown active client session.',{code:'client_session_not_found'});
		await store.run(`UPDATE agent_client_actions SET status='expired',updated_at=? WHERE session_id=? AND status='pending' AND expires_at<=?`,[new Date().toISOString(),session.id,new Date().toISOString()]);
		return c.json({ok:true,payload:await store.all(`SELECT * FROM agent_client_actions WHERE session_id=? AND user_id=? AND team_id=? AND project_id=? AND status='pending' AND expires_at>? ORDER BY created_at LIMIT 20`,[session.id,principal.id,session.team_id,session.project_id,new Date().toISOString()])});
	});
	app.post('/v1/client-sessions/:sessionId/actions/:actionId/result',async(c:any)=>{
		const principal=c.get('principal'); if(!principal||c.get('actorType')==='service')return jsonError(c,401,'An authenticated user is required.');
		const body=object(await c.req.json().catch(()=>({}))); const status=text(body.status);
		if(!RESULTS.has(status))return jsonError(c,422,'Client action result must be completed, rejected, or failed.',{code:'client_action_result_invalid'});
		const now=new Date().toISOString(); const result=await store.run(`UPDATE agent_client_actions SET status=?,result_json=?,completed_at=?,updated_at=? WHERE id=? AND session_id=? AND user_id=? AND status='pending'`,[status,JSON.stringify({detail:object(body.detail),digest:digest(body.detail)}),now,now,c.req.param('actionId'),c.req.param('sessionId'),principal.id]);
		if(!result.changes){ const replay=await store.first(`SELECT * FROM agent_client_actions WHERE id=? AND session_id=? AND user_id=?`,[c.req.param('actionId'),c.req.param('sessionId'),principal.id]); if(replay&&replay.status===status)return c.json({ok:true,payload:replay,replayed:true}); return jsonError(c,409,'Client action is missing, terminal, expired, or outside this user session.',{code:'client_action_state_conflict'}); }
		return c.json({ok:true,payload:await store.first(`SELECT * FROM agent_client_actions WHERE id=?`,[c.req.param('actionId')])});
	});
}
