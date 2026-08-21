import { isoNow,ControlPlaneStore } from "../../../../persistence/store.ts";
export async function recalculateCommonsProposalVoteTotalsMethod(this: ControlPlaneStore, proposalId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT vote, COALESCE(SUM(weight), 0) AS total FROM commons_proposal_votes WHERE proposal_id = ? GROUP BY vote`, [proposalId]);
    const totals = Object.fromEntries(rows.map((row) => [row.vote, Number(row.total ?? 0)]));
    await this.run(`UPDATE commons_proposals SET vote_support_weight = ?, vote_object_weight = ?, vote_abstain_weight = ?, updated_at = ? WHERE id = ?`, [totals.support ?? 0, totals.object ?? 0, totals.abstain ?? 0, isoNow(), proposalId]);
}
