import type { TreeAiOperationId } from '@treeseed/sdk/treeai';
import { TREEAI_UPSTREAM_OPERATIONS } from '@treeseed/sdk/treeai';
import type { OperationInvocationContext } from '../catalog/operation-registry.ts';
import type { TreeDxDelegationAuthority } from '../treedx/delegation-authority.ts';
import { CapacityOperationError } from '../repositories/capacity/capacity-operation-error.ts';

const fail = (status: 403 | 404 | 409 | 412 | 503, code: string, message: string): never => { throw new CapacityOperationError(status, code, message); };
type Runtime = { nodeId: string; teamId: string; projectId: string; endpoints: Record<string, string> };
export function localAiRuntime(env: NodeJS.ProcessEnv): Runtime | null {
	if (!env.TREESEED_AI_RUNTIME) return null;
	let value: Runtime;
	try { value = JSON.parse(env.TREESEED_AI_RUNTIME); } catch { throw new Error('Managed AI runtime configuration is invalid.'); }
	if (!value || ![value.nodeId, value.teamId, value.projectId].every(id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(id))) throw new Error('Managed AI runtime identity is invalid.');
	if (!value.endpoints || typeof value.endpoints !== 'object' || Array.isArray(value.endpoints) || !Object.keys(value.endpoints).length || Object.entries(value.endpoints).some(([service, endpoint]) => {
		if (!['inference', 'training', 'lab', 'gateway'].includes(service)) return true;
		let url: URL;
		try { if (typeof endpoint !== 'string') return true; url = new URL(endpoint); } catch { return true; }
		return url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
			(url.protocol !== 'https:' && !(url.protocol === 'http:' && ['inference-api', 'training-api', 'controller'].includes(url.hostname)));
	})) throw new Error('Managed AI runtime endpoints are invalid.');
	return value;
}

export function createRegisteredAiNodes(store: any, authority: TreeDxDelegationAuthority, env = process.env, fetchImpl: typeof fetch = fetch) {
	const runtime = localAiRuntime(env);
	const authorize = async (principal: any, teamId: string, write: boolean) => {
		if (!principal) fail(403, 'ai_authorization_required', 'AI access requires an authenticated principal.');
		const admin = principal.roles?.includes('platform_admin') || principal.permissions?.includes('*:*:*');
		if (!admin && !await store.principalCanAccessTeam(principal, teamId)) fail(403, 'ai_team_access_denied', 'AI team access is required.');
		if (write && !admin && !await store.principalCanManageServices(principal, teamId)) fail(403, 'ai_management_required', 'AI service management permission is required.');
	};
	const configured = (teamId: string, nodeId: string, projectId: string) => {
		if (!runtime || runtime.nodeId !== nodeId || runtime.teamId !== teamId || runtime.projectId !== projectId)
			fail(409, 'ai_runtime_binding_unavailable', 'This runtime is not assigned to the requested team and project by the host manager.');
		return runtime!;
	};
	const health = async (purpose: string) => {
		const services = purpose === 'both' ? ['inference', 'training'] : [purpose];
		for (const service of services) {
			const endpoint = runtime?.endpoints[service];
			if (!endpoint) return false;
			try { const response = await fetchImpl(new URL('/readyz', endpoint), { redirect: 'error', signal: AbortSignal.timeout(5000) }); await response.body?.cancel(); if (!response.ok) return false; }
			catch { return false; }
		}
		return true;
	};
	return {
		async register(principal: any, teamId: string, id: string, input: { name: string; projectId: string; purpose: string; model: string }, ifMatch?: string) {
			if (!['inference', 'training', 'both'].includes(input.purpose)) fail(409, 'ai_purpose_invalid', 'Select inference, training, or both.');
			await authorize(principal, teamId, true); configured(teamId, id, input.projectId); await store.ensureInitialized();
			if (!await store.first('SELECT id FROM projects WHERE id=? AND team_id=?', [input.projectId, teamId])) fail(403, 'ai_project_scope_invalid', 'Select a project owned by this team.');
			const current = await store.first('SELECT * FROM team_ai_instances WHERE team_id=? AND id=?', [teamId, id]);
			if (ifMatch !== (current ? String(current.version) : 'new')) fail(412, 'ai_version_conflict', 'Reload the AI registration before retrying.');
			if (!await health(input.purpose)) fail(503, 'ai_runtime_not_ready', 'The managed AI runtime has not passed readiness.');
			const configuration = { ...input, origin: 'managed-local' }, encoded = JSON.stringify(configuration), now = new Date().toISOString();
			if (current && current.configuration_json === encoded) return { id, teamId, configuration, version: Number(current.version), status: 'registered', healthy: true, noop: true };
			if (current) fail(409, 'ai_registration_immutable', 'Remove the previous registration before assigning a different runtime binding.');
			const saved = await store.first('INSERT INTO team_ai_instances (id,team_id,configuration_json,version,created_at,updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT (team_id,id) DO NOTHING RETURNING *', [id, teamId, encoded, now, now]);
			if (!saved) fail(412, 'ai_version_conflict', 'The AI registration changed while saving.');
			return { id, teamId, configuration, version: 1, status: 'registered', healthy: true, noop: false };
		},
		async observe(row: any) { const config = JSON.parse(row.configuration_json); return { healthy: runtime?.nodeId === row.id && runtime.teamId === row.team_id && runtime.projectId === config.projectId && await health(config.purpose) }; },
		async resolve(nodeId: string, operationId: TreeAiOperationId, context: OperationInvocationContext) {
			if (!runtime || nodeId !== runtime.nodeId) return null;
			const operation = TREEAI_UPSTREAM_OPERATIONS.find(item => item.operationId === operationId);
			if (!operation) fail(404, 'ai_operation_not_found', 'AI operation not found.');
			await authorize(context.principal, runtime.teamId, operation!.kind !== 'read'); await store.ensureInitialized();
			const row = await store.first('SELECT * FROM team_ai_instances WHERE team_id=? AND id=?', [runtime.teamId, nodeId]);
			if (!row) return null;
			const config = JSON.parse(row.configuration_json); configured(row.team_id, nodeId, config.projectId);
			if (config.origin !== 'managed-local' || !['both', operation!.service].includes(config.purpose) || !runtime.endpoints[operation!.service]) fail(403, 'ai_capability_denied', 'This AI service is not registered for that capability.');
			return { endpoints: runtime.endpoints, token: authority.mintAi({ actorId: context.principal!.id, teamId: runtime.teamId, nodeId, service: operation!.service, scopes: operation!.scopes }) };
		},
	};
}
