import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('runs phase 8 commerce scoped services request quote contract checkout and fulfillment', async () => {
		const stripeAccounts = new Map<string, any>();
		const stripeProducts = new Map<string, any>();
		const paymentIntents = new Map<string, any>();
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
			async createPaymentIntent(input: any) {
				const paymentIntent = {
					id: `pi_service_${paymentIntents.size + 1}`,
					status: 'requires_payment_method',
					client_secret: `pi_service_secret_${paymentIntents.size + 1}`,
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
			body: JSON.stringify({ namespace: 'commerce-phase-8' }),
		}));
		const team = seeded.payload.fixtures.team;
		const ownerToken = seeded.payload.actors.teamOwner.accessToken;
		const adminToken = seeded.payload.actors.marketSteward.accessToken;

		const vendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ displayName: 'Scoped Service Vendor', slug: 'scoped-service-vendor' }),
		}));
		await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({
				trustLevel: 'trusted_service_vendor',
				salesEnabled: true,
				serviceSalesEnabled: true,
			}),
		});
		await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/vendors/${team.id}/stripe/status?refresh=1`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		});

		const product = await json(await app.request('/v1/commerce/products', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				sellerTeamId: team.id,
				kind: 'scoped_service',
				slug: 'cooperative-service',
				title: 'Cooperative Service',
				summary: 'Scoped service with governed quotes.',
				visibility: 'public',
				ownershipModel: 'cooperative_owned',
				ownership: {
					model: 'cooperative_owned',
					canonicalOwnerType: 'cooperative',
					canonicalOwnerId: 'coop-service-phase-8',
					publicSummary: 'Service governed by cooperative stewards.',
				},
			}),
		}));
		await app.request(`/v1/commerce/products/${product.payload.id}/stewards`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				role: 'governance_steward',
				assigneeType: 'team',
				assigneeId: team.id,
				displayName: 'Service Governance Steward',
			}),
		});
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
		const offer = await json(await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: product.payload.id,
				mode: 'scoped_contract',
				title: 'Scoped service contract',
				termsSummary: 'Quote-driven scoped service.',
				accessScope: { service: 'governed_scope' },
			}),
		}));
		await app.request(`/v1/commerce/offers/${offer.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/offers/${offer.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({}),
		});

		const invalidProduct = await json(await app.request('/v1/commerce/products', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				sellerTeamId: team.id,
				kind: 'template',
				slug: 'not-a-service',
				title: 'Not a Service',
				summary: 'Template product.',
				visibility: 'public',
			}),
		}));
		const invalidOffer = await json(await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: invalidProduct.payload.id,
				mode: 'scoped_contract',
				title: 'Invalid service offer',
			}),
		}));
		const invalidRequest = await app.request('/v1/commerce/services/requests', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ offerId: invalidOffer.payload.id, requestedScope: 'Should fail.' }),
		});
		expect(invalidRequest.status).toBe(409);

		const serviceRequest = await json(await app.request('/v1/commerce/services/requests', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				buyerTeamId: team.id,
				offerId: offer.payload.id,
				requestedScope: 'Scope a migration with cooperative governance review.',
				accessNeeds: { repository: 'read', secrets: 'explicit-review-required' },
				relatedProjectId: 'project-reference-only',
				amount: 1,
				stripePriceId: 'price_client_spoof',
			}),
		}));
		expect(serviceRequest.payload).toMatchObject({
			status: 'requested',
			vendorId: vendor.payload.id,
			sellerTeamId: team.id,
			productId: product.payload.id,
			offerId: offer.payload.id,
			ownershipSnapshot: expect.objectContaining({
				ownershipModel: 'cooperative_owned',
				stewards: expect.arrayContaining([
					expect.objectContaining({ role: 'governance_steward' }),
				]),
			}),
		});
		expect(serviceRequest.payload).not.toHaveProperty('stripePriceId');

		await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}/scoping`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ reason: 'Begin seller scoping.' }),
		});
		const scopedRequest = await json(await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				approvedScope: 'Approved migration scope.',
				buyerVisibleSummary: 'Governed migration support.',
				vendorPrivateNotes: 'Seller-only operational note.',
			}),
		}));
		expect(scopedRequest.payload).toMatchObject({
			status: 'scoping',
			approvedScope: 'Approved migration scope.',
			vendorPrivateNotes: 'Seller-only operational note.',
		});

		const quote = await json(await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}/quotes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				title: 'Scoped migration quote',
				scopeSummary: 'Migration support with explicit access review.',
				deliverables: [{ name: 'Migration plan' }],
				assumptions: [{ name: 'Buyer grants reviewed repository access' }],
				accessRequirements: { repository: 'read' },
				governanceRequirements: { review: 'seller_steward' },
				amount: 12500,
				currency: 'usd',
			}),
		}));
		expect(quote.payload).toMatchObject({
			status: 'draft',
			quoteVersion: 1,
			amount: 12500,
			currency: 'usd',
		});
		const secondQuote = await json(await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}/quotes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				title: 'Scoped migration quote revision',
				scopeSummary: 'Revised migration support.',
				amount: 13000,
				currency: 'usd',
			}),
		}));
		expect(secondQuote.payload.quoteVersion).toBe(2);
		const invalidQuote = await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}/quotes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				title: 'Invalid quote',
				scopeSummary: 'Invalid.',
				amount: 0,
				currency: 'US',
			}),
		});
		expect(invalidQuote.status).toBe(400);
		await app.request(`/v1/commerce/services/quotes/${secondQuote.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		const rejected = await json(await app.request(`/v1/commerce/services/quotes/${secondQuote.payload.id}/reject`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ reason: 'Buyer rejected revision.' }),
		}));
		expect(rejected.payload.status).toBe('rejected');
		const finalQuote = await json(await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}/quotes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				title: 'Accepted scoped migration quote',
				scopeSummary: 'Accepted migration support with explicit access review.',
				deliverables: [{ name: 'Migration plan' }],
				assumptions: [{ name: 'Buyer grants reviewed repository access' }],
				accessRequirements: { repository: 'read' },
				governanceRequirements: { review: 'seller_steward' },
				amount: 12500,
				currency: 'usd',
			}),
		}));
		expect(finalQuote.payload.quoteVersion).toBe(3);

		await app.request(`/v1/commerce/services/quotes/${finalQuote.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/services/quotes/${finalQuote.payload.id}/buyer-approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		const accepted = await json(await app.request(`/v1/commerce/services/quotes/${finalQuote.payload.id}/vendor-approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		}));
		expect(accepted.payload.quote).toMatchObject({
			status: 'accepted',
			acceptedAt: expect.any(String),
		});
		expect(accepted.payload.contract).toMatchObject({
			status: 'pending_checkout',
			amount: 12500,
			currency: 'usd',
		});

		const bypass = await app.request('/v1/commerce/checkout', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ buyerTeamId: team.id, items: [{ offerId: offer.payload.id, quantity: 1 }] }),
		});
		expect(bypass.status).toBe(409);

		const checkout = await json(await app.request(`/v1/commerce/services/contracts/${accepted.payload.contract.id}/checkout`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ amount: 1 }),
		}));
		expect(checkout.payload.checkout.status).toBe('requires_confirmation');
		expect(checkout.payload.paymentGroups).toEqual([
			expect.objectContaining({
				groupKind: 'one_time',
				totalAmount: 12500,
				clientSecret: expect.stringMatching(/^pi_service_secret_/u),
			}),
		]);
		const paymentGroup = checkout.payload.paymentGroups[0];
		const paymentIntent = paymentIntents.get(paymentGroup.stripePaymentIntentId);
		expect(paymentIntent).toMatchObject({
			amount: 12500,
			currency: 'usd',
			connectedAccountId: expect.stringMatching(/^acct_/u),
			metadata: expect.objectContaining({
				treeseed_service_request_id: serviceRequest.payload.id,
				treeseed_service_quote_id: finalQuote.payload.id,
				treeseed_service_contract_id: accepted.payload.contract.id,
				treeseed_product_id: product.payload.id,
			}),
		});
		expect(JSON.stringify(checkout.payload)).not.toContain('sk_test');

		paymentIntents.set(paymentGroup.stripePaymentIntentId, {
			...paymentIntent,
			status: 'succeeded',
		});
		const webhook = await json(await app.request('/v1/commerce/webhooks/stripe', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'stripe-signature': 'valid_signature',
			},
			body: JSON.stringify({
				id: 'evt_phase_8_payment_success',
				type: 'payment_intent.succeeded',
				account: paymentGroup.connectedAccountId,
				data: {
					object: {
						id: paymentGroup.stripePaymentIntentId,
						object: 'payment_intent',
						status: 'succeeded',
						metadata: paymentIntent.metadata,
					},
				},
			}),
		}));
		expect(webhook.payload.status).toBe('processed');
		const activatedContract = await json(await app.request(`/v1/commerce/services/contracts/${accepted.payload.contract.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(activatedContract.payload).toMatchObject({
			status: 'active',
			orderId: checkout.payload.orders[0].id,
			paymentGroupId: paymentGroup.id,
			entitlementId: expect.any(String),
		});
		const activeRequest = await json(await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(activeRequest.payload.request).toMatchObject({
			status: 'active',
			contractId: accepted.payload.contract.id,
			entitlementId: activatedContract.payload.entitlementId,
		});

		const linked = await json(await app.request(`/v1/commerce/services/contracts/${accepted.payload.contract.id}/link-work`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ relatedProjectId: 'project-link-only', relatedWorkdayId: 'workday-link-only' }),
		}));
		expect(linked.payload).toMatchObject({
			relatedProjectId: 'project-link-only',
			relatedWorkdayId: 'workday-link-only',
		});
		const fulfilled = await json(await app.request(`/v1/commerce/services/contracts/${accepted.payload.contract.id}/fulfill`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				summary: 'Scoped service delivered.',
				artifactRefs: [{ key: 'service-delivery-note' }],
				deliveryRefs: [{ href: '/services/delivery/reference' }],
			}),
		}));
		expect(fulfilled.payload.contract).toMatchObject({ status: 'fulfilled', fulfillmentSummary: 'Scoped service delivered.' });
		const fulfilledRequest = await json(await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(fulfilledRequest.payload.request.status).toBe('fulfilled');
		expect(fulfilled.payload.event).toMatchObject({
			status: 'delivered',
			eventType: 'artifact_delivered',
			entitlementId: activatedContract.payload.entitlementId,
		});

		const events = await json(await app.request(`/v1/commerce/services/events?requestId=${serviceRequest.payload.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(events.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ eventType: 'requested' }),
			expect.objectContaining({ eventType: 'quote_created' }),
			expect.objectContaining({ eventType: 'quote_buyer_approved' }),
			expect.objectContaining({ eventType: 'quote_vendor_approved' }),
			expect.objectContaining({ eventType: 'checkout_created' }),
			expect.objectContaining({ eventType: 'contract_activated' }),
			expect.objectContaining({ eventType: 'work_linked' }),
			expect.objectContaining({ eventType: 'fulfilled' }),
		]));
		const governance = await json(await app.request(`/v1/commerce/governance-events?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(governance.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: 'commerce_service.requested' }),
			expect.objectContaining({ action: 'commerce_service.contract_activated' }),
			expect.objectContaining({ action: 'commerce_service.fulfilled' }),
		]));
		const serialized = JSON.stringify({ checkout, activeRequest, fulfilled, events, governance });
		expect(serialized).not.toContain('sk_test');
		expect(serialized).not.toContain('card');
		expect(serialized).not.toContain('applicationFee');
		expect(serialized).not.toContain('revenueSplit');
		expect(serialized).not.toContain('capacityCredit');

		const legacyPaid = await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: product.payload.id,
				mode: 'paid',
				title: 'Legacy paid scoped service',
			}),
		});
		expect(legacyPaid.status).toBe(400);
	}, 25_000);
});
