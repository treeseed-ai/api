import { randomBytes, randomUUID } from 'node:crypto';
import type { DeviceCodeStartRequest,DeviceCodeStartResponse } from "../../../types.ts";
import { addSeconds,approvalUrl,PostgresAuthStore,now,stableHash } from "../../postgres-store.ts";
import { nextOpaqueToken } from "../../tokens.ts";
export async function startDeviceFlowMethod(this: PostgresAuthStore, request: DeviceCodeStartRequest): Promise<DeviceCodeStartResponse> {
    await this.ensureInitialized();
    const current = now();
    const expiresAt = addSeconds(current, this.config.deviceCodeTtlSeconds);
    const deviceCode = nextOpaqueToken('device');
    const codeBytes = randomBytes(4).toString('hex').toUpperCase();
    const userCode = `${codeBytes.slice(0, 4)}-${codeBytes.slice(4)}`;
    await this.run(`INSERT INTO device_codes (id, device_code_hash, user_code, client_id, requested_scopes_json, expires_at, interval_seconds, status, user_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`, [
        randomUUID(),
        stableHash(deviceCode, this.config.authSecret),
        userCode,
        request.clientName?.trim() || 'trsd',
        JSON.stringify(request.scopes?.length ? request.scopes : ['auth:me']),
        expiresAt.toISOString(),
        this.config.deviceCodePollIntervalSeconds,
        current.toISOString(),
        current.toISOString(),
    ]);
    return {
        ok: true,
        deviceCode,
        userCode,
        verificationUri: approvalUrl(this.config.baseUrl),
        verificationUriComplete: approvalUrl(this.config.baseUrl, userCode),
        intervalSeconds: this.config.deviceCodePollIntervalSeconds,
        expiresAt: expiresAt.toISOString(),
        expiresInSeconds: this.config.deviceCodeTtlSeconds,
    };
}
