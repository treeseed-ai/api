-- An unreported stop is failed closeout, never a successfully ended workday.
-- Preserve the erroneous plan and original error as historical evidence. Do not
-- synthesize a report, alter assignment/usage history, or reopen admissions.
UPDATE capacity_workday_runs
SET status = 'failed',
    error_json = (error_json::jsonb || jsonb_build_object(
      'code', 'workday_closeout_report_missing',
      'message', 'Prior closeout marked the workday ended without its exact report.',
      'previousError', error_json::jsonb,
      'unreportedEndedPlan', parameters_json::jsonb->'appliedPlan'
    ))::text,
    parameters_json = jsonb_set(parameters_json::jsonb, '{appliedPlan}',
      ((parameters_json::jsonb->'appliedPlan') - 'endedAt') || '{"state":"closing"}'::jsonb
    )::text
WHERE execution_kind = 'workday'
  AND parameters_json::jsonb#>>'{appliedPlan,state}' = 'ended'
  AND (parameters_json::jsonb#>'{appliedPlan,reportRef}' IS NULL
    OR parameters_json::jsonb#>'{appliedPlan,reportRef}' = 'null'::jsonb);
