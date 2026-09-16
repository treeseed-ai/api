export function assignmentCloseoutWarningSeconds(requestedSeconds: number, configuredValue: unknown) {
	const configuredSeconds = Number(configuredValue);
	const requestedShare = Math.max(1, Math.floor(requestedSeconds * .2));
	const configuredOrDefault = Number.isInteger(configuredSeconds) && configuredSeconds > 0
		? configuredSeconds
		: 180;
	return Math.min(requestedSeconds, configuredOrDefault, requestedShare);
}

export function assignmentPreparationSeconds(configuredValue: unknown) {
	const configuredSeconds = Number(configuredValue);
	return Number.isInteger(configuredSeconds) && configuredSeconds > 0
		? Math.min(configuredSeconds, 900)
		: 180;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function compileAssignmentTimeBudget(input: { now: string; requestedSeconds: number; configuredBudget: Record<string, unknown> }) {
	const configuredTime = record(input.configuredBudget.time);
	const configuredTokens = record(input.configuredBudget.tokens);
	const closeoutSeconds = assignmentCloseoutWarningSeconds(input.requestedSeconds, configuredTime.closeoutSeconds ?? configuredTime.closeoutWarningSeconds);
	const preparationSeconds = assignmentPreparationSeconds(configuredTime.preparationSeconds);
	const preparationDeadlineAt = new Date(Date.parse(input.now) + preparationSeconds * 1_000).toISOString();
	const authorityExpiresAt = new Date(Date.parse(input.now) + (preparationSeconds + input.requestedSeconds) * 1_000).toISOString();
	const closeoutDeadlineAt = authorityExpiresAt;
	return {
		closeoutSeconds, preparationSeconds, authorityExpiresAt,
		capacityBudget: {
			schemaVersion: 'treeseed.capacity-budget/v2', ...input.configuredBudget,
			time: { ...configuredTime, requestedSeconds: input.requestedSeconds, executionSeconds: input.requestedSeconds, preparationSeconds, closeoutSeconds,
				reservedSeconds: input.requestedSeconds, activeSeconds: 0, elapsedSeconds: 0, releasedSeconds: 0, overrunSeconds: 0,
				preparationStartedAt: input.now, preparationDeadlineAt, executionStartedAt: null, executionDeadlineAt: null, closeoutStartedAt: null,
				closeoutDeadlineAt, hardDeadlineAt: closeoutDeadlineAt, authorityDeadlineAt: authorityExpiresAt, remainingSeconds: input.requestedSeconds, closeoutWarningSeconds: closeoutSeconds },
			tokens: { inputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, outputTokens: 0, hardLimitTokens: configuredTokens.hardLimitTokens ?? null, warningTokens: configuredTokens.warningTokens ?? null, hardLimitEnforceable: configuredTokens.hardLimitEnforceable === true },
			maxAttempts: Math.max(1, Number(input.configuredBudget.maxAttempts ?? 1)), maxConcurrency: 1, deadline: closeoutDeadlineAt,
			pricingGeneration: input.configuredBudget.pricingGeneration ?? null, enforcementConfidence: input.configuredBudget.enforcementConfidence ?? 'bounded',
		},
	};
}

export function beginAssignmentPreparationTimeBudget(capacityEnvelope: Record<string, unknown>, now: string) {
	const envelope = record(capacityEnvelope);
	const budget = record(envelope.budget);
	const time = record(budget.time);
	if (time.executionStartedAt) return envelope;
	const startedAt = Date.parse(now);
	const preparationSeconds = assignmentPreparationSeconds(time.preparationSeconds);
	const closeoutSeconds = assignmentCloseoutWarningSeconds(Number(time.executionSeconds ?? time.requestedSeconds ?? envelope.requestedSeconds), time.closeoutSeconds ?? time.closeoutWarningSeconds);
	const authorityDeadlineMs = Date.parse(String(time.authorityDeadlineAt));
	if (!Number.isFinite(authorityDeadlineMs)) throw new Error('assignment_authority_deadline_required');
	const preparationDeadlineMs = Date.parse(String(time.preparationDeadlineAt));
	if (!Number.isFinite(preparationDeadlineMs)) throw new Error('assignment_preparation_deadline_required');
	const preparationDeadlineAt = new Date(Math.min(preparationDeadlineMs, startedAt + preparationSeconds * 1_000)).toISOString();
	const authorityDeadlineAt = new Date(authorityDeadlineMs).toISOString();
	const closeoutDeadlineAt = authorityDeadlineAt;
	return {
		...envelope,
		budget: {
			...budget,
			deadline: closeoutDeadlineAt,
			time: { ...time, preparationStartedAt: now, preparationDeadlineAt, executionStartedAt: null, executionDeadlineAt: null,
				closeoutStartedAt: null, closeoutDeadlineAt, hardDeadlineAt: closeoutDeadlineAt, authorityDeadlineAt },
		},
	};
}
