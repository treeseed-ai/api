import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const parserFault=vi.hoisted(()=>({nonbinary:false}));
vi.mock('tar-stream',async original=>{
	const actual=await original<typeof import('tar-stream')>();
	return {...actual,extract:(...args:Parameters<typeof actual.extract>)=>{
		if(!parserFault.nonbinary)return actual.extract(...args);
		const emitter=new EventEmitter();
		return Object.assign(emitter,{end(){const stream=new EventEmitter();emitter.emit('entry',{name:'template/file',type:'file'},stream,()=>emitter.emit('finish'));
			stream.emit('data',null);stream.emit('end');},destroy(error:Error){emitter.emit('error',error);}});
	}};
});
import { createPlatformProjectCreationService,templateFiles } from '../../../../src/api/control-plane/projects/platform-project-creation-service.ts';
import { pack } from 'tar-stream';
import { gzipSync } from 'node:zlib';

const digest = `sha256:${'b'.repeat(64)}`;
const target = {
	slug: 'example-app', team: 'team-1', template: { id: 'engineering', version: '1.0.0-rc.5', digest },
	repository: { owner: 'example', name: 'example-app', visibility: 'private' as const },
};

const store = { async getProjectByTeamAndSlug() { return null; }, async listHubRepositories() { return []; }, async getProjectTreeDxLibrary() { return null; } };

describe('Platform project creation authority observation', () => {
	it('template binary stream denies a nonbinary dependency chunk with its own retained diagnostic',async()=>{
		parserFault.nonbinary=true;
		const bytes=gzipSync(Buffer.alloc(0)),held=Buffer.from(bytes);
		try{await expect(templateFiles(bytes,'agent-execution')).rejects.toThrow('Template file file does not contain binary bytes.');expect(bytes.equals(held)).toBe(true);}
		finally{parserFault.nonbinary=false;}
	});
	it('template input bounds deny oversized compressed bytes or malformed gzip without changing supplied bytes',async()=>{
		const invalid=Buffer.from('not a gzip archive'),held=Buffer.from(invalid);
		await expect(templateFiles(invalid,'agent-execution')).rejects.toThrow();expect(invalid.equals(held)).toBe(true);
		const oversized=Buffer.alloc(8*1024*1024+1);
		await expect(templateFiles(oversized,'agent-execution')).rejects.toThrow('The compressed project template exceeds the 8 MiB safety limit.');
		expect(oversized.every(byte=>byte===0)).toBe(true);
	});
	it('native tar and gzip template parsing retains exact binary bytes and bounds unsafe empty and oversized expanded entries',async()=>{
		const archive=async(entries:Array<{name:string;bytes:Buffer}>)=>{
			const stream=pack();for(const entry of entries)stream.entry({name:entry.name},entry.bytes);stream.finalize();
			const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(chunk);return gzipSync(Buffer.concat(chunks));
		};
		const binary=Buffer.from([0,255,128,1]),text=Buffer.from('# __SITE_NAME__\n__SITE_SLUG__\n');
		const bytes=await archive([{name:'template/README.md',bytes:text},{name:'template/assets/data.bin',bytes:binary}]),held=Buffer.from(bytes);
		const files=await templateFiles(bytes,'agent-execution');
		expect([...files.keys()]).toEqual(['README.md','assets/data.bin']);
		expect(files.get('README.md')).toEqual(Buffer.from('# Agent Execution\nagent-execution\n'));expect(files.get('assets/data.bin')).toEqual(binary);
		expect(bytes.equals(held)).toBe(true);expect(text.toString()).toBe('# __SITE_NAME__\n__SITE_SLUG__\n');expect(binary).toEqual(Buffer.from([0,255,128,1]));
		for(const name of ['template/../escape','/absolute','template/nested/./file']){
			const unsafe=await archive([{name,bytes:Buffer.from('held')}]),before=Buffer.from(unsafe);
			await expect(templateFiles(unsafe,'agent-execution')).rejects.toThrow('The project template contains an unsafe entry.');expect(unsafe.equals(before)).toBe(true);
		}
		await expect(templateFiles(await archive([]),'agent-execution')).rejects.toThrow('The project template contains no files.');
		await expect(templateFiles(await archive([{name:'template/large.bin',bytes:Buffer.alloc(4*1024*1024+1)}]),'agent-execution')).rejects.toThrow('Template file large.bin exceeds 4 MiB.');
	});
	it('plans a new project without performing any mutation', async () => {
		const fetchImpl = async () => new Response(null, { status: 404 });
		const service = createPlatformProjectCreationService(store, { env: {}, fetchImpl: fetchImpl as typeof fetch });
		await expect(service.plan(target)).resolves.toMatchObject({ ok: true, actions: [
			{ step: 'project', action: 'create' }, { step: 'repository', action: 'adopt' }, { step: 'template', action: 'apply' },
			{ step: 'library', action: 'bind' }, { step: 'inventory', action: 'publish' },
		] });
	});

	it('derives the repository owner from portable team configuration', async () => {
		const configuredStore = { ...store, async getTeam() { return { metadata: { repositoryOwner: 'example' } }; } };
		const service = createPlatformProjectCreationService(configuredStore, { env: {}, fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch });
		await expect(service.plan({ ...target, repository: { name: 'example-app', visibility: 'private' } } as never))
			.resolves.toMatchObject({ repository: { owner: 'example', name: 'example-app', visibility: 'private' } });
	});

	it('derives the repository owner from the active team project inventory', async () => {
		const inventoryStore = {
			...store,
			async getTeam() { return { metadata: {} }; },
			async first() { return null; },
			async listTeamProjects() { return [{ id: 'project-1' }]; },
			async listHubRepositories() { return [{ role: 'primary', owner: 'example', name: 'platform' }]; },
		};
		const service = createPlatformProjectCreationService(inventoryStore, { env: {}, fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch });
		await expect(service.plan({ ...target, repository: { name: 'example-app', visibility: 'private' } } as never))
			.resolves.toMatchObject({ repository: { owner: 'example', name: 'example-app', visibility: 'private' } });
	});

	it('fails closed when a nonempty unmanaged repository already owns the requested identity', async () => {
		const fetchImpl = async () => new Response(JSON.stringify({ id: 7, name: 'example-app', owner: { login: 'example' }, private: true, size: 12,
			html_url: 'https://github.com/example/example-app' }), { status: 200, headers: { 'content-type': 'application/json' } });
		const service = createPlatformProjectCreationService(store, { env: {}, fetchImpl: fetchImpl as typeof fetch });
		await expect(service.plan(target)).resolves.toMatchObject({ ok: false, blockers: ['repository_conflicts_with_requested_target'] });
	});
});
