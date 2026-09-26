/** Minimum viable model turn, including its required clock checks and closeout. */
export function modelTurnEstimate(maximumSeconds: number) {
	return { minimumSeconds: Math.min(90, maximumSeconds), expectedSeconds: maximumSeconds, maximumSeconds };
}
