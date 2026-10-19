import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseBook } from '../../../../../src/api/knowledge/runtime/catalog.ts';
import { describe,expect,it,vi } from 'vitest';
import { createKnowledgeWorkspaceService } from '../../../../../src/api/control-plane/knowledge/knowledge-workspace-service.ts';
import { managedTeamLibrarySeedFiles } from '../../../../../src/api/teams/managed-team-library-service.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts',async(original)=>({
	...await original<typeof import('../../../../../src/api/knowledge/gateway-treedx-connection.ts')>(),
	resolveKnowledgeGatewayConnection:vi.fn(),
}));

describe('Book revision custody',()=>{
	it('replaces an invalid historical Book without validating the retired source shape',async()=>{
		const workspace={id:'draft-legacy',projectId:'project',actorUserId:'author',status:'draft',version:1,
			treeDxWorkspaceId:'remote',baseCommitSha:'a'.repeat(40),baseRef:'staging',
			branchName:'refs/heads/knowledge/draft-legacy',allowedPaths:['books/**','knowledge/**']};
		const source='---\nschemaVersion: treeseed.book/v2\nid: core\nslug: core\ntitle: Core\nsummary: Legacy book\nstatus: published\nvisibility: team\norder: 0\ntopics: []\n---\n';
		const client={readFile:vi.fn(async()=>({sha:'old-sha',content:source})),
			listRepositoryPaths:vi.fn(async()=>({resolvedRef:'a'.repeat(40),entries:[],page:{hasMore:false}})),
			status:vi.fn(async()=>({changes:[]})),applyChangeset:vi.fn(async()=>({applied:true}))};
		vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({client,contentPath:'.',repositoryId:'repo-1'} as never);
		const store={getKnowledgeWorkspace:vi.fn(async()=>workspace),
			getProjectDetails:vi.fn(async()=>({project:{id:'project',teamId:'team'}})),
			principalCanAccessTeam:vi.fn(async()=>true),
			getTeamAccessSummary:vi.fn(async()=>({permissions:['knowledge:author']})),
			updateKnowledgeWorkspace:vi.fn(async()=>({ok:true,workspace:{...workspace,version:2}})),
			recordAuditEvent:vi.fn(async()=>undefined)};
		const service=createKnowledgeWorkspaceService(store,{projectCatalog:vi.fn(async()=>({books:[],pages:[]}))});
		await service.updateContent({id:'author'},workspace.id,{kind:'book',version:1,sourcePath:'books/core.md',
			id:'core',slug:'core',title:'Core',summary:'Governed book',visibility:'team',order:0});
		expect(client.applyChangeset.mock.calls[0]?.[0]?.patch).toContain('treeseed.book/v3');
	});
	it('repins every existing page in the same governed changeset as its Book update',async()=>{
		const seed=managedTeamLibrarySeedFiles('project');
		const bookPath='books/team-operations.md';
		const pagePath='knowledge/team-operations/communication-standards.md';
		const workspace={id:'draft-1',projectId:'project',actorUserId:'author',status:'draft',version:1,
			treeDxWorkspaceId:'remote',baseCommitSha:'a'.repeat(40),baseRef:'staging',
			branchName:'refs/heads/knowledge/draft-1',allowedPaths:['books/**','knowledge/**']};
		const client={
			readFile:vi.fn(async({path}:{path:string})=>({sha:'existing-sha',content:seed[path]})),
			listRepositoryPaths:vi.fn(async()=>({resolvedRef:'a'.repeat(40),entries:[{path:bookPath},{path:pagePath}],page:{hasMore:false}})),
			status:vi.fn(async()=>({changes:[]})),
			applyChangeset:vi.fn(async(_input:{patch:string})=>({applied:true})),
		};
		vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({client,contentPath:'.',repositoryId:'repo-1'} as never);
		const store={
			getKnowledgeWorkspace:vi.fn(async()=>workspace),
			getProjectDetails:vi.fn(async()=>({project:{id:'project',teamId:'team'}})),
			principalCanAccessTeam:vi.fn(async()=>true),
			getTeamAccessSummary:vi.fn(async()=>({permissions:['knowledge:author']})),
			updateKnowledgeWorkspace:vi.fn(async()=>({ok:true,workspace:{...workspace,version:2}})),
			recordAuditEvent:vi.fn(async()=>undefined),
		};
		const service=createKnowledgeWorkspaceService(store,{projectCatalog:vi.fn(async()=>({books:[],pages:[]}))});
		await service.updateContent({id:'author'},workspace.id,{kind:'book',version:1,sourcePath:bookPath,
			id:'team-operations',slug:'team-operations',title:'Team Operations',summary:'Updated team standards.',
			visibility:'team',order:0});
		const patch=client.applyChangeset.mock.calls[0]?.[0]?.patch ?? '';
		expect(patch).toContain(bookPath);
		expect(patch).toContain(pagePath);
		expect(patch).toContain('revision: 2');
	});

	it.each([
		['legacyv2', 'treeseed.book/v2', '\n'],
		['currentv3', 'treeseed.book/v3', '\n'],
		['legacyv2 CRLF', 'treeseed.book/v2', '\r\n'],
		['currentv3 CRLF', 'treeseed.book/v3', '\r\n'],
	])('preserves exact Markdown body bytes for a metadata update of a %s Book', async (label, schemaVersion, newline) => {
		const bookPath = 'books/team-operations.md';
		const seed = managedTeamLibrarySeedFiles('workspace-project');
		const currentSource = seed[bookPath];
		if (typeof currentSource !== 'string') throw new Error(`Missing canonical Book fixture: ${bookPath}`);

		const body = ['Distinctive body — naïve café 雪.', 'Line with trailing spaces.  ', '', 'Final paragraph Ω.', ''].join(newline);
		const separator = currentSource.indexOf('\n---\n');
		if (separator < 0) throw new Error('Canonical Book fixture has no frontmatter boundary.');
		let frontmatter = currentSource.slice(0, separator + 1);
		if (schemaVersion === 'treeseed.book/v2') {
			frontmatter = frontmatter
				.replace(/^schemaVersion: treeseed\.book\/v3\n/mu, '')
				.replace(/^projectId:.*\n/mu, '')
				.replace(/^revision:.*\n/mu, '');
			frontmatter = frontmatter.replace(/^---\n/mu, `---\nschemaVersion: ${schemaVersion}\n`);
		}
		const source = `${frontmatter}---\n${body}`;
		if (schemaVersion === 'treeseed.book/v3') {
			const fixtureBook = parseBook({ path: bookPath, raw: source });
			expect(fixtureBook.projectId).toBe('workspace-project');
			expect(fixtureBook.revision).toBe(1);
		}
		const workspace = {
			id: `draft-body-${label}`, projectId: 'workspace-project', actorUserId: 'author', status: 'draft', version: 1,
			treeDxWorkspaceId: 'remote', baseCommitSha: 'a'.repeat(40), baseRef: 'staging',
			branchName: `refs/heads/knowledge/draft-body-${label}`, allowedPaths: ['books/**', 'knowledge/**'],
		};
		const client = {
			readFile: vi.fn(async () => ({ sha: 'old-sha', content: source })),
			listRepositoryPaths: vi.fn(async () => ({ resolvedRef: 'a'.repeat(40), entries: [], page: { hasMore: false } })),
			status: vi.fn(async () => ({ changes: [] })),
			applyChangeset: vi.fn(async (_input: { patch: string }) => ({ applied: true })),
		};
		vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({ client, contentPath: '.', repositoryId: 'repo-1' } as never);
		const store = {
			getKnowledgeWorkspace: vi.fn(async () => workspace),
			getProjectDetails: vi.fn(async () => ({ project: { id: 'workspace-project', teamId: 'team' } })),
			principalCanAccessTeam: vi.fn(async () => true),
			getTeamAccessSummary: vi.fn(async () => ({ permissions: ['knowledge:author'] })),
			updateKnowledgeWorkspace: vi.fn(async () => ({ ok: true, workspace: { ...workspace, version: 2 } })),
			recordAuditEvent: vi.fn(async () => undefined),
		};
		const service = createKnowledgeWorkspaceService(store, { projectCatalog: vi.fn(async () => ({ books: [], pages: [] })) });
		await service.updateContent({ id: 'author' }, workspace.id, {
			kind: 'book', version: 1, sourcePath: bookPath,
			id: 'team-operations', slug: 'team-operations', title: 'Updated Team Operations',
			summary: 'Updated team standards.', visibility: 'team', order: 1,
		});

		const patch = client.applyChangeset.mock.calls[0]?.[0]?.patch;
		expect(patch).toBeTruthy();
		const tempDir = await mkdtemp(join(tmpdir(), 'book-body-'));
		try {
			const filePath = join(tempDir, bookPath);
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, source);
			const patchPath = join(tempDir, 'changes.patch');
			await writeFile(patchPath, patch!);
			execFileSync('git', ['apply', patchPath], { cwd: tempDir, timeout: 5_000 });

			const resulting = await readFile(filePath);
			const resultingText = resulting.toString('utf8');
			const resultingSeparator = resulting.indexOf(Buffer.from('\n---\n'));
			expect(resultingSeparator).toBeGreaterThanOrEqual(0);
			expect(resulting.subarray(resultingSeparator + 5).equals(Buffer.from(body))).toBe(true);

			const updatedBook = parseBook({ path: bookPath, raw: resultingText });
			expect(updatedBook.id).toBe('team-operations');
			expect(updatedBook.projectId).toBe('workspace-project');
			expect(updatedBook.revision).toBe(schemaVersion === 'treeseed.book/v2' ? 1 : 2);
			expect(updatedBook.title).toBe('Updated Team Operations');
			expect(updatedBook.summary).toBe('Updated team standards.');
			expect(updatedBook.order).toBe(1);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
