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

	it('records audited identities and enforces future contribution grants', () => {
		const provenance = readRepositoryFile('docs/licensing-provenance.md');
		const template = readRepositoryFile('.github/PULL_REQUEST_TEMPLATE.md');
		const workflow = readRepositoryFile('.github/workflows/contributor-license.yml');

		expect(provenance).toContain('Status: complete for the currently reachable repository history.');
		expect(provenance).toContain('Adrian Webb `<adrian@webb.sh>`');
		expect(provenance).toContain('TreeSeed migration `<operations@treeseed.dev>`');
		expect(template).toContain('- [ ] I have read `CONTRIBUTING.md`');
		expect(workflow).toContain('pull_request:');
		expect(workflow).toContain('core.setFailed');
		expect(workflow).toContain('Contribution grant affirmation');
	});
});
