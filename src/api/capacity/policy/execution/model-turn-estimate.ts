/** Minimum viable model turn, including its required clock checks and closeout. */
export function modelTurnEstimate(maximumSeconds: number) {
	return { expectedSeconds: maximumSeconds, maximumSeconds };
}
