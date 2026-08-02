import { COMMERCE_PAYMENT_GROUP_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore,serializeCommercePaymentGroup } from "../../../../persistence/store.ts";
export async function updateCommercePaymentGroupMethod(this: MarketControlPlaneStore, groupId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommercePaymentGroup(groupId);
    if (!existing)
        return null;
    const status = enumValue(input.status, COMMERCE_PAYMENT_GROUP_STATUS_SET, existing.status);
    const clientSecret = input.clientSecret ?? null;
    await this.run(`UPDATE commerce_payment_groups
			 SET status = ?, stripe_payment_intent_id = ?, stripe_subscription_id = ?, stripe_customer_id = ?,
			     client_secret_last4 = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        status,
        input.stripePaymentIntentId === undefined ? existing.stripePaymentIntentId : input.stripePaymentIntentId,
        input.stripeSubscriptionId === undefined ? existing.stripeSubscriptionId : input.stripeSubscriptionId,
        input.stripeCustomerId === undefined ? existing.stripeCustomerId : input.stripeCustomerId,
        clientSecret ? clientSecret.slice(-4) : existing.clientSecretLast4,
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        isoNow(),
        groupId,
    ]);
    return serializeCommercePaymentGroup(await this.first(`SELECT * FROM commerce_payment_groups WHERE id = ?`, [groupId]), clientSecret);
}
