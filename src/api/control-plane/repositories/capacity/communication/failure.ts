/** Surface the recorded execution cause, not just its terminal wrapper. */
export function communicationFailure(state: Record<string, unknown>) {
	const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
	const code = text(state.lifecycleCode) || text(state.code);
	return code ? { code, message: text(state.lifecycleReason) || text(state.message) || text(state.reason) || null } : null;
}
