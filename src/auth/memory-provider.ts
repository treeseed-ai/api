import { randomUUID } from 'node:crypto';
import type {
	ApiAuthProvider,
	ApiConfig,
	ApiPrincipal,
	DeviceCodeApproveRequest,
	DeviceCodePollRequest,
	DeviceCodePollResponse,
	DeviceCodeStartRequest,
	DeviceCodeStartResponse,
	TokenRefreshRequest,
	TokenRefreshResponse,
} from '../types.ts';
import {
	createAccessToken,
	nextOpaqueToken,
	principalFromAccessTokenPayload,
	verifyAccessToken,
} from './tokens.ts';

type DeviceFlowRecord = {
	deviceCode: string;
	userCode: string;
	requestedScopes: string[];
	expiresAt: number;
	intervalSeconds: number;
	status: 'pending' | 'approved' | 'used';
	principal: ApiPrincipal | null;
};

type RefreshSessionRecord = {
	principal: ApiPrincipal;
	expiresAt: number;
};

function nowSeconds() {
	return Math.floor(Date.now() / 1000);
}

function formatExpiry(epochSeconds: number) {
	return new Date(epochSeconds * 1000).toISOString();
}

function nextUserCode() {
	return Math.random().toString(36).slice(2, 6).toUpperCase()
		+ '-'
		+ Math.random().toString(36).slice(2, 6).toUpperCase();
}

export class MemoryDeviceCodeAuthProvider implements ApiAuthProvider {
	readonly id = 'memory';
	private readonly devices = new Map<string, DeviceFlowRecord>();
	private readonly refreshSessions = new Map<string, RefreshSessionRecord>();

	constructor(private readonly config: ApiConfig) {}

	async startDeviceFlow(request: DeviceCodeStartRequest): Promise<DeviceCodeStartResponse> {
		const expiresAt = nowSeconds() + this.config.deviceCodeTtlSeconds;
		const deviceCode = nextOpaqueToken('device');
		const userCode = nextUserCode();
		this.devices.set(deviceCode, {
			deviceCode,
			userCode,
			requestedScopes: request.scopes?.length ? [...request.scopes] : ['templates:read', 'auth:me', 'sdk', 'cli'],
			expiresAt,
			intervalSeconds: this.config.deviceCodePollIntervalSeconds,
			status: 'pending',
			principal: null,
		});

		return {
			ok: true,
			deviceCode,
			userCode,
			verificationUri: `${this.config.baseUrl}/auth/device/approve`,
			verificationUriComplete: `${this.config.baseUrl}/auth/device/approve?user_code=${encodeURIComponent(userCode)}`,
			intervalSeconds: this.config.deviceCodePollIntervalSeconds,
			expiresAt: formatExpiry(expiresAt),
			expiresInSeconds: this.config.deviceCodeTtlSeconds,
		};
	}

	async approveDeviceFlow(request: DeviceCodeApproveRequest): Promise<{ ok: true }> {
		const record = [...this.devices.values()].find((entry) => entry.userCode === request.userCode);
		if (!record || record.expiresAt <= nowSeconds()) {
			throw new Error('Device code approval failed because the user code is unknown or expired.');
		}

		record.status = 'approved';
		record.principal = {
			id: request.principalId,
			displayName: request.displayName,
			scopes: request.scopes?.length ? [...request.scopes] : [...record.requestedScopes],
			metadata: request.metadata,
		};
		return { ok: true };
	}

	async pollDeviceFlow(request: DeviceCodePollRequest): Promise<DeviceCodePollResponse> {
		const record = this.devices.get(request.deviceCode);
		if (!record) {
			return { ok: false, status: 'invalid', error: 'Unknown device code.' };
		}
		if (record.expiresAt <= nowSeconds()) {
			this.devices.delete(request.deviceCode);
			return { ok: false, status: 'expired', error: 'Device code expired.' };
		}
		if (record.status === 'pending' || !record.principal) {
			return {
				ok: true,
				status: 'pending',
				intervalSeconds: record.intervalSeconds,
			};
		}
		if (record.status === 'used') {
			return { ok: false, status: 'already_used', error: 'Device code already used.' };
		}

		record.status = 'used';
		const refreshToken = nextOpaqueToken('refresh');
		const expiresAt = nowSeconds() + this.config.accessTokenTtlSeconds;
		const accessToken = createAccessToken({
			sub: record.principal.id,
			displayName: record.principal.displayName,
			scopes: record.principal.scopes,
			metadata: record.principal.metadata,
			iat: nowSeconds(),
			exp: expiresAt,
			iss: this.config.issuer,
			jti: randomUUID(),
		}, this.config.authSecret);

		this.refreshSessions.set(refreshToken, {
			principal: record.principal,
			expiresAt: nowSeconds() + this.config.refreshTokenTtlSeconds,
		});

		return {
			ok: true,
			status: 'approved',
			accessToken,
			refreshToken,
			tokenType: 'Bearer',
			expiresAt: formatExpiry(expiresAt),
			expiresInSeconds: this.config.accessTokenTtlSeconds,
			principal: record.principal,
		};
	}

	async refreshAccessToken(request: TokenRefreshRequest): Promise<TokenRefreshResponse> {
		const session = this.refreshSessions.get(request.refreshToken);
		if (!session || session.expiresAt <= nowSeconds()) {
			throw new Error('Refresh token is invalid or expired.');
		}

		const nextRefreshToken = nextOpaqueToken('refresh');
		this.refreshSessions.delete(request.refreshToken);
		this.refreshSessions.set(nextRefreshToken, {
			principal: session.principal,
			expiresAt: nowSeconds() + this.config.refreshTokenTtlSeconds,
		});

		const expiresAt = nowSeconds() + this.config.accessTokenTtlSeconds;
		const accessToken = createAccessToken({
			sub: session.principal.id,
			displayName: session.principal.displayName,
			scopes: session.principal.scopes,
			metadata: session.principal.metadata,
			iat: nowSeconds(),
			exp: expiresAt,
			iss: this.config.issuer,
			jti: randomUUID(),
		}, this.config.authSecret);

		return {
			ok: true,
			accessToken,
			refreshToken: nextRefreshToken,
			tokenType: 'Bearer',
			expiresAt: formatExpiry(expiresAt),
			expiresInSeconds: this.config.accessTokenTtlSeconds,
			principal: session.principal,
		};
	}

	async authenticateBearerToken(token: string) {
		const payload = verifyAccessToken(token, this.config.authSecret);
		return payload ? principalFromAccessTokenPayload(payload) : null;
	}
}
