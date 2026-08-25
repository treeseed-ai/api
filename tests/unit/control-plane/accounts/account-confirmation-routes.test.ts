import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { installAccountConfirmationRoutes } from '../../../../src/api/control-plane/accounts/account-confirmation-routes.ts';

describe('account confirmation browser route', () => {
	it('renders a no-store confirmation form without consuming the token on GET', async () => {
		const confirm = vi.fn();
		const app = new Hono();
		installAccountConfirmationRoutes(app, { confirm });
		const response = await app.request('/auth/confirm-email?token=confirm_secret&returnTo=%2Fapp%2F');
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(html).toContain('method="post"');
		expect(html).toContain('value="confirm_secret"');
		expect(confirm).not.toHaveBeenCalled();
	});

	it('confirms only through the explicit form POST and never returns the token', async () => {
		const confirm = vi.fn(async () => ({ ok: true, confirmed: true }));
		const app = new Hono();
		installAccountConfirmationRoutes(app, { confirm });
		const response = await app.request('/auth/confirm-email', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'token=confirm_secret',
		});
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(confirm).toHaveBeenCalledWith('confirm_secret');
		expect(html).toContain('trsd auth login');
		expect(html).not.toContain('confirm_secret');
	});

	it('renders an invalid or expired result without exposing service internals', async () => {
		const app = new Hono();
		installAccountConfirmationRoutes(app, { async confirm() { return { ok: false, status: 401, code: 'invalid_confirmation_token', message: 'Email confirmation token is invalid or expired.' }; } });
		const response = await app.request('/auth/confirm-email', {
			method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=expired',
		});
		expect(response.status).toBe(401);
		expect(await response.text()).toContain('invalid or expired');
	});
});
