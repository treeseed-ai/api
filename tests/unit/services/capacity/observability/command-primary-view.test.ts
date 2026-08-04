import { describe, expect, it, vi } from 'vitest';
import { commandPrimaryView } from '../../../../../src/api/capacity/services/capacity/observability/command-primary-view.ts';

describe('command primary view', () => {
	it('projects proposal authorship and voting content without exposing an internal ID', async () => {
		const first = vi.fn().mockResolvedValue({ display_name: 'Adrian Webb', email: 'adrian@example.test' });
		const primary = await commandPrimaryView({ first }, 'proposal', {
			kind: 'proposal', title: 'Guide direction', description: 'Summary', status: 'voting', projectName: 'Market', occurredAt: '2026-08-04T14:00:00.000Z',
		}, { body: 'Adopt the proposed editorial direction.\n\nAgent evidence:\n{\"mode\":\"plan\"}', proposal_type: 'editorial-test', created_by_type: 'user', created_by_id: 'opaque-user-id', created_at: '2026-08-04T13:00:00.000Z' });

		expect(primary.actor.name).toBe('Adrian Webb');
		expect(primary.content).toEqual({ label: 'Proposal', body: 'Adopt the proposed editorial direction.', classification: 'editorial-test', missing: false });
		expect(JSON.stringify(primary)).not.toContain('opaque-user-id');
	});

	it('reports missing proposal content without substituting the collection summary', async () => {
		const primary = await commandPrimaryView({ first: vi.fn() }, 'proposal', {
			kind: 'proposal', title: 'Incomplete proposal', description: 'Collection card summary', status: 'draft',
		}, { proposal_type: 'editorial-test', created_by_type: 'agent' });

		expect(primary.content).toEqual({ label: 'Proposal', body: '', classification: 'editorial-test', missing: true });
	});
});
