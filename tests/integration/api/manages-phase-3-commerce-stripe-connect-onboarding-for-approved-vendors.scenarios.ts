import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('manages phase 3 commerce stripe connect onboarding for approved vendors', async () => {
		const calls: string[] = [];
		const stripeAccounts = new Map<string, any>();
		const fakeStripeConnectService = {
			environment: 'test',
			async isConfigured() {
				return true;
			},
			async createExpressAccount({ vendor }: any) {
				calls.push('createExpressAccount');
				const account = {
					id: `acct_${vendor.id}`,
					charges_enabled: false,
					payouts_enabled: false,
					details_submitted: false,
					requirements: {
						currently_due: ['business_profile.url'],
						eventually_due: ['external_account'],
						past_due: [],
						disabled_reason: null,
					},
					capabilities: {
						card_payments: 'pending',
						transfers: 'pending',
					},
				};
				stripeAccounts.set(account.id, account);
				return account;
			},
			async createOnboardingLink({ stripeAccountId }: any) {
				calls.push(`createOnboardingLink:${stripeAccountId}`);
				return { url: `https://connect.stripe.test/onboarding/${stripeAccountId}` };
			},
			async retrieveAccount(stripeAccountId: string) {
				calls.push(`retrieveAccount:${stripeAccountId}`);
				return stripeAccounts.get(stripeAccountId);
			},
			async createLoginLink(stripeAccountId: string) {
				calls.push(`createLoginLink:${stripeAccountId}`);
				return { url: `https://connect.stripe.test/dashboard/${stripeAccountId}` };
			},
		};
		const app = createTestApp({ stripeConnectService: fakeStripeConnectService });
		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'commerce-phase-3' }),
		}));
		const team = seeded.payload.fixtures.team;
		const ownerToken = seeded.payload.actors.teamOwner.accessToken;
		const viewerToken = seeded.payload.actors.teamViewer.accessToken;
		const adminToken = seeded.payload.actors.marketSteward.accessToken;

		const emptyStatus = await json(await app.request(`/v1/commerce/vendors/${team.id}/stripe/status`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(emptyStatus.payload).toBeNull();

		const vendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				displayName: 'Stripe Cooperative Vendor',
				slug: 'stripe-cooperative-vendor',
			}),
		}));

		const unapprovedOnboarding = await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		});
		expect(unapprovedOnboarding.status).toBe(409);
		expect(calls).not.toContain('createExpressAccount');

		const deniedManager = await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${viewerToken}`,
			},
			body: JSON.stringify({}),
		});
		expect(deniedManager.status).toBe(403);

		await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({
				trustLevel: 'verified_seller',
				salesEnabled: true,
				reason: 'Approved for seller onboarding.',
			}),
		});

		const onboarding = await json(await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		}));
		expect(onboarding.payload.onboardingUrl).toMatch(/^https:\/\/connect\.stripe\.test\/onboarding\/acct_/u);
		expect(onboarding.payload.account).toMatchObject({
			vendorId: vendor.payload.id,
			teamId: team.id,
			environment: 'test',
			accountStatus: 'restricted',
			onboardingStatus: 'started',
			chargesEnabled: false,
			payoutsEnabled: false,
			detailsSubmitted: false,
			requirementsCurrentlyDue: ['business_profile.url'],
			requirementsPastDue: [],
		});
		expect(JSON.stringify(onboarding.payload)).not.toContain('sk_test');

		const persistedVendor = await json(await app.request(`/v1/commerce/vendors/${team.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(persistedVendor.payload.stripeAccountId).toBe(onboarding.payload.account.stripeAccountId);

		const returned = await json(await app.request(`/v1/commerce/vendors/${team.id}/stripe/return`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		}));
		expect(returned.payload).toMatchObject({
			onboardingStatus: 'returned',
			accountStatus: 'restricted',
		});

		const stripeAccountId = onboarding.payload.account.stripeAccountId;
		stripeAccounts.set(stripeAccountId, {
			id: stripeAccountId,
			charges_enabled: true,
			payouts_enabled: true,
			details_submitted: true,
			requirements: {
				currently_due: [],
				eventually_due: [],
				past_due: [],
				disabled_reason: null,
			},
			capabilities: {
				card_payments: 'active',
				transfers: 'active',
			},
		});

		const refreshed = await json(await app.request(`/v1/commerce/vendors/${team.id}/stripe/status?refresh=1`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(refreshed.payload).toMatchObject({
			accountStatus: 'enabled',
			onboardingStatus: 'completed',
			chargesEnabled: true,
			payoutsEnabled: true,
			detailsSubmitted: true,
			capabilities: {
				card_payments: 'active',
				transfers: 'active',
			},
		});

		const loginLink = await json(await app.request(`/v1/commerce/vendors/${team.id}/stripe/login-link`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		}));
		expect(loginLink.payload.loginUrl).toBe(`https://connect.stripe.test/dashboard/${stripeAccountId}`);

		const events = await json(await app.request(`/v1/commerce/governance-events?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(events.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: 'commerce_vendor.stripe_account.created' }),
			expect.objectContaining({ action: 'commerce_vendor.stripe_onboarding.started' }),
			expect.objectContaining({ action: 'commerce_vendor.stripe_onboarding.returned' }),
			expect.objectContaining({ action: 'commerce_vendor.stripe_status.synced' }),
			expect.objectContaining({ action: 'commerce_vendor.stripe_login_link.created' }),
		]));
		expect(JSON.stringify(events.payload)).not.toContain(loginLink.payload.loginUrl);
	}, 15_000);
});
