import { ControlPlaneStore,serializeGovernanceDecision } from "../../../../../persistence/store.ts";
export async function getGovernanceDecisionMethod(this: ControlPlaneStore, decisionId: string) {
    await this.ensureInitialized();
    return serializeGovernanceDecision(await this.first<GovernanceDecisionRow>(`SELECT * FROM governance_decisions WHERE id = ? LIMIT 1`, [decisionId]));
}
import type { GovernanceDecisionRow } from "../../../../support/governance/policy/governance.ts";
