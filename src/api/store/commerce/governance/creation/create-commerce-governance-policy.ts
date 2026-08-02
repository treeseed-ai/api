import { randomUUID } from 'node:crypto';
import { enumValue,isoNow,MarketControlPlaneStore,serializeCommerceGovernancePolicy,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceGovernancePolicyMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_governance_policies (
				id, product_id, team_id, policy_kind, title, approval_rules_json, quorum_rules_json, buyer_visible_summary, status, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.productId ?? null,
        input.teamId ?? null,
        enumValue(input.policyKind, new Set(['product', 'vendor', 'cooperative', 'community']), 'product'),
        stringValue(input.title, 'Commerce Governance Policy'),
        JSON.stringify(input.approvalRules ?? {}),
        JSON.stringify(input.quorumRules ?? {}),
        input.buyerVisibleSummary ?? null,
        enumValue(input.status, new Set(['draft', 'active', 'superseded', 'archived']), 'draft'),
        timestamp,
        timestamp,
    ]);
    return serializeCommerceGovernancePolicy(await this.first(`SELECT * FROM commerce_governance_policies WHERE id = ?`, [id]));
}
