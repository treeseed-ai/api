import { expect, json } from './api-harness.ts';

export async function verifyCommerceGovernanceSetup(app: any) {
	    const seeded = await json(await app.request('/v1/acceptance/seed', {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            'x-treeseed-service-id': 'web',
	            'x-treeseed-service-secret': 'web-test-secret',
	        },
	        body: JSON.stringify({ namespace: 'commerce-phase-2' }),
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
	        body: JSON.stringify({
	            displayName: 'Cooperative Commerce Team',
	            slug: 'cooperative-commerce-team',
	            reason: 'Request marketplace seller capability.',
	        }),
	    }));
	    expect(vendor.payload).toMatchObject({
	        teamId: team.id,
	        status: 'submitted',
	        trustLevel: 'public_publisher',
	        salesEnabled: false,
	    });
	    const deniedApproval = await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({ trustLevel: 'verified_seller' }),
	    });
	    expect(deniedApproval.status).toBe(403);
	    const approvedVendor = await json(await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${adminToken}`,
	        },
	        body: JSON.stringify({
	            trustLevel: 'verified_seller',
	            salesEnabled: true,
	            reason: 'Seller governance review passed.',
	        }),
	    }));
	    expect(approvedVendor.payload).toMatchObject({
	        status: 'approved',
	        trustLevel: 'verified_seller',
	        salesEnabled: true,
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
	            slug: 'cooperative-starter',
	            title: 'Cooperative Starter',
	            summary: 'A starter product with cooperative ownership.',
	            visibility: 'public',
	            ownershipModel: 'cooperative_owned',
	            ownership: {
	                model: 'cooperative_owned',
	                canonicalOwnerType: 'cooperative',
	                canonicalOwnerId: 'coop-commerce-phase-2',
	                publicSummary: 'Owned by the cooperative contributor group.',
	            },
	            metadata: { cooperativeGovernance: true },
	        }),
	    }));
	    expect(product.payload).toMatchObject({
	        sellerTeamId: team.id,
	        status: 'draft',
	        visibility: 'public',
	        ownershipModel: 'cooperative_owned',
	    });
	    const ownership = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership`, {
	        headers: { authorization: `Bearer ${ownerToken}` },
	    }));
	    expect(ownership.payload[0]).toMatchObject({
	        model: 'cooperative_owned',
	        buyerVisible: true,
	    });
	    const steward = await json(await app.request(`/v1/commerce/products/${product.payload.id}/stewards`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            role: 'governance_steward',
	            assigneeType: 'team',
	            assigneeId: team.id,
	            responsibilities: ['review product changes', 'maintain cooperative policy'],
	        }),
	    }));
	    expect(steward.payload).toMatchObject({
	        role: 'governance_steward',
	        visibleToBuyers: true,
	    });
	    const contribution = await json(await app.request(`/v1/commerce/products/${product.payload.id}/contributions`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            contributorType: 'team',
	            contributorId: team.id,
	            role: 'knowledge_curator',
	            summary: 'Prepared the starter project knowledge.',
	            benefitWeight: 0.6,
	        }),
	    }));
	    expect(contribution.payload).toMatchObject({
	        role: 'knowledge_curator',
	        benefitWeight: 0.6,
	    });
	    expect(contribution.payload).not.toHaveProperty('payoutAccountId');
	    const policy = await json(await app.request(`/v1/commerce/products/${product.payload.id}/governance-policy`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            policyKind: 'cooperative',
	            title: 'Cooperative Listing Policy',
	            approvalRules: { productApproval: 'market_steward' },
	            quorumRules: { contributorConsent: 'majority' },
	            buyerVisibleSummary: 'Material changes require cooperative review.',
	            status: 'active',
	        }),
	    }));
	    expect(policy.payload).toMatchObject({
	        policyKind: 'cooperative',
	        status: 'active',
	    });
	    const updatedOwnership = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership/${ownership.payload[0].id}`, {
	        method: 'PATCH',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            publicSummary: 'Updated buyer-visible cooperative ownership.',
	            buyerVisible: true,
	            reason: 'Clarify ownership summary.',
	        }),
	    }));
	    expect(updatedOwnership.payload).toMatchObject({
	        publicSummary: 'Updated buyer-visible cooperative ownership.',
	        buyerVisible: true,
	    });
	    const updatedSteward = await json(await app.request(`/v1/commerce/products/${product.payload.id}/stewards/${steward.payload.id}`, {
	        method: 'PATCH',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            displayName: 'Cooperative Governance Steward',
	            responsibilities: ['review product changes', 'maintain cooperative policy', 'publish buyer-visible governance'],
	            visibleToBuyers: true,
	            reason: 'Clarify stewardship.',
	        }),
	    }));
	    expect(updatedSteward.payload).toMatchObject({
	        displayName: 'Cooperative Governance Steward',
	        visibleToBuyers: true,
	    });
	    const endedSteward = await json(await app.request(`/v1/commerce/products/${product.payload.id}/stewards/${steward.payload.id}/end`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({ reason: 'Rotate steward assignment.' }),
	    }));
	    expect(endedSteward.payload.endsAt).toEqual(expect.any(String));
	    const updatedContribution = await json(await app.request(`/v1/commerce/products/${product.payload.id}/contributions/${contribution.payload.id}`, {
	        method: 'PATCH',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            summary: 'Updated private contribution note.',
	            attributionVisibility: 'private',
	            benefitWeight: 0.75,
	            reason: 'Contributor requested private attribution.',
	        }),
	    }));
	    expect(updatedContribution.payload).toMatchObject({
	        attributionVisibility: 'private',
	        benefitWeight: 0.75,
	    });
	    expect(updatedContribution.payload).not.toHaveProperty('payoutAccountId');
	    expect(updatedContribution.payload).not.toHaveProperty('revenueShare');
	    const updatedPolicy = await json(await app.request(`/v1/commerce/products/${product.payload.id}/governance-policy/${policy.payload.id}`, {
	        method: 'PATCH',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            title: 'Updated Cooperative Listing Policy',
	            buyerVisibleSummary: 'Updated material changes require cooperative review.',
	            status: 'active',
	            reason: 'Policy summary update.',
	        }),
	    }));
	    expect(updatedPolicy.payload).toMatchObject({
	        title: 'Updated Cooperative Listing Policy',
	        buyerVisibleSummary: 'Updated material changes require cooperative review.',
	    });
	    const secondOwnership = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            model: 'community_governed',
	            canonicalOwnerType: 'community',
	            canonicalOwnerId: 'community-commerce-phase-2',
	            publicSummary: 'Community governed successor ownership.',
	        }),
	    }));
	    const productWithSecondOwnership = await json(await app.request(`/v1/commerce/products/${product.payload.id}`, {
	        headers: { authorization: `Bearer ${ownerToken}` },
	    }));
	    expect(productWithSecondOwnership.payload.ownershipRecordId).toBe(secondOwnership.payload.id);
	    const transfer = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership-transfer`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            fromOwnershipRecordId: secondOwnership.payload.id,
	            toOwnershipRecordId: ownership.payload[0].id,
	            reason: 'Return ownership to the cooperative.',
	            approvalEvidence: { proposal: 'phase-7-transfer' },
	        }),
	    }));
	    expect(transfer.payload).toMatchObject({
	        status: 'draft',
	        fromOwnershipRecordId: secondOwnership.payload.id,
	        toOwnershipRecordId: ownership.payload[0].id,
	    });
	    const productBeforeTransferApproval = await json(await app.request(`/v1/commerce/products/${product.payload.id}`, {
	        headers: { authorization: `Bearer ${ownerToken}` },
	    }));
	    expect(productBeforeTransferApproval.payload.ownershipRecordId).toBe(secondOwnership.payload.id);
	    await app.request(`/v1/commerce/products/${product.payload.id}/ownership-transfer/${transfer.payload.id}/submit`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({ reason: 'Ready for transfer decision.' }),
	    });
	    const approvedTransfer = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership-transfer/${transfer.payload.id}/approve`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({ reason: 'Approved by cooperative steward.' }),
	    }));
	    expect(approvedTransfer.payload.status).toBe('approved');
	    const productAfterTransferApproval = await json(await app.request(`/v1/commerce/products/${product.payload.id}`, {
	        headers: { authorization: `Bearer ${ownerToken}` },
	    }));
	    expect(productAfterTransferApproval.payload.ownershipRecordId).toBe(ownership.payload[0].id);
	    const rejectedTransfer = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership-transfer`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            fromOwnershipRecordId: ownership.payload[0].id,
	            toOwnershipRecordId: secondOwnership.payload.id,
	            status: 'submitted',
	            reason: 'Rejected transfer exercise.',
	        }),
	    }));
	    await app.request(`/v1/commerce/products/${product.payload.id}/ownership-transfer/${rejectedTransfer.payload.id}/reject`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({ reason: 'Rejected by steward.' }),
	    });
	    const productAfterRejectedTransfer = await json(await app.request(`/v1/commerce/products/${product.payload.id}`, {
	        headers: { authorization: `Bearer ${ownerToken}` },
	    }));
	    expect(productAfterRejectedTransfer.payload.ownershipRecordId).toBe(ownership.payload[0].id);
	    const succession = await json(await app.request(`/v1/commerce/products/${product.payload.id}/succession-events`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({
	            successorType: 'team',
	            successorId: team.id,
	            eventType: 'successor_named',
	            reason: 'Name team as successor steward.',
	        }),
	    }));
	    expect(succession.payload).toMatchObject({
	        eventType: 'successor_named',
	        status: 'submitted',
	    });
	    const workflow = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership-workflow`, {
	        headers: { authorization: `Bearer ${ownerToken}` },
	    }));
	    expect(workflow.payload).toMatchObject({
	        productId: product.payload.id,
	        currentOwnershipRecord: expect.objectContaining({ id: ownership.payload[0].id }),
	    });
	    expect(workflow.payload.successionEvents).toContainEqual(expect.objectContaining({ id: succession.payload.id }));
	    const submittedProduct = await json(await app.request(`/v1/commerce/products/${product.payload.id}/submit`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${ownerToken}`,
	        },
	        body: JSON.stringify({ reason: 'Ready for marketplace review.' }),
	    }));
	    expect(submittedProduct.payload.status).toBe('submitted');
	    const approvedProduct = await json(await app.request(`/v1/commerce/products/${product.payload.id}/approve`, {
	        method: 'POST',
	        headers: {
	            'content-type': 'application/json',
	            authorization: `Bearer ${adminToken}`,
	        },
	        body: JSON.stringify({ reason: 'Approved for catalog listing.' }),
	    }));
	    expect(approvedProduct.payload).toMatchObject({
	        status: 'approved',
	        catalogItemId: expect.any(String),
	    });
	    const publicWorkflow = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership-workflow`));
	    expect(publicWorkflow.payload.currentOwnershipRecord).toMatchObject({
	        id: ownership.payload[0].id,
	        buyerVisible: true,
	    });
	    expect(publicWorkflow.payload.contributions).not.toContainEqual(expect.objectContaining({
	        id: contribution.payload.id,
	        attributionVisibility: 'private',
	    }));
	    expect(publicWorkflow.payload.pendingTransfers).toEqual([]);
	    expect(publicWorkflow.payload.successionEvents).toEqual([]);
	    const listedProducts = await json(await app.request('/v1/commerce/products?kind=template'));
	    expect(listedProducts.payload).toContainEqual(expect.objectContaining({
	        id: product.payload.id,
	        status: 'approved',
	    }));

	return { team, ownerToken, adminToken, product, vendor, approvedProduct };
}
