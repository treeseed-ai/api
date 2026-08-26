import { ControlPlaneOperationError } from '../operation-registry.ts';

type Store = {
	first(query: string, parameters?: unknown[]): Promise<Record<string, any> | null>;
	run(query: string, parameters?: unknown[]): Promise<unknown>;
};

export function requireRevision(actual: unknown, supplied: string | undefined, domain: string) {
	const revision = String(actual ?? '0');
	if (supplied !== revision) {
		throw new ControlPlaneOperationError(412, `${domain}_precondition_failed`, `The ${domain.replaceAll('_', ' ')} changed after it was inspected.`);
	}
	return revision;
}

export async function accountRevision(store: Store, userId: string) {
	const row = await store.first('SELECT updated_at FROM users WHERE id = ? LIMIT 1', [userId]);
	if (!row) throw new ControlPlaneOperationError(404, 'account_missing', 'The account was not found.');
	return String(row.updated_at ?? '0');
}

export async function requireAccountRevision(store: Store, userId: string, supplied: string | undefined) {
	return requireRevision(await accountRevision(store, userId), supplied, 'account');
}

export async function touchAccountRevision(store: Store, userId: string) {
	const updatedAt = new Date().toISOString();
	await store.run('UPDATE users SET updated_at = ? WHERE id = ?', [updatedAt, userId]);
	return updatedAt;
}
