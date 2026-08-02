import { randomUUID } from 'node:crypto';
import { arrayValue,COMMERCE_SERVICE_QUOTE_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore,objectValue,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceServiceQuoteMethod(this: MarketControlPlaneStore, requestId, input: any = {}) {
    await this.ensureInitialized();
    const request = await this.getCommerceServiceRequest(requestId);
    if (!request)
        return null;
    if (!['requested', 'scoping'].includes(request.status)) {
        const error: Error & Record<string, any> = new Error('Quotes can only be created while a service request is requested or scoping.');
        error.status = 409;
        throw error;
    }
    const title = stringValue(input.title, '');
    const scopeSummary = stringValue(input.scopeSummary, '');
    const amount = Number(input.amount ?? 0);
    const currency = stringValue(input.currency, '').toLowerCase();
    if (!title || !scopeSummary) {
        const error: Error & Record<string, any> = new Error('Quote title and scope summary are required.');
        error.status = 400;
        throw error;
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        const error: Error & Record<string, any> = new Error('Quote amount must be a positive integer minor-unit amount.');
        error.status = 400;
        throw error;
    }
    if (!/^[a-z]{3}$/u.test(currency)) {
        const error: Error & Record<string, any> = new Error('Quote currency must be a lowercase 3-letter code.');
        error.status = 400;
        throw error;
    }
    const priorActive = request.activeQuoteId ? await this.getCommerceServiceQuote(request.activeQuoteId) : null;
    if (priorActive && ['draft', 'submitted', 'buyer_approved'].includes(priorActive.status)) {
        await this.updateCommerceServiceQuoteState(priorActive.id, 'superseded', {
            recordEvent: false,
        });
    }
    const last = await this.first(`SELECT MAX(quote_version) AS version FROM commerce_service_quotes WHERE request_id = ?`, [requestId]);
    const quoteVersion = Number(last?.version ?? 0) + 1;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const status = enumValue(input.status, COMMERCE_SERVICE_QUOTE_STATUS_SET, 'draft');
    await this.run(`INSERT INTO commerce_service_quotes (
				id, request_id, vendor_id, seller_team_id, buyer_team_id, buyer_user_id, quote_version, status,
				title, scope_summary, deliverables_json, assumptions_json, access_requirements_json, governance_requirements_json,
				amount, currency, expires_at, buyer_approved_at, vendor_approved_at, accepted_at, rejected_at,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        request.id,
        request.vendorId,
        request.sellerTeamId,
        request.buyerTeamId,
        request.buyerUserId,
        quoteVersion,
        status,
        title,
        scopeSummary,
        JSON.stringify(arrayValue(input.deliverables)),
        JSON.stringify(arrayValue(input.assumptions)),
        JSON.stringify(objectValue(input.accessRequirements, {})),
        JSON.stringify(objectValue(input.governanceRequirements, {})),
        amount,
        currency,
        input.expiresAt ?? null,
        null,
        null,
        null,
        null,
        JSON.stringify(objectValue(input.metadata, {})),
        timestamp,
        timestamp,
    ]);
    await this.updateCommerceServiceRequest(request.id, {
        status: status === 'submitted' ? 'quoted' : request.status,
        activeQuoteId: id,
        recordEvent: false,
    });
    await this.recordCommerceServiceGovernance({
        requestId: request.id,
        quoteId: id,
        eventType: 'quote_created',
        action: 'commerce_service.quote_created',
        objectType: 'commerce_service_quote',
        objectId: id,
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        nextState: status,
        evidence: { quoteVersion, amount, currency },
        relatedOfferId: request.offerId,
        relatedProductId: request.productId,
        relatedTeamId: request.sellerTeamId,
    });
    return this.getCommerceServiceQuote(id);
}
