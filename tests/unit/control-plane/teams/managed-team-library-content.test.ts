import { describe,expect,it } from 'vitest';
import { managedTeamLibrarySeedFiles } from '../../../../src/api/teams/managed-team-library-service.ts';
import { parseBook,parseKnowledgePage,validateKnowledgeCatalog } from '../../../../src/api/knowledge/runtime/catalog.ts';
import { requireKnowledgePageBookPath } from '../../../../src/api/knowledge/snapshot-projects.ts';

describe('managed Team Library content',()=>{
	it('creates only book-owned documents in the knowledge directory',()=>{
		const entries=Object.entries(managedTeamLibrarySeedFiles);
		const books=entries.filter(([path])=>path.startsWith('books/')).map(([path,raw])=>parseBook({path,raw}));
		const pages=entries.filter(([path])=>path.startsWith('knowledge/')).map(([path,raw])=>{
			expect(path.split('/')).toHaveLength(3);
			const page=parseKnowledgePage({path,raw});
			requireKnowledgePageBookPath(path,'knowledge/',page);
			return page;
		});
		validateKnowledgeCatalog(books,pages);
		expect(books.map((book)=>book.id)).toEqual(['team-operations']);
		expect(pages).toHaveLength(6);
		expect(pages.map((page)=>page.id)).toContain('team-knowledge-authoring');
	});
});
