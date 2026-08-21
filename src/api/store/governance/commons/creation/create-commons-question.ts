import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,stringValue } from "../../../../persistence/store.ts";
export async function createCommonsQuestionMethod(this: ControlPlaneStore, principal, input: any = {}) {
    const participant = await this.ensureCommonsParticipantForPrincipal(principal);
    const title = stringValue(input.title);
    const body = stringValue(input.body);
    if (!title || !body) {
        const error: Error & Record<string, any> = new Error('Question title and body are required.');
        error.status = 400;
        throw error;
    }
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commons_questions (
				id, participant_id, user_id, team_id, status, title, body, answer, converted_proposal_id,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'open', ?, ?, NULL, NULL, ?, ?, ?)`, [id, participant.id, participant.userId, participant.teamId, title, body, JSON.stringify(input.metadata ?? {}), timestamp, timestamp]);
    await this.recordCommonsGovernanceEvent({
        eventType: 'question.created',
        actorType: 'user',
        actorId: principal.id,
        participantId: participant.id,
        questionId: id,
        nextState: 'open',
        message: 'Commons question submitted.',
    });
    return this.getCommonsQuestion(id);
}
