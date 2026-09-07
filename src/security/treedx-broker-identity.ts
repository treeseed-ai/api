/** The configured broker service identity is not a repository placement ID. */
export function treeDxBrokerIdentity(connection: { nodeId?: unknown }) {
	const identity = typeof connection.nodeId === 'string' ? connection.nodeId.trim() : '';
	if (!identity) throw new Error('TreeDX remote operations require a configured broker node identity.');
	return identity;
}
