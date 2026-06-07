import type {
	CloudflareRuntime,
	D1DatabaseLike,
	KvNamespaceLike,
	KvNamespacePutOptions,
} from '@treeseed/core/types/cloudflare';

type RuntimeLocals = App.Locals & {
	runtime?: CloudflareRuntime;
};

interface LocalRuntimeState {
	runtime: CloudflareRuntime;
}

declare global {
	var __treeseedLocalCloudflareRuntime: Promise<LocalRuntimeState> | undefined;
}

class LocalFormGuardKv implements KvNamespaceLike {
	private readonly values = new Map<string, { value: string; expiresAt: number | null }>();

	async get(key: string) {
		const entry = this.values.get(key);
		if (!entry) return null;
		if (entry.expiresAt && entry.expiresAt <= Date.now()) {
			this.values.delete(key);
			return null;
		}
		return entry.value;
	}

	async put(key: string, value: string, options?: KvNamespacePutOptions) {
		const expiresAt = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
		this.values.set(key, { value, expiresAt });
	}
}

function getProcessEnv() {
	return typeof process === 'undefined' ? null : process.env;
}

async function resolvePath(cwd: string, ...segments: string[]) {
	const pathSpecifier = 'node:path';
	const { resolve } = await import(/* @vite-ignore */ pathSpecifier) as typeof import('node:path');
	return resolve(cwd, ...segments);
}

async function fileExists(path: string) {
	const fsSpecifier = 'node:fs';
	const { existsSync } = await import(/* @vite-ignore */ fsSpecifier) as typeof import('node:fs');
	return existsSync(path);
}

async function resolveLocalWranglerConfigPath(cwd: string, env: NodeJS.ProcessEnv) {
	const explicit = env.TREESEED_LOCAL_WRANGLER_CONFIG?.trim();
	if (explicit) return resolvePath(cwd, explicit);
	const generated = await resolvePath(cwd, '.treeseed', 'generated', 'environments', 'local', 'wrangler.toml');
	return await fileExists(generated) ? generated : null;
}

async function resolveLocalPersistTo(cwd: string, env: NodeJS.ProcessEnv) {
	const explicit = env.TREESEED_API_D1_LOCAL_PERSIST_TO?.trim();
	if (explicit) return explicit;
	const wranglerConfigPath = await resolveLocalWranglerConfigPath(cwd, env);
	if (wranglerConfigPath) {
		const pathSpecifier = 'node:path';
		const { dirname, resolve } = await import(/* @vite-ignore */ pathSpecifier) as typeof import('node:path');
		return resolve(dirname(wranglerConfigPath), '.wrangler', 'state', 'v3', 'd1');
	}
	return resolvePath(cwd, '.wrangler', 'state', 'v3', 'd1');
}

async function createLocalRuntime() {
	const processEnv = getProcessEnv();
	if (!processEnv) {
		throw new Error('Local Cloudflare runtime requires a Node.js process environment.');
	}
	const cwd = process.cwd();
	const persistTo = await resolveLocalPersistTo(cwd, processEnv);
	const sdkDbSpecifier = '@treeseed/sdk/db/node-sqlite';
	const { NodeSqliteD1Database } = await import(/* @vite-ignore */ sdkDbSpecifier) as {
		NodeSqliteD1Database: new (path?: string | null) => D1DatabaseLike;
	};
	const db = new NodeSqliteD1Database(persistTo);
	const env = {
		...processEnv,
		SITE_DATA_DB: db,
		FORM_GUARD_KV: new LocalFormGuardKv(),
	};
	return {
		runtime: {
			env,
		},
	} satisfies LocalRuntimeState;
}

function shouldInstallLocalRuntime(locals: RuntimeLocals) {
	if (locals.runtime?.env?.SITE_DATA_DB) return false;
	const processEnv = getProcessEnv();
	if (!processEnv) return false;
	return processEnv.TREESEED_LOCAL_DEV_MODE === 'cloudflare'
		|| processEnv.TREESEED_API_D1_DATABASE_NAME === 'SITE_DATA_DB'
		|| processEnv.SITE_DATA_DB === 'SITE_DATA_DB';
}

export async function ensureLocalCloudflareRuntime(locals: RuntimeLocals) {
	if (!shouldInstallLocalRuntime(locals)) return;
	const state = await (globalThis.__treeseedLocalCloudflareRuntime ??= createLocalRuntime());
	locals.runtime = {
		...(locals.runtime ?? {}),
		env: {
			...(locals.runtime?.env ?? {}),
			...state.runtime.env,
		},
	};
}
