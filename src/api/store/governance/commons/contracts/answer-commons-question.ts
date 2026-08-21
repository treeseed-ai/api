import { isoNow,ControlPlaneStore,stringValue } from "../../../../persistence/store.ts";
export async function answerCommonsQuestionMethod(this: ControlPlaneStore, questionId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommonsQuestion(questionId);
    if (!existing)
        return null;
    const timestamp = isoNow();
    const answer = stringValue(input.answer ?? input.message);
    await this.run(`UPDATE commons_questions SET status = 'answered', answer = ?, updated_at = ? WHERE id = ?`, [answer, timestamp, questionId]);
    await this.recordCommonsGovernanceEvent({
        eventType: 'question.answered',
        actorType: input.actorType ?? 'operator',
        actorId: input.actorId ?? null,
        participantId: existing.participantId,
        questionId,
        priorState: existing.status,
        nextState: 'answered',
        message: 'Commons question answered by steward.',
    });
    return this.getCommonsQuestion(questionId);
}
