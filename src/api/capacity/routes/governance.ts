import type { Context, Hono } from 'hono';
import type { CapacityProviderIdentityRotationRequest, CapacityProviderSignedProof, ProviderRegistrationSubmission } from '@treeseed/sdk/capacity-provider/contracts';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { CapacityGovernanceRepository } from '../repositories/governance.ts';
import { CapacityAuditRepository } from '../repositories/audit.ts';
import { CapacityRegistrationService } from '../services/registration-service.ts';
import { CapacitySecretCodec } from '../security.ts';
import { createCapacityProviderAccessMiddleware } from '../provider-access-middleware.ts';
import { readCapacityRequestObject } from './request-json.ts';

interface CapacityGovernanceRouteOptions {
	store: CapacityGovernanceDatabase;
	requireTeamAccess(c: Context, store: CapacityGovernanceDatabase, teamId: string, permission: string): Promise<{ response?: Response | null }>;
	config: Record<string, unknown>;
}

function errorResponse(c: Context, error: unknown) {
	if (error instanceof CapacityGovernanceError) return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code, details: error.details }), { status: error.status, headers: { 'content-type': 'application/json' } });
	return c.json({ ok: false, error: error instanceof Error ? error.message : String(error), code: 'capacity_governance_failed' }, { status: 500 });
}

function actorId(c: Context) {
	const principal = c.get('principal') as { id?: unknown } | undefined;
	return typeof principal?.id === 'string' ? principal.id : null;
}

function idempotencyKey(c: Context) {
	return c.req.header('idempotency-key')?.trim() ?? '';
}

function registrationCredential(c: Context) {
	const value = c.req.header('authorization')?.trim() ?? '';
	return value.startsWith('Treeseed-Registration ') ? value.slice('Treeseed-Registration '.length).trim() : '';
}

type ProviderAccessPrincipal = { membershipId: string; teamId: string; capacityProviderId: string; scopes: string[] };

function providerAccessPrincipal(c: Context): ProviderAccessPrincipal {
	const auth = (c as Context<{ Variables: { capacityProviderAccessAuth: { principal?: ProviderAccessPrincipal } | null } }>).get('capacityProviderAccessAuth');
	if (!auth?.principal) throw new CapacityGovernanceError('provider_access_token_required', 'Provider membership access token is required.', 401);
	return auth.principal;
}

function identityRotationRequest(body: Record<string, unknown>): CapacityProviderIdentityRotationRequest {
	if (!Number.isInteger(body.expectedIdentityVersion)
		|| !body.newPublicJwk || typeof body.newPublicJwk !== 'object'
		|| !body.oldProof || typeof body.oldProof !== 'object'
		|| !body.newProof || typeof body.newProof !== 'object') {
		throw new CapacityGovernanceError('provider_identity_rotation_invalid', 'Identity rotation requires the expected version, new public key, and both signed proofs.', 400);
	}
	return body as unknown as CapacityProviderIdentityRotationRequest;
}

function membershipCredential(c: Context) {
	const value = c.req.header('authorization')?.trim() ?? '';
	return value.startsWith('Treeseed-Credential ') ? value.slice('Treeseed-Credential '.length).trim() : '';
}

function proofHeader(c: Context): CapacityProviderSignedProof {
	const value = c.req.header('x-treeseed-provider-proof')?.trim();
	if (!value) throw new CapacityGovernanceError('provider_proof_required', 'X-Treeseed-Provider-Proof is required.', 401);
	try {
		return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as CapacityProviderSignedProof;
	} catch {
		throw new CapacityGovernanceError('provider_proof_invalid', 'X-Treeseed-Provider-Proof is invalid.', 401);
	}
}

type TeamAccessCheck = (c: Context) => Promise<{ response?: Response | null }>;

function installRegistrationKeyRoutes(app: Hono, service: CapacityRegistrationService, manage: TeamAccessCheck) {
	app.get('/v1/teams/:teamId/capacity-registration-key', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			return c.json({ ok: true, payload: await service.registrationKey(c.req.param('teamId'), actorId(c)) });
		} catch (error) { return errorResponse(c, error); }
	});
	app.get('/v1/teams/:teamId/capacity-registration-key/reveal', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			return c.json({ ok: true, payload: await service.revealRegistrationKey(c.req.param('teamId'), actorId(c)) });
		} catch (error) { return errorResponse(c, error); }
	});
	app.post('/v1/teams/:teamId/capacity-registration-key/rotate', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			return c.json({ ok: true, payload: await service.rotateRegistrationKey(c.req.param('teamId'), actorId(c), idempotencyKey(c)) });
		} catch (error) { return errorResponse(c, error); }
	});
	const setStatus = (status: 'active' | 'disabled') => async (c: Context) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			return c.json({ ok: true, payload: await service.setRegistrationKeyStatus(c.req.param('teamId'), actorId(c), status, idempotencyKey(c)) });
		} catch (error) { return errorResponse(c, error); }
	};
	app.post('/v1/teams/:teamId/capacity-registration-key/enable', setStatus('active'));
	app.post('/v1/teams/:teamId/capacity-registration-key/disable', setStatus('disabled'));
}

export function installCapacityGovernanceRoutes(app: Hono, options: CapacityGovernanceRouteOptions) {
	const secretSource = options.config.capacityGovernanceSecret
		?? options.config.TREESEED_CAPACITY_GOVERNANCE_SECRET
		?? options.config.authSecret
		?? process.env.TREESEED_CAPACITY_GOVERNANCE_SECRET
		?? process.env.TREESEED_AUTH_SECRET;
	const environment = String(options.config.environment ?? process.env.TREESEED_ENVIRONMENT ?? 'local');
	if (!secretSource && !['local', 'test'].includes(environment)) throw new Error('TREESEED_CAPACITY_GOVERNANCE_SECRET is required outside local/test environments.');
	const rawSecret = String(secretSource ?? 'treeseed-local-capacity-governance-secret');
	if (rawSecret.trim().length < 24 && !['local', 'test'].includes(environment)) throw new Error('TREESEED_CAPACITY_GOVERNANCE_SECRET must contain at least 24 characters.');
	const configuredSecret = rawSecret.trim().length >= 24 ? rawSecret : `treeseed-local:${rawSecret}:capacity-governance`;
	const audience = String(options.config.baseUrl ?? process.env.TREESEED_API_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/u, '');
	const service = new CapacityRegistrationService(new CapacityGovernanceRepository(options.store), new CapacitySecretCodec(configuredSecret), audience);
	const manage = async (c: Context) => options.requireTeamAccess(c, options.store, c.req.param('teamId'), 'teams:manage:team');
	const read = async (c: Context) => options.requireTeamAccess(c, options.store, c.req.param('teamId'), 'teams:read:team');

	const providerAccess = createCapacityProviderAccessMiddleware(service);
	app.use('/v1/provider/*', providerAccess);
	app.use('/v1/dx/*', providerAccess);
	installRegistrationKeyRoutes(app, service, manage);

	app.post('/v1/provider-registrations', async (c) => {
		try {
			const key = registrationCredential(c);
			if (!key) throw new CapacityGovernanceError('registration_key_required', 'Treeseed-Registration authorization is required.', 401);
			const body = await readCapacityRequestObject(c) as unknown as ProviderRegistrationSubmission;
			const clientAddress = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
			return c.json({ ok: true, payload: await service.submitRegistration(key, body, '/v1/provider-registrations', idempotencyKey(c), clientAddress) }, { status: 201 });
		} catch (error) { return errorResponse(c, error); }
	});

	app.get('/v1/provider-registrations/:requestId', async (c) => {
		try {
			const requestId = c.req.param('requestId');
			return c.json({ ok: true, payload: await service.registrationStatus(requestId, proofHeader(c), `/v1/provider-registrations/${encodeURIComponent(requestId)}`) });
		} catch (error) { return errorResponse(c, error); }
	});

	app.post('/v1/provider-registrations/:requestId/credential', async (c) => {
		try {
			const requestId = c.req.param('requestId');
			const body = await readCapacityRequestObject(c) as { proof?: CapacityProviderSignedProof };
			if (!body.proof) throw new CapacityGovernanceError('provider_proof_required', 'Provider proof is required.', 401);
			return c.json({ ok: true, payload: await service.exchangeCredential(requestId, body.proof, `/v1/provider-registrations/${encodeURIComponent(requestId)}/credential`, idempotencyKey(c)) }, { status: 201 });
		} catch (error) { return errorResponse(c, error); }
	});

	app.post('/v1/provider/access-tokens', async (c) => {
		try {
			const credential = membershipCredential(c);
			if (!credential) throw new CapacityGovernanceError('provider_credential_required', 'Treeseed-Credential authorization is required.', 401);
			const body = await readCapacityRequestObject(c) as { credentialId?: string; proof?: CapacityProviderSignedProof };
			if (!body.credentialId) throw new CapacityGovernanceError('provider_credential_id_required', 'Provider credentialId is required.', 400);
			if (!body.proof) throw new CapacityGovernanceError('provider_proof_required', 'Provider proof is required.', 401);
			return c.json({ ok: true, payload: await service.issueAccessToken({ credentialValue: credential, credentialId: body.credentialId, proof: body.proof, path: '/v1/provider/access-tokens', idempotencyKey: idempotencyKey(c) }) }, { status: 201 });
		} catch (error) { return errorResponse(c, error); }
	});

	app.get('/v1/teams/:teamId/capacity-provider-requests', async (c) => {
		try {
			const access = await read(c); if (access.response) return access.response;
			return c.json({
				ok: true,
				payload: await service.listRequestsPage(c.req.param('teamId'), {
					status: c.req.query('status'),
					limit: c.req.query('limit'),
					cursor: c.req.query('cursor'),
				}),
			});
		} catch (error) { return errorResponse(c, error); }
	});

	app.get('/v1/teams/:teamId/capacity-provider-requests/:requestId', async (c) => {
		try {
			const access = await read(c); if (access.response) return access.response;
			return c.json({ ok: true, payload: await service.registrationRequest(c.req.param('teamId'), c.req.param('requestId')) });
		} catch (error) { return errorResponse(c, error); }
	});

	const reviewRegistration = (action: 'approve' | 'reject' | 'cancel') => async (c: Context) => {
			try {
				const access = await manage(c); if (access.response) return access.response;
				const principal = actorId(c); if (!principal) throw new CapacityGovernanceError('authentication_required', 'Authentication is required.', 401);
				const body = await readCapacityRequestObject(c, { optional: true });
				const result = action === 'approve'
					? await service.approve(c.req.param('teamId'), c.req.param('requestId'), principal, idempotencyKey(c), typeof body.teamAlias === 'string' ? body.teamAlias : null)
					: action === 'reject'
						? await service.reject(c.req.param('teamId'), c.req.param('requestId'), principal, String(body.reason ?? ''), idempotencyKey(c))
						: await service.cancel(c.req.param('teamId'), c.req.param('requestId'), principal, idempotencyKey(c));
				return c.json({ ok: true, payload: result });
			} catch (error) { return errorResponse(c, error); }
		};
	app.post('/v1/teams/:teamId/capacity-provider-requests/:requestId/approve', reviewRegistration('approve'));
	app.post('/v1/teams/:teamId/capacity-provider-requests/:requestId/reject', reviewRegistration('reject'));
	app.post('/v1/teams/:teamId/capacity-provider-requests/:requestId/cancel', reviewRegistration('cancel'));

	app.get('/v1/teams/:teamId/capacity-provider-memberships', async (c) => {
		try {
			const access = await read(c); if (access.response) return access.response;
			return c.json({
				ok: true,
				payload: await service.listMembershipsPage(c.req.param('teamId'), {
					status: c.req.query('status'),
					providerId: c.req.query('providerId'),
					limit: c.req.query('limit'),
					cursor: c.req.query('cursor'),
				}),
			});
		} catch (error) { return errorResponse(c, error); }
	});

	app.get('/v1/teams/:teamId/capacity-provider-memberships/:membershipId', async (c) => {
		try {
			const access = await read(c); if (access.response) return access.response;
			return c.json({ ok: true, payload: await service.membership(c.req.param('teamId'), c.req.param('membershipId')) });
		} catch (error) { return errorResponse(c, error); }
	});

	app.get('/v1/teams/:teamId/capacity-audit-events', async (c) => {
		try {
			const access = await read(c); if (access.response) return access.response;
			return c.json({
				ok: true,
				payload: await new CapacityAuditRepository(options.store).listPage(c.req.param('teamId'), {
					providerId: c.req.query('providerId'),
					membershipId: c.req.query('membershipId'),
					action: c.req.query('action'),
					resourceType: c.req.query('resourceType'),
					resourceId: c.req.query('resourceId'),
					limit: c.req.query('limit'),
					cursor: c.req.query('cursor'),
				}),
			});
		} catch (error) { return errorResponse(c, error); }
	});

	app.get('/v1/teams/:teamId/capacity-provider-memberships/:membershipId/credentials', async (c) => {
		try {
			const access = await read(c); if (access.response) return access.response;
			return c.json({
				ok: true,
				payload: await service.listCredentialsPage(c.req.param('teamId'), c.req.param('membershipId'), {
					status: c.req.query('status'),
					limit: c.req.query('limit'),
					cursor: c.req.query('cursor'),
				}),
			});
		} catch (error) { return errorResponse(c, error); }
	});

	app.post('/v1/teams/:teamId/capacity-provider-memberships/:membershipId/credentials/:credentialId/revoke', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			const principal = actorId(c); if (!principal) throw new CapacityGovernanceError('authentication_required', 'Authentication is required.', 401);
			return c.json({ ok: true, payload: await service.revokeCredential(c.req.param('teamId'), c.req.param('membershipId'), c.req.param('credentialId'), principal, idempotencyKey(c)) });
		} catch (error) { return errorResponse(c, error); }
	});

	app.post('/v1/teams/:teamId/capacity-provider-memberships/:membershipId/credentials/rotate', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			const principal = actorId(c); if (!principal) throw new CapacityGovernanceError('authentication_required', 'Authentication is required.', 401);
			return c.json({ ok: true, payload: await service.authorizeTeamCredentialRotation(c.req.param('teamId'), c.req.param('membershipId'), principal, idempotencyKey(c)) }, { status: 201 });
		} catch (error) { return errorResponse(c, error); }
	});

	app.post('/v1/provider/credential-rotation', async (c) => {
		try {
			const principal = providerAccessPrincipal(c);
			return c.json({ ok: true, payload: await service.authorizeProviderCredentialRotation(principal, idempotencyKey(c)) }, { status: 201 });
		} catch (error) { return errorResponse(c, error); }
	});

	app.post('/v1/provider/membership/leave', async (c) => {
		try {
			const principal = providerAccessPrincipal(c);
			return c.json({ ok: true, payload: await service.leaveMembership(principal, idempotencyKey(c)) });
		} catch (error) { return errorResponse(c, error); }
	});

	app.post('/v1/provider/identity/rotate', async (c) => {
		try {
			const principal = providerAccessPrincipal(c);
			const body = await readCapacityRequestObject(c);
			return c.json({ ok: true, payload: await service.rotateIdentity(principal, identityRotationRequest(body), idempotencyKey(c)) });
		} catch (error) { return errorResponse(c, error); }
	});

	const updateMembership = (action: 'suspend' | 'resume' | 'revoke') => async (c: Context) => {
			try {
				const access = await manage(c); if (access.response) return access.response;
				const principal = actorId(c); if (!principal) throw new CapacityGovernanceError('authentication_required', 'Authentication is required.', 401);
				const status = action === 'suspend' ? 'suspended' : action === 'resume' ? 'approved' : 'revoked';
				return c.json({ ok: true, payload: await service.updateMembership(c.req.param('teamId'), c.req.param('membershipId'), principal, status, idempotencyKey(c)) });
			} catch (error) { return errorResponse(c, error); }
		};
	app.post('/v1/teams/:teamId/capacity-provider-memberships/:membershipId/suspend', updateMembership('suspend'));
	app.post('/v1/teams/:teamId/capacity-provider-memberships/:membershipId/resume', updateMembership('resume'));
	app.post('/v1/teams/:teamId/capacity-provider-memberships/:membershipId/revoke', updateMembership('revoke'));
}
