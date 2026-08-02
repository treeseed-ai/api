import { randomUUID } from 'node:crypto';
import { COMMERCE_COMMERCIAL_OFFER_MODES,COMMERCE_PRICE_INTERVAL_SET,COMMERCE_PRICE_STATUS_SET,COMMERCE_TAX_BEHAVIOR_SET,COMMERCE_ZERO_PRICE_OFFER_MODES,enumValue,isoNow,MarketControlPlaneStore,numberValue,serializeCommercePrice,stringValue } from "../../../../persistence/store.ts";
export async function createCommercePriceMethod(this: MarketControlPlaneStore, offerId, input: any = {}) {
    await this.ensureInitialized();
    const offer = await this.getCommerceOffer(offerId);
    if (!offer)
        return null;
    const amount = numberValue(input.amount, 0);
    if (amount < 0) {
        const error: Error & Record<string, any> = new Error('Price amount must be non-negative.');
        error.status = 400;
        throw error;
    }
    if (COMMERCE_ZERO_PRICE_OFFER_MODES.has(offer.mode) && amount !== 0) {
        const error: Error & Record<string, any> = new Error('Non-checkout offer modes must use zero display prices in Phase 2.');
        error.status = 400;
        throw error;
    }
    const billingInterval = enumValue(input.billingInterval, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_COMMERCIAL_OFFER_MODES.has(offer.mode) && offer.mode !== 'one_time' && offer.mode !== 'one_time_current_version' ? 'month' : 'one_time');
    if (['one_time', 'one_time_current_version'].includes(offer.mode) && billingInterval !== 'one_time') {
        const error: Error & Record<string, any> = new Error('One-time offers must use one_time billing interval.');
        error.status = 400;
        throw error;
    }
    if (['subscription', 'subscription_updates', 'professional_hosting', 'scoped_contract'].includes(offer.mode) && billingInterval === 'one_time') {
        const error: Error & Record<string, any> = new Error('Recurring or scoped offers must use month, year, or custom billing interval.');
        error.status = 400;
        throw error;
    }
    const currency = stringValue(input.currency, 'usd').toLowerCase();
    if (!/^[a-z]{3}$/u.test(currency)) {
        const error: Error & Record<string, any> = new Error('Currency must be a lowercase 3-letter code.');
        error.status = 400;
        throw error;
    }
    const latest = await this.first(`SELECT MAX(price_version) AS max_version FROM commerce_prices WHERE offer_id = ?`, [offerId]);
    const priceVersion = Number(latest?.max_version ?? 0) + 1;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_prices (
				id, offer_id, amount, currency, billing_interval, status, stripe_product_id, stripe_price_id,
				stripe_lookup_key, stripe_sync_status, stripe_synced_at, stripe_sync_error, stripe_metadata_json, price_version,
				tax_behavior, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        offerId,
        amount,
        currency,
        billingInterval,
        enumValue(input.status, COMMERCE_PRICE_STATUS_SET, 'draft'),
        null,
        null,
        null,
        'not_synced',
        null,
        null,
        '{}',
        priceVersion,
        enumValue(input.taxBehavior, COMMERCE_TAX_BEHAVIOR_SET, 'unspecified'),
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    return serializeCommercePrice(await this.first(`SELECT * FROM commerce_prices WHERE id = ?`, [id]));
}
