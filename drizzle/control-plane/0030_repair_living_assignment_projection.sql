-- Repair only malformed pre-launch living-graph rows produced before the
-- normalized assignment INSERT mapped its operational JSON columns exactly.
-- The immutable assignment attempt remains the source for every reconstructed value.
WITH malformed AS (
  SELECT id, assignment_attempt_json::jsonb AS attempt
  FROM capacity_provider_assignments
  WHERE synthesized_from = 'living_execution_graph'
    AND assignment_attempt_json IS NOT NULL
    AND (
      COALESCE(capacity_envelope_json::jsonb->>'teamId', '') = ''
      OR COALESCE(capacity_envelope_json::jsonb->>'projectId', '') = ''
      OR COALESCE(decision_input_json::jsonb->>'teamId', '') = ''
      OR COALESCE(decision_input_json::jsonb->>'projectId', '') = ''
    )
)
UPDATE capacity_provider_assignments AS assignment
SET capacity_envelope_json = jsonb_build_object(
      'teamId', team_id,
      'projectId', project_id,
      'workDayId', work_day_id,
      'mode', mode,
      'projectAgentClassId', project_agent_class_id,
      'capacityProviderId', capacity_provider_id,
      'executionProviderId', execution_provider_id,
      'reservationId', reservation_id,
      'requestedSeconds', COALESCE((malformed.attempt->'estimate'->>'expectedSeconds')::integer, 0),
      'reservedSeconds', COALESCE((malformed.attempt->'estimate'->>'expectedSeconds')::integer, 0),
      'limits', COALESCE(malformed.attempt->'limits', '{}'::jsonb),
      'budget', jsonb_build_object('time', jsonb_build_object(
        'executionDeadlineAt', malformed.attempt->>'deadline'
      ))
    )::text,
    decision_input_json = jsonb_build_object(
      'teamId', team_id,
      'projectId', project_id,
      'projectAgentClassId', project_agent_class_id,
      'mode', mode,
      'activityType', malformed.attempt->'effectiveProfile'->>'activity',
      'workDayId', work_day_id,
      'agentId', malformed.attempt->'effectiveProfile'->'profileRef'->>'id',
      'handlerId', malformed.attempt->'effectiveProfile'->>'handler',
      'capacity', jsonb_build_object(
        'teamId', team_id,
        'projectId', project_id,
        'mode', mode
      ),
      'input', '{}'::jsonb,
      'metadata', jsonb_build_object(
        'source', 'living_execution_graph',
        'nodeId', malformed.attempt->>'nodeId'
      )
    )::text,
    updated_at = CURRENT_TIMESTAMP::text
FROM malformed
WHERE assignment.id = malformed.id;
