import { createTestApp,describe,expect,it,vi } from '../../../support/api-harness.ts';

describe('API request logging', () => {
	it('redacts sensitive query values', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const app = createTestApp({ logRequests: true });

		const response = await app.request('/v1/auth/providers?token=secret-token&teamId=team-1');

		expect(response.status).toBe(200);
		expect(write).toHaveBeenCalledWith(expect.stringContaining('[api] GET /v1/auth/providers?token=[redacted]&teamId=team-1 -> 200'));
	});
});
