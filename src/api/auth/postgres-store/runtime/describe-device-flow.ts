import type { OAuthDeviceApprovalPresentation } from '@treeseed/sdk/operator-contracts';
import type { DeviceCodeApprovalPresentationRequest } from '../../../types.ts';
import { DeviceCodeRow, parseJson, PostgresAuthStore } from '../../postgres-store.ts';

export async function describeDeviceFlowMethod(
	this: PostgresAuthStore,
	request: DeviceCodeApprovalPresentationRequest,
): Promise<OAuthDeviceApprovalPresentation> {
	await this.ensureInitialized();
	const row = await this.first<DeviceCodeRow>('SELECT * FROM device_codes WHERE user_code = ?', [request.userCode]);
	if (!row || row.status !== 'pending' || new Date(row.expires_at).getTime() <= Date.now()) {
		throw new Error('Device code is unknown, expired, or no longer pending.');
	}
	return {
		schemaVersion: 'treeseed.oauth.device-approval-presentation/v1',
		clientId: row.client_id,
		clientName: row.client_id === 'trsd' ? 'TreeSeed CLI' : row.client_id,
		userCode: row.user_code,
		scopes: parseJson<string[]>(row.requested_scopes_json, []),
		expiresAt: row.expires_at,
		status: 'pending',
	};
}
