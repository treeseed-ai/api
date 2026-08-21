import { randomUUID } from 'node:crypto';
import type { DeviceCodePollRequest,DeviceCodePollResponse } from "../../../types.ts";
import { addSeconds,PostgresAuthStore,DeviceCodeRow,isoNow,now,parseJson,stableHash } from "../../postgres-store.ts";
import { createAccessToken,nextOpaqueToken } from "../../tokens.ts";
export async function pollDeviceFlowMethod(this: PostgresAuthStore, request: DeviceCodePollRequest): Promise<DeviceCodePollResponse> {
    await this.ensureInitialized();
    const row = await this.first<DeviceCodeRow>(`SELECT * FROM device_codes WHERE device_code = ?`, [request.deviceCode]);
    if (!row) {
        return { ok: false, status: 'invalid', error: 'Unknown device code.' };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
        return { ok: false, status: 'expired', error: 'Device code expired.' };
    }
    if (row.status === 'pending' || !row.user_id) {
        return { ok: true, status: 'pending', intervalSeconds: row.interval_seconds };
    }
    if (row.status === 'used') {
        return { ok: false, status: 'already_used', error: 'Device code already used.' };
    }
    await this.run(`UPDATE device_codes SET status = 'used', updated_at = ? WHERE id = ?`, [isoNow(), row.id]);
    const principalRecord = await this.principalForUser(row.user_id);
    const refreshToken = nextOpaqueToken('refresh');
    const sessionId = randomUUID();
    const refreshTokenHash = stableHash(refreshToken, this.config.authSecret);
    const expiresAt = addSeconds(now(), this.config.accessTokenTtlSeconds);
    const refreshExpiresAt = addSeconds(now(), this.config.refreshTokenTtlSeconds);
    await this.run(`INSERT INTO auth_sessions (id, user_id, session_type, refresh_token_hash, scopes_json, expires_at, revoked_at, data_json, created_at, updated_at)
			 VALUES (?, ?, 'device', ?, ?, ?, NULL, ?, ?, ?)`, [
        sessionId,
        row.user_id,
        refreshTokenHash,
        row.requested_scopes_json,
        refreshExpiresAt.toISOString(),
        JSON.stringify({ deviceCodeId: row.id }),
        isoNow(),
        isoNow(),
    ]);
    const requestedScopes = parseJson<string[]>(row.requested_scopes_json, principalRecord.principal.scopes);
    const accessToken = createAccessToken({
        sub: principalRecord.principal.id,
        displayName: principalRecord.principal.displayName,
        scopes: requestedScopes,
        roles: principalRecord.principal.roles,
        permissions: principalRecord.principal.permissions,
        metadata: principalRecord.principal.metadata,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(expiresAt.getTime() / 1000),
        iss: this.config.issuer,
        jti: randomUUID(),
        tokenType: 'access',
    }, this.config.authSecret);
    return {
        ok: true,
        status: 'approved',
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresAt: expiresAt.toISOString(),
        expiresInSeconds: this.config.accessTokenTtlSeconds,
        principal: {
            ...principalRecord.principal,
            scopes: requestedScopes,
            metadata: {
                ...principalRecord.principal.metadata,
                sessionId,
            },
        },
    };
}

