import { describe, expect, it, vi } from 'vitest';
import { ProviderAssignmentLifecycleService } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lifecycle-service.ts';
import type { CapacityDatabaseOperation } from '../../../../../src/api/capacity/database.ts';

describe('provider assignment retry policy', () => {
	it('fails a repeatedly returned assignment when its durable attempt limit is reached', async () => {
		let transitioned = false;
		const batch = vi.fn(async (_operations: CapacityDatabaseOperation[]) => { transitioned = true; });
		const store = {
			ensureInitialized: vi.fn(async () => undefined),
			getProviderAssignment: vi.fn(async () => ({
				id: 'assignment-a',
				membershipId: 'membership-a',
				teamId: 'team-a',
				projectId: 'project-a',
				capacityProviderId: 'provider-a',
				status: transitioned ? 'failed' : 'leased',
				leaseState: transitioned ? 'released' : 'leased',
				leaseToken: transitioned ? null : 'lease-a',
				attemptCount: transitioned ? 3 : 2,
				stateVersion: transitioned ? 2 : 1,
				mode: 'planning',
				metadata: { retryPolicy: { maxAttempts: 3 } },
				lifecycleCode: transitioned ? 'provider_assignment_retry_exhausted' : null,
			})),
			batch,
		};

		const result = await new ProviderAssignmentLifecycleService(store as never).return(
			{ membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' },
			'assignment-a',
			{ leaseToken: 'lease-a', code: 'transient_failure', reason: 'Temporary failure.', retryable: true },
		);

		expect(result).toMatchObject({ assignment: { status: 'failed', lifecycleCode: 'provider_assignment_retry_exhausted' } });
		expect(batch).toHaveBeenCalledOnce();
		expect(batch.mock.calls[0]?.[0]?.[0]?.params).toContain('provider_assignment_retry_exhausted');
	});

	it('does not release a lease when required fallback evidence cannot be persisted', async () => {
		const persistenceFailure = Object.assign(new Error('fallback storage unavailable'), { code: 'agent_fallback_not_persisted' });
		const run = vi.fn(async () => undefined);
		const store = {
			ensureInitialized: vi.fn(async () => undefined),
			getProviderAssignment: vi.fn(async () => ({
				id: 'assignment-a', membershipId: 'membership-a', teamId: 'team-a', projectId: 'project-a',
				capacityProviderId: 'provider-a', status: 'leased', leaseState: 'leased', leaseToken: 'lease-a',
				attemptCount: 0, stateVersion: 1, metadata: {}, mode: 'planning',
			})),
			recordAgentFallbackOutput: vi.fn(async () => { throw persistenceFailure; }),
			run,
		};

		await expect(new ProviderAssignmentLifecycleService(store as never).return(
			{ membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' },
			'assignment-a',
			{ leaseToken: 'lease-a', fallbackOutput: { id: 'fallback-a', code: 'input_missing' } },
		)).rejects.toBe(persistenceFailure);
		expect(run).not.toHaveBeenCalled();
	});

	it('rejects terminal mutations from an expired lease without mutation', async () => {
		const run = vi.fn(async () => undefined);
		const store = {
			ensureInitialized: vi.fn(async () => undefined),
			getProviderAssignment: vi.fn(async () => ({
				id: 'assignment-a', membershipId: 'membership-a', teamId: 'team-a', projectId: 'project-a',
				capacityProviderId: 'provider-a', status: 'leased', leaseState: 'leased', leaseToken: 'lease-a',
				leaseExpiresAt: '2020-01-01T00:00:00.000Z', attemptCount: 0, stateVersion: 1,
				metadata: {}, mode: 'planning',
			})),
			run,
		};
		const lifecycle = new ProviderAssignmentLifecycleService(store as never);
		for (const operation of ['return', 'complete', 'fail'] as const) {
			await expect(lifecycle[operation](
				{ membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' },
				'assignment-a',
				{ leaseToken: 'lease-a' },
			)).resolves.toBeNull();
		}
		expect(run).not.toHaveBeenCalled();
	});
});
