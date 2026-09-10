import { expect, it, vi } from 'vitest';
import { createClient } from '../../../../src/operations-runner/entrypoint-support/support/clients.ts';
import { DirectControlPlaneRunnerClient } from '../../../../src/operations-runner/client/direct-control-plane-runner-client.ts';

it('uses the supplied store without creating another database pool or closing borrowed custody', async () => {
	const close = vi.fn(async () => {});
	const register = vi.fn(async () => ({ id: 'runner' }));
	const store = { db: { close }, upsertControlPlaneOperationRunner: register };
	// No database URL: allocating another pool would fail this test.
	const client = createClient({}, store as unknown as NonNullable<Parameters<typeof createClient>[1]>);
	await client.register({ runnerId: 'runner' });
	await client.close();
	expect(register).toHaveBeenCalledOnce();
	expect(close).not.toHaveBeenCalled();
});

it('still closes stores owned by standalone clients', async () => {
	const close = vi.fn(async () => {});
	const client = new DirectControlPlaneRunnerClient({ db: { close } } as ConstructorParameters<typeof DirectControlPlaneRunnerClient>[0]);
	await client.close();
	expect(close).toHaveBeenCalledOnce();
});
