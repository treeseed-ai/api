export type AuthoringExecutionMode = 'simulation' | 'production';

export function authoringExecutionPolicy(value: unknown): {
	executionMode: AuthoringExecutionMode;
	upstreamMutationPolicy: 'denied' | 'exact-approved-ref';
} {
	const executionMode = value === undefined || value === null || value === '' ? 'simulation' : value;
	if (executionMode !== 'simulation' && executionMode !== 'production') {
		throw new Error('executionMode must be simulation or production.');
	}
	return {
		executionMode,
		upstreamMutationPolicy: executionMode === 'production' ? 'exact-approved-ref' : 'denied',
	};
}
