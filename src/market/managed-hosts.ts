// @ts-nocheck
function runtimeEnvValue(runtime, name) {
	const runtimeValue = runtime?.env?.[name];
	if (typeof runtimeValue === 'string' && runtimeValue.trim()) return runtimeValue.trim();
	const processEnv = typeof process !== 'undefined' && process?.env ? process.env : {};
	const processValue = processEnv[name];
	return typeof processValue === 'string' && processValue.trim() ? processValue.trim() : '';
}

function configValue(values, name) {
	const value = values?.[name];
	return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function firstRuntimeEnvValue(runtime, names, values = {}) {
	for (const name of names) {
		const configuredValue = configValue(values, name);
		if (configuredValue) return configuredValue;
		const value = runtimeEnvValue(runtime, name);
		if (value) return value;
	}
	return '';
}

function machineConfigAllowedForRuntime(runtime) {
	const localDevMode = runtimeEnvValue(runtime, 'TREESEED_LOCAL_DEV_MODE');
	const environment = runtimeEnvValue(runtime, 'TREESEED_ENVIRONMENT');
	return localDevMode === 'cloudflare' || environment === 'local';
}

async function collectLocalTreeseedConfigValues(runtime, scope = 'prod') {
	if (!machineConfigAllowedForRuntime(runtime)) {
		return {};
	}
	if (typeof process === 'undefined' || typeof process.cwd !== 'function') {
		return {};
	}
	try {
		const operationsSpecifier = '@treeseed/sdk/operations';
		const { collectTreeseedConfigSeedValues } = await import(/* @vite-ignore */ operationsSpecifier);
		if (typeof collectTreeseedConfigSeedValues === 'function') {
			return collectTreeseedConfigSeedValues(process.cwd(), scope, runtime?.env ?? process.env);
		}
	} catch {
		return {};
	}
	return {};
}

export function resolveTreeseedManagedCloudflareHostConfig(runtime, values = {}) {
	const token = firstRuntimeEnvValue(runtime, ['TREESEED_CLOUDFLARE_API_TOKEN'], values);
	const accountId = firstRuntimeEnvValue(runtime, ['TREESEED_CLOUDFLARE_ACCOUNT_ID'], values);
	const config = {
		TREESEED_CLOUDFLARE_API_TOKEN: token,
		TREESEED_CLOUDFLARE_ACCOUNT_ID: accountId,
		...(token ? { CLOUDFLARE_API_TOKEN: token } : {}),
		...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
		TREESEED_CLOUDFLARE_PAGES_PROJECT_NAME: firstRuntimeEnvValue(runtime, ['TREESEED_CLOUDFLARE_PAGES_PROJECT_NAME'], values),
		TREESEED_CLOUDFLARE_PAGES_PREVIEW_PROJECT_NAME: firstRuntimeEnvValue(runtime, ['TREESEED_CLOUDFLARE_PAGES_PREVIEW_PROJECT_NAME'], values),
		CLOUDFLARE_ZONE_ID: firstRuntimeEnvValue(runtime, ['CLOUDFLARE_ZONE_ID', 'TREESEED_CLOUDFLARE_ZONE_ID'], values),
		TREESEED_CLOUDFLARE_ZONE_NAME: firstRuntimeEnvValue(runtime, ['TREESEED_CLOUDFLARE_ZONE_NAME', 'TREESEED_WEB_ROOT_DOMAIN'], values),
		TREESEED_CONTENT_BUCKET_NAME: firstRuntimeEnvValue(runtime, ['TREESEED_CONTENT_BUCKET_NAME'], values),
		TREESEED_CONTENT_BUCKET_BINDING: firstRuntimeEnvValue(runtime, ['TREESEED_CONTENT_BUCKET_BINDING'], values),
	};
	return Object.fromEntries(Object.entries(config).filter(([, value]) => value));
}

export async function resolveTreeseedManagedCloudflareHostConfigFromConfig(runtime, scope = 'prod') {
	return resolveTreeseedManagedCloudflareHostConfig(runtime, await collectLocalTreeseedConfigValues(runtime, scope));
}

export function managedCloudflareConfigMissing(config) {
	return ['TREESEED_CLOUDFLARE_API_TOKEN', 'TREESEED_CLOUDFLARE_ACCOUNT_ID'].filter((key) => !config?.[key]);
}

function managedStatus(missing) {
	return missing.length > 0 ? 'configuration_required' : 'active';
}

export function listTreeseedManagedHosts(teamId, runtime, values = {}) {
	const cloudflareConfig = resolveTreeseedManagedCloudflareHostConfig(runtime, values);
	const cloudflareMissing = managedCloudflareConfigMissing(cloudflareConfig);
	const now = null;
	return [
		{
			id: 'treeseed-managed-web',
			teamId,
			provider: 'cloudflare',
			ownership: 'treeseed_managed',
			name: 'TreeSeed Web Host',
			accountLabel: 'TreeSeed Cloudflare account',
			allowedEnvironments: ['staging', 'prod'],
			status: managedStatus(cloudflareMissing),
			encryptedPayload: null,
			metadata: {
				hostType: 'web',
				managed: true,
				configured: cloudflareMissing.length === 0,
				missingConfigKeys: cloudflareMissing,
				requiredOperationalKeys: [
					'TREESEED_CLOUDFLARE_API_TOKEN',
					'TREESEED_CLOUDFLARE_ACCOUNT_ID',
				],
				dns: {
					managed: Boolean(cloudflareConfig.CLOUDFLARE_ZONE_ID || cloudflareConfig.TREESEED_CLOUDFLARE_ZONE_NAME),
					zoneId: cloudflareConfig.CLOUDFLARE_ZONE_ID ?? null,
					zoneName: cloudflareConfig.TREESEED_CLOUDFLARE_ZONE_NAME ?? null,
				},
			},
			createdAt: now,
			updatedAt: now,
		},
		{
			id: 'treeseed-managed-email',
			teamId,
			provider: 'smtp',
			ownership: 'treeseed_managed',
			name: 'TreeSeed Email Host',
			accountLabel: 'TreeSeed email service',
			allowedEnvironments: ['staging', 'prod'],
			status: 'active',
			encryptedPayload: null,
			metadata: {
				hostType: 'email',
				managed: true,
				configured: true,
				pricing: '$0.01/email sent',
			},
			createdAt: now,
			updatedAt: now,
		},
	];
}

export async function listTreeseedManagedHostsFromConfig(teamId, runtime, scope = 'prod') {
	return listTreeseedManagedHosts(teamId, runtime, await collectLocalTreeseedConfigValues(runtime, scope));
}
