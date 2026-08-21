import { ControlPlaneStore,serializeGovernanceDecision } from "../../../../../persistence/store.ts";
export async function getGovernanceDecisionMethod(this: ControlPlaneStore, decisionId) {
    await this.ensureInitialized();
    return serializeGovernanceDecision(await this.first(`SELECT * FROM governance_decisions WHERE id = ? LIMIT 1`, [decisionId]));
}
