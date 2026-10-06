import { describe,expect,it } from 'vitest';
import { managedTeamLibrarySeedFiles } from '../../../../src/api/teams/managed-team-library-service.ts';
import { parseBook,parseKnowledgePage,validateKnowledgeCatalog } from '../../../../src/api/knowledge/runtime/catalog.ts';
import { requireKnowledgePageBookPath } from '../../../../src/api/knowledge/snapshot-projects.ts';
import { parseFrontmatterDocument } from '../../../../src/api/content/frontmatter.ts';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';

describe('managed Team Library content',()=>{
	it('creates only book-owned documents in the knowledge directory',()=>{
		const entries=Object.entries(managedTeamLibrarySeedFiles('team-library-project'));
		const objective=entries.find(([path])=>path==='objectives/core.mdx')?.[1];
		expect(validatePortableContentData('objective',parseFrontmatterDocument(objective??'').frontmatter).ok).toBe(true);
		const books=entries.filter(([path])=>path.startsWith('books/')).map(([path,raw])=>parseBook({path,raw}));
		const pages=entries.filter(([path])=>path.startsWith('knowledge/')).map(([path,raw])=>{
			expect(path.split('/')).toHaveLength(3);
			const page=parseKnowledgePage({path,raw});
			requireKnowledgePageBookPath(path,'knowledge/',page);
			return page;
		});
		validateKnowledgeCatalog(books,pages);
		expect(()=>validateKnowledgeCatalog(books,[{...pages[0]!,bookRef:{...pages[0]!.bookRef,digest:`sha256:${'0'.repeat(64)}`}},...pages.slice(1)])).toThrow(/exact owning Book/);
		expect(()=>validateKnowledgeCatalog(books,[{...pages[0]!,bookRef:{...pages[0]!.bookRef,revision:2}},...pages.slice(1)])).toThrow(/exact owning Book/);
		expect(()=>validateKnowledgeCatalog(books,[{...pages[0]!,bookRef:{...pages[0]!.bookRef,path:'books/another.md'}},...pages.slice(1)])).toThrow(/exact owning Book/);
		expect(books.map((book)=>book.id)).toEqual(['team-operations']);
		expect(pages).toHaveLength(6);
		expect(pages.map((page)=>page.id)).toContain('team-knowledge-authoring');
	});
});
