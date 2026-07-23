import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('syncs phase 4 commerce stripe product and price mirrors for approved vendor offers', async () => {
		const calls: Array<{ name: string; input: any }> = [];
		const stripeAccounts = new Map<string, any>();
		const stripeProducts = new Map<string, any>();
		const stripePrices = new Map<string, any>();
		const fakeStripeConnectService = {
			environment: 'test',
			async isConfigured() {
				return true;
			},
			async createExpressAccount({ vendor }: any) {
				const account = {
					id: `acct_${vendor.id}`,
					charges_enabled: true,
					payouts_enabled: true,
					details_submitted: true,
					requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
					capabilities: { card_payments: 'active', transfers: 'active' },
				};
				stripeAccounts.set(account.id, account);
				return account;
			},
			async createOnboardingLink({ stripeAccountId }: any) {
				return { url: `https://connect.stripe.test/onboarding/${stripeAccountId}` };
			},
			async retrieveAccount(stripeAccountId: string) {
				return stripeAccounts.get(stripeAccountId);
			},
			async createLoginLink(stripeAccountId: string) {
				return { url: `https://connect.stripe.test/dashboard/${stripeAccountId}` };
			},
			async createProductMirror(input: any) {
				calls.push({ name: 'createProductMirror', input });
				const product = {
					id: `prod_${stripeProducts.size + 1}`,
					...input.params,
				};
				stripeProducts.set(product.id, product);
				return product;
			},
			async updateProductMirror(input: any) {
				calls.push({ name: 'updateProductMirror', input });
				const existing = stripeProducts.get(input.stripeProductId) ?? { id: input.stripeProductId };
				const product = { ...existing, ...input.params };
				stripeProducts.set(product.id, product);
				return product;
			},
			async retrieveProductMirror({ stripeProductId }: any) {
				return stripeProducts.get(stripeProductId);
			},
			async createPriceMirror(input: any) {
				calls.push({ name: 'createPriceMirror', input });
				const price = {
					id: `price_${stripePrices.size + 1}`,
					unit_amount: input.params.unit_amount,
					currency: input.params.currency,
					recurring: input.params.recurring ?? null,
					lookup_key: input.params.lookup_key,
					metadata: input.params.metadata,
				};
				stripePrices.set(price.id, price);
				return price;
			},
			async updatePriceMirror(input: any) {
				calls.push({ name: 'updatePriceMirror', input });
				const existing = stripePrices.get(input.stripePriceId) ?? { id: input.stripePriceId };
				const price = { ...existing, ...input.params };
				stripePrices.set(price.id, price);
				return price;
			},
			async retrievePriceMirror({ stripePriceId }: any) {
				return stripePrices.get(stripePriceId);
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
			body: JSON.stringify({ namespace: 'commerce-phase-4' }),
		}));
		const team = seeded.payload.fixtures.team;
		const ownerToken = seeded.payload.actors.teamOwner.accessToken;
		const adminToken = seeded.payload.actors.marketSteward.accessToken;

		const vendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({ displayName: 'Phase 4 Vendor', slug: 'phase-4-vendor' }),
		}));
		await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({ trustLevel: 'verified_seller', salesEnabled: true }),
		});
		await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/vendors/${team.id}/stripe/status?refresh=1`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		});

		const product = await json(await app.request('/v1/commerce/products', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				sellerTeamId: team.id,
				kind: 'template',
				slug: 'phase-4-template',
				title: 'Phase 4 Template',
				summary: 'Template with Stripe mirrors.',
				visibility: 'public',
				ownershipModel: 'cooperative_owned',
				ownership: {
					model: 'cooperative_owned',
					canonicalOwnerType: 'cooperative',
					canonicalOwnerId: 'coop-phase-4',
					publicSummary: 'Cooperatively governed.',
				},
			}),
		}));
		await app.request(`/v1/commerce/products/${product.payload.id}/submit`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/products/${product.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({}),
		});
		const offer = await json(await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				productId: product.payload.id,
				mode: 'subscription_updates',
				title: 'Phase 4 Updates',
				termsSummary: 'Subscribers receive cooperative updates.',
			}),
		}));
		const price = await json(await app.request(`/v1/commerce/offers/${offer.payload.id}/prices`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				amount: 4900,
				currency: 'usd',
				billingInterval: 'month',
				stripePriceId: 'price_client_supplied_should_be_ignored',
			}),
		}));
		expect(price.payload.stripePriceId).toBeNull();
		await app.request(`/v1/commerce/offers/${offer.payload.id}/submit`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		});
		const approvedOffer = await json(await app.request(`/v1/commerce/offers/${offer.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({}),
		}));
		expect(approvedOffer.payload).toMatchObject({
			status: 'approved',
			stripeProductStatus: 'synced',
			stripeProductId: expect.stringMatching(/^prod_/u),
		});
		expect(calls).toContainEqual(expect.objectContaining({
			name: 'createProductMirror',
			input: expect.objectContaining({
				connectedAccountId: expect.stringMatching(/^acct_/u),
				params: expect.objectContaining({
					metadata: expect.objectContaining({
						treeseed_product_id: product.payload.id,
						treeseed_offer_id: offer.payload.id,
						treeseed_ownership_model: 'cooperative_owned',
						treeseed_object_authority: 'treeseed',
					}),
				}),
			}),
		}));

		const activated = await json(await app.request(`/v1/commerce/prices/${price.payload.id}/activate`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		}));
		expect(activated.payload).toMatchObject({
			status: 'active',
			stripeSyncStatus: 'synced',
			stripePriceId: expect.stringMatching(/^price_/u),
			stripeLookupKey: `treeseed_test_${price.payload.id}_v1`,
		});
		const priceCall = calls.find((call) => call.name === 'createPriceMirror');
		expect(priceCall).toMatchObject({
			input: {
				connectedAccountId: expect.stringMatching(/^acct_/u),
				params: expect.objectContaining({
					unit_amount: 4900,
					currency: 'usd',
					recurring: { interval: 'month' },
					metadata: expect.objectContaining({
						treeseed_price_id: price.payload.id,
						treeseed_price_version: '1',
						treeseed_ownership_model: 'cooperative_owned',
					}),
				}),
			},
		});

		stripePrices.set(activated.payload.stripePriceId, {
			id: activated.payload.stripePriceId,
			unit_amount: 9900,
			currency: 'usd',
			recurring: { interval: 'month' },
			lookup_key: activated.payload.stripeLookupKey,
			metadata: {},
		});
		const drifted = await json(await app.request(`/v1/commerce/prices/${price.payload.id}/stripe/reconcile`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		}));
		expect(drifted.payload.price).toMatchObject({
			stripeSyncStatus: 'drifted',
			stripeSyncError: expect.stringContaining('immutable terms'),
		});

		const status = await json(await app.request(`/v1/commerce/offers/${offer.payload.id}/stripe/status`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(status.payload.offer.stripeProductStatus).toBe('synced');
		expect(status.payload.prices).toContainEqual(expect.objectContaining({
			id: price.payload.id,
			stripeSyncStatus: 'drifted',
		}));
		const events = await json(await app.request(`/v1/commerce/governance-events?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(events.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: 'commerce_offer.stripe_product.synced' }),
			expect.objectContaining({ action: 'commerce_price.stripe_price.synced' }),
			expect.objectContaining({ action: 'commerce_price.stripe_price.drifted' }),
		]));
		expect(JSON.stringify({ status, events })).not.toContain('sk_test');
	}, 20_000);
});
