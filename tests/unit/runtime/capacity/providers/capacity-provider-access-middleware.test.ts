import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createCapacityProviderAccessMiddleware, type CapacityProviderAccessEnv } from '../../../../../src/api/capacity/provider-access-middleware.ts';

describe('capacity provider access middleware', () => {
	it('authenticates provider access tokens on assignment-scoped TreeDX routes', async () => {
		const authenticateAccessToken = vi.fn(async (token: string) => ({
			principal: { id: 'membership-a', token },
		}));
		const app = new Hono<CapacityProviderAccessEnv>();
		app.use('/v1/dx/*', createCapacityProviderAccessMiddleware({ authenticateAccessToken }));
		app.post('/v1/dx/projects/:projectId/repos/:repoId/files/read', (c) => c.json({
			auth: c.get('capacityProviderAccessAuth'),
		}));

		const response = await app.request('/v1/dx/projects/project-a/repos/repo-a/files/read', {
			method: 'POST',
			headers: { authorization: 'Bearer tspa_assignment_access' },
		});

		expect(response.status).toBe(200);
		expect(authenticateAccessToken).toHaveBeenCalledWith('tspa_assignment_access');
		expect(await response.json()).toEqual({
			auth: { principal: { id: 'membership-a', token: 'tspa_assignment_access' } },
		});
	});

	it('does not treat user bearer tokens as provider credentials', async () => {
		const authenticateAccessToken = vi.fn();
		const app = new Hono<CapacityProviderAccessEnv>();
		app.use('/v1/dx/*', createCapacityProviderAccessMiddleware({ authenticateAccessToken }));
		app.get('/v1/dx/projects/project-a', (c) => c.json({
			hasProviderAuth: Boolean(c.get('capacityProviderAccessAuth')),
		}));

		const response = await app.request('/v1/dx/projects/project-a', {
			headers: { authorization: 'Bearer user-session-token' },
		});

		expect(authenticateAccessToken).not.toHaveBeenCalled();
		expect(await response.json()).toEqual({ hasProviderAuth: false });
	});
});
