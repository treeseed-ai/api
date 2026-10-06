type Result = { teamId?: unknown; state?: unknown; error?: unknown };
type Scheduler = (work: () => void, delayMs: number) => void;
const delays = [5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000];
const transient = (error: unknown) => /TreeDX network request failed|TreeDX.*\b(?:502|503|504)\b/u.test(error instanceof Error ? error.message : String(error ?? ''));

/** Retry only failed startup bindings; never relax provisioning/admission gates. */
export function recoverManagedLibraryStartup(results: Result[], reconcile: (teamId: string) => Promise<unknown>, schedule: Scheduler = (work, delay) => { setTimeout(work, delay).unref(); }) {
	for (const teamId of new Set(results.filter(result => result.state === 'blocked' && transient(result.error)).map(result => String(result.teamId ?? '')).filter(Boolean))) {
		const retry = (attempt: number) => schedule(() => {
			void reconcile(teamId).catch(error => {
				if (transient(error) && attempt + 1 < delays.length) retry(attempt + 1);
			});
		}, delays[attempt]!);
		retry(0);
	}
}
