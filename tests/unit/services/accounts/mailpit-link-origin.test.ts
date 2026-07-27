import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { assertMailpitExpectation } from '../../../../scripts/api-acceptance-support/support/mailpit-assertions.ts';
import { getSiteAuthConfig } from '../../../../src/auth/config.ts';
import { marketAuthContext } from '../../../../src/api/app/support/accounts/authentication-sessions.ts';

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))));
});

async function mailpitServer(linkOrigin: string) {
	const server = createServer((request, response) => {
		response.setHeader('content-type', 'application/json');
		if (request.url === '/api/v1/messages') {
			response.end(JSON.stringify({
				messages: [{ ID: 'message-1', Subject: 'Confirm account', To: [{ Address: 'user@example.test' }] }],
			}));
			return;
		}
		response.end(JSON.stringify({
			Text: `Confirm ${linkOrigin}/auth/confirm-email?token=confirmation-token`,
		}));
	});
	servers.push(server);
	return new Promise<string>((resolvePromise) => {
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Mailpit test server address is unavailable.');
			resolvePromise(`http://127.0.0.1:${address.port}`);
		});
	});
}

describe('Mailpit acceptance link origin', () => {
	it('uses the configured site origin instead of the API request origin', () => {
		const context = marketAuthContext({
			env: {},
			req: { url: 'http://127.0.0.1:3000/v1/auth/web/sign-up' },
		}, {
			siteUrl: 'http://127.0.0.1:4321',
		});

		expect(getSiteAuthConfig(context).siteBaseUrl).toBe('http://127.0.0.1:4321');
	});

	it('passes only when the delivered service link uses the configured site origin', async () => {
		const url = await mailpitServer('http://127.0.0.1:4321');
		const expectation = {
			url,
			to: 'user@example.test',
			subjectIncludes: 'Confirm',
			linkOrigin: 'http://127.0.0.1:4321',
			timeoutMs: 1,
		};

		await expect(assertMailpitExpectation(expectation)).resolves.toEqual([]);
		await expect(assertMailpitExpectation({
			...expectation,
			linkOrigin: 'http://127.0.0.1:3000',
		})).resolves.toEqual([
			expect.stringContaining('Mailpit link origin http://127.0.0.1:4321 does not match http://127.0.0.1:3000'),
		]);
	});
});
