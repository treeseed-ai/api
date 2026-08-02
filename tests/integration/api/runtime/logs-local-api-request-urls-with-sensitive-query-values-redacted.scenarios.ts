import { createTestApp,describe,expect,it,vi } from '../../../support/api-harness.ts';

describe('market api', () => {
it('logs local API request URLs with sensitive query values redacted', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const app = createTestApp({ logRequests: true });

		const response = await app.request('/v1/markets/current?token=secret-token&teamId=team-1');

		expect(response.status).toBe(200);
		expect(write).toHaveBeenCalledWith(expect.stringContaining('[api] GET /v1/markets/current?token=[redacted]&teamId=team-1 -> 200'));
	});
});
