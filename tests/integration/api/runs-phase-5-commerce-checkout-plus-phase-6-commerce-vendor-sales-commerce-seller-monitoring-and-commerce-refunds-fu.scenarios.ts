import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('runs phase 5 commerce checkout plus phase 6 commerce vendor sales, commerce seller monitoring, and commerce refunds fulfillment', async () => {
		const stripeAccounts = new Map<string, any>();
		const stripeProducts = new Map<string, any>();
		const stripePrices = new Map<string, any>();
		const paymentIntents = new Map<string, any>();
		const refunds = new Map<string, any>();
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
			async createProductMirror(input: any) {
				const product = { id: `prod_${stripeProducts.size + 1}`, ...input.params };
				stripeProducts.set(product.id, product);
				return product;
			},
			async updateProductMirror(input: any) {
				const product = { ...(stripeProducts.get(input.stripeProductId) ?? { id: input.stripeProductId }), ...input.params };
				stripeProducts.set(product.id, product);
				return product;
			},
			async retrieveProductMirror({ stripeProductId }: any) {
				return stripeProducts.get(stripeProductId);
			},
			async createPriceMirror(input: any) {
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
				const price = { ...(stripePrices.get(input.stripePriceId) ?? { id: input.stripePriceId }), ...input.params };
				stripePrices.set(price.id, price);
				return price;
			},
			async retrievePriceMirror({ stripePriceId }: any) {
				return stripePrices.get(stripePriceId);
			},
			async createPaymentIntent(input: any) {
				const paymentIntent = {
					id: `pi_${paymentIntents.size + 1}`,
					status: 'requires_payment_method',
					client_secret: `pi_secret_${paymentIntents.size + 1}`,
					amount: input.params.amount,
					currency: input.params.currency,
					metadata: input.params.metadata,
					connectedAccountId: input.connectedAccountId,
				};
				paymentIntents.set(paymentIntent.id, paymentIntent);
				return paymentIntent;
			},
			async retrievePaymentIntent({ paymentIntentId }: any) {
				return paymentIntents.get(paymentIntentId);
			},
			async createRefund(input: any) {
				const refund = {
					id: `re_${refunds.size + 1}`,
					status: 'succeeded',
					amount: input.params.amount,
					payment_intent: input.params.payment_intent,
					metadata: input.params.metadata,
					connectedAccountId: input.connectedAccountId,
					idempotencyKey: input.idempotencyKey,
				};
				refunds.set(refund.id, refund);
				return refund;
			},
			async retrieveRefund({ refundId }: any) {
				return refunds.get(refundId);
			},
			async constructWebhookEvent({ payload, signature, webhookSecret }: any) {
				if (signature !== 'valid_signature' || webhookSecret !== 'whsec_test') {
					const error = new Error('Invalid Stripe webhook signature.');
					(error as any).status = 400;
					throw error;
				}
				return JSON.parse(payload);
			},
		};
		const app = createTestApp({
			stripeConnectService: fakeStripeConnectService,
			config: {
				stripePublishableKey: 'pk_test_tree',
				stripeWebhookSecret: 'whsec_test',
			},
		});
		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'commerce-phase-5' }),
		}));
		const team = seeded.payload.fixtures.team;
		const ownerToken = seeded.payload.actors.teamOwner.accessToken;
		const adminToken = seeded.payload.actors.marketSteward.accessToken;

		const stripeConfig = await json(await app.request('/v1/commerce/stripe/config', {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(stripeConfig.payload).toEqual({ publishableKey: 'pk_test_tree', environment: 'test' });

		const vendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ displayName: 'Phase 5 Vendor', slug: 'phase-5-vendor' }),
		}));
		await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({ trustLevel: 'verified_seller', salesEnabled: true }),
		});
		await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/vendors/${team.id}/stripe/status?refresh=1`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		});

		async function approvedProduct(slug: string, title: string) {
			const product = await json(await app.request('/v1/commerce/products', {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
				body: JSON.stringify({
					sellerTeamId: team.id,
					kind: 'template',
					slug,
					title,
					summary: `${title} summary`,
					visibility: 'public',
					ownershipModel: 'cooperative_owned',
					ownership: {
						model: 'cooperative_owned',
						canonicalOwnerType: 'cooperative',
						canonicalOwnerId: `coop-${slug}`,
						publicSummary: 'Cooperatively governed checkout product.',
					},
				}),
			}));
			await app.request(`/v1/commerce/products/${product.payload.id}/submit`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
				body: JSON.stringify({}),
			});
			await app.request(`/v1/commerce/products/${product.payload.id}/approve`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
				body: JSON.stringify({}),
			});
			return product.payload;
		}

		const freeProduct = await approvedProduct('phase-5-free', 'Phase 5 Free');
		const paidProduct = await approvedProduct('phase-5-paid', 'Phase 5 Paid');
		const freeOffer = await json(await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: freeProduct.id,
				mode: 'free',
				title: 'Free cooperative offer',
				accessScope: { artifact: 'free' },
			}),
		}));
		await app.request(`/v1/commerce/offers/${freeOffer.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/offers/${freeOffer.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({}),
		});
		const paidOffer = await json(await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: paidProduct.id,
				mode: 'one_time',
				title: 'One-time cooperative offer',
				accessScope: { artifact: 'paid' },
			}),
		}));
		const paidPrice = await json(await app.request(`/v1/commerce/offers/${paidOffer.payload.id}/prices`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ amount: 2500, currency: 'usd', billingInterval: 'one_time' }),
		}));
		await app.request(`/v1/commerce/offers/${paidOffer.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/offers/${paidOffer.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({}),
		});
		const activePrice = await json(await app.request(`/v1/commerce/prices/${paidPrice.payload.id}/activate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		}));
		expect(activePrice.payload).toMatchObject({ stripeSyncStatus: 'synced', stripePriceId: expect.stringMatching(/^price_/u) });

		const checkout = await json(await app.request('/v1/commerce/checkout', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				buyerTeamId: team.id,
				items: [
					{ offerId: freeOffer.payload.id, quantity: 1 },
					{ offerId: paidOffer.payload.id, priceId: activePrice.payload.id, quantity: 1, amount: 1, sellerTeamId: 'client-spoof' },
				],
			}),
		}));
		expect(checkout.payload.checkout).toMatchObject({
			status: 'partially_confirmed',
			groupCount: 2,
			completedGroupCount: 1,
		});
		expect(checkout.payload.paymentGroups).toEqual(expect.arrayContaining([
			expect.objectContaining({ groupKind: 'free', status: 'succeeded', clientSecret: null }),
			expect.objectContaining({ groupKind: 'one_time', status: 'requires_confirmation', clientSecret: expect.stringMatching(/^pi_secret_/u) }),
		]));
		expect(checkout.payload.entitlements).toContainEqual(expect.objectContaining({
			offerId: freeOffer.payload.id,
			status: 'active',
			ownershipSnapshot: expect.objectContaining({ ownershipModel: 'cooperative_owned' }),
		}));
		expect(JSON.stringify(checkout.payload)).not.toContain('sk_test');
		expect(JSON.stringify(checkout.payload)).not.toContain('applicationFee');
		const paidGroup = checkout.payload.paymentGroups.find((group: any) => group.groupKind === 'one_time');
		paymentIntents.set(paidGroup.stripePaymentIntentId, {
			...paymentIntents.get(paidGroup.stripePaymentIntentId),
			status: 'succeeded',
		});
		const webhookPayload = {
			id: 'evt_phase_5_payment_success',
			type: 'payment_intent.succeeded',
			account: paidGroup.connectedAccountId,
			data: {
				object: {
					id: paidGroup.stripePaymentIntentId,
					object: 'payment_intent',
					status: 'succeeded',
				},
			},
		};
		const webhook = await json(await app.request('/v1/commerce/webhooks/stripe', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'stripe-signature': 'valid_signature',
			},
			body: JSON.stringify(webhookPayload),
		}));
		expect(webhook.payload).toMatchObject({
			eventId: 'evt_phase_5_payment_success',
			status: 'processed',
		});
		const duplicateWebhook = await json(await app.request('/v1/commerce/webhooks/stripe', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'stripe-signature': 'valid_signature',
			},
			body: JSON.stringify(webhookPayload),
		}));
		expect(duplicateWebhook.payload.status).toBe('processed');

		const entitlements = await json(await app.request('/v1/commerce/entitlements?buyerTeamId=' + encodeURIComponent(team.id), {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(entitlements.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ offerId: freeOffer.payload.id, status: 'active' }),
			expect.objectContaining({ offerId: paidOffer.payload.id, status: 'active' }),
		]));
		expect(entitlements.payload.filter((entitlement: any) => entitlement.offerId === paidOffer.payload.id)).toHaveLength(1);

		const sellerSummary = await json(await app.request(`/v1/commerce/vendors/${team.id}/sales/summary`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(sellerSummary.payload).toMatchObject({
			vendorId: vendor.payload.id,
			sellerTeamId: team.id,
			paidOrderCount: 2,
			activeEntitlementCount: 2,
		});

		const sellerMonitor = await json(await app.request(`/v1/commerce/vendors/${team.id}/monitoring`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(sellerMonitor.payload).toMatchObject({
			vendorId: vendor.payload.id,
			sellerTeamId: team.id,
			stripeReady: true,
			pendingFulfillmentCount: expect.any(Number),
			failedRefundCount: 0,
			failedWebhookCount: expect.any(Number),
			recentGovernanceEvents: expect.any(Array),
		});
		expect(JSON.stringify(sellerMonitor.payload)).not.toContain('client_secret');
		const unrelatedMonitor = await app.request(`/v1/commerce/vendors/${team.id}/monitoring`, {
			headers: { authorization: `Bearer ${seeded.payload.actors.nonMember.accessToken}` },
		});
		expect(unrelatedMonitor.status).toBe(403);

		const sellerOrders = await json(await app.request(`/v1/commerce/vendors/${team.id}/sales/orders`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(sellerOrders.payload[0]).toMatchObject({
			buyerTeamId: team.id,
			buyerUserIdRedacted: expect.anything(),
		});
		expect(JSON.stringify(sellerOrders.payload)).not.toContain('email');

		const paidOrder = checkout.payload.orders.find((order: any) => order.stripePaymentIntentId === paidGroup.stripePaymentIntentId);
		const paidOrderDetail = await json(await app.request(`/v1/commerce/orders/${paidOrder.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		const paidOrderItem = paidOrderDetail.payload.items.find((item: any) => item.offerId === paidOffer.payload.id);
		const fulfillment = await json(await app.request(`/v1/commerce/order-items/${paidOrderItem.id}/fulfillment/artifact`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ artifactRefs: [{ key: 'manual-artifact' }], message: 'Delivered from test.' }),
		}));
		expect(fulfillment.payload.event).toMatchObject({
			orderItemId: paidOrderItem.id,
			status: 'delivered',
			eventType: 'artifact_delivered',
		});
		const fulfillmentEvents = await json(await app.request(`/v1/commerce/vendors/${team.id}/sales/fulfillment-events`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(fulfillmentEvents.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ orderItemId: paidOrderItem.id, status: 'delivered' }),
		]));

		const refund = await json(await app.request(`/v1/commerce/orders/${paidOrder.id}/refunds`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ orderItemId: paidOrderItem.id, amount: 2500, reason: 'test refund', idempotencyKey: 'phase-6-refund-key' }),
		}));
		expect(refund.payload.refund).toMatchObject({
			orderId: paidOrder.id,
			orderItemId: paidOrderItem.id,
			status: 'succeeded',
			amount: 2500,
			stripeRefundId: expect.stringMatching(/^re_/u),
		});
		expect(refunds.get(refund.payload.refund.stripeRefundId)).toMatchObject({
			connectedAccountId: paidGroup.connectedAccountId,
			idempotencyKey: 'phase-6-refund-key',
		});
		const duplicateRefund = await json(await app.request(`/v1/commerce/orders/${paidOrder.id}/refunds`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ orderItemId: paidOrderItem.id, amount: 2500, idempotencyKey: 'phase-6-refund-key' }),
		}));
		expect(duplicateRefund.payload.id ?? duplicateRefund.payload.refund?.id).toBe(refund.payload.refund.id);
		const salesRefunds = await json(await app.request(`/v1/commerce/vendors/${team.id}/sales/refunds`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(salesRefunds.payload).toContainEqual(expect.objectContaining({ id: refund.payload.refund.id, status: 'succeeded' }));

		const revoked = await json(await app.request(`/v1/commerce/entitlements/${paidOrderItem.entitlementId}/revoke`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ reason: 'test revocation' }),
		}));
		expect(revoked.payload).toMatchObject({ id: paidOrderItem.entitlementId, status: 'revoked' });

		const invalidWebhook = await app.request('/v1/commerce/webhooks/stripe', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'stripe-signature': 'invalid_signature',
			},
			body: JSON.stringify({ id: 'evt_invalid', type: 'unknown', data: { object: {} } }),
		});
		expect(invalidWebhook.status).toBe(400);
	}, 25_000);
});
