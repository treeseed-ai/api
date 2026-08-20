import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe,expect,it } from 'vitest';

const readRepositoryFile = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('API licensing policy', () => {
	it('publishes the canonical AGPLv3 license and matching package metadata', () => {
		const license = readRepositoryFile('LICENSE');
		const manifest = JSON.parse(readRepositoryFile('package.json')) as { license?: string };

		expect(license).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
		expect(license).toContain('TERMS AND CONDITIONS');
		expect(license).toContain('13. Remote Network Interaction; Use with the GNU General Public License.');
		expect(license).toContain('END OF TERMS AND CONDITIONS');
		expect(manifest.license).toBe('AGPL-3.0-only');
	});

	it('describes the commercial alternative without narrowing AGPL rights', () => {
		const notice = readRepositoryFile('COMMERCIAL.md');

		expect(notice).toContain('permits commercial use');
		expect(notice).toContain('competing network services');
		expect(notice).toContain('without the AGPL obligations');
		expect(notice).toContain('No runtime DRM');
	});

	it('records audited identities and enforces one-time GitHub username approval', () => {
		const provenance = readRepositoryFile('docs/licensing-provenance.md');
		const template = readRepositoryFile('.github/PULL_REQUEST_TEMPLATE.md');
		const workflow = readRepositoryFile('.github/workflows/agpl-committer-authorization.yml');
		const policy = JSON.parse(readRepositoryFile('.github/approved-committers.json')) as { schemaVersion: number; repository: string; approvedGitHubUsernames: string[] };
		const approval = readRepositoryFile('.github/COMMITTER_APPROVAL.md');

		expect(provenance).toContain('Status: complete for the currently reachable repository history.');
		expect(provenance).toContain('Adrian Webb `<adrian@webb.sh>`');
		expect(provenance).toContain('TreeSeed migration `<operations@treeseed.dev>`');
		expect(policy).toEqual({ schemaVersion: 1, repository: 'treeseed-ai/api', approvedGitHubUsernames: ['adrianwebb'] });
		expect(template).not.toContain('Contribution grant');
		expect(template).not.toContain('contribution-attestation');
		expect(template).toContain('There is no per-PR grant checkbox');
		expect(workflow).toContain('pull_request_target:');
		expect(workflow).toContain('core.setFailed');
		expect(workflow).toContain('pr?.user?.login');
		expect(workflow).toContain('ref: pr.base.sha');
		expect(workflow).toContain('.github/approved-committers.json');
		expect(workflow).toContain('actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b');
		expect(workflow).not.toContain('actions/checkout');
		expect(workflow).not.toContain('pull_request?.body');
		expect(workflow).not.toContain('author.email');
		expect(workflow).not.toContain('commit.author');
		expect(approval).toContain('Future pull requests opened by that GitHub account pass without another grant checkbox.');
	});
});
