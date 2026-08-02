import { buildCommerceStripeMetadata,commerceStripeLookupKey,commerceStripePriceParams,commerceStripeSyncContext,STRIPE_PRICE_MIRROR_OFFER_MODES,stripePriceTermsDrift,syncCommerceOfferStripeProduct } from '../../index.ts';
export async function syncCommercePriceStripePrice({ store, stripeConnectService, price, actorType = 'system', actorId = null, reconcile = false, throwOnBlocked = false, }) {
    const offer = await store.getCommerceOffer(price.offerId);
    const environment = stripeConnectService.environment ?? 'test';
    const block = async (reason) => {
        const updated = await store.markCommercePriceStripeSyncBlocked(price.id, {
            reason,
            actorType,
            actorId,
            evidence: { environment, offerId: offer?.id ?? null },
        });
        if (throwOnBlocked) {
            const error: Error & Record<string, any> = new Error(reason);
            error.status = 409;
            throw error;
        }
        return { price: updated, blocked: true, reason };
    };
    if (!offer)
        return block('Commerce offer was not found for Stripe Price sync.');
    if (!STRIPE_PRICE_MIRROR_OFFER_MODES.has(offer.mode)) {
        if (offer.mode === 'scoped_contract')
            return block('Scoped contract Stripe Price sync is deferred until scoped service checkout.');
        return { price, skipped: true, reason: 'Offer mode does not require a Stripe Price mirror.' };
    }
    if (price.billingInterval === 'custom')
        return block('Custom billing intervals are not supported by Phase 4 Stripe Price sync.');
    if (['subscription', 'subscription_updates', 'professional_hosting'].includes(offer.mode) && !['month', 'year'].includes(price.billingInterval)) {
        return block('Recurring Stripe Price sync requires month or year billing intervals.');
    }
    if (['one_time', 'one_time_current_version'].includes(offer.mode) && price.billingInterval !== 'one_time') {
        return block('One-time Stripe Price sync requires one_time billing interval.');
    }
    const productSync = await syncCommerceOfferStripeProduct({
        store,
        stripeConnectService,
        offer,
        actorType,
        actorId,
        reconcile,
        throwOnBlocked,
    });
    const syncedOffer = productSync.offer ?? offer;
    if (!syncedOffer?.stripeProductId || syncedOffer.stripeProductStatus !== 'synced') {
        return block(productSync.reason ?? 'Stripe Product must be synced before Stripe Price sync.');
    }
    const context = await commerceStripeSyncContext({ store, stripeConnectService, offer: syncedOffer, environment });
    if (!context.account || context.account.accountStatus !== 'enabled')
        return block('Stripe connected account must be enabled before Price sync.');
    const metadata = buildCommerceStripeMetadata({ environment, ...context, offer: syncedOffer, price });
    const lookupKey = price.stripeLookupKey ?? commerceStripeLookupKey(environment, price);
    const params = commerceStripePriceParams({
        offer: syncedOffer,
        price: { ...price, stripeLookupKey: lookupKey },
        stripeProductId: syncedOffer.stripeProductId,
        metadata,
        environment,
    });
    try {
        let stripePrice = null;
        if (price.stripePriceId) {
            stripePrice = await stripeConnectService.retrievePriceMirror({
                connectedAccountId: context.account.stripeAccountId,
                stripePriceId: price.stripePriceId,
            });
            if (stripePriceTermsDrift(stripePrice, price, syncedOffer)) {
                const updated = await store.updateCommercePriceStripeSync(price.id, {
                    stripeProductId: syncedOffer.stripeProductId,
                    stripePriceId: price.stripePriceId,
                    stripeLookupKey: lookupKey,
                    stripeSyncStatus: 'drifted',
                    stripeSyncError: 'Stripe Price immutable terms differ from TreeSeed price terms.',
                    stripeMetadata: metadata,
                    actorType,
                    actorId,
                    action: 'commerce_price.stripe_price.drifted',
                    reason: 'Stripe Price immutable terms differ from TreeSeed price terms.',
                    evidence: { environment, stripeAccountId: context.account.stripeAccountId, stripePriceId: price.stripePriceId },
                });
                return { offer: syncedOffer, price: updated, connectedAccount: context.account, stripeProductId: syncedOffer.stripeProductId, stripePriceId: price.stripePriceId, stripeLookupKey: lookupKey, status: 'drifted', reconciled: reconcile };
            }
            stripePrice = await stripeConnectService.updatePriceMirror({
                connectedAccountId: context.account.stripeAccountId,
                stripePriceId: price.stripePriceId,
                params: { metadata, lookup_key: lookupKey, active: price.status === 'active' },
            });
        }
        else {
            stripePrice = await stripeConnectService.createPriceMirror({
                connectedAccountId: context.account.stripeAccountId,
                params,
            });
        }
        if (!stripePrice?.id)
            return block('Stripe Price sync did not return a Price ID.');
        const updated = await store.updateCommercePriceStripeSync(price.id, {
            stripeProductId: syncedOffer.stripeProductId,
            stripePriceId: stripePrice.id,
            stripeLookupKey: lookupKey,
            stripeSyncStatus: 'synced',
            stripeMetadata: metadata,
            actorType,
            actorId,
            action: reconcile ? 'commerce_price.stripe_price.reconciled' : 'commerce_price.stripe_price.synced',
            evidence: {
                environment,
                stripeAccountId: context.account.stripeAccountId,
                stripeProductId: syncedOffer.stripeProductId,
                stripePriceId: stripePrice.id,
            },
        });
        return {
            offer: syncedOffer,
            price: updated,
            connectedAccount: context.account,
            stripeProductId: syncedOffer.stripeProductId,
            stripePriceId: stripePrice.id,
            stripeLookupKey: lookupKey,
            status: 'synced',
            reconciled: reconcile,
        };
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? 'Stripe Price sync failed.');
        await store.updateCommercePriceStripeSync(price.id, {
            stripeSyncStatus: 'failed',
            stripeSyncError: reason,
            actorType,
            actorId,
            action: 'commerce_price.stripe_price.failed',
            reason,
            evidence: { environment, stripeAccountId: context.account.stripeAccountId },
        });
        if (throwOnBlocked)
            throw error;
        return { offer: syncedOffer, price: await store.getCommercePrice(price.id), failed: true, reason };
    }
}
