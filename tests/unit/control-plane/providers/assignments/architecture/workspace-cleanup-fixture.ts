import { createServer } from 'node:http';
import { TreeDxClient, FetchTransport } from '@treeseed/treedx/treedx/client';
import type { CapacityGovernanceDatabase } from '../../../../../../src/api/capacity/database.ts';
import type { WorkdayTreeDxConnectionStore } from '../../../../../../src/api/capacity/services/capacity/workdays/treedx/workday-treedx-connection.ts';
import { cancellationDatabase, cancelNow } from './cancellation-fixture.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { terminalUsage } from '../../../capacity/accounting/architecture/settlement-fixture.ts';

export const workspaceId = 'ws_terminalfixture';
// REAL native HTTP + official client + original owning SQL. The remote resource
// is controlled fixture state, NOT a TreeDX server or physical sandbox receipt.
export async function workspaceCleanupFixture(handleStatus = 'issued') {
	const base = await cancellationDatabase('returned', true);
	let fault: 'none' | 'denied' | 'open-success' | 'absent' | 'unidentified-404' = 'none', state = 'open', bound = true;
	const requests: string[] = [];
	const server = createServer((request, response) => {
		const route = `${request.method} ${request.url}`; requests.push(route);
		response.setHeader('content-type', 'application/json');
		if (route === `GET /api/v1/workspaces/${workspaceId}`) {
			response.end(JSON.stringify({ workspaceId, repoId: 'repository', status: state })); return;
		}
		if (route !== `POST /api/v1/workspaces/${workspaceId}/close`) {
			response.writeHead(404); response.end(JSON.stringify({ error: { code: 'not_found', message: 'Unknown fixture route.' } })); return;
		}
		if (fault === 'denied') { response.writeHead(403); response.end(JSON.stringify({ error: { code: 'permission_denied', message: 'Isolated permission denial.' } })); return; }
		if (fault === 'unidentified-404') { response.writeHead(404); response.end(JSON.stringify({ error: { code: 'permission_denied', message: 'Unidentified resource must remain closed to the caller.' } })); return; }
		if (fault === 'absent') { state = 'absent'; response.writeHead(404); response.end(JSON.stringify({ error: { code: 'not_found', message: 'Workspace not found.' } })); return; }
		if (fault !== 'open-success') state = 'closed';
		response.end(JSON.stringify({ workspaceId, repoId: 'repository', status: state }));
	});
	try {
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing native workspace endpoint');
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const owner: CapacityGovernanceDatabase & WorkdayTreeDxConnectionStore = { ...base.owner,
			config: { TREESEED_TREEDX_URL: baseUrl, TREESEED_ENVIRONMENT: 'test' },
			getProjectTreeDxLibrary: async () => bound ? { repositoryId: 'repository' } : null };
		const proxy = { workspaceId, repositoryId: 'repository', status: handleStatus };
		await base.query(`UPDATE capacity_provider_assignments SET workspace_context_json=?,treedx_proxy_handle_json=? WHERE id=?`,
			[JSON.stringify({ workspaceId, repositoryId: 'repository' }), JSON.stringify(proxy), base.assignment.id]);
		await base.query(`INSERT INTO treedx_proxy_handles (id,team_id,project_id,assignment_id,repository_id,workspace_id,
			status,issued_at,created_at,updated_at) VALUES ('handle','team','project',?,'repository',?,?,?,?,?)`,
			[base.assignment.id, workspaceId, handleStatus, cancelNow, cancelNow, cancelNow]);
		await settleCapacityReservationExactlyOnce(owner, terminalUsage);
		const client = new TreeDxClient({ baseUrl, transport: new FetchTransport({ baseUrl }) });
		return { ...base, owner, client, requests, setFault: (value: typeof fault) => { fault = value; },
			setBound: (value: boolean) => { bound = value; }, close: async () => {
				server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await base.db.close(); } };
	} catch (error) { server.closeAllConnections(); if (server.listening) server.close(); await base.db.close(); throw error; }
}
