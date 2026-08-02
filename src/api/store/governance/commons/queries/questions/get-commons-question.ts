import { MarketControlPlaneStore,serializeCommonsQuestion } from "../../../../../persistence/store.ts";
export async function getCommonsQuestionMethod(this: MarketControlPlaneStore, questionId) {
    await this.ensureInitialized();
    return serializeCommonsQuestion(await this.first(`SELECT * FROM commons_questions WHERE id = ? LIMIT 1`, [questionId]));
}
