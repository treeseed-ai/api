import { describe, expect, it } from 'vitest';
import type { OperationInvocationContext } from '../../../../../../src/api/control-plane/catalog/operation-registry.ts';
import { crossProjectProxy, readGrants, secondaryProject, secondaryRepository, firstRef, secondRef } from './cross-project-proxy-fixture.ts';

describe('public secondary reads through original SQL authorization delegation and native HTTP', () => {
	it('returns exact secondary bytes with independently verified narrow signed scope for each selected commit and path', async () => {
		const f = await crossProjectProxy(); try {
			const before = await f.snapshot(), original = structuredClone(f.input);
			for (const [ref, path] of [[firstRef, 'books/first.md'], [secondRef, 'books/second.md']]) {
				const input = { ...f.input, body: { ...f.input.body, ref, paths: [path] } };
				expect(await f.invoke(input)).toMatchObject({ result: { resolvedRef: ref, files: [{ path, content: '# Exact secondary bytes\n' }] },
					receipt: { projectId: secondaryProject, connectionId: 'isolated-connection' } });
				expect(f.calls.at(-1), JSON.stringify(f.calls.at(-1))).toEqual({ method: 'POST', path: `/api/v1/repos/${secondaryRepository}/files/read`, body: input.body,
					scope: { treedx_actor_id: 'isolated-service', treedx_tenant_id: 'isolated-tenant', treedx_repo_ids: [secondaryRepository],
						treedx_capabilities: ['files:read'], treedx_refs: [ref], treedx_paths: [path], treeseed_project_id: secondaryProject,
						treeseed_connection_id: 'isolated-connection' } });
			}
			expect((await f.audit()).items).toHaveLength(2); expect(await f.snapshot()).toEqual(before); expect(f.input).toEqual(original);
			f.setFault('403');
			const unscoped = { ...f.input, body: { ...f.input.body, paths: [] } }, unchanged = structuredClone(unscoped);
			await expect(f.invoke(unscoped)).rejects.toMatchObject({ status: 403 });
			expect(f.calls.at(-1)).toMatchObject({ body: unscoped.body,
				scope: { treedx_refs: [secondRef], treedx_paths: ['books/second.md'] } });
			expect((await f.audit()).items).toHaveLength(2); expect(await f.snapshot()).toEqual(before);
			expect(unscoped).toEqual(unchanged);
		} finally { await f.close(); }
	});
	it('denies missing foreign moved and out of path secondary grants before upstream while retaining durable denial audit and frozen finance', async () => {
		const outcomes: boolean[] = [];
		for (const mutation of ['missing', 'foreign-project', 'foreign-repository', 'moved', 'path', 'empty-paths', 'empty-paths-unscoped', 'wildcard', 'wildcard-single']) {
			const f = await crossProjectProxy(); try {
				const grants = readGrants();
				if (mutation === 'foreign-project') grants[1]!.projectId = 'foreign';
				if (mutation === 'foreign-repository') grants[1]!.repositoryId = 'foreign';
				if (mutation === 'moved') grants[1]!.baseRef = 'd'.repeat(40);
				if (mutation.startsWith('empty-paths')) grants[1]!.allowedPaths = [];
				await f.setGrants(mutation === 'missing' ? [] : grants);
				const input = { ...f.input, body: { ...f.input.body, ...(mutation === 'path' ? { paths: ['private/foreign.md'] } : {}),
					...(mutation.startsWith('wildcard') ? { paths: [mutation === 'wildcard' ? '**' : '*'] } : {}),
					...(mutation === 'empty-paths-unscoped' ? { paths: [] } : {}) } };
				const before = await f.snapshot(), original = structuredClone(input);
				try { await f.invoke(input); outcomes.push(false); } catch { outcomes.push(true); }
				expect(f.calls).toEqual([]); expect(await f.snapshot()).toEqual(before); expect(input).toEqual(original);
				expect((await f.audit()).items).toEqual([expect.objectContaining({ resultStatus: 'denied', projectId: secondaryProject,
					assignmentId: f.attempt.id, actorId: 'provider', actorType: 'capacity_provider' })]);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(Array(9).fill(true));
	});
	it('revoked expired and malformed handle authority cannot be bypassed by a different secondary repository identity', async () => {
		const outcomes: boolean[] = [];
		for (const mutation of ['revoked', 'expired', 'malformed-clock', 'foreign-assignment', 'wrong-token']) {
			const f = await crossProjectProxy(); try {
				if (mutation === 'revoked') await f.query("UPDATE treedx_proxy_handles SET status='revoked',revoked_at=? WHERE id=?", [new Date().toISOString(), f.handleId]);
				if (mutation === 'expired' || mutation === 'malformed-clock') await f.query('UPDATE treedx_proxy_handles SET expires_at=? WHERE id=?',
					[mutation === 'expired' ? new Date(0).toISOString() : 'not-a-clock', f.handleId]);
				if (mutation === 'foreign-assignment') await f.query("UPDATE treedx_proxy_handles SET assignment_id='foreign' WHERE id=?", [f.handleId]);
				const context = { ...f.context, requestHeaders: { ...f.context.requestHeaders,
					...(mutation === 'wrong-token' ? { 'x-treeseed-treedx-proxy-handle': 'wrong-disposable-token' } : {}) } };
				const before = await f.snapshot();
				try { await f.invoke(f.input, context); outcomes.push(false); } catch { outcomes.push(true); }
				expect(f.calls).toEqual([]); expect(await f.snapshot()).toEqual(before);
				expect((await f.audit()).items).toEqual([expect.objectContaining({ resultStatus: 'denied' })]);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(Array(5).fill(true));
	});
	it('denies released elapsed unknown clock foreign provider and missing scope authority before secondary HTTP without rewriting the original attempt', async () => {
		const outcomes: boolean[] = [];
		for (const mutation of ['released', 'elapsed', 'unknown-clock', 'foreign-provider', 'missing-scope', 'missing-handle', 'missing-provider']) {
			const f = await crossProjectProxy(); try {
				if (mutation === 'released') await f.query("UPDATE capacity_provider_assignments SET lease_state='released' WHERE id=?", [f.attempt.id]);
				if (mutation === 'elapsed' || mutation === 'unknown-clock') await f.query('UPDATE capacity_provider_assignments SET lease_expires_at=? WHERE id=?',
					[mutation === 'elapsed' ? new Date(0).toISOString() : 'not-a-clock', f.attempt.id]);
				const principal = structuredClone(f.context.providerAuth.principal);
				const context: OperationInvocationContext = { ...f.context, providerAuth: { principal } };
				if (mutation === 'foreign-provider') principal.capacityProviderId = 'foreign-provider';
				if (mutation === 'missing-scope') principal.scopes = [];
				if (mutation === 'missing-handle') context.requestHeaders = {};
				if (mutation === 'missing-provider') context.providerAuth = undefined;
				const before = await f.snapshot();
				try { await f.invoke(f.input, context); outcomes.push(false); } catch { outcomes.push(true); }
				expect(f.calls).toEqual([]); expect(await f.snapshot()).toEqual(before);
				expect((await f.audit()).items.every(value => value.resultStatus === 'denied')).toBe(true);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(Array(7).fill(true));
	});
	it('secondary read grants never authorize workspace creation writes or a foreign repository even with a provider write token', async () => {
		const f = await crossProjectProxy(); try {
			const before = await f.snapshot();
			await expect(f.invoke({ ...f.input, body: { branch: 'foreign-workspace', baseRef: secondRef } }, f.context, 'treedx.workspaces.create')).rejects.toMatchObject({ status: 403 });
			await expect(f.invoke({ ...f.input, path: { ...f.input.path, repoId: 'foreign-library' } })).rejects.toMatchObject({ status: 403 });
			expect(f.calls).toEqual([]); expect(await f.snapshot()).toEqual(before);
			expect((await f.audit()).items.every(value => value.resultStatus === 'denied')).toBe(true);
		} finally { await f.close(); }
	});
	it('duplicate exact grants and conflicting path authority deny rather than signing the first secondary entry', async () => {
		const outcomes: boolean[] = [];
		for (const mutation of ['duplicate', 'conflicting-path']) {
			const f = await crossProjectProxy(); try {
				const grants = readGrants(); grants.push({ ...grants[1]!, ...(mutation === 'conflicting-path' ? { allowedPaths: ['private/foreign.md'] } : {}) });
				await f.setGrants(grants); const before = await f.snapshot();
				try { await f.invoke(); outcomes.push(false); } catch { outcomes.push(true); }
				expect(f.calls).toEqual([]); expect(await f.snapshot()).toEqual(before);
				expect((await f.audit()).items).toEqual([expect.objectContaining({ resultStatus: 'denied' })]);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual([true, true]);
	});
	it('denied unavailable reset malformed and preaborted native reads never create successful audit finance or widened retry authority', async () => {
		const outcomes: boolean[] = [];
		for (const fault of ['403', '503', 'reset', 'json', 'abort'] as const) {
			const f = await crossProjectProxy(); try {
				if (fault !== 'abort') f.setFault(fault);
				const controller = new AbortController(); if (fault === 'abort') controller.abort();
				const before = await f.snapshot(), input = structuredClone(f.input);
				try { await f.invoke(f.input, { ...f.context, signal: controller.signal }); outcomes.push(false); } catch { outcomes.push(true); }
				expect(await f.snapshot()).toEqual(before); expect(f.input).toEqual(input); expect((await f.audit()).items).toEqual([]);
				if (fault === 'abort') expect(f.calls).toEqual([]);
				else { expect(f.calls.length).toBeGreaterThanOrEqual(1); expect(f.calls.length).toBeLessThanOrEqual(2);
					for (const call of f.calls) { expect(call.body).toEqual(input.body); expect(call.scope.treedx_refs).toEqual([secondRef]);
						expect(call.path).toBe(`/api/v1/repos/${secondaryRepository}/files/read`); } }
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(Array(5).fill(true));
	});
	it('repeated and concurrent exact secondary reads preserve one frozen authority with distinct actual proxy audits and no assignment or financial mutation', async () => {
		const f = await crossProjectProxy(); try {
			const before = await f.snapshot(), input = structuredClone(f.input);
			const values = [await f.invoke(), ...await Promise.all([f.invoke(), f.invoke()])];
			for (const value of values) expect(value).toMatchObject({ result: { resolvedRef: secondRef }, receipt: { projectId: secondaryProject } });
			expect(await f.snapshot()).toEqual(before); expect(f.input).toEqual(input); expect(f.calls).toHaveLength(3);
			const audit = await f.audit(); expect(audit.items).toHaveLength(3); expect(audit.page.hasMore).toBe(false);
			expect(new Set(audit.items.map(value => value.id)).size).toBe(3);
			for (const value of audit.items) expect(value).toMatchObject({ projectId: secondaryProject, assignmentId: f.attempt.id, actorId: 'provider', resultStatus: 'proxied' });
		} finally { await f.close(); }
	});
	it('native audit persistence interruption fails the public read and retry retains the same scope without false successful history or financial mutation', async () => {
		const f = await crossProjectProxy(); try {
			const before = await f.snapshot();
			await f.db.exec(`CREATE FUNCTION deny_read_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated audit interruption'; END $$;
				CREATE TRIGGER deny_read_audit BEFORE INSERT ON treedx_project_proxy_audit FOR EACH ROW EXECUTE FUNCTION deny_read_audit();`);
			await expect(f.invoke()).rejects.toThrow(); expect(f.calls).toHaveLength(1);
			expect((await f.audit()).items).toEqual([]); expect(await f.snapshot()).toEqual(before);
			await f.db.exec('DROP TRIGGER deny_read_audit ON treedx_project_proxy_audit; DROP FUNCTION deny_read_audit();');
			expect(await f.invoke()).toMatchObject({ result: { resolvedRef: secondRef }, receipt: { projectId: secondaryProject } });
			expect(f.calls).toHaveLength(2); expect(f.calls[1]).toEqual(f.calls[0]); expect((await f.audit()).items).toHaveLength(1);
			expect(await f.snapshot()).toEqual(before);
		} finally { await f.close(); }
	});
});
