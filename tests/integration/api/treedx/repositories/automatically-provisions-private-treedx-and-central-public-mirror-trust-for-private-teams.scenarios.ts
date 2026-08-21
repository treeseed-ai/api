import { authorizeApp,createTestApp,describe,expect,it,json } from '../../../../support/api-harness.ts';

describe('control-plane API', () => {
it('automatically provisions private TreeDX and central public mirror trust for private teams', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app, { principalId: 'private-owner' });
		const team = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ slug: 'private-demo-team', name: 'Private Demo Team' }),
		}));
		expect(team.payload.metadata).toMatchObject({
			visibility: 'private',
			privateTreeDx: true,
		});

		const treedx = await json(await app.request(`/v1/teams/${team.payload.id}/treedx`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(treedx.payload.instance).toMatchObject({
			kind: 'managed_private',
			publicRead: false,
			registryUrl: 'https://api.treeseed.dev/treedx',
			metadata: expect.objectContaining({
				automaticPrivateTeamTreeDx: true,
				centralPublicRegistry: expect.objectContaining({
					trustMode: 'scoped_node_token',
					mirrorAllowed: true,
					queryDelegationAllowed: true,
				}),
			}),
		});
		expect(treedx.payload.mirrors).toEqual(expect.arrayContaining([
			expect.objectContaining({
				name: 'TreeSeed public registry mirror',
				direction: 'pull',
				targetKind: 'treedx',
				targetUrl: 'https://api.treeseed.dev/treedx',
				metadata: expect.objectContaining({
					centralPublicRegistry: true,
					privateDataEgress: 'deny_by_default',
				}),
			}),
		]));
	});
});
