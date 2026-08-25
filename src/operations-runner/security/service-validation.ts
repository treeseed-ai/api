type Connection = {
	providerId: string;
	nonSecretConfig: Record<string, unknown>;
};

async function expectOk(response: Response, provider: string) {
	if (response.ok) return;
	throw new Error(`${provider} rejected the read-only connection validation (HTTP ${response.status}).`);
}

export async function validateProviderConnection(
	connection: Connection,
	values: Record<string, string>,
) {
	if (connection.providerId === 'github') {
		if (!values.accessToken) throw new Error('A fine-grained GitHub token is required. Managed Apps are validated through the Connector flow.');
		const response = await fetch('https://api.github.com/user', {
			headers: {
				accept: 'application/vnd.github+json',
				authorization: `Bearer ${values.accessToken}`,
				'x-github-api-version': '2022-11-28',
				'user-agent': 'treeseed-service-validation',
			},
		});
		await expectOk(response, 'GitHub');
		return;
	}
	if (connection.providerId === 'cloudflare') {
		if (!values.apiToken) throw new Error('Cloudflare API token is required.');
		const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
			headers: { authorization: `Bearer ${values.apiToken}` },
		});
		await expectOk(response, 'Cloudflare');
		return;
	}
	if (connection.providerId === 'railway') {
		if (!values.apiToken) throw new Error('Railway workspace token is required.');
		const response = await fetch('https://backboard.railway.app/graphql/v2', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${values.apiToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ query: 'query ServiceConnectionValidation { me { id } }' }),
		});
		await expectOk(response, 'Railway');
		const result = await response.json() as { errors?: unknown[] };
		if (result.errors?.length) throw new Error('Railway rejected the read-only workspace query.');
		return;
	}
	if (connection.providerId === 'openbao') {
		const address = String(connection.nonSecretConfig.address ?? '');
		if (!address.startsWith('https://')) throw new Error('The external vault address must use HTTPS.');
		const response = await fetch(new URL('/v1/sys/health?standbyok=true&perfstandbyok=true', address), {
			redirect: 'error',
		});
		if (![200, 429, 472, 473].includes(response.status)) {
			throw new Error(`The external vault health endpoint returned HTTP ${response.status}.`);
		}
		return;
	}
	throw new Error('This provider has no read-only validation adapter.');
}
