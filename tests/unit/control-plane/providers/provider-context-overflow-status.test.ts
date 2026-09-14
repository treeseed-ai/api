import { keyFixture } from '../security/os-key-fixture.ts';
import { describe, expect, it, vi } from 'vitest';
import { createProviderRuntimeService } from '../../../../src/api/control-plane/repositories/providers/provider-runtime-service.ts';

describe('provider context-capacity status', () => {
	it('surfaces quarantined offers as status alerts and diagnostic blockers', async () => {
		const store = {
			all: vi.fn(async (query: string) => query.includes('execution_capability_offers')
				? [{ offer_id: 'codex-chat', execution_provider_id: 'private-adapter', status: 'context_overflow', last_seen_at: '2026-08-31T00:00:00.000Z' }]
				: query.includes('availability_sessions') ? [{ status: 'open', expires_at: '2099-01-01T00:00:00.000Z' }] : []),
			first: vi.fn(async (query: string) => query.includes('COUNT(*)') ? { count: 1 } : null),
			principalCanAccessTeam: vi.fn(async () => true), principalCanManageTeam: vi.fn(async () => true),
		} as any;
		const service = createProviderRuntimeService(store, { environment: 'test', capacityEncryptionKeyFile: keyFixture() });
		service.show = vi.fn(async () => ({ id: 'provider-1' })) as any;
		const status = await service.diagnose({ id: 'owner' }, 'team-1', 'provider-1');
		expect(status.healthy).toBe(true);
		expect(status.alerts).toEqual([expect.objectContaining({ code: 'provider_context_capacity_overflow', offerId: 'codex-chat' })]);
		expect(status.blockers).toContain('context_overflow:codex-chat');
		expect(status.nextActions).toContain('Publish an updated context-capacity offer and pass conformance before re-enabling it.');
	});

	it('surfaces the latest durable assignment synthesis failure', async () => {
		const store = {
			all: vi.fn(async (query: string) => query.includes('execution_capability_offers')
				? [] : query.includes('availability_sessions') ? [{ status: 'open', expires_at: '2099-01-01T00:00:00.000Z' }] : []),
			first: vi.fn(async (query: string) => query.includes('COUNT(*)') ? { count: 1 }
				: query.includes("provider-assignment.synthesis-failed") ? {
					action: 'provider-assignment.synthesis-failed',
					metadata_json: JSON.stringify({ status: 'failed', code: 'execution_node_invalid', message: 'Invalid node.' }),
					created_at: '2026-09-14T12:00:00.000Z',
				} : null),
			principalCanAccessTeam: vi.fn(async () => true), principalCanManageTeam: vi.fn(async () => true),
		} as any;
		const service = createProviderRuntimeService(store, { environment: 'test', capacityEncryptionKeyFile: keyFixture() });
		service.show = vi.fn(async () => ({ id: 'provider-1' })) as any;
		const status = await service.diagnose({ id: 'owner' }, 'team-1', 'provider-1');
		expect(status.synthesisFailure).toEqual(expect.objectContaining({ code: 'execution_node_invalid', observedAt: '2026-09-14T12:00:00.000Z' }));
		expect(status.blockers).toContain('execution_node_invalid');
	});
});
