import { MarketControlPlaneStore,serializeGovernanceDecision } from "../../../../../persistence/store.ts";
export async function getGovernanceDecisionMethod(this: MarketControlPlaneStore, decisionId) {
    await this.ensureInitialized();
    return serializeGovernanceDecision(await this.first(`SELECT * FROM governance_decisions WHERE id = ? LIMIT 1`, [decisionId]));
}
