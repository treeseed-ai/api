import { createApiApp } from '../../api/app.js';
import { resolveLocalSeedEnv } from './apply.js';

function localApiConfig(projectRoot, env = process.env) {
	const localEnv = resolveLocalSeedEnv(projectRoot, env);
	return {
		repoRoot: projectRoot,
		projectId: localEnv.TREESEED_PROJECT_ID ?? 'treeseed-market',
		environment: localEnv.TREESEED_API_ENVIRONMENT ?? localEnv.TREESEED_ENVIRONMENT ?? 'local',
		baseUrl: String(localEnv.TREESEED_API_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/u, ''),
		issuer: String(localEnv.TREESEED_API_ISSUER ?? localEnv.TREESEED_API_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/u, ''),
		authSecret: localEnv.TREESEED_AUTH_SECRET ?? localEnv.TREESEED_API_AUTH_SECRET ?? localEnv.TREESEED_BETTER_AUTH_SECRET ?? 'treeseed-local-seed-auth-secret',
		webAssertionSecret: localEnv.TREESEED_WEB_ASSERTION_SECRET ?? localEnv.TREESEED_API_WEB_ASSERTION_SECRET ?? 'treeseed-local-seed-assertion-secret',
		webServiceId: localEnv.TREESEED_WEB_SERVICE_ID ?? localEnv.TREESEED_API_WEB_SERVICE_ID ?? localEnv.TREESEED_API_SERVICE_ID ?? 'web',
		webServiceSecret: localEnv.TREESEED_WEB_SERVICE_SECRET ?? localEnv.TREESEED_API_WEB_SERVICE_SECRET ?? localEnv.TREESEED_API_SERVICE_SECRET ?? 'treeseed-local-seed-service-secret',
		projectApiKey: localEnv.TREESEED_PROJECT_API_KEY,
		providers: {
			auth: 'market-postgres',
		},
	};
}

function seedRequestBody(input) {
	return {
		...(typeof input.environments === 'string' && input.environments.trim()
			? { environments: input.environments.split(',').map((entry) => entry.trim()).filter(Boolean) }
			: {}),
		...(typeof input.approvalRequestId === 'string' && input.approvalRequestId.trim()
			? { approvalRequestId: input.approvalRequestId.trim() }
			: {}),
	};
}

async function jsonRequest(app, path, input, body: any = {}) {
	const headers: Record<string, string> = {
		accept: 'application/json',
		'content-type': 'application/json',
	};
	if (typeof input.accessToken === 'string' && input.accessToken.trim()) {
		headers.authorization = `Bearer ${input.accessToken.trim()}`;
	}
	const response = await app.request(path, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
	const payload = await response.json().catch(() => null);
	if (!response.ok || !payload?.ok) {
		const message = payload?.error ?? payload?.diagnostics?.[0]?.message ?? `Local seed API request failed with HTTP ${response.status}.`;
		const error: Error & Record<string, any> = new Error(message);
		error.status = response.status;
		error.payload = payload;
		throw error;
	}
	return payload;
}

async function requestLocalSeedApi(input, endpoint) {
	const localEnv = resolveLocalSeedEnv(input.projectRoot, input.env);
	const db = input.db;
	try {
		const config = localApiConfig(input.projectRoot, localEnv);
		const app = createApiApp({ config, ...(db ? { db } : {}) });
		return await jsonRequest(app, `/v1/seeds/${encodeURIComponent(input.seedName)}/${endpoint}`, input, seedRequestBody(input));
	} finally {
		if (!input.db) db?.close?.();
	}
}

async function requestLocalSeedExport(input) {
	const localEnv = resolveLocalSeedEnv(input.projectRoot, input.env);
	const db = input.db;
	try {
		const config = localApiConfig(input.projectRoot, localEnv);
		const app = createApiApp({ config, ...(db ? { db } : {}) });
		let teamId = input.team;
		const teamsResponse = await app.request('/v1/teams', {
			headers: {
				accept: 'application/json',
				...(typeof input.accessToken === 'string' && input.accessToken.trim() ? { authorization: `Bearer ${input.accessToken.trim()}` } : {}),
			},
		});
		const teamsPayload = await teamsResponse.json().catch(() => null);
		if (teamsResponse.ok && Array.isArray(teamsPayload?.payload)) {
			const match = teamsPayload.payload.find((team) =>
				team?.id === input.team || team?.slug === input.team || team?.name === input.team,
			);
			if (match?.id) teamId = match.id;
		}
		return await jsonRequest(app, `/v1/teams/${encodeURIComponent(teamId)}/seeds/export`, input, {
			name: input.seedName,
			...(typeof input.environments === 'string' && input.environments.trim()
				? { environments: input.environments.split(',').map((entry) => entry.trim()).filter(Boolean) }
				: {}),
			...(input.includePrivate === true ? { includePrivate: true } : {}),
			...(input.includeArtifacts === true ? { includeArtifacts: true } : {}),
		});
	} finally {
		if (!input.db) db?.close?.();
	}
}

function planFromPayload(payload) {
	return {
		ok: payload.ok !== false,
		seed: payload.seed,
		version: 1,
		mode: payload.mode === 'apply' ? 'apply' : 'plan',
		environments: Array.isArray(payload.environments) ? payload.environments : [],
		summary: payload.summary,
		actions: Array.isArray(payload.actions) ? payload.actions : [],
		diagnostics: Array.isArray(payload.diagnostics) ? payload.diagnostics : [],
		manifestPath: '',
	};
}

export async function planLocalSeedViaApiFromCli(input) {
	const payload = await requestLocalSeedApi(input, 'plan');
	return {
		plan: planFromPayload(payload),
		diagnostics: Array.isArray(payload.diagnostics) ? payload.diagnostics : [],
		manifestPath: '',
		run: payload.run ?? null,
	};
}

export async function applyLocalSeedViaApiFromCli(input) {
	const payload = await requestLocalSeedApi(input, 'apply');
	return {
		plan: planFromPayload(payload),
		result: payload.result ?? {},
		run: payload.run ?? null,
	};
}

export async function exportLocalSeedViaApiFromCli(input) {
	return requestLocalSeedExport(input);
}
