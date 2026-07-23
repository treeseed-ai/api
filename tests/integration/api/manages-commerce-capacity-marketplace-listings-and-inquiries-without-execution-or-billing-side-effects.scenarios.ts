import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('manages commerce capacity marketplace listings and inquiries without execution or billing side effects', async () => {
		const app = createTestApp();
		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'commerce-phase-9' }),
		}));
		const team = seeded.payload.fixtures.team;
		const ownerToken = seeded.payload.actors.teamOwner.accessToken;
		const adminToken = seeded.payload.actors.marketSteward.accessToken;
		const viewerToken = seeded.payload.actors.teamViewer.accessToken;
		const nonMemberToken = seeded.payload.actors.nonMember.accessToken;

		const vendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ displayName: 'Capacity Cooperative', slug: 'capacity-cooperative' }),
		}));
		await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({
				trustLevel: 'trusted_capacity_vendor',
				capacityListingsEnabled: true,
				reason: 'Capacity trust review passed.',
			}),
		});

		const blockedVendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ displayName: 'Duplicate Capacity Request', slug: 'duplicate-capacity-request' }),
		}));
		const approvedVendor = await json(await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({
				trustLevel: 'trusted_capacity_vendor',
				capacityListingsEnabled: true,
			}),
		}));
		expect(blockedVendor.payload.id).toBe(vendor.payload.id);
		expect(approvedVendor.payload).toMatchObject({
			status: 'approved',
			trustLevel: 'trusted_capacity_vendor',
			capacityListingsEnabled: true,
		});

		const product = await json(await app.request('/v1/commerce/products', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				sellerTeamId: team.id,
				kind: 'capacity_listing',
				slug: 'capacity-foundation',
				title: 'Capacity Foundation',
				summary: 'Trust-gated capacity discovery.',
				visibility: 'public',
				ownershipModel: 'cooperative_owned',
				ownership: {
					model: 'cooperative_owned',
					canonicalOwnerType: 'cooperative',
					canonicalOwnerId: 'capacity-coop',
					publicSummary: 'Capacity listing governed by cooperative stewards.',
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
				displayName: 'Capacity Governance Steward',
			}),
		});

		const blockedCommercialOffer = await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: product.payload.id,
				mode: 'one_time',
				title: 'Blocked capacity checkout',
			}),
		});
		expect(blockedCommercialOffer.status).toBe(409);
		const legacyPaid = await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: product.payload.id,
				mode: 'paid',
				title: 'Legacy paid capacity',
			}),
		});
		expect(legacyPaid.status).toBe(400);
		const contactOffer = await json(await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: product.payload.id,
				mode: 'contact',
				title: 'Capacity inquiry',
				termsSummary: 'Discovery and seller review only.',
			}),
		}));
		expect(contactOffer.payload.mode).toBe('contact');

		const listing = await json(await app.request(`/v1/commerce/products/${product.payload.id}/capacity-listing`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				accessLevel: 'public_summary',
				runtimeIsolationLevel: 'tenant_isolated',
				humanInvolvementLevel: 'operator_assisted',
				aiInvolvementLevel: 'agentic',
				dataAccessLevel: 'project_scoped',
				secretAccessLevel: 'delegated_scoped',
				supportedServiceTypes: ['review', 'migration'],
				supportedRegions: ['us'],
				runtimeRequirements: { lane: 'review' },
				dataHandlingSummary: 'Project-scoped data only after explicit review.',
				buyerVisibleRiskSummary: 'Seller review required before any private data or secrets.',
				governanceRequirements: { review: 'market_admin_or_steward' },
				supportPolicy: 'Seller-assisted review.',
				availabilitySummary: 'Weekday review windows.',
				metadata: { privateNote: 'seller-only' },
				grantId: 'client-spoof',
				stripePriceId: 'price_spoof',
			}),
		}));
		expect(listing.payload).toMatchObject({
			status: 'draft',
			productId: product.payload.id,
			vendorId: vendor.payload.id,
			capacityProviderId: null,
			executionProviderId: null,
			ownershipSnapshot: expect.objectContaining({
				ownershipModel: 'cooperative_owned',
				stewards: expect.arrayContaining([
					expect.objectContaining({ role: 'governance_steward' }),
				]),
			}),
		});
		expect(listing.payload).not.toHaveProperty('grantId');
		expect(listing.payload).not.toHaveProperty('stripePriceId');

		const publicDraft = await app.request(`/v1/commerce/capacity-listings/${listing.payload.id}`);
		expect(publicDraft.status).toBe(404);

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
		await app.request(`/v1/commerce/capacity-listings/${listing.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		const approvedListing = await json(await app.request(`/v1/commerce/capacity-listings/${listing.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({ reason: 'Approved public capacity disclosure.' }),
		}));
		expect(approvedListing.payload.status).toBe('approved');

		const publicListing = await json(await app.request(`/v1/commerce/capacity-listings/${listing.payload.id}`));
		expect(publicListing.payload).toMatchObject({
			status: 'approved',
			accessLevel: 'public_summary',
			runtimeIsolationLevel: 'tenant_isolated',
			aiInvolvementLevel: 'agentic',
			humanInvolvementLevel: 'operator_assisted',
			dataAccessLevel: 'project_scoped',
			secretAccessLevel: 'delegated_scoped',
		});
		expect(publicListing.payload.capacityProviderId).toBeNull();
		expect(publicListing.payload.metadata).toEqual({});
		expect(publicListing.payload.governanceRequirements).toEqual({});
		const publicList = await json(await app.request('/v1/commerce/capacity-listings'));
		expect(publicList.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: listing.payload.id, status: 'approved' }),
		]));

		const inquiry = await json(await app.request(`/v1/commerce/capacity-listings/${listing.payload.id}/inquiries`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				buyerTeamId: team.id,
				requestedServiceType: 'migration',
				requestedScope: 'Evaluate capacity for a governed migration.',
				dataAccessRequested: { repository: 'read after review' },
				secretAccessRequested: { secrets: 'buyer managed' },
				relatedProjectId: 'project-disclosure-only',
				relatedWorkdayId: 'workday-disclosure-only',
				sellerTeamId: 'client-spoof',
				priceId: 'price-spoof',
				stripePaymentIntentId: 'pi_spoof',
				capacityGrantId: 'grant-spoof',
				capacityReservationId: 'reservation-spoof',
				executionCredential: 'secret-spoof',
			}),
		}));
		expect(inquiry.payload).toMatchObject({
			status: 'requested',
			listingId: listing.payload.id,
			productId: product.payload.id,
			vendorId: vendor.payload.id,
			sellerTeamId: team.id,
			buyerTeamId: team.id,
		});
		expect(inquiry.payload).not.toHaveProperty('priceId');
		expect(inquiry.payload).not.toHaveProperty('stripePaymentIntentId');
		expect(inquiry.payload).not.toHaveProperty('capacityGrantId');

		const readerList = await json(await app.request(`/v1/commerce/capacity-listing-inquiries?sellerTeamId=${encodeURIComponent(team.id)}`, {
			headers: { authorization: `Bearer ${viewerToken}` },
		}));
		expect(readerList.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: inquiry.payload.id }),
		]));
		const unrelatedRead = await app.request(`/v1/commerce/capacity-listing-inquiries/${inquiry.payload.id}`, {
			headers: { authorization: `Bearer ${nonMemberToken}` },
		});
		expect(unrelatedRead.status).toBe(403);

		const reviewing = await json(await app.request(`/v1/commerce/capacity-listing-inquiries/${inquiry.payload.id}/review`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ reason: 'Seller started review.' }),
		}));
		expect(reviewing.payload.status).toBe('reviewing');
		const approvedInquiry = await json(await app.request(`/v1/commerce/capacity-listing-inquiries/${inquiry.payload.id}/approve-for-scoping`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ reason: 'Approved for scoping discussion.' }),
		}));
		expect(approvedInquiry.payload.status).toBe('approved_for_scoping');

		const canceledAfterApproval = await app.request(`/v1/commerce/capacity-listing-inquiries/${inquiry.payload.id}/cancel`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		expect(canceledAfterApproval.status).toBe(409);

		const serviceRequests = await json(await app.request('/v1/commerce/services/requests', {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		const checkouts = await json(await app.request('/v1/commerce/orders', {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		const entitlements = await json(await app.request('/v1/commerce/entitlements', {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		const grants = await json(await app.request(`/v1/teams/${team.id}/capacity-grants`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(serviceRequests.payload).toEqual([]);
		expect(checkouts.payload).toEqual([]);
		expect(entitlements.payload).toEqual([]);
		expect(grants.payload).toEqual({ items: [], page: { limit: 50, hasMore: false, nextCursor: null } });

		const governance = await json(await app.request(`/v1/commerce/governance-events?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(governance.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: 'commerce_capacity_listing.created' }),
			expect.objectContaining({ action: 'commerce_capacity_listing.submitted' }),
			expect.objectContaining({ action: 'commerce_capacity_listing.approved' }),
			expect.objectContaining({ action: 'commerce_capacity_inquiry.created' }),
			expect.objectContaining({ action: 'commerce_capacity_inquiry.reviewing' }),
			expect.objectContaining({ action: 'commerce_capacity_inquiry.approved_for_scoping' }),
		]));
		const serialized = JSON.stringify({ approvedListing, publicListing, inquiry, approvedInquiry, governance });
		expect(serialized).not.toContain('sk_test');
		expect(serialized).not.toContain('client_secret');
		expect(serialized).not.toContain('card');
		expect(serialized).not.toContain('payout');
		expect(serialized).not.toContain('applicationFee');
		expect(serialized).not.toContain('commission');
		expect(serialized).not.toContain('revenueSplit');
		expect(serialized).not.toContain('providerToken');
		expect(serialized).not.toContain('capacityCredit');
		expect(serialized).not.toContain('grantToken');
		expect(serialized).not.toContain('executionCredential');
	}, 25_000);
});
