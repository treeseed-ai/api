import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

export type PrivateObjectNamespace = 'feedback-attachments' | 'feedback-exports' | 'knowledge-packs';

export interface PrivateObject {
	bytes: Uint8Array;
	contentType: string;
}

export interface PrivateObjectStorage {
	put(kind: PrivateObjectNamespace, bytes: Uint8Array, contentType: string): Promise<{ key: string; digest: string }>;
	get(key: string): Promise<PrivateObject | null>;
	delete(key: string): Promise<void>;
}

export function createPrivateObjectStorage(options: { adapter?: PrivateObjectStorage; environment?: string } = {}) {
	if (options.adapter) return options.adapter;
	const environment = options.environment ?? process.env.TREESEED_ENVIRONMENT ?? (process.env.NODE_ENV === 'production' ? 'production' : 'local');
	if (environment !== 'local' && environment !== 'test') {
		throw new Error('Private object storage requires an injected R2-compatible adapter outside local development.');
	}
	return createLocalPrivateObjectStorage();
}

function storageRoot() {
	return resolve(process.env.TREESEED_PRIVATE_OBJECT_ROOT?.trim() || '.treeseed/runtime/private-objects');
}

function assertStorageKey(key: string) {
	if (!/^(feedback-attachments|feedback-exports|knowledge-packs)\/[a-f0-9-]{36}\.(png|zip)$/u.test(key) || basename(key).includes('..')) {
		throw new Error('Invalid private object key.');
	}
}

export function createLocalPrivateObjectStorage(): PrivateObjectStorage {
	const root = storageRoot();
	return {
		async put(kind, bytes, contentType) {
			const extension = contentType === 'image/png' ? 'png' : 'zip';
			const key = `${kind}/${randomUUID()}.${extension}`;
			assertStorageKey(key);
			const path = resolve(root, key);
			if (!path.startsWith(`${root}/`)) throw new Error('Private storage path escaped its root.');
			await mkdir(resolve(root, kind), { recursive: true, mode: 0o700 });
			const temporary = `${path}.pending-${randomUUID()}`;
			await writeFile(temporary, bytes, { mode: 0o600 });
			await rename(temporary, path);
			return { key, digest: createHash('sha256').update(bytes).digest('hex') };
		},
		async get(key) {
			assertStorageKey(key);
			const bytes = await readFile(resolve(root, key)).catch(() => null);
			if (!bytes) return null;
			return { bytes, contentType: key.endsWith('.png') ? 'image/png' : 'application/zip' };
		},
		async delete(key) {
			assertStorageKey(key);
			await rm(resolve(root, key), { force: true });
		},
	};
}
