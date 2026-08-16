import { describe,expect,it,vi } from "vitest";
import { CapacityWorkdayRecoveryRepository } from "../../../../../src/api/capacity/repositories/capacity/workdays/workday-recovery.ts";

describe("capacity workday recovery repository", () => {
  it("does not reopen an exact durable required-response suspension",async()=>{
    const queries:string[]=[];
    const database={ensureInitialized:vi.fn(async()=>undefined),first:vi.fn(async(query:string)=>{queries.push(query);return null;})} as never;
    await expect(new CapacityWorkdayRecoveryRepository(database).recoveryState({
      id:'conversation-a',teamId:'team-a',actual:{},parameters:{},status:'degraded',
    } as never)).resolves.toMatchObject({hasUnfinishedAssignments:false});
    const assignmentQuery=queries.find((query)=>query.includes('capacity_provider_assignments assignment'))??'';
    expect(assignmentQuery).toContain("assignment.lifecycle_code = 'discussion_response_required'");
    expect(assignmentQuery).toContain("invocation.status = 'suspended'");
    expect(assignmentQuery).toContain('invocation.final_message_ref IS NOT NULL');
  });

  it("deduplicates artifact references while preserving strict evidence totals", async () => {
    const database = {
      ensureInitialized: vi.fn(async () => undefined),
      first: vi.fn(async () => ({
        mode_run_count: 2,
        succeeded_mode_runs: 1,
        failed_mode_runs: 1,
      })),
      all: vi.fn(async () => [
        {
          id: "mode-a",
          outputs_json: JSON.stringify({
            artifactManifest: {
              contentReferences: [
                { model: "notes", contentPath: "notes/research/a.mdx" },
              ],
            },
          }),
        },
      ]),
    } as never;
    await expect(
      new CapacityWorkdayRecoveryRepository(database).modeRunEvidence(
        "team-a",
        "run-a",
      ),
    ).resolves.toEqual({
      modeRunCount: 2,
      succeededModeRuns: 1,
      failedModeRuns: 1,
      contentArtifactCount: 1,
	  requiredContentOutcomeAssignments: 0,
	  integratedContentOutcomeAssignments: 0,
	  abandonedContentOutcomeAssignments: 0,
	  unresolvedContentOutcomeAssignments: 0,
    });
  });

  it("fails closed when durable mode-run artifact evidence is malformed", async () => {
    const database = {
      ensureInitialized: vi.fn(async () => undefined),
      first: vi.fn(async () => ({
        mode_run_count: 1,
        succeeded_mode_runs: 1,
        failed_mode_runs: 0,
      })),
      all: vi.fn(async () => [{ id: "mode-a", outputs_json: "{broken" }]),
    } as never;
    await expect(
      new CapacityWorkdayRecoveryRepository(database).modeRunEvidence(
        "team-a",
        "run-a",
      ),
    ).rejects.toMatchObject({ code: "capacity_durable_json_invalid" });
  });

	it("requires exact integration evidence for every TreeDX mutation outcome",async()=>{
		const receipt=(assignmentId:string)=>({kind:'treedx-content',assignmentId,phase:'provisional'});
		const database={ensureInitialized:vi.fn(async()=>undefined),first:vi.fn(async()=>({mode_run_count:2,succeeded_mode_runs:2,failed_mode_runs:0})),
			all:vi.fn(async(query:string)=>query.includes('FROM audit_events')
				?[{id:'audit-a',target_id:'assignment-a',event_type:'assignment.content.integrated'},{id:'audit-b',target_id:'assignment-b',event_type:'assignment.content.abandoned'}]
				:[{id:'mode-a',assignment_id:'assignment-a',outputs_json:JSON.stringify({artifactManifest:{contentReferences:[{path:'a.mdx'}],mutationReceipts:[receipt('assignment-a')]}})},
					{id:'mode-b',assignment_id:'assignment-b',outputs_json:JSON.stringify({artifactManifest:{contentReferences:[{path:'b.mdx'}],mutationReceipts:[receipt('assignment-b')]}})}])} as never;
		await expect(new CapacityWorkdayRecoveryRepository(database).modeRunEvidence('team-a','run-a')).resolves.toMatchObject({
			requiredContentOutcomeAssignments:2,integratedContentOutcomeAssignments:1,abandonedContentOutcomeAssignments:1,unresolvedContentOutcomeAssignments:1,
		});
	});
});
