import { describe, expect, it, vi } from 'vitest';
import { createProjectCreateOperation } from '../../../../src/api/control-plane/catalog/project-operations.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const plan = {
	schemaVersion: 'treeseed.platform-project-create-plan/v1' as const, slug: 'example-app',
	template: { id: 'engineering', version: '1.0.0-rc.5', digest }, team: 'team-1',
	repository: { owner: 'example', name: 'example-app', visibility: 'private' as const },
	steps: ['project', 'repository', 'template', 'library', 'inventory'] as const,
	actions: [
		{ step: 'project', action: 'create' }, { step: 'repository', action: 'adopt' }, { step: 'template', action: 'apply' },
		{ step: 'library', action: 'bind' }, { step: 'inventory', action: 'publish' },
	] as const,
	observationDigest: digest, planDigest: digest, ok: true, blockers: [],
};

function operation() {
	const createPlan = vi.fn(async (target) => ({ ...plan, ...target }));
	const apply = vi.fn(async (accepted, key) => ({ schemaVersion: 'treeseed.platform-project-create-receipt/v1', planDigest: accepted.planDigest, idempotencyKey: key }));
	return { createPlan, apply, value: createProjectCreateOperation({ platformProjectCreation: { plan: createPlan, apply }, store: {} } as never) };
}

describe('governed Platform project creation operation', () => {
	it('plans without mutation and binds the target to the authorized team', async () => {
		const fixture = operation();
		await expect(fixture.value.handler({ path: { teamId: 'team-1' }, query: {}, body: { mode: 'plan', target: { ...plan, team: undefined } } },
			{ principal: { id: 'admin', roles: ['admin'] } } as never)).resolves.toMatchObject({ team: 'team-1', slug: 'example-app' });
		expect(fixture.createPlan).toHaveBeenCalledWith(expect.objectContaining({ team: 'team-1', slug: 'example-app' }));
		expect(fixture.apply).not.toHaveBeenCalled();
	});

	it('requires idempotency and rejects cross-team accepted plans', async () => {
		const fixture = operation();
		const invocation = { path: { teamId: 'team-1' }, query: {}, body: { mode: 'apply', plan } };
		await expect(fixture.value.handler(invocation, { principal: { id: 'admin', roles: ['admin'] } } as never))
			.rejects.toMatchObject({ code: 'idempotency_key_required' });
		await expect(fixture.value.handler({ ...invocation, body: { mode: 'apply', plan: { ...plan, team: 'team-2' } } },
			{ principal: { id: 'admin', roles: ['admin'] }, idempotencyKey: 'key-1' } as never)).rejects.toMatchObject({ code: 'project_team_mismatch' });
	});

	it('applies the exact accepted plan with the request idempotency key', async () => {
		const fixture = operation();
		await fixture.value.handler({ path: { teamId: 'team-1' }, query: {}, body: { mode: 'apply', plan } },
			{ principal: { id: 'admin', roles: ['admin'] }, idempotencyKey: 'key-1' } as never);
		expect(fixture.apply).toHaveBeenCalledWith(plan, 'key-1');
	});
});
