import { describe, expect, it, vi } from 'vitest';
import { TREEAI_CONTROL_PLANE_OPERATION_LIST } from '@treeseed/sdk/treeai';
import { createTreeAiOperations } from '../../../../src/api/control-plane/catalog/treeai/index.ts';
import { TreeAiProxyService } from '../../../../src/api/control-plane/treeai/proxy-service.ts';

describe('TreeAI SDK-driven proxy', () => {
	it('binds exactly the SDK-adopted operation set', () => {
		const service = { invoke: vi.fn() } as unknown as TreeAiProxyService;
		expect(createTreeAiOperations({ treeAiProxy: service }).map(({ binding }) => binding.descriptor.operationId).sort())
			.toEqual(TREEAI_CONTROL_PLANE_OPERATION_LIST.map(({ descriptor }) => descriptor.operationId).sort());
	});

	it('resolves a node and forwards an upstream operation without exposing its credential', async () => {
		const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
			expect((init?.headers as Headers).get('authorization')).toBe('Bearer private-token');
			return new Response(JSON.stringify({ mode: 'awake' }), { headers: { 'content-type': 'application/json' } });
		});
		const service = new TreeAiProxyService({ resolve: () => ({ token: 'private-token', endpoints: {
			inference: 'https://inference.test', training: 'https://training.test', lab: 'https://lab.test', qualification: 'https://manager.test',
		} }) }, fetchImpl);
		await expect(service.invoke('node-1', 'qualification.get.mode', {}, { interface: 'rest', requestId: 'request-1' })).resolves.toEqual({ mode: 'awake' });
		expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://manager.test/v1/mode');
	});
});
