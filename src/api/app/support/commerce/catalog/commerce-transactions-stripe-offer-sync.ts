import { buildCommerceStripeMetadata,commerceStripeProductParams,commerceStripeSyncContext,STRIPE_PRODUCT_MIRROR_OFFER_MODES } from '../../index.ts';
export async function syncCommerceOfferStripeProduct({ store, stripeConnectService, offer, actorType = 'system', actorId = null, reconcile = false, throwOnBlocked = false, }) {
    const environment = stripeConnectService.environment ?? 'test';
    if (!STRIPE_PRODUCT_MIRROR_OFFER_MODES.has(offer.mode)) {
        return { offer, skipped: true, reason: 'Offer mode does not require a Stripe Product mirror.' };
    }
    const context = await commerceStripeSyncContext({ store, stripeConnectService, offer, environment });
    const block = async (reason) => {
        const updated = await store.markCommerceOfferStripeSyncBlocked(offer.id, {
            reason,
            actorType,
            actorId,
            evidence: { environment, vendorId: context.vendor?.id ?? null },
        });
        if (throwOnBlocked) {
            const error: Error & Record<string, any> = new Error(reason);
            error.status = 409;
            throw error;
        }
        return { offer: updated, blocked: true, reason };
    };
    if (!context.product || !context.vendor)
        return block('Commerce product or vendor was not found for Stripe Product sync.');
    if (context.vendor.status !== 'approved')
        return block('Commerce vendor approval is required before Stripe Product sync.');
    if (!await stripeConnectService.isConfigured())
        return block('Stripe Connect is not configured for this market.');
    if (!context.account)
        return block('Stripe connected account is not linked for this vendor.');
    if (context.account.accountStatus !== 'enabled')
        return block('Stripe connected account must be enabled before Product sync.');
    const metadata = buildCommerceStripeMetadata({ environment, ...context, offer });
    const params = commerceStripeProductParams({ product: context.product, offer, metadata });
    try {
        const stripeProduct = offer.stripeProductId
            ? await stripeConnectService.updateProductMirror({
                connectedAccountId: context.account.stripeAccountId,
                stripeProductId: offer.stripeProductId,
                params,
            })
            : await stripeConnectService.createProductMirror({
                connectedAccountId: context.account.stripeAccountId,
                params,
            });
        if (!stripeProduct?.id)
            return block('Stripe Product sync did not return a Product ID.');
        const updated = await store.updateCommerceOfferStripeProductSync(offer.id, {
            stripeProductId: stripeProduct.id,
            stripeProductStatus: 'synced',
            stripeProductMetadata: metadata,
            actorType,
            actorId,
            action: reconcile ? 'commerce_offer.stripe_product.reconciled' : 'commerce_offer.stripe_product.synced',
            evidence: {
                environment,
                stripeAccountId: context.account.stripeAccountId,
                stripeProductId: stripeProduct.id,
            },
        });
        return {
            offer: updated,
            product: context.product,
            vendor: context.vendor,
            connectedAccount: context.account,
            stripeProductId: stripeProduct.id,
            status: 'synced',
            reconciled: reconcile,
        };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'Stripe Product sync failed.');
        await store.updateCommerceOfferStripeProductSync(offer.id, {
            stripeProductStatus: 'failed',
            stripeProductSyncError: reason,
            actorType,
            actorId,
            action: 'commerce_offer.stripe_product.failed',
            reason,
            evidence: { environment, stripeAccountId: context.account.stripeAccountId },
        });
        if (throwOnBlocked)
            throw error;
        return { offer: await store.getCommerceOffer(offer.id), failed: true, reason };
    }
}
