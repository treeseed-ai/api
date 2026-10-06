/** One database allocation is shared by released/live API processes, the
 * operations runner, and a one-shot maintenance process. Keep headroom for
 * health/verification connections; a pool's default ten is not a role budget.
 */
export const API_POSTGRES_POOL_MAX = 4;
export const API_POSTGRES_PROCESS_SLOTS = 4;
export const API_POSTGRES_RESERVED_CONNECTIONS = 4;
export const API_POSTGRES_RUNTIME_CONNECTION_LIMIT =
	API_POSTGRES_POOL_MAX * API_POSTGRES_PROCESS_SLOTS + API_POSTGRES_RESERVED_CONNECTIONS;

export const API_POSTGRES_POOL_OPTIONS = Object.freeze({
	max: API_POSTGRES_POOL_MAX,
	connectionTimeoutMillis: 10_000,
	idleTimeoutMillis: 5_000,
});
