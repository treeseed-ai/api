import {describe,expect,it} from 'vitest';
import {buildAssignmentAttempt} from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import {canonicalOfferBuildInput,candidate,run,provider,sourceRef,withIdentityRead} from '../fixtures/assignment-attempt-fixtures.ts';
describe('frozen Workday workspace authority',()=>{
 it('gives a subscribed estimator the exact shared proposal workspace without changing its allocation project',()=>{
  const input=canonicalOfferBuildInput(),exact=structuredClone(input.candidate);
  exact.node.kind='estimating';exact.node.pairRole=null;delete exact.node.workItemId;exact.node.workspace='treedx';
  exact.node.sourceRef={...sourceRef,repository:'ui-library'};
  exact.node.requestedPermissions={content:{read:['proposal'],write:['proposal']},tools:['source.read']};
  exact.effectiveProfile.activity='estimating';exact.effectiveProfile.permissionCeiling=withIdentityRead(exact.node.requestedPermissions) as never;
  exact.contextRefs=[exact.node.sourceRef];exact.projectContentRepositoryId='sdk-library';
  const before=structuredClone(exact),result=buildAssignmentAttempt({...input,candidate:exact}).assignment;
  expect(result.projectId).toBe(exact.node.projectId);expect(result.workspace).toMatchObject({mode:'treedx',repository:'ui-library',baseCommit:sourceRef.commit});
  expect(result.grant.contentWrite).toEqual([exact.node.sourceRef]);expect(exact).toEqual(before);
  const own={store:'treedx' as const,model:'agent',id:'renamed/maintenance',repository:'sdk-library',commit:'f'.repeat(40),path:'agents/maintenance.mdx'};
  exact.effectiveProfile.profileRef=own;
  exact.node.requestedPermissions.content.read.push('agent');
  exact.effectiveProfile.permissionCeiling=exact.node.requestedPermissions;
  const held=structuredClone(exact),withProfile=buildAssignmentAttempt({...input,candidate:exact}).assignment;
  expect(withProfile.contextRefs).toContainEqual(own);expect(withProfile.grant.contentRead).toContainEqual(own);
  expect(withProfile.grant.sourceWrite).toEqual([]);expect(withProfile.grant.tools).toEqual(['source.read']);
  expect(withProfile.grant.contentWrite).toEqual([exact.node.sourceRef]);expect(exact).toEqual(held);
  exact.node.requestedPermissions.content.read=['proposal'];
  exact.effectiveProfile.permissionCeiling=withIdentityRead(exact.node.requestedPermissions) as never;
  const narrowed=buildAssignmentAttempt({...input,candidate:exact}).assignment;
  expect(narrowed.contextRefs).toContainEqual(own);expect(narrowed.grant.contentRead).toContainEqual(own);
  exact.effectiveProfile.permissionCeiling=exact.node.requestedPermissions;
  expect(()=>buildAssignmentAttempt({...input,candidate:exact})).toThrow(expect.objectContaining({code:'assignment_permission_ceiling_exceeded'}));
 });
 it('keeps a lifecycle workspace on its held workday project context when the governed library advances before issuance',()=>{
  const input=canonicalOfferBuildInput(),exact=structuredClone(input.candidate),held={store:'treedx' as const,model:'knowledge',id:exact.node.projectId+':project-context',repository:exact.projectContentRepositoryId,commit:'d'.repeat(40),path:'README.md',revision:1,digest:'sha256:'+'4'.repeat(64)};
  exact.node.kind='reporting';exact.node.pairRole=null;exact.node.workspace='treedx';exact.node.sourceRef={store:'postgresql',model:'workday',id:input.run.id,revision:1,digest:'sha256:'+'1'.repeat(64)};
  exact.node.requestedPermissions={content:{read:['knowledge'],write:['note']},tools:[]};exact.effectiveProfile.activity='reporting';exact.effectiveProfile.permissionCeiling=withIdentityRead(exact.node.requestedPermissions) as never;
  exact.effectiveProfile.permissionCeiling.content.read.push('objective');
  exact.contextRefs=[{...held,id:'current-project-objective',commit:'e'.repeat(40),model:'objective',path:'objectives/core'},held];
  const run={...input.run,parameters:{...input.run.parameters,workdayContextByProjectId:{[exact.node.projectId]:held},appliedPlan:{...input.run.parameters.appliedPlan as object,state:'closing'}}};
  const before=structuredClone({exact,run}),build=()=>buildAssignmentAttempt({...input,candidate:exact,run});
  const result=build().assignment;expect(result.workspace).toMatchObject({mode:'treedx',baseCommit:held.commit});expect(result.grant.contentWrite[0]!.commit).toBe(held.commit);
  exact.contextRefs[0]!.commit='f'.repeat(40);expect(build().assignment.workspace).toEqual(result.workspace);
  expect(run).toEqual(before.run);
  for(const mode of ['missing','foreign','moved-context']){
   const denied=structuredClone(run);
   if(mode==='missing')Reflect.deleteProperty(denied.parameters,'workdayContextByProjectId');
   if(mode==='foreign')denied.parameters.workdayContextByProjectId[exact.node.projectId]!.repository='foreign';
   if(mode==='moved-context')denied.parameters.workdayContextByProjectId[exact.node.projectId]!.commit='a'.repeat(40);
   const unchanged=structuredClone(denied);expect(()=>buildAssignmentAttempt({...input,candidate:exact,run:denied})).toThrow('original exact workday project context');expect(denied).toEqual(unchanged);
  }
 });
});

const opportunity = canonicalOfferBuildInput().allocationInputs.codex!.opportunity;
	it.each(['workday', 'shared-proposal'])('writes planning content to its project library with %s read-only context', subject => {
		const planning = structuredClone(candidate);
		planning.node.kind = 'planning';
		planning.node.workspace = 'treedx';
		planning.node.sourceRef = { store: 'postgresql', model: 'workday', id: 'workday', revision: 1,
			digest: `sha256:${'2'.repeat(64)}` } as never;
		if (subject === 'shared-proposal') planning.node.sourceRef = { ...sourceRef, repository: 'ui-library' };
		planning.node.requestedPermissions = { content: { read: ['proposal', 'objective', 'book'], write: ['note'] }, tools: ['source.read'] } as never;
		if (subject === 'shared-proposal') planning.node.requestedPermissions.content.write.push('proposal');
		planning.effectiveProfile.permissionCeiling = withIdentityRead(planning.node.requestedPermissions) as never;
		const team = { store: 'treedx', model: 'objective', id: 'team-objective', repository: 'team-library',
			commit: '8'.repeat(40), path: 'objectives/team.md', revision: 1, digest: `sha256:${'8'.repeat(64)}` };
		const project = { store: 'treedx', model: 'objective', id: 'sdk-objective', repository: 'sdk-library',
			commit: '9'.repeat(40), path: 'objectives/sdk.md', revision: 1, digest: `sha256:${'9'.repeat(64)}` };
		planning.contextRefs = [planning.node.sourceRef, team, project] as never;
		planning.projectContentRepositoryId = 'sdk-library';
		const result = buildAssignmentAttempt({ candidate: planning as never, run,
			principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
			allocationInputs: { codex: { opportunity, measurements: [], constraints: [] } }, providerSessionId: 'session',
			providers: [provider] as never, attempt: 1, now: '2026-09-13T12:00:00.000Z' });
		expect(result.assignment.contextRefs).toContainEqual(team);
		expect(result.assignment.workspace).toMatchObject({ mode: 'treedx', repository: 'sdk-library', baseCommit: '9'.repeat(40) });
		expect(result.assignment.grant.contentWrite).toEqual(planning.node.requestedPermissions.content.write
			.map(model => expect.objectContaining({ model, repository: 'sdk-library' })));
		expect(result.assignment.grant.contentRead).toContainEqual(team);
		if (subject === 'shared-proposal') expect(result.assignment.grant.contentRead).toContainEqual(planning.node.sourceRef);
	});
