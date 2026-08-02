import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function commonsSummaryMethod(this: MarketControlPlaneStore, principal = null) {
    await this.ensureInitialized();
    const [participants, proposals, questions, decisions] = await Promise.all([
        this.first(`SELECT COUNT(*) AS count FROM commons_participants WHERE status = 'active'`),
        this.first(`SELECT COUNT(*) AS count FROM commons_proposals WHERE status NOT IN ('archived')`),
        this.first(`SELECT COUNT(*) AS count FROM commons_questions WHERE status = 'open'`),
        this.first(`SELECT COUNT(*) AS count FROM commons_decisions WHERE status IN ('accepted', 'scheduled', 'implemented')`),
    ]);
    return {
        team: await this.ensureCommonsTeam(),
        participant: principal?.id ? await this.getCommonsParticipantByUserId(principal.id) : null,
        counts: {
            activeParticipants: Number(participants?.count ?? 0),
            activeProposals: Number(proposals?.count ?? 0),
            openQuestions: Number(questions?.count ?? 0),
            acceptedDecisions: Number(decisions?.count ?? 0),
        },
        recentProposals: await this.listCommonsProposals({ limit: 6 }),
        recentEvents: await this.listCommonsGovernanceEvents({ limit: 12 }),
    };
}
