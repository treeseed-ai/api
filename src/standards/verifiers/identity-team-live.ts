#!/usr/bin/env node
import { createVerifiedAccount, deleteVerifiedAccount, verifyAccountJourneys } from './accounts.ts';
import { VerifierHttp } from './http.ts';
import { verifyTeamJourneys } from './teams.ts';
import { verifyDeviceFlow } from './oauth.ts';

function option(name: string, fallback = '') {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const startedAt = new Date().toISOString();
const apiOrigin = option('api-origin', process.env.TREESEED_API_BASE_URL ?? 'http://api:3000');
const mailpitOrigin = option('mailpit-origin', process.env.TREESEED_MAILPIT_BASE_URL ?? 'http://mailpit:8025');
const adminOrigin = option('admin-origin', process.env.TREESEED_ADMIN_BASE_URL ?? 'https://admin.treeseed.localhost');
const checks: Array<{ id: string; status: 'passed' | 'failed'; durationMs: number; error?: string }> = [];

async function check(id: string, task: () => Promise<void>) {
	const started = Date.now();
	try { await task(); checks.push({ id, status: 'passed', durationMs: Date.now() - started }); }
	catch (error) { checks.push({ id, status: 'failed', durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }); }
}

const http = new VerifierHttp(apiOrigin);
let owner: Awaited<ReturnType<typeof createVerifiedAccount>> | null = null;
await check('api.identity.registration-confirmation-oauth', async () => {
	owner = await createVerifiedAccount(http, mailpitOrigin, adminOrigin, 'owner');
});
if (owner) await check('api.identity.account-lifecycle', async () => verifyAccountJourneys(http, mailpitOrigin, owner!));
else checks.push({ id: 'api.identity.account-lifecycle', status: 'failed', durationMs: 0, error: 'Registration prerequisite failed.' });
if (owner) await check('api.identity.device-approval', async () => verifyDeviceFlow(http, owner!.accessToken));
else checks.push({ id: 'api.identity.device-approval', status: 'failed', durationMs: 0, error: 'Identity prerequisite failed.' });
if (owner) await check('api.teams.lifecycle-authority-cleanup', async () => verifyTeamJourneys(http, mailpitOrigin, adminOrigin, owner!));
else checks.push({ id: 'api.teams.lifecycle-authority-cleanup', status: 'failed', durationMs: 0, error: 'Identity prerequisite failed.' });
if (owner) await check('api.identity.cleanup', async () => deleteVerifiedAccount(http, owner!));
else checks.push({ id: 'api.identity.cleanup', status: 'failed', durationMs: 0, error: 'Identity prerequisite failed.' });

const report = {
	schemaVersion: 'treeseed.guarantee-verifier-result/v1', verifierId: '@treeseed/api/identity-team-live',
	startedAt, completedAt: new Date().toISOString(), environment: { apiOrigin, mailpitOrigin, adminOrigin },
	ok: checks.every((entry) => entry.status === 'passed'), checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
