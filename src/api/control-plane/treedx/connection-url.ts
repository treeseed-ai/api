export function resolveTreeDxServiceUrl(value: string, environment: Record<string, unknown>): string {
	let parsed: URL;
	try { parsed = new URL(value); } catch { throw new Error('TreeDX connection URL is invalid.'); }
	if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error('TreeDX connection requires a credential-free HTTP service URL without query or fragment data.');
	}
	const text = (candidate: unknown) => typeof candidate === 'string' ? candidate.trim() : '';
	const local = environment.TREESEED_ENVIRONMENT === 'local' || environment.TREESEED_ENVIRONMENT === 'test'
		|| environment.NODE_ENV === 'test' || environment.LOCAL_DEV_MODE === '1';
	const localHttpHosts = new Set(['localhost', '127.0.0.1', '::1', 'treedx',
		...text(environment.TREESEED_LOCAL_TREEDX_HOSTS).split(',').map((host) => host.trim()).filter(Boolean)]);
	if (parsed.protocol !== 'https:' && (!local || !localHttpHosts.has(parsed.hostname))) {
		throw new Error('TreeDX connections require TLS outside the explicitly declared local deployment.');
	}
	return parsed.toString().replace(/\/+$/u, '');
}
