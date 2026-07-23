import { expect, json } from './api-harness.ts';

export async function verifyCommerceCatalogPublication(app: any, state: any) {
	const { team, ownerToken, adminToken, product, vendor, approvedProduct } = state;
	    const version = await json(await app.request(`/v1/commerce/products/${product.payload.id}/versions`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            version: '1.0.0',
	            artifactKey: 'teams/commerce-phase-2/artifacts/cooperative-starter-v1.zip',
	            manifestKey: 'teams/commerce-phase-2/manifests/cooperative-starter-v1.json',
	            integrity: 'sha256:test',
	        }),
	    }));
	    await app.request(`/v1/commerce/products/${product.payload.id}/versions/${version.payload.id}/submit`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({ reason: 'Version ready.' }),
	    });
	    const approvedVersion = await json(await app.request(`/v1/commerce/products/${product.payload.id}/versions/${version.payload.id}/approve`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${adminToken}`,
	        },
	        body: JSON.stringify({ reason: 'Version approved.' }),
	    }));
	    expect(approvedVersion.payload).toMatchObject({
	        status: 'approved',
	        catalogArtifactVersionId: expect.any(String),
	    });
	    const invalidOffer = await app.request('/v1/commerce/offers', {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            productId: product.payload.id,
	            mode: 'paid',
	            title: 'Legacy Paid Offer',
	        }),
	    });
	    expect(invalidOffer.status).toBe(400);
	    const offer = await json(await app.request('/v1/commerce/offers', {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            productId: product.payload.id,
	            productVersionId: version.payload.id,
	            mode: 'subscription_updates',
	            title: 'Cooperative Starter Updates',
	            termsSummary: 'Subscribers receive updates while active.',
	        }),
	    }));
	    expect(offer.payload).toMatchObject({
	        mode: 'subscription_updates',
	        status: 'draft',
	    });
	    expect(offer.payload).not.toHaveProperty('checkoutUrl');
	    const price = await json(await app.request(`/v1/commerce/offers/${offer.payload.id}/prices`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            amount: 2900,
	            currency: 'usd',
	            billingInterval: 'month',
	        }),
	    }));
	    expect(price.payload).toMatchObject({
	        amount: 2900,
	        priceVersion: 1,
	        status: 'draft',
	        stripePriceId: null,
	    });
	    const activatedPrice = await json(await app.request(`/v1/commerce/prices/${price.payload.id}/activate`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({ reason: 'Initial active display price.' }),
	    }));
	    expect(activatedPrice.payload).toMatchObject({
	        status: 'active',
	        priceVersion: 1,
	    });
	    const nextPrice = await json(await app.request(`/v1/commerce/offers/${offer.payload.id}/prices`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            amount: 3900,
	            currency: 'usd',
	            billingInterval: 'month',
	        }),
	    }));
	    expect(nextPrice.payload).toMatchObject({
	        amount: 3900,
	        priceVersion: 2,
	    });
	    await app.request(`/v1/commerce/offers/${offer.payload.id}/submit`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({ reason: 'Offer ready.' }),
	    });
	    const approvedOffer = await json(await app.request(`/v1/commerce/offers/${offer.payload.id}/approve`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${adminToken}`,
	        },
	        body: JSON.stringify({ reason: 'Offer approved.' }),
	    }));
	    expect(approvedOffer.payload).toMatchObject({
	        status: 'approved',
	        mode: 'subscription_updates',
	    });
	    const catalog = await json(await app.request('/v1/catalog?kind=template'));
	    expect(catalog.payload).toContainEqual(expect.objectContaining({
	        id: approvedProduct.payload.catalogItemId,
	        slug: 'cooperative-starter',
	        offerMode: 'subscription_updates',
	        metadata: expect.objectContaining({
	            commerceProductId: product.payload.id,
	            ownershipModel: 'cooperative_owned',
	        }),
	    }));
	    const marketplace = await json(await app.request('/v1/commerce/marketplace'));
	    expect(marketplace.payload.products).toContainEqual(expect.objectContaining({
	        id: product.payload.id,
	        title: 'Cooperative Starter',
	        vendorId: vendor.payload.id,
	        sellerTeamId: team.id,
	        ownershipModel: 'cooperative_owned',
	        buyerVisibleOwnershipSummary: 'Updated buyer-visible cooperative ownership.',
	        offers: expect.arrayContaining([
	            expect.objectContaining({
	                id: offer.payload.id,
	                mode: 'subscription_updates',
	                title: 'Cooperative Starter Updates',
	                priceId: activatedPrice.payload.id,
	                unitAmount: 2900,
	                currency: 'usd',
	            }),
	        ]),
	    }));
	    expect(JSON.stringify(marketplace.payload)).not.toContain('approvalEvidence');
	    expect(JSON.stringify(marketplace.payload)).not.toContain('Updated private contribution note.');
	    const marketplaceProduct = await json(await app.request(`/v1/commerce/marketplace/products/${product.payload.id}`));
	    expect(marketplaceProduct.payload).toMatchObject({
	        id: product.payload.id,
	        serviceRequestEligible: false,
	        checkoutEligible: true,
	        capacityListingId: null,
	    });
	    expect(marketplaceProduct.payload.stewardshipSummary).toEqual(expect.arrayContaining([
	        expect.objectContaining({ role: 'governance_steward' }),
	    ]));
	    const artifacts = await json(await app.request(`/v1/catalog/${approvedProduct.payload.catalogItemId}/artifacts`));
	    expect(artifacts.payload).toContainEqual(expect.objectContaining({
	        version: '1.0.0',
	        contentKey: 'teams/commerce-phase-2/artifacts/cooperative-starter-v1.zip',
	    }));
	    const events = await json(await app.request(`/v1/commerce/governance-events?teamId=${team.id}`, {
	        headers: { authorization: `Bearer ${ownerToken}` },
	    }));
	    expect(events.payload).toEqual(expect.arrayContaining([
	        expect.objectContaining({ action: 'vendor.request', nextState: 'submitted' }),
	        expect.objectContaining({ action: 'product.approve', nextState: 'approved' }),
	        expect.objectContaining({ action: 'offer.approve', nextState: 'approved' }),
	    ]));
}
