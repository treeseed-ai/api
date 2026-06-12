export function deploymentError(code: string, message: string, options: Record<string, unknown> = {}) {
	return {
		ok: false,
		error: {
			code,
			message,
			retryable: Boolean(options.retryable),
			...(options.details ? { details: options.details } : {}),
		},
	};
}

export function deploymentErrorStatus(code: string): number {
	if (code === 'not_authenticated') return 401;
	if (code === 'not_authorized') return 403;
	if (code === 'project_not_found' || code === 'deployment_not_found') return 404;
	if (['invalid_environment', 'invalid_action', 'validation_failed'].includes(code)) return 400;
	if (code === 'external_provider_failed') return 502;
	if ([
		'deployment_not_ready',
		'host_not_ready',
		'repository_not_ready',
		'runner_not_ready',
		'operation_conflict',
		'operation_not_cancellable',
		'operation_not_retryable',
	].includes(code)) return 409;
	return 500;
}

export function jsonDeploymentError(c: any, code: string, message: string, options: Record<string, unknown> = {}) {
	return c.json(deploymentError(code, message, options), { status: Number(options.status ?? deploymentErrorStatus(code)) });
}

