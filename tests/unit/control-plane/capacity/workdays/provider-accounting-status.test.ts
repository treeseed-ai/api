import { describe, expect, it } from 'vitest';
import { providerAccountingStatus } from '../../../../../src/api/control-plane/repositories/providers/provider-runtime-service.ts';

describe('provider accounting diagnostics', () => {
	it('returns the existing capability/model report without arbitrary metadata or credentials', () => {
		const observation = { day: '2026-09-17', observedAt: '2026-09-17T00:00:00Z', healthy: true,
			activeSeconds: 30, reservedSeconds: 40, credential: 'must-not-appear' };
		const status = providerAccountingStatus(JSON.stringify([{ id: 'codex-research', status: 'active', runtimeBuild: 'exact-build',
			credential: 'must-not-appear', nativeLimits: { credential: 'must-not-appear', modelConfigurationId: 'sol-medium', dailyActiveSecondsLimit: 7200,
				capabilityLimits: { research: { dailyActiveSecondsLimit: 7200 } } },
			accountingObservation: { modelUsage: observation, capabilityUsage: { research: observation }, token: 'must-not-appear' } }]));
		expect(status[0]).toMatchObject({ id: 'codex-research', nativeLimits: { dailyActiveSecondsLimit: 7200 },
			accountingObservation: { modelUsage: { activeSeconds: 30, reservedSeconds: 40 } } });
		expect(JSON.stringify(status)).not.toContain('must-not-appear');
		expect(providerAccountingStatus(null)).toEqual([]);
	});
});

it('retains original typed configured model policy without exposing private adapter observations or repairing invalid model authority',()=>{
 const modelPolicy={provider:'openai',model:'configured-luna',reasoningEffort:'low',capabilities:['treeseed.research.synthesis'],maxInputTokens:1234,maxOutputTokens:456,maxCost:7};
 const rows=[{id:'arbitrary-configured-provider',status:'active',runtimeBuild:'exact-build',observations:{modelPolicy,credential:'must-not-appear',token:'must-not-appear'},nativeLimits:{modelConfigurationId:'configured-model-low',dailyActiveSecondsLimit:7200,capabilityLimits:{'treeseed.research.synthesis':{dailyActiveSecondsLimit:7200}}},accountingObservation:{modelUsage:{day:'2026-10-16',observedAt:'2026-10-16T00:00:00Z',healthy:true,activeSeconds:1,reservedSeconds:2},capabilityUsage:{}}}],held=structuredClone(rows);
 const read=(input:unknown)=>providerAccountingStatus(JSON.stringify(input));
 const observed=read(rows);expect(Reflect.get(Object(observed[0]),'modelPolicy')).toEqual(modelPolicy);expect(JSON.stringify(observed)).not.toContain('must-not-appear');expect(rows).toEqual(held);
 for(const value of [undefined,null,{},[],{...modelPolicy,model:''},{...modelPolicy,reasoningEffort:'unknown'},{...modelPolicy,maxInputTokens:0},{...modelPolicy,maxCost:-1},{...modelPolicy,credential:'must-not-appear'}]){const changed=structuredClone(rows);Reflect.set(changed[0]!.observations,'modelPolicy',value);const before=structuredClone(changed),status=read(changed);expect(Reflect.get(Object(status[0]),'modelPolicy')).toBeUndefined();expect(JSON.stringify(status)).not.toContain('must-not-appear');expect(changed).toEqual(before);}
 const different=structuredClone(rows);different[0]!.id='renamed-configured-provider';different[0]!.observations.modelPolicy.model='configured-other';different[0]!.observations.modelPolicy.reasoningEffort='high';expect(Reflect.get(Object(read(different)[0]),'modelPolicy')).toEqual(different[0]!.observations.modelPolicy);expect(rows).toEqual(held);
});
