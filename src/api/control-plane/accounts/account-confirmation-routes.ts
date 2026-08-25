import type { Hono } from 'hono';

interface AccountConfirmationService {
	confirm(token: unknown): Promise<Record<string, any>>;
}

const headers = {
	'cache-control': 'no-store',
	pragma: 'no-cache',
	'referrer-policy': 'no-referrer',
	'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	'x-frame-options': 'DENY',
};

function escapeHtml(value: unknown) {
	return String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function page(token: string, state: 'pending' | 'confirmed' | 'failed' = 'pending', message = '') {
	const title = state === 'confirmed' ? 'Email confirmed' : state === 'failed' ? 'Confirmation failed' : 'Confirm your TreeSeed account';
	const content = state === 'confirmed'
		? '<p class="success">Your account is active. Return to your terminal and run <code>trsd auth login</code>.</p>'
		: state === 'failed'
			? `<p class="error">${escapeHtml(message)}</p>`
			: `<p>Activate your TreeSeed account for this email address.</p><form method="post" action="/auth/confirm-email"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Confirm email</button></form>`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui,sans-serif;background:#f5f7f4;color:#172019;margin:0}main{max-width:32rem;margin:8vh auto;background:white;padding:2rem;border-radius:1rem;box-shadow:0 8px 30px #0002}h1{margin-top:0}button{padding:.75rem 1.1rem;border:0;border-radius:.4rem;background:#176b45;color:white;font:700 1rem system-ui;cursor:pointer}.error{color:#a21b1b}.success{color:#176b45;font-weight:600}code{font-family:ui-monospace,monospace}</style></head><body><main><h1>${title}</h1>${content}</main></body></html>`;
}

export function installAccountConfirmationRoutes(app: Hono, service: AccountConfirmationService) {
	app.get('/auth/confirm-email', (context) => {
		const token = context.req.query('token')?.trim() ?? '';
		return context.html(page(token, token ? 'pending' : 'failed', token ? '' : 'The confirmation token is missing.'), token ? 200 : 400, headers);
	});

	app.post('/auth/confirm-email', async (context) => {
		const body = await context.req.parseBody().catch(() => ({}));
		const token = typeof body.token === 'string' ? body.token.trim() : '';
		if (!token) return context.html(page('', 'failed', 'The confirmation token is missing.'), 400, headers);
		const result = await service.confirm(token);
		if (!result.ok) return context.html(page('', 'failed', String(result.message ?? 'The confirmation link is invalid or expired.')), Number(result.status ?? 400) as any, headers);
		return context.html(page('', 'confirmed'), 200, headers);
	});
}
