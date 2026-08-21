export function routeId(method: string, path: string): string {
	return [
		method.toLowerCase(),
		...path
			.replace(/^\/+/, '')
			.split('/')
			.filter(Boolean)
			.map((part) => part.startsWith(':') ? part.slice(1) : part)
			.map((part) => part.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
			.filter(Boolean),
	].join('.');
}

export function runtimePlane(): 'control-plane' {
	return 'control-plane';
}

export function ownerDomain(path: string): string {
	if (path.startsWith('/v1/provider/') || path.startsWith('/v1/provider-registrations')) return 'provider-ingress';
	if (path.startsWith('/v1/platform/runners/')) return 'platform-runner';
	if (path.startsWith('/v1/platform/operations')) return 'platform-operation';
	if (path.startsWith('/v1/auth/')) return 'auth';
	if (path.startsWith('/v1/governance/')) return 'governance';
	if (path.startsWith('/v1/commons/')) return 'commons';
	if (path.startsWith('/v1/teams/')) return 'team';
	if (path.startsWith('/v1/projects/')) return 'project';
	if (path.startsWith('/v1/capacity/') || path.includes('/capacity-')) return 'capacity';
	if (path.startsWith('/v1/seeds/')) return 'seed';
	if (path.startsWith('/v1/acceptance/')) return 'acceptance';
	if (path.startsWith('/v1/me')) return 'identity';
	return 'control-plane';
}

export function safeProduction(path: string, method: string): boolean {
	if (method === 'get') return true;
	if (path.startsWith('/v1/auth/web/appearance') || path.startsWith('/v1/auth/web/preferences') || path.startsWith('/v1/auth/web/sessions')) return true;
	return path.startsWith('/v1/acceptance/');
}

export function productionSafeStrategy(path: string, method: string): string {
	if (method === 'get') return 'read';
	if (path.startsWith('/v1/auth/web/appearance') || path.startsWith('/v1/auth/web/preferences') || path.startsWith('/v1/auth/logout') || path.startsWith('/v1/auth/web/sessions/')) return 'acceptance-owned';
	if (path.startsWith('/v1/platform/runners/') || path.startsWith('/v1/provider/')) return 'acceptance-owned';
	if (path.startsWith('/v1/acceptance/')) return 'acceptance-service';
	return 'acceptance-owned-fixture';
}
