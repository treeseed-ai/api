import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createAccountDeleteOperation, createAccountDeletionBlockersOperation, createAccountEmailAddOperation, createAccountEmailConfirmOperation, createAccountEmailPrimaryOperation, createAccountEmailRemoveOperation, createAccountEmailsOperation, createAccountEmailVerifyOperation, createAccountIdentityOperation, createAccountNotificationReadOperation, createAccountNotificationsOperation, createAccountPasswordResetCompleteOperation, createAccountPasswordResetRequestOperation, createAccountPasswordUpdateOperation, createAccountPreferencesOperation, createAccountPreferencesUpdateOperation, createAccountProfileUpdateOperation, createAccountPublicProfileOperation, createAccountRegisterOperation, createAccountSessionRevokeOperation, createAccountSessionsOperation } from '../../../src/api/control-plane/catalog/account-operations.ts';
import { createAccountSecurityService } from '../../../src/api/control-plane/accounts/account-security-service.ts';
import { Hono } from 'hono';
import { createOperationHttpHandler } from '../../../src/api/control-plane/http/operation-http-handler.ts';
import { controlPlaneErrorStatus } from '../../../src/api/control-plane/catalog/operation-registry.ts';
import { createOrResendUserEmailAddress } from '../../../src/api/app/support/accounts/authentication-email.ts';
import { ControlPlaneStore } from '../../../src/api/persistence/store.ts';
import { postgresGraph } from './capacity/execution/graph/architecture/living/living-postgres-fixture.ts';

const context = { principal: { id: 'user-1', displayName: 'Adrian', metadata: { sessionId: 'current-session' } },
	interface: 'rest' as const, requestId: 'request-1', ifMatch: 'account-v1' };

function dependencies() {
	const run = vi.fn(async (query: string, parameters?: unknown[]) => ({ meta: { changes: query.includes('COALESCE(updated_at') && parameters?.at(-1) !== 'account-v1' ? 0 : 1 } }));
	const recordAuditEvent = vi.fn(async () => undefined);
	return { run, recordAuditEvent, value: {
		store: {
			async loadUserProfileByUsername(username: string) { return username === 'adrian' ? { user: { username: 'adrian', displayName: 'Adrian' }, knowledge: [] } : null; },
			async listTeamsForPrincipal() { return []; },
			async listProjectsForPrincipal() { return [{ id: 'project-1' }]; },
			async first(query: string) {
				if (query.includes('FROM users')) return { username: 'adrian', display_name: 'Adrian', metadata_json: '{"expertise":["systems"]}', updated_at: 'account-v1' };
				if (query.includes('FROM user_preferences')) return null;
				if (query.includes('control_plane_auth_credentials')) return { user_id: 'user-1' };
				return { revoked_at: null };
			},
			async all(query: string) { return query.includes('auth_sessions') ? [{ id: 'session-2', session_type: 'oauth', data_json: '{}', created_at: '2026-08-21T00:00:00Z', updated_at: '2026-08-21T00:00:00Z' }] : []; },
			run, recordAuditEvent,
		},
		async listUserEmailAddresses() { return [{ id: 'email-1', email: 'adrian@example.test' }]; },
		accountEmails: {
			async add() { return { ok: true, emailAddress: { id: 'email-2' }, verificationSent: true }; },
			async verify() { return { ok: true, emailAddress: { id: 'email-2' }, verificationSent: true }; },
			async makePrimary() { return { ok: true, emailAddress: { id: 'email-1', isPrimary: true } }; },
			async remove() { return { ok: true, items: [{ id: 'email-1' }] }; },
		},
		accountRegistration: {
			async register() { return { ok: true, confirmationRequired: true, email: 'adrian@example.test', expiresInSeconds: 3600 }; },
			async confirm() { return { ok: true, confirmed: true }; },
		},
		accountSecurity: {
			async updatePassword() { return { ok: true, changed: true }; },
			async requestPasswordReset() { return { ok: true, sent: true }; },
			async completePasswordReset() { return { ok: true, changed: true }; },
			async deletionBlockers() { return { blockers: [], canDelete: true }; },
			async removeAccount() { return { ok: true, deleted: true }; },
		},
	} as any };
}

describe('account catalog operations', () => {
	it('identity prerequisites retain supported failure status and deny coercion before publishing success', async () => {
		for(const status of [400,401,403,404,409,412,413,422,429,500,502,503,undefined,null,'','502',200,501,504,NaN,Infinity,{},[]]){
			const fixture=dependencies(),result={ok:false,status,code:'original_identity_failure',message:'Retained original failure.'},before=structuredClone(result);
			fixture.value.accountSecurity.requestPasswordReset=async()=>result;fixture.value.accountEmails.add=async()=>result;
			const expected={status:controlPlaneErrorStatus(status??400),code:result.code,message:result.message};
			await expect(createAccountPasswordResetRequestOperation(fixture.value).handler({path:{},query:{},body:{email:'identity@example.test'}},context)).rejects.toMatchObject(expected);
			await expect(createAccountEmailAddOperation(fixture.value).handler({path:{},query:{},body:{email:'identity@example.test'}},context)).rejects.toMatchObject(expected);
			expect(result).toEqual(before);expect(fixture.recordAuditEvent).not.toHaveBeenCalled();
		}
	});
	it('public identity HTTP boundary preserves failed observations and exact successful retry without coercing status', async () => {
		const fixture=dependencies(),failure={ok:false,status:'502',code:'original_identity_failure',message:'Retained original failure.'},held=structuredClone(failure);
		const inputs:unknown[]=[];
		fixture.value.accountSecurity.requestPasswordReset=async(email:unknown)=>{inputs.push(email);return inputs.length===1?failure:{ok:true,sent:true};};
		const app=new Hono();app.post('/reset',createOperationHttpHandler(createAccountPasswordResetRequestOperation(fixture.value),async()=>{throw new Error('Public operation must not require authentication');},'identity-contract'));
		const request=()=>app.request('/reset',{method:'POST',headers:{'content-type':'application/json','idempotency-key':'same-identity-request'},body:'{"email":"identity@example.test"}'});
		const denied=await request(),body=await denied.json(),accepted=await request(),success=await accepted.json();
		expect(accepted.status).toBe(200);expect(success).toEqual({data:{ok:true,sent:true}});
		expect(inputs).toEqual(['identity@example.test','identity@example.test']);expect(failure).toEqual(held);
		expect(denied.status).toBe(500);
		expect(body).toMatchObject({status:500,code:failure.code,detail:failure.message,instance:'/reset'});
		expect(body).toMatchObject({status:500,code:failure.code,detail:failure.message});
	});
	it('identity email preparation denies missing read-back before or after confirmation without false successful receipts', async () => {
		const observed:unknown[]=[];
		for(const stage of ['insert','confirmation']){
			const store=new ControlPlaneStore({}, {prepare(){throw new Error('Unexpected unit SQL');}}),input={email:'identity@example.test',skipDelivery:true},before=structuredClone(input);
			const pending={id:'email',user_id:'user',email:input.email,normalized_email:input.email,status:'pending',is_primary:0,verification_requested_at:null,verified_at:null,created_at:'held',updated_at:'held'};
			const first=vi.spyOn(store,'first');
			if(stage==='insert')first.mockResolvedValueOnce(null).mockResolvedValueOnce({count:0}).mockResolvedValueOnce(null);
			else first.mockResolvedValueOnce(pending).mockResolvedValueOnce(null);
			const run=vi.spyOn(store,'run').mockResolvedValue({});let cause:unknown;
			try{await createOrResendUserEmailAddress(store,{locals:{}},'user',input);}catch(error){cause=error;}
			observed.push(cause);expect(input).toEqual(before);
			if(stage==='insert')expect(run.mock.calls.some(([sql])=>sql.includes('INSERT INTO better_auth_verification'))).toBe(false);
		}
		for(const cause of observed)expect(cause).toMatchObject({message:'Email address could not be read back.'});
	});
	it('native identity email preparation retains missing-readback failures and confirmation rows before current-authority retry', async () => {
		const f=await postgresGraph();
		try{
			const store=new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},f.left);store.initializationPromise=Promise.resolve();
			const observed:unknown[]=[];
			for(const stage of ['insert','confirmation']){
				const input={email:`${stage}@identity.example.test`,skipDelivery:true},before=structuredClone(input);
				await f.left.pool.query(`CREATE FUNCTION moved_identity_email() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.id := 'interrupted-' || NEW.id; RETURN NEW; END $$;
					CREATE TRIGGER moved_identity_email BEFORE ${stage==='insert'?'INSERT':'UPDATE'} ON user_email_addresses FOR EACH ROW ${stage==='confirmation'?'WHEN (NEW.verification_requested_at IS NOT NULL)':''} EXECUTE FUNCTION moved_identity_email()`);
				let cause:unknown;try{await createOrResendUserEmailAddress(store,{locals:{}},'user',input);}catch(error){cause=error;}observed.push(cause);
				const rows=(await f.right.pool.query('SELECT * FROM user_email_addresses WHERE normalized_email=$1',[input.email])).rows;
				expect(rows).toHaveLength(1);expect(rows[0].id).toMatch(/^interrupted-/);
				const verification=(await f.right.pool.query('SELECT * FROM better_auth_verification ORDER BY id')).rows;
				if(stage==='insert')expect(verification).toEqual([]);else expect(verification).toHaveLength(2);
				await f.left.pool.query('DROP TRIGGER moved_identity_email ON user_email_addresses; DROP FUNCTION moved_identity_email()');
				const retry=await createOrResendUserEmailAddress(store,{locals:{}},'user',input);
				expect(retry).toMatchObject({ok:true,verificationSent:true,emailAddress:{id:rows[0].id,status:'pending',email:input.email}});
				const current=(await f.right.pool.query('SELECT * FROM user_email_addresses WHERE normalized_email=$1',[input.email])).rows;
				expect(current[0]).toMatchObject({id:rows[0].id,user_id:rows[0].user_id,status:rows[0].status,created_at:rows[0].created_at});
				const retained=(await f.right.pool.query('SELECT * FROM better_auth_verification ORDER BY id')).rows;
				for(const row of verification)expect(retained).toContainEqual(row);
				expect(input).toEqual(before);
			}
			for(const cause of observed)expect(cause).toMatchObject({message:'Email address could not be read back.'});
		}finally{await f.close();}
	});
	it('serves public user profiles without requiring a principal', async () => {
		const operation = createAccountPublicProfileOperation(dependencies().value);
		await expect(operation.handler({ path: { username: 'adrian' }, query: {}, body: undefined }, { interface: 'rest', requestId: 'public-1' }))
			.resolves.toMatchObject({ user: { username: 'adrian' } });
		await expect(operation.handler({ path: { username: 'missing' }, query: {}, body: undefined }, { interface: 'rest', requestId: 'public-2' }))
			.rejects.toMatchObject({ status: 404, code: 'user_profile_missing' });
		expect(operation.binding).toBe(CONTROL_PLANE_OPERATIONS.accounts.publicProfile);
	});
	it('projects identity, emails, and sessions without transport-owned behavior', async () => {
		const fixture = dependencies();
		const input = { path: {}, query: {}, body: undefined };
		const identity = await createAccountIdentityOperation(fixture.value).handler(input, context);
		const emails = await createAccountEmailsOperation(fixture.value).handler(input, context);
		const sessions = await createAccountSessionsOperation(fixture.value).handler(input, context);
		expect(identity).toMatchObject({ id: 'user-1', username: 'adrian', hasCredential: true, expertise: ['systems'] });
		expect(emails).toEqual({ items: [{ id: 'email-1', email: 'adrian@example.test' }] });
		expect(sessions).toMatchObject({ items: [{ id: 'session-2', current: false }] });
		expect(createAccountIdentityOperation(fixture.value).binding).toBe(CONTROL_PLANE_OPERATIONS.accounts.identity);
	});

	it('revokes a non-current session with an audit receipt', async () => {
		const fixture = dependencies();
		const operation = createAccountSessionRevokeOperation(fixture.value);
		const output = await operation.handler({ path: { sessionId: 'session-2' }, query: {}, body: {} }, context);
		expect(output).toEqual({ id: 'session-2', status: 'revoked' });
		expect(fixture.run).toHaveBeenCalledOnce();
		expect(fixture.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'auth.session.revoked' }));
		expect(operation.binding).toBe(CONTROL_PLANE_OPERATIONS.accounts.revokeSession);
	});

	it('updates profile and preferences through API-owned validation', async () => {
		const fixture = dependencies();
		const profile = await createAccountProfileUpdateOperation(fixture.value).handler({ path: {}, query: {}, body: {
			displayName: 'Adrian Webb', website: 'https://example.test', expertise: ['systems'],
		} }, context);
		const preferences = await createAccountPreferencesUpdateOperation(fixture.value).handler({ path: {}, query: {}, body: {
			timeZone: 'America/New_York', realTimeUpdates: true, realTimePollingIntervalSeconds: 5,
		} }, { ...context, ifMatch: '0' });
		expect(profile).toMatchObject({ changed: true, updatedAt: expect.any(String) });
		expect(preferences).toMatchObject({ colorScheme: 'fern', themeMode: 'system', timeZone: 'America/New_York', realTimeUpdates: true, realTimePollingIntervalSeconds: 5, updatedAt: expect.any(String) });
		expect(createAccountPreferencesOperation(fixture.value).binding).toBe(CONTROL_PLANE_OPERATIONS.accounts.preferences);
	});

	it('rejects stale account and preference revisions without mutation', async () => {
		const fixture = dependencies();
		await expect(createAccountProfileUpdateOperation(fixture.value).handler({ path: {}, query: {}, body: { displayName: 'Changed' } }, { ...context, ifMatch: 'stale' }))
			.rejects.toMatchObject({ status: 412, code: 'account_precondition_failed' });
		await expect(createAccountPreferencesUpdateOperation(fixture.value).handler({ path: {}, query: {}, body: { timeZone: 'UTC' } }, { ...context, ifMatch: 'stale' }))
			.rejects.toMatchObject({ status: 412, code: 'account_preferences_precondition_failed' });
		expect(fixture.run).toHaveBeenCalledTimes(1);
		expect(fixture.run.mock.calls[0]?.[0]).toContain('COALESCE(updated_at');
	});

	it('filters notifications by accessible projects and marks one read', async () => {
		const fixture = dependencies();
		fixture.value.store.all = async (query: string) => query.includes('notification_events') ? [{
			id: 'notification-1', project_id: 'project-1', event_type: 'assignment.updated', created_at: '2026-08-21T00:00:00Z',
		}, { id: 'hidden', project_id: 'project-2' }] : [];
		fixture.value.store.first = async () => ({ id: 'notification-1', read_at: null });
		const listed = await createAccountNotificationsOperation(fixture.value).handler({ path: {}, query: { limit: 20 }, body: undefined }, context);
		const read = await createAccountNotificationReadOperation(fixture.value).handler({ path: { notificationId: 'notification-1' }, query: {}, body: {} }, context);
		expect(listed).toMatchObject({ items: [{ id: 'notification-1', projectId: 'project-1' }] });
		expect(read).toMatchObject({ id: 'notification-1', readAt: expect.any(String) });
	});

	it('uses API-owned email custody without returning session credentials', async () => {
		const fixture = dependencies();
		const added = await createAccountEmailAddOperation(fixture.value).handler({ path: {}, query: {}, body: { email: 'new@example.test' } }, context);
		const verified = await createAccountEmailVerifyOperation(fixture.value).handler({ path: { emailId: 'email-2' }, query: {}, body: {} }, context);
		const primary = await createAccountEmailPrimaryOperation(fixture.value).handler({ path: { emailId: 'email-1' }, query: {}, body: {} }, context);
		const removed = await createAccountEmailRemoveOperation(fixture.value).handler({ path: { emailId: 'email-2' }, query: {}, body: {} }, context);
		expect(added).toMatchObject({ verificationSent: true });
		expect(verified).toMatchObject({ verificationSent: true });
		expect(primary).toEqual({ emailAddress: { id: 'email-1', isPrimary: true } });
		expect(removed).toEqual({ items: [{ id: 'email-1' }] });
		expect(JSON.stringify([added, verified, primary, removed])).not.toMatch(/accessToken|refreshToken|sessionToken/iu);
	});

	it('registers and confirms without minting web-session credentials', async () => {
		const fixture = dependencies();
		const registered = await createAccountRegisterOperation(fixture.value).handler({ path: {}, query: {}, body: {
			email: 'adrian@example.test', username: 'adrian', password: 'redacted-password',
		} }, { interface: 'rest', requestId: 'request-public' });
		const confirmed = await createAccountEmailConfirmOperation(fixture.value).handler({ path: {}, query: {}, body: {
			token: 'redacted-token',
		} }, { interface: 'rest', requestId: 'request-public' });
		expect(registered).toMatchObject({ confirmationRequired: true, email: 'adrian@example.test' });
		expect(confirmed).toEqual({ ok: true, confirmed: true });
		expect(JSON.stringify([registered, confirmed])).not.toMatch(/accessToken|refreshToken|sessionToken/iu);
		expect(createAccountRegisterOperation(fixture.value).binding).toBe(CONTROL_PLANE_OPERATIONS.accounts.register);
	});

	it('routes password and account deletion through the API security service', async () => {
		const fixture = dependencies();
		const body = { currentPassword: 'redacted-current', password: 'redacted-new-password' };
		expect(await createAccountPasswordUpdateOperation(fixture.value).handler({ path: {}, query: {}, body }, context)).toMatchObject({ changed: true });
		expect(await createAccountPasswordResetRequestOperation(fixture.value).handler({ path: {}, query: {}, body: { email: 'adrian@example.test' } }, context)).toMatchObject({ sent: true });
		expect(await createAccountPasswordResetCompleteOperation(fixture.value).handler({ path: {}, query: {}, body: { token: 'redacted', password: 'redacted-new-password' } }, context)).toMatchObject({ changed: true });
		expect(await createAccountDeletionBlockersOperation(fixture.value).handler({ path: {}, query: {}, body: undefined }, context)).toEqual({ blockers: [], canDelete: true });
		expect(await createAccountDeleteOperation(fixture.value).handler({ path: {}, query: {}, body: { confirmation: 'DELETE MY ACCOUNT' } }, context)).toMatchObject({ deleted: true });
	});

	it('rejects an invalid account deletion confirmation before claiming the account revision', async () => {
		const fixture = dependencies();
		await expect(createAccountDeleteOperation(fixture.value).handler({ path: {}, query: {}, body: { confirmation: 'DELETE' } }, context))
			.rejects.toMatchObject({ status: 409, code: 'confirmation_required' });
		expect(fixture.run).not.toHaveBeenCalled();
	});

	it('claims a password reset token atomically before changing the credential', async () => {
		const statements: string[] = [];
		const store = {
			ensureInitialized: vi.fn(),
			async first(query: string) {
				statements.push(query);
				return query.startsWith('UPDATE control_plane_auth_password_resets') ? { id: 'reset-1', user_id: 'user-1' } : null;
			},
			async run(query: string) { statements.push(query); },
			recordAuditEvent: vi.fn(),
		};
		const service = createAccountSecurityService(store, {});
		await expect(service.completePasswordReset({ token: 'reset_secret', password: 'a sufficiently long password' }))
			.resolves.toMatchObject({ ok: true, changed: true });
		expect(statements[0]).toContain('used_at IS NULL');
		expect(statements[0]).toContain('RETURNING id, user_id');
		expect(statements[1]).toContain('UPDATE control_plane_auth_credentials');
	});

	it('does not change a password when the atomic reset claim loses a race', async () => {
		const run = vi.fn();
		const service = createAccountSecurityService({ ensureInitialized: vi.fn(), first: vi.fn(async () => null), run,
			recordAuditEvent: vi.fn() }, {});
		await expect(service.completePasswordReset({ token: 'reset_secret', password: 'a sufficiently long password' }))
			.resolves.toMatchObject({ ok: false, status: 401, code: 'invalid_password_reset' });
		expect(run).not.toHaveBeenCalled();
	});
});
