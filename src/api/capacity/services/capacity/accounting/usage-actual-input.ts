export interface CapacityUsageActualInput {
	nativeUsage?: Record<string, unknown>;
	taskSignature?: string | null;
	executionProfileId?: string | null;
	executionProviderId?: string | null;
	businessModel?: string | null;
	modelName?: string | null;
	inputTokens?: number | null;
	outputTokens?: number | null;
	cachedInputTokens?: number | null;
	quotaMinutes?: number | null;
	wallMinutes?: number | null;
	filesOpened?: number | null;
	filesChanged?: number | null;
	diffLinesAdded?: number | null;
	diffLinesRemoved?: number | null;
	testRuns?: number | null;
	retryCount?: number | null;
}
