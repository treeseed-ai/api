-- TreeSeed API control-plane baseline generated from the accepted pre-launch schema.

CREATE TABLE "better_auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" bigint,
	"refreshTokenExpiresAt" bigint,
	"scope" text,
	"password" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);

CREATE TABLE "better_auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" bigint NOT NULL,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);

CREATE TABLE "capacity_execution_providers" (
	"id" text NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"display_name" text NOT NULL,
	"adapter" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"capabilities_json" text DEFAULT '[]' NOT NULL,
	"native_unit" text NOT NULL,
	"quota_visibility" text DEFAULT 'opaque' NOT NULL,
	"max_concurrent_runners" integer NOT NULL,
	"native_limits_json" text DEFAULT '[]' NOT NULL,
	"latest_observation_json" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "capacity_execution_providers_capacity_provider_id_id_pk" PRIMARY KEY("capacity_provider_id","id"),
	CONSTRAINT "chk_capacity_execution_providers_status" CHECK ("capacity_execution_providers"."status" IN ('active', 'degraded', 'unavailable', 'revoked')),
	CONSTRAINT "chk_capacity_execution_providers_concurrency" CHECK ("capacity_execution_providers"."max_concurrent_runners" >= 1)
);

CREATE TABLE "capacity_provider_credential_issuance_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"membership_id" text NOT NULL,
	"team_id" text NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"generation" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"issued_credential_id" text,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_provider_credential_authorizations_generation" CHECK ("capacity_provider_credential_issuance_authorizations"."generation" >= 1),
	CONSTRAINT "chk_capacity_provider_credential_authorizations_status" CHECK ("capacity_provider_credential_issuance_authorizations"."status" IN ('pending', 'issued', 'cancelled'))
);

CREATE TABLE "capacity_provider_identity_rotations" (
	"id" text PRIMARY KEY NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"from_identity_version" integer NOT NULL,
	"to_identity_version" integer NOT NULL,
	"old_fingerprint" text NOT NULL,
	"new_fingerprint" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "chk_capacity_provider_identity_rotations_versions" CHECK ("capacity_provider_identity_rotations"."from_identity_version" >= 1 AND "capacity_provider_identity_rotations"."to_identity_version" = "capacity_provider_identity_rotations"."from_identity_version" + 1)
);

CREATE TABLE "capacity_provider_lanes" (
	"id" text NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"execution_provider_id" text NOT NULL,
	"display_name" text NOT NULL,
	"purpose" text DEFAULT 'operation' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"capabilities_json" text DEFAULT '[]' NOT NULL,
	"max_concurrent_runners" integer NOT NULL,
	"native_limits_json" text DEFAULT '[]' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "capacity_provider_lanes_capacity_provider_id_id_pk" PRIMARY KEY("capacity_provider_id","id"),
	CONSTRAINT "chk_capacity_provider_lanes_status" CHECK ("capacity_provider_lanes"."status" IN ('active', 'paused', 'degraded', 'revoked')),
	CONSTRAINT "chk_capacity_provider_lanes_purpose" CHECK ("capacity_provider_lanes"."purpose" IN ('communication', 'operation')),
	CONSTRAINT "chk_capacity_provider_lanes_concurrency" CHECK ("capacity_provider_lanes"."max_concurrent_runners" >= 1)
);

CREATE TABLE "capacity_provider_registration_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"provider_fingerprint" text NOT NULL,
	"registration_key_generation" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"capability_summary_json" text DEFAULT '[]' NOT NULL,
	"supply_offer_json" text DEFAULT '{}' NOT NULL,
	"proof_jti" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"expires_at" text NOT NULL,
	"reviewed_at" text,
	"reviewed_by_id" text,
	"rejection_reason" text,
	"membership_id" text,
	"transition_action" text,
	"transition_idempotency_key" text,
	"transition_request_digest" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_provider_registration_requests_generation" CHECK ("capacity_provider_registration_requests"."registration_key_generation" >= 1),
	CONSTRAINT "chk_capacity_provider_registration_requests_status" CHECK ("capacity_provider_registration_requests"."status" IN ('pending', 'approved', 'rejected', 'cancelled', 'expired'))
);

CREATE TABLE "capacity_provider_team_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"team_alias" text,
	"approved_at" text NOT NULL,
	"approved_by_id" text NOT NULL,
	"suspended_at" text,
	"revoked_at" text,
	"revoked_by_id" text,
	"status_idempotency_key" text,
	"status_request_digest" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_provider_team_memberships_status" CHECK ("capacity_provider_team_memberships"."status" IN ('approved', 'suspended', 'revoked'))
);

CREATE TABLE "capacity_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"public_jwk_json" text NOT NULL,
	"display_name" text NOT NULL,
	"identity_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"rotated_at" text,
	"revoked_at" text,
	CONSTRAINT "chk_capacity_providers_identity_version" CHECK ("capacity_providers"."identity_version" >= 1),
	CONSTRAINT "chk_capacity_providers_status" CHECK ("capacity_providers"."status" IN ('active', 'rotating', 'revoked'))
);

CREATE TABLE "team_capacity_registration_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"generation" integer NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"encrypted_reveal_value" text NOT NULL,
	"rotation_idempotency_key" text,
	"status_idempotency_key" text,
	"status_request_digest" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"rotated_at" text,
	"last_revealed_at" text,
	CONSTRAINT "chk_team_capacity_registration_keys_generation" CHECK ("team_capacity_registration_keys"."generation" >= 1),
	CONSTRAINT "chk_team_capacity_registration_keys_status" CHECK ("team_capacity_registration_keys"."status" IN ('active', 'disabled'))
);

CREATE TABLE "team_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"email" text NOT NULL,
	"role_key" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" text,
	"accepted_by_user_id" text,
	"accepted_at" text,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "agent_lab_view_state" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"namespace" text NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"pinned" integer DEFAULT 0 NOT NULL,
	"hidden" integer DEFAULT 0 NOT NULL,
	"resolved" integer DEFAULT 0 NOT NULL,
	"layout_json" text DEFAULT '{}' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "cursor_state" (
	"agent_slug" text,
	"cursor_key" text,
	"status" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"updated_at" text NOT NULL,
	"payload_json" text NOT NULL,
	"meta_json" text NOT NULL,
	CONSTRAINT "cursor_state_agent_slug_cursor_key_pk" PRIMARY KEY("agent_slug","cursor_key")
);

CREATE TABLE "lease_state" (
	"model" text,
	"item_key" text,
	"status" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"claimed_by" text,
	"claimed_at" text,
	"lease_expires_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"payload_json" text NOT NULL,
	"meta_json" text NOT NULL,
	CONSTRAINT "lease_state_model_item_key_pk" PRIMARY KEY("model","item_key")
);

CREATE TABLE "credit_conversion_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"task_signature" text NOT NULL,
	"execution_profile_id" text DEFAULT 'standard-code-model' NOT NULL,
	"execution_provider_kind" text NOT NULL,
	"native_unit" text NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"completed_sample_count" integer DEFAULT 0 NOT NULL,
	"interrupted_sample_count" integer DEFAULT 0 NOT NULL,
	"native_units_per_credit_p50" real,
	"native_units_per_credit_p90" real,
	"credits_per_native_unit_p50" real,
	"credits_per_native_unit_p90" real,
	"actual_credits_p50" real,
	"actual_credits_p90" real,
	"confidence" text DEFAULT 'low' NOT NULL,
	"formula_version" text NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_credit_conversion_profiles_sample_counts" CHECK ("credit_conversion_profiles"."sample_count" >= 0 AND "credit_conversion_profiles"."completed_sample_count" >= 0 AND "credit_conversion_profiles"."interrupted_sample_count" >= 0 AND "credit_conversion_profiles"."completed_sample_count" + "credit_conversion_profiles"."interrupted_sample_count" <= "credit_conversion_profiles"."sample_count"),
	CONSTRAINT "chk_credit_conversion_profiles_native_p50" CHECK ("credit_conversion_profiles"."native_units_per_credit_p50" IS NULL OR "credit_conversion_profiles"."native_units_per_credit_p50" >= 0),
	CONSTRAINT "chk_credit_conversion_profiles_native_p90" CHECK ("credit_conversion_profiles"."native_units_per_credit_p90" IS NULL OR "credit_conversion_profiles"."native_units_per_credit_p90" >= 0),
	CONSTRAINT "chk_credit_conversion_profiles_credit_p50" CHECK ("credit_conversion_profiles"."credits_per_native_unit_p50" IS NULL OR "credit_conversion_profiles"."credits_per_native_unit_p50" >= 0),
	CONSTRAINT "chk_credit_conversion_profiles_credit_p90" CHECK ("credit_conversion_profiles"."credits_per_native_unit_p90" IS NULL OR "credit_conversion_profiles"."credits_per_native_unit_p90" >= 0),
	CONSTRAINT "chk_credit_conversion_profiles_actual_p50" CHECK ("credit_conversion_profiles"."actual_credits_p50" IS NULL OR "credit_conversion_profiles"."actual_credits_p50" >= 0),
	CONSTRAINT "chk_credit_conversion_profiles_actual_p90" CHECK ("credit_conversion_profiles"."actual_credits_p90" IS NULL OR "credit_conversion_profiles"."actual_credits_p90" >= 0),
	CONSTRAINT "chk_credit_conversion_profiles_confidence" CHECK ("credit_conversion_profiles"."confidence" IN ('low', 'medium', 'high'))
);

CREATE TABLE "control_plane_auth_credentials" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"username" text,
	"password_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "control_plane_auth_credentials_email_unique" UNIQUE("email"),
	CONSTRAINT "control_plane_auth_credentials_username_unique" UNIQUE("username")
);

CREATE TABLE "control_plane_auth_password_resets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "control_plane_auth_password_resets_token_hash_unique" UNIQUE("token_hash")
);

CREATE TABLE "control_plane_operation_runners" (
	"id" text PRIMARY KEY NOT NULL,
	"runner_key" text NOT NULL,
	"name" text NOT NULL,
	"environment" text NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	"version" text,
	"capabilities_json" text DEFAULT '[]' NOT NULL,
	"active_job_count" integer DEFAULT 0 NOT NULL,
	"max_concurrent_jobs" integer DEFAULT 1 NOT NULL,
	"heartbeat_at" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "control_plane_operation_runners_runner_key_unique" UNIQUE("runner_key")
);

CREATE TABLE "message_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_type" text NOT NULL,
	"status" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"related_model" text,
	"related_id" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"available_at" text NOT NULL,
	"claimed_by" text,
	"claimed_at" text,
	"lease_expires_at" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"payload_json" text NOT NULL,
	"meta_json" text NOT NULL
);

CREATE TABLE "notification_email_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_id" text,
	"digest_key" text NOT NULL,
	"cadence" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_at" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" text,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "notification_email_deliveries_digest_key_unique" UNIQUE("digest_key")
);

CREATE TABLE "notification_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"content_type" text NOT NULL,
	"project_id" text NOT NULL,
	"actor_id" text,
	"resource_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"target_url" text NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "platform_operation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"data_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "platform_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"operation" text NOT NULL,
	"status" text NOT NULL,
	"target" text NOT NULL,
	"idempotency_key" text,
	"input_json" text DEFAULT '{}' NOT NULL,
	"output_json" text,
	"error_json" text,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text,
	"assigned_runner_id" text,
	"lease_expires_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"started_at" text,
	"finished_at" text,
	"cancelled_at" text
);

CREATE TABLE "runtime_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"record_type" text NOT NULL,
	"record_key" text NOT NULL,
	"lookup_key" text,
	"secondary_key" text,
	"status" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"payload_json" text NOT NULL,
	"meta_json" text NOT NULL
);

CREATE TABLE "seed_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"seed_name" text NOT NULL,
	"seed_version" integer NOT NULL,
	"environments_json" text NOT NULL,
	"mode" text NOT NULL,
	"state" text NOT NULL,
	"actor_type" text,
	"actor_id" text,
	"manifest_hash" text NOT NULL,
	"plan_json" text NOT NULL,
	"result_json" text,
	"error_json" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text
);

CREATE TABLE "session_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text,
	"resource_id" text NOT NULL,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL
);

CREATE TABLE "user_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"read_at" text,
	"created_at" text NOT NULL
);

CREATE TABLE "team_service_capability_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"capability_type" text NOT NULL,
	"status" text DEFAULT 'configured' NOT NULL,
	"credential_profile_id" text,
	"configuration_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "team_service_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"non_secret_config_json" text DEFAULT '{}' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"last_validated_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "team_service_credential_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"definition_id" text NOT NULL,
	"custody_mode" text NOT NULL,
	"status" text DEFAULT 'configured' NOT NULL,
	"envelope_version" text,
	"fingerprint" text,
	"last_rotated_at" text,
	"last_validated_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "agent_fallback_outputs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"assignment_id" text,
	"mode" text NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"output_json" text DEFAULT '{}' NOT NULL,
	"provenance_json" text DEFAULT '{}' NOT NULL,
	"quota_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "agent_invocation_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"decision_id" text,
	"project_agent_class_id" text,
	"agent_id" text,
	"agent_revision" text,
	"mode" text DEFAULT 'planning' NOT NULL,
	"execution_kind" text DEFAULT 'workday' NOT NULL,
	"trigger_kind" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"scope_hash" text NOT NULL,
	"prompt" text,
	"content_refs_json" text DEFAULT '[]' NOT NULL,
	"parent_workday_id" text,
	"parent_assignment_id" text,
	"handoff_root_id" text,
	"handoff_parent_id" text,
	"handoff_depth" integer DEFAULT 0 NOT NULL,
	"recipients_json" text DEFAULT '[]' NOT NULL,
	"blocking_state_json" text DEFAULT '{}' NOT NULL,
	"subject_digest" text,
	"priority_class" text DEFAULT 'operational' NOT NULL,
	"available_at" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"admitted_demand_id" text,
	"execution_id" text,
	"assignment_id" text,
	"final_message_ref" text,
	"response_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"requested_at" text NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"completed_at" text,
	"stale_at" text,
	CONSTRAINT "chk_agent_invocations_mode" CHECK ("agent_invocation_requests"."mode" IN ('planning','acting')),
	CONSTRAINT "chk_agent_invocations_execution_kind" CHECK ("agent_invocation_requests"."execution_kind" IN ('workday','conversation','simulation','recovery')),
	CONSTRAINT "chk_agent_invocations_trigger_kind" CHECK ("agent_invocation_requests"."trigger_kind" IN ('scheduled','manual','discussion','agent-handoff')),
	CONSTRAINT "chk_agent_invocations_priority" CHECK ("agent_invocation_requests"."priority_class" IN ('human-interactive','workday-blocking-agent','agent-asynchronous','operational')),
	CONSTRAINT "chk_agent_invocations_status" CHECK ("agent_invocation_requests"."status" IN ('queued','blocked','coalesced','admitted','running','suspended','completed','failed','cancelled','expired','stale')),
	CONSTRAINT "chk_agent_invocations_handoff_depth" CHECK ("agent_invocation_requests"."handoff_depth" >= 0)
);

CREATE TABLE "agent_mode_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"provider_assignment_id" text NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"execution_provider_id" text,
	"project_agent_class_id" text NOT NULL,
	"agent_id" text,
	"handler_id" text,
	"mode" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"selected_input_json" text DEFAULT '{}' NOT NULL,
	"capacity_envelope_json" text DEFAULT '{}' NOT NULL,
	"outputs_json" text DEFAULT '{}' NOT NULL,
	"trace_refs_json" text DEFAULT '{}' NOT NULL,
	"usage_actual_json" text DEFAULT '{}' NOT NULL,
	"validation_json" text DEFAULT '{}' NOT NULL,
	"fallback_reason" text,
	"started_at" text,
	"completed_at" text,
	"failed_at" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_agent_mode_runs_mode" CHECK ("agent_mode_runs"."mode" IN ('planning', 'acting')),
	CONSTRAINT "chk_agent_mode_runs_status" CHECK ("agent_mode_runs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);

CREATE TABLE "capacity_workday_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"capacity_provider_id" text,
	"scenario_id" text DEFAULT 'portfolio-local' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"environment" text DEFAULT 'local' NOT NULL,
	"execution_kind" text DEFAULT 'workday' NOT NULL,
	"trigger_kind" text DEFAULT 'scheduled' NOT NULL,
	"hidden" integer DEFAULT 0 NOT NULL,
	"requested_by_id" text,
	"parameters_json" text DEFAULT '{}' NOT NULL,
	"summary_json" text DEFAULT '{}' NOT NULL,
	"metrics_json" text DEFAULT '{}' NOT NULL,
	"expected_json" text DEFAULT '{}' NOT NULL,
	"actual_json" text DEFAULT '{}' NOT NULL,
	"report_refs_json" text DEFAULT '{}' NOT NULL,
	"error_json" text DEFAULT '{}' NOT NULL,
	"started_at" text,
	"completed_at" text,
	"next_event_index" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_workday_runs_status" CHECK ("capacity_workday_runs"."status" IN ('queued','running','completed','cancelled','failed','degraded')),
	CONSTRAINT "chk_capacity_workday_runs_execution_kind" CHECK ("capacity_workday_runs"."execution_kind" IN ('workday','conversation','simulation','recovery')),
	CONSTRAINT "chk_capacity_workday_runs_trigger_kind" CHECK ("capacity_workday_runs"."trigger_kind" IN ('scheduled','manual','discussion','agent-handoff')),
	CONSTRAINT "chk_capacity_workday_runs_hidden" CHECK ("capacity_workday_runs"."hidden" IN (0,1)),
	CONSTRAINT "chk_capacity_workday_runs_next_event" CHECK ("capacity_workday_runs"."next_event_index" >= 0)
);

CREATE TABLE "decision_assignment_graphs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"active" integer DEFAULT 0 NOT NULL,
	"graph_json" text NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"compiled_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_decision_assignment_graphs_version" CHECK ("decision_assignment_graphs"."version" >= 1),
	CONSTRAINT "chk_decision_assignment_graphs_status" CHECK ("decision_assignment_graphs"."status" IN ('draft','compiled','ready','executing','completed','blocked')),
	CONSTRAINT "chk_decision_assignment_graphs_active" CHECK ("decision_assignment_graphs"."active" IN (0,1))
);

CREATE TABLE "decision_execution_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"work_graph_node_id" text,
	"project_agent_class_id" text NOT NULL,
	"mode" text DEFAULT 'acting' NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"scope_hash" text NOT NULL,
	"input_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"accepted_at" text,
	"revision_requested_at" text,
	"stale_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_decision_execution_inputs_mode" CHECK ("decision_execution_inputs"."mode" IN ('planning','acting')),
	CONSTRAINT "chk_decision_execution_inputs_status" CHECK ("decision_execution_inputs"."status" IN ('proposed','accepted','revision_requested','rejected','stale'))
);

CREATE TABLE "decision_planning_statuses" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"human_approval_state" text,
	"execution_readiness" text DEFAULT 'draft' NOT NULL,
	"planning_inputs_status" text DEFAULT 'requested' NOT NULL,
	"scope_hash" text NOT NULL,
	"stale_reason" text,
	"ready_at" text,
	"stale_at" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_decision_planning_statuses_readiness" CHECK ("decision_planning_statuses"."execution_readiness" IN ('draft','blocked','ready','stale','waived')),
	CONSTRAINT "chk_decision_planning_statuses_inputs" CHECK ("decision_planning_statuses"."planning_inputs_status" IN ('requested','complete','waived','rejected','stale'))
);

CREATE TABLE "deliverable_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"deliverable_type" text NOT NULL,
	"status" text NOT NULL,
	"contract_json" text NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_deliverable_contracts_status" CHECK ("deliverable_contracts"."status" IN ('required','draft','submitted','approved','rejected'))
);

CREATE TABLE "deliverable_manifests" (
	"id" text PRIMARY KEY NOT NULL,
	"deliverable_contract_id" text NOT NULL,
	"project_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"ready_for_review" integer DEFAULT 0 NOT NULL,
	"manifest_json" text NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"submitted_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "chk_deliverable_manifests_ready" CHECK ("deliverable_manifests"."ready_for_review" IN (0,1))
);

CREATE TABLE "research_workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"objective_ref" text NOT NULL,
	"question_ref" text NOT NULL,
	"status" text NOT NULL,
	"state_version" integer NOT NULL,
	"workflow_json" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_research_workflows_status" CHECK ("research_workflows"."status" IN ('ready','running','completed','blocked','failed')),
	CONSTRAINT "chk_research_workflows_state_version" CHECK ("research_workflows"."state_version" >= 1)
);

CREATE TABLE "structured_agent_estimates" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"decision_id" text,
	"proposal_id" text,
	"work_unit_id" text,
	"agent_class" text NOT NULL,
	"agent_id" text,
	"status" text DEFAULT 'submitted' NOT NULL,
	"estimate_json" text NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"accepted_at" text,
	"rejected_at" text,
	CONSTRAINT "chk_structured_agent_estimates_status" CHECK ("structured_agent_estimates"."status" IN ('submitted','accepted','rejected','superseded'))
);

CREATE TABLE "agent_context_query_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"test_id" text NOT NULL,
	"test_ref" text NOT NULL,
	"definition_kind" text NOT NULL,
	"definition_id" text NOT NULL,
	"definition_revision" integer NOT NULL,
	"definition_commit" text NOT NULL,
	"status" text NOT NULL,
	"checked_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"stats_json" text NOT NULL,
	"assertions_json" text NOT NULL,
	"result_digest" text NOT NULL,
	CONSTRAINT "chk_agent_context_query_checks_kind" CHECK ("agent_context_query_checks"."definition_kind" IN ('query','query-set')),
	CONSTRAINT "chk_agent_context_query_checks_status" CHECK ("agent_context_query_checks"."status" IN ('passing','failing','stale'))
);

CREATE TABLE "agent_client_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"assignment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"expires_at" text NOT NULL,
	"completed_at" text,
	"result_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_agent_client_actions_kind" CHECK ("agent_client_actions"."kind" IN ('navigate','reveal-resource','set-view-filter','populate-draft','present-confirmation')),
	CONSTRAINT "chk_agent_client_actions_status" CHECK ("agent_client_actions"."status" IN ('pending','completed','rejected','expired','failed','unavailable'))
);

CREATE TABLE "agent_client_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"route" text NOT NULL,
	"capabilities_json" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"heartbeat_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_agent_client_sessions_status" CHECK ("agent_client_sessions"."status" IN ('active','closed','expired'))
);

CREATE TABLE "agent_operation_handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"assignment_id" text NOT NULL,
	"invocation_id" text,
	"discussion_id" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'awaiting-approval' NOT NULL,
	"target" text NOT NULL,
	"expected_effect" text NOT NULL,
	"inputs_json" text DEFAULT '{}' NOT NULL,
	"source_message_refs_json" text DEFAULT '[]' NOT NULL,
	"required_authority_json" text DEFAULT '[]' NOT NULL,
	"proposal_id" text,
	"decision_id" text,
	"approval_request_id" text,
	"resulting_assignment_id" text,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_agent_operation_handoffs_status" CHECK ("agent_operation_handoffs"."status" IN ('awaiting-approval','approved','scheduled','running','completed','failed','cancelled'))
);

CREATE TABLE "capacity_allocation_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"effective_from" text NOT NULL,
	"effective_until" text,
	"reserve_policy_json" text DEFAULT '{}' NOT NULL,
	"slices_json" text DEFAULT '[]' NOT NULL,
	"borrowing_rules_json" text DEFAULT '[]' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_by_id" text,
	"activated_at" text,
	"superseded_by_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_allocation_sets_version" CHECK ("capacity_allocation_sets"."version" >= 1),
	CONSTRAINT "chk_capacity_allocation_sets_status" CHECK ("capacity_allocation_sets"."status" IN ('draft', 'validated', 'active', 'superseded', 'archived')),
	CONSTRAINT "chk_capacity_allocation_sets_effective_interval" CHECK ("capacity_allocation_sets"."effective_until" IS NULL OR "capacity_allocation_sets"."effective_until" > "capacity_allocation_sets"."effective_from")
);

CREATE TABLE "capacity_ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"settlement_key" text NOT NULL,
	"membership_id" text NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"execution_provider_id" text,
	"lane_id" text,
	"lane_purpose" text,
	"communication_overflow" integer DEFAULT 0 NOT NULL,
	"execution_kind" text DEFAULT 'workday' NOT NULL,
	"trigger_kind" text DEFAULT 'scheduled' NOT NULL,
	"invocation_id" text,
	"operation_handoff_id" text,
	"reservation_id" text,
	"assignment_id" text,
	"mode_run_id" text,
	"mode" text,
	"team_id" text NOT NULL,
	"project_id" text,
	"work_day_id" text,
	"task_id" text,
	"phase" text NOT NULL,
	"active_seconds" integer NOT NULL,
	"elapsed_seconds" integer NOT NULL,
	"provider_units" real,
	"usd" real,
	"source" text NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "chk_capacity_ledger_time" CHECK ("capacity_ledger_entries"."active_seconds" >= 0 AND "capacity_ledger_entries"."elapsed_seconds" >= 0),
	CONSTRAINT "chk_capacity_ledger_lane_purpose" CHECK ("capacity_ledger_entries"."lane_purpose" IS NULL OR "capacity_ledger_entries"."lane_purpose" IN ('communication','operation')),
	CONSTRAINT "chk_capacity_ledger_overflow" CHECK ("capacity_ledger_entries"."communication_overflow" IN (0,1)),
	CONSTRAINT "chk_capacity_ledger_execution_kind" CHECK ("capacity_ledger_entries"."execution_kind" IN ('workday','conversation','simulation','recovery')),
	CONSTRAINT "chk_capacity_ledger_trigger_kind" CHECK ("capacity_ledger_entries"."trigger_kind" IN ('scheduled','manual','discussion','agent-handoff'))
);

CREATE TABLE "capacity_provider_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"membership_id" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"provider_session_id" text,
	"execution_provider_id" text,
	"lane_id" text,
	"lane_purpose" text,
	"communication_overflow" integer DEFAULT 0 NOT NULL,
	"execution_kind" text DEFAULT 'workday' NOT NULL,
	"trigger_kind" text DEFAULT 'scheduled' NOT NULL,
	"invocation_id" text,
	"parent_workday_id" text,
	"parent_assignment_id" text,
	"handoff_root_id" text,
	"handoff_parent_id" text,
	"handoff_depth" integer DEFAULT 0 NOT NULL,
	"source_message_refs_json" text DEFAULT '[]' NOT NULL,
	"operation_handoff_id" text,
	"allocation_set_id" text,
	"project_agent_class_id" text NOT NULL,
	"reservation_id" text,
	"work_day_id" text,
	"task_id" text,
	"mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_state" text DEFAULT 'unleased' NOT NULL,
	"lease_expires_at" text,
	"lease_token" text,
	"state_version" integer DEFAULT 1 NOT NULL,
	"lease_renewed_at" text,
	"runner_id" text,
	"agent_id" text,
	"handler_id" text,
	"capacity_envelope_json" text DEFAULT '{}' NOT NULL,
	"decision_input_json" text DEFAULT '{}' NOT NULL,
	"workspace_context_json" text DEFAULT '{}' NOT NULL,
	"allowed_outputs_json" text DEFAULT '{}' NOT NULL,
	"explanation_json" text DEFAULT '{}' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"assigned_at" text,
	"claimed_at" text,
	"completed_at" text,
	"returned_at" text,
	"failed_at" text,
	"lifecycle_reason" text,
	"lifecycle_code" text,
	"lifecycle_output_json" text DEFAULT '{}' NOT NULL,
	"synthesized_from" text,
	"synthesis_key" text,
	"decision_id" text,
	"proposal_id" text,
	"fallback_output_id" text,
	"treedx_proxy_handle_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_provider_assignments_state_version" CHECK ("capacity_provider_assignments"."state_version" >= 1),
	CONSTRAINT "chk_capacity_provider_assignments_mode" CHECK ("capacity_provider_assignments"."mode" IN ('planning', 'acting')),
	CONSTRAINT "chk_capacity_provider_assignments_lane_purpose" CHECK ("capacity_provider_assignments"."lane_purpose" IS NULL OR "capacity_provider_assignments"."lane_purpose" IN ('communication','operation')),
	CONSTRAINT "chk_capacity_provider_assignments_overflow" CHECK ("capacity_provider_assignments"."communication_overflow" IN (0,1)),
	CONSTRAINT "chk_capacity_provider_assignments_handoff_depth" CHECK ("capacity_provider_assignments"."handoff_depth" >= 0),
	CONSTRAINT "chk_capacity_provider_assignments_execution_kind" CHECK ("capacity_provider_assignments"."execution_kind" IN ('workday','conversation','simulation','recovery')),
	CONSTRAINT "chk_capacity_provider_assignments_trigger_kind" CHECK ("capacity_provider_assignments"."trigger_kind" IN ('scheduled','manual','discussion','agent-handoff')),
	CONSTRAINT "chk_capacity_provider_assignments_status" CHECK ("capacity_provider_assignments"."status" IN ('pending', 'leased', 'running', 'completed', 'failed', 'returned', 'expired', 'cancelled')),
	CONSTRAINT "chk_capacity_provider_assignments_lease_state" CHECK ("capacity_provider_assignments"."lease_state" IN ('unleased', 'leased', 'released', 'expired'))
);

CREATE TABLE "capacity_usage_actuals" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"task_id" text,
	"work_day_id" text,
	"project_id" text NOT NULL,
	"task_signature" text NOT NULL,
	"assignment_id" text,
	"assignment_attempt" integer NOT NULL,
	"usage_dimension" text NOT NULL,
	"accounting_mode" text NOT NULL,
	"mode_run_id" text,
	"mode" text,
	"capacity_provider_id" text,
	"execution_provider_id" text,
	"lane_id" text,
	"lane_purpose" text,
	"communication_overflow" integer DEFAULT 0 NOT NULL,
	"execution_kind" text DEFAULT 'workday' NOT NULL,
	"trigger_kind" text DEFAULT 'scheduled' NOT NULL,
	"invocation_id" text,
	"parent_workday_id" text,
	"parent_assignment_id" text,
	"handoff_root_id" text,
	"handoff_parent_id" text,
	"handoff_depth" integer DEFAULT 0 NOT NULL,
	"source_message_refs_json" text DEFAULT '[]' NOT NULL,
	"operation_handoff_id" text,
	"business_model" text NOT NULL,
	"model_name" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_input_tokens" integer,
	"reasoning_tokens" integer,
	"quota_minutes" real,
	"wall_minutes" real,
	"files_opened" integer,
	"files_changed" integer,
	"diff_lines_added" integer,
	"diff_lines_removed" integer,
	"test_runs" integer,
	"retry_count" integer,
	"active_seconds" integer NOT NULL,
	"elapsed_seconds" integer NOT NULL,
	"actual_usd" real,
	"native_usage_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"execution_profile_id" text DEFAULT 'standard-code-model' NOT NULL,
	CONSTRAINT "chk_capacity_usage_actuals_time" CHECK ("capacity_usage_actuals"."active_seconds" >= 0 AND "capacity_usage_actuals"."elapsed_seconds" >= 0),
	CONSTRAINT "chk_capacity_usage_actuals_assignment_attempt" CHECK ("capacity_usage_actuals"."assignment_attempt" >= 0),
	CONSTRAINT "chk_capacity_usage_actuals_accounting_mode" CHECK ("capacity_usage_actuals"."accounting_mode" IN ('informational', 'incremental', 'aggregate'))
);

CREATE TABLE "project_agent_classes" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"allowed_modes_json" text DEFAULT '[]' NOT NULL,
	"required_capabilities_json" text DEFAULT '[]' NOT NULL,
	"kernel_profile_json" text DEFAULT '{}' NOT NULL,
	"kernel_policy_json" text DEFAULT '{}' NOT NULL,
	"handler_refs_json" text DEFAULT '{}' NOT NULL,
	"output_contracts_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_project_agent_classes_status" CHECK ("project_agent_classes"."status" IN ('active', 'paused', 'archived'))
);

CREATE TABLE "capacity_provider_availability_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"membership_id" text NOT NULL,
	"team_id" text NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"environment" text,
	"status" text DEFAULT 'open' NOT NULL,
	"sequence" integer DEFAULT 1 NOT NULL,
	"opened_at" text NOT NULL,
	"refreshed_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"available_from" text NOT NULL,
	"available_until" text,
	"execution_providers_json" text DEFAULT '[]' NOT NULL,
	"capabilities_json" text DEFAULT '[]' NOT NULL,
	"native_limits_json" text DEFAULT '{}' NOT NULL,
	"runner_pressure_json" text DEFAULT '{}' NOT NULL,
	"constraints_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"closed_at" text,
	CONSTRAINT "chk_capacity_provider_availability_sessions_sequence" CHECK ("capacity_provider_availability_sessions"."sequence" >= 1),
	CONSTRAINT "chk_capacity_provider_availability_sessions_status" CHECK ("capacity_provider_availability_sessions"."status" IN ('open', 'draining', 'closed', 'expired'))
);

CREATE TABLE "capacity_admission_counters" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"period_key" text NOT NULL,
	"hard_limit" real NOT NULL,
	"committed_amount" real DEFAULT 0 NOT NULL,
	"state_version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_admission_counter_hard_limit" CHECK ("capacity_admission_counters"."hard_limit" >= 0),
	CONSTRAINT "chk_capacity_admission_counter_committed_amount" CHECK ("capacity_admission_counters"."committed_amount" >= 0 AND "capacity_admission_counters"."committed_amount" <= "capacity_admission_counters"."hard_limit")
);

CREATE TABLE "capacity_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text,
	"capacity_provider_id" text,
	"membership_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"request_id" text,
	"idempotency_key" text,
	"before_fingerprint" text,
	"after_fingerprint" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "capacity_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"membership_id" text NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"execution_provider_ids_json" text DEFAULT '[]' NOT NULL,
	"lane_ids_json" text DEFAULT '[]' NOT NULL,
	"capabilities_json" text DEFAULT '[]' NOT NULL,
	"allowed_modes_json" text DEFAULT '[]' NOT NULL,
	"daily_agent_seconds_limit" integer,
	"monthly_agent_seconds_limit" integer,
	"max_concurrent_assignments" integer,
	"unmetered" integer DEFAULT 0 NOT NULL,
	"expires_at" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_grants_status" CHECK ("capacity_grants"."status" IN ('planned', 'active', 'paused', 'revoked', 'expired')),
	CONSTRAINT "chk_capacity_grants_unmetered" CHECK ("capacity_grants"."unmetered" IN (0, 1)),
	CONSTRAINT "chk_capacity_grants_daily_time_limit" CHECK ("capacity_grants"."daily_agent_seconds_limit" IS NULL OR "capacity_grants"."daily_agent_seconds_limit" >= 0),
	CONSTRAINT "chk_capacity_grants_monthly_time_limit" CHECK ("capacity_grants"."monthly_agent_seconds_limit" IS NULL OR "capacity_grants"."monthly_agent_seconds_limit" >= 0),
	CONSTRAINT "chk_capacity_grants_concurrency" CHECK ("capacity_grants"."max_concurrent_assignments" IS NULL OR "capacity_grants"."max_concurrent_assignments" >= 0)
);

CREATE TABLE "capacity_operation_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"response_json" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "capacity_provider_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"membership_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes_json" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"issued_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"last_used_at" text,
	"expired_at" text,
	"revoked_at" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_provider_access_tokens_status" CHECK ("capacity_provider_access_tokens"."status" IN ('active', 'revoked', 'expired'))
);

CREATE TABLE "capacity_provider_proof_nonces" (
	"provider_fingerprint" text NOT NULL,
	"jti" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "capacity_provider_proof_nonces_provider_fingerprint_jti_pk" PRIMARY KEY("provider_fingerprint","jti")
);

CREATE TABLE "capacity_provider_registration_rate_limits" (
	"dimension" text NOT NULL,
	"bucket_key" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_started_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "capacity_provider_registration_rate_limits_dimension_bucket_key_pk" PRIMARY KEY("dimension","bucket_key"),
	CONSTRAINT "chk_capacity_provider_registration_rate_limits_count" CHECK ("capacity_provider_registration_rate_limits"."count" >= 0)
);

CREATE TABLE "capacity_provider_team_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"membership_id" text NOT NULL,
	"team_id" text NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"issuance_authorization_id" text NOT NULL,
	"issuance_generation" integer NOT NULL,
	"issue_idempotency_key" text NOT NULL,
	"scopes_json" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_used_at" text,
	"rotated_from_credential_id" text,
	"expires_at" text,
	"revealed_at" text,
	"revoked_at" text,
	"revoke_idempotency_key" text,
	"revoke_request_digest" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_provider_team_credentials_status" CHECK ("capacity_provider_team_credentials"."status" IN ('active', 'rotating', 'revoked'))
);

CREATE TABLE "capacity_reservation_counter_claims" (
	"reservation_id" text NOT NULL,
	"counter_id" text NOT NULL,
	"admission_token" text NOT NULL,
	"reserved_amount" real NOT NULL,
	"released_amount" real DEFAULT 0 NOT NULL,
	"release_policy" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_reservation_claim_reserved" CHECK ("capacity_reservation_counter_claims"."reserved_amount" >= 0),
	CONSTRAINT "chk_capacity_reservation_claim_released" CHECK ("capacity_reservation_counter_claims"."released_amount" >= 0 AND "capacity_reservation_counter_claims"."released_amount" <= "capacity_reservation_counter_claims"."reserved_amount")
);

CREATE TABLE "capacity_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"admission_token" text NOT NULL,
	"membership_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"execution_provider_id" text,
	"lane_id" text,
	"lane_purpose" text,
	"communication_overflow" integer DEFAULT 0 NOT NULL,
	"execution_kind" text DEFAULT 'workday' NOT NULL,
	"trigger_kind" text DEFAULT 'scheduled' NOT NULL,
	"invocation_id" text,
	"operation_handoff_id" text,
	"allocation_set_id" text NOT NULL,
	"allocation_version" integer NOT NULL,
	"allocation_slice_ids_json" text DEFAULT '[]' NOT NULL,
	"policy_snapshot_json" text DEFAULT '{}' NOT NULL,
	"project_agent_class_id" text NOT NULL,
	"assignment_id" text,
	"mode" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"work_day_id" text,
	"task_id" text,
	"state" text DEFAULT 'reserved' NOT NULL,
	"usage_report_token" text,
	"settlement_token" text,
	"requested_seconds" integer NOT NULL,
	"reserved_seconds" integer NOT NULL,
	"active_seconds" integer DEFAULT 0 NOT NULL,
	"elapsed_seconds" integer DEFAULT 0 NOT NULL,
	"released_seconds" integer DEFAULT 0 NOT NULL,
	"overrun_seconds" integer DEFAULT 0 NOT NULL,
	"native_unit" text,
	"reserved_native_amount" real,
	"consumed_native_amount" real,
	"reserved_provider_units" real,
	"consumed_provider_units" real,
	"reserved_usd" real,
	"consumed_usd" real,
	"expires_at" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_reservations_allocation_version" CHECK ("capacity_reservations"."allocation_version" >= 1),
	CONSTRAINT "chk_capacity_reservations_mode" CHECK ("capacity_reservations"."mode" IN ('planning', 'acting')),
	CONSTRAINT "chk_capacity_reservations_lane_purpose" CHECK ("capacity_reservations"."lane_purpose" IS NULL OR "capacity_reservations"."lane_purpose" IN ('communication','operation')),
	CONSTRAINT "chk_capacity_reservations_overflow" CHECK ("capacity_reservations"."communication_overflow" IN (0,1)),
	CONSTRAINT "chk_capacity_reservations_execution_kind" CHECK ("capacity_reservations"."execution_kind" IN ('workday','conversation','simulation','recovery')),
	CONSTRAINT "chk_capacity_reservations_trigger_kind" CHECK ("capacity_reservations"."trigger_kind" IN ('scheduled','manual','discussion','agent-handoff')),
	CONSTRAINT "chk_capacity_reservations_state" CHECK ("capacity_reservations"."state" IN ('reserved', 'consuming', 'consumed', 'released', 'expired', 'failed', 'overran_pending_approval', 'continuation_required')),
	CONSTRAINT "chk_capacity_reservations_time" CHECK ("capacity_reservations"."requested_seconds" > 0 AND "capacity_reservations"."reserved_seconds" > 0 AND "capacity_reservations"."active_seconds" >= 0 AND "capacity_reservations"."elapsed_seconds" >= 0 AND "capacity_reservations"."released_seconds" >= 0 AND "capacity_reservations"."overrun_seconds" >= 0)
);

CREATE TABLE "agent_capacity_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scope_hash" text NOT NULL,
	"allocation_set_id" text,
	"work_day_id" text,
	"expected_seconds" integer DEFAULT 0 NOT NULL,
	"high_seconds" integer DEFAULT 0 NOT NULL,
	"work_units_json" text DEFAULT '[]' NOT NULL,
	"capability_needs_json" text DEFAULT '[]' NOT NULL,
	"environment_needs_json" text DEFAULT '[]' NOT NULL,
	"reserves_json" text DEFAULT '{}' NOT NULL,
	"blockers_json" text DEFAULT '[]' NOT NULL,
	"priority_rationale" text,
	"review_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"accepted_at" text,
	"scheduled_at" text,
	"superseded_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_agent_capacity_plans_status" CHECK ("agent_capacity_plans"."status" IN ('draft','accepted','revision_requested','deferred','scheduled','active','completed','superseded')),
	CONSTRAINT "chk_agent_capacity_plans_time" CHECK ("agent_capacity_plans"."expected_seconds" >= 0 AND "agent_capacity_plans"."high_seconds" >= "agent_capacity_plans"."expected_seconds")
);

CREATE TABLE "agent_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"workday_run_id" text,
	"assignment_id" text,
	"agent_id" text,
	"activity_type" text,
	"capacity_provider_id" text,
	"causation_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"origin" text NOT NULL,
	"commit_sha" text,
	"immutable_ref" text,
	"digest" text,
	"changed_paths_json" text DEFAULT '[]' NOT NULL,
	"change_summary" text,
	"evidence_ref" text,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "chk_agent_signals_origin" CHECK ("agent_signals"."origin" IN ('treedx-change','deterministic-handler','agent-tool'))
);

CREATE TABLE "capacity_workday_demands" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"workday_run_id" text NOT NULL,
	"workday_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"mode" text NOT NULL,
	"project_agent_class_id" text NOT NULL,
	"agent_id" text,
	"handler_id" text NOT NULL,
	"activity_type" text NOT NULL,
	"decision_id" text,
	"capacity_plan_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"requested_seconds" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"claim_token" text,
	"assignment_id" text,
	"payload_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"available_at" text NOT NULL,
	"claimed_at" text,
	"admitted_at" text,
	"completed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_workday_demands_mode" CHECK ("capacity_workday_demands"."mode" IN ('planning','acting')),
	CONSTRAINT "chk_capacity_workday_demands_status" CHECK ("capacity_workday_demands"."status" IN ('pending','claimed','admitted','completed','blocked','cancelled','superseded')),
	CONSTRAINT "chk_capacity_workday_demands_source" CHECK ("capacity_workday_demands"."source_type" IN ('objective','question','proposal','decision-review','knowledge-gap','release-readiness','idle-intent','planning-input','capacity-plan','assignment-completion','assignment-blockage','workday-summary','handoff','research-workflow')),
	CONSTRAINT "chk_capacity_workday_demands_time" CHECK ("capacity_workday_demands"."requested_seconds" > 0)
);

CREATE TABLE "capacity_workday_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text,
	"workday_id" text,
	"assignment_id" text,
	"mode_run_id" text,
	"event_index" integer NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'recorded' NOT NULL,
	"title" text,
	"message" text,
	"parameters_json" text DEFAULT '{}' NOT NULL,
	"context_json" text DEFAULT '{}' NOT NULL,
	"refs_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "chk_capacity_workday_events_index" CHECK ("capacity_workday_events"."event_index" >= 0),
	CONSTRAINT "chk_capacity_workday_events_status" CHECK ("capacity_workday_events"."status" IN ('recorded','active','completed','warning','error','failed'))
);

CREATE TABLE "capacity_workday_participation_cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"workday_run_id" text NOT NULL,
	"cycle_number" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" text NOT NULL,
	"covered_at" text,
	"closed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_workday_participation_cycles_number" CHECK ("capacity_workday_participation_cycles"."cycle_number" >= 1),
	CONSTRAINT "chk_capacity_workday_participation_cycles_status" CHECK ("capacity_workday_participation_cycles"."status" IN ('open','covered','closed'))
);

CREATE TABLE "capacity_workday_participation_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"cycle_id" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"workday_run_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"project_agent_class_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason_code" text,
	"demand_id" text,
	"assignment_id" text,
	"covered_at" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_workday_participation_entries_status" CHECK ("capacity_workday_participation_entries"."status" IN ('pending','assigned','completed','excluded','blocked'))
);

CREATE TABLE "capacity_workday_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"capacity_provider_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"purpose" text NOT NULL,
	"project_ids_json" text DEFAULT '[]' NOT NULL,
	"agent_selection_json" text DEFAULT '{}' NOT NULL,
	"cadence_seconds" integer NOT NULL,
	"duration_seconds" integer NOT NULL,
	"max_active_assignments" integer NOT NULL,
	"available_seconds" integer NOT NULL,
	"time_policy_json" text DEFAULT '{}' NOT NULL,
	"planning_only" integer DEFAULT 1 NOT NULL,
	"publication_policy_json" text DEFAULT '{}' NOT NULL,
	"last_run_id" text,
	"next_run_at" text NOT NULL,
	"state_version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_capacity_workday_schedules_status" CHECK ("capacity_workday_schedules"."status" IN ('active','paused','completed','failed')),
	CONSTRAINT "chk_capacity_workday_schedules_cadence" CHECK ("capacity_workday_schedules"."cadence_seconds" >= 60),
	CONSTRAINT "chk_capacity_workday_schedules_duration" CHECK ("capacity_workday_schedules"."duration_seconds" >= 60),
	CONSTRAINT "chk_capacity_workday_schedules_concurrency" CHECK ("capacity_workday_schedules"."max_active_assignments" >= 1),
	CONSTRAINT "chk_capacity_workday_schedules_time" CHECK ("capacity_workday_schedules"."available_seconds" > 0),
	CONSTRAINT "chk_capacity_workday_schedules_planning" CHECK ("capacity_workday_schedules"."planning_only" IN (0,1)),
	CONSTRAINT "chk_capacity_workday_schedules_version" CHECK ("capacity_workday_schedules"."state_version" >= 1)
);

CREATE TABLE "treedx_project_proxy_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"assignment_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"handle_json" text DEFAULT '{}' NOT NULL,
	"result_status" text DEFAULT 'observed' NOT NULL,
	"reason_code" text,
	"reason" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "treedx_proxy_handles" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"assignment_id" text,
	"repository_id" text,
	"workspace_id" text,
	"status" text DEFAULT 'issued' NOT NULL,
	"scopes_json" text DEFAULT '[]' NOT NULL,
	"allowed_operations_json" text DEFAULT '[]' NOT NULL,
	"allowed_paths_json" text DEFAULT '[]' NOT NULL,
	"allowed_read_paths_json" text DEFAULT '[]' NOT NULL,
	"allowed_write_paths_json" text DEFAULT '[]' NOT NULL,
	"token_hash" text,
	"expires_at" text,
	"issued_at" text NOT NULL,
	"revoked_at" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "workday_capacity_envelopes" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"workday_run_id" text,
	"allocation_set_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"started_at" text,
	"paused_at" text,
	"completed_at" text,
	"envelope_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_workday_capacity_envelopes_status" CHECK ("workday_capacity_envelopes"."status" IN ('draft','queued','active','paused','completed','cancelled','failed','degraded'))
);

CREATE TABLE "workday_planning_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"node_id" text NOT NULL,
	"project_agent_class_id" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"requested_by_signal_id" text,
	"rationale" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "workday_planning_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"workday_run_id" text NOT NULL,
	"graph_revision" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"agenda_json" text DEFAULT '{}' NOT NULL,
	"objectives_json" text DEFAULT '[]' NOT NULL,
	"proposal_ids_json" text DEFAULT '[]' NOT NULL,
	"rounds" integer NOT NULL,
	"current_round" integer DEFAULT 0 NOT NULL,
	"allocated_seconds" integer NOT NULL,
	"reserved_seconds" integer DEFAULT 0 NOT NULL,
	"started_at" text,
	"deadline" text NOT NULL,
	"completed_at" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "chk_workday_planning_sessions_status" CHECK ("workday_planning_sessions"."status" IN ('scheduled','running','completed','failed','cancelled'))
);

CREATE TABLE "workday_planning_waves" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"round" integer NOT NULL,
	"wave" integer NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"snapshot_ref" text NOT NULL,
	"snapshot_json" text DEFAULT '{}' NOT NULL,
	"assignment_ids_json" text DEFAULT '[]' NOT NULL,
	"started_at" text,
	"completed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "better_auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" bigint NOT NULL,
	"token" text NOT NULL,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "better_auth_session_token_unique" UNIQUE("token")
);

CREATE TABLE "better_auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" integer DEFAULT 0 NOT NULL,
	"image" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	"username" text,
	"firstName" text,
	"lastName" text,
	CONSTRAINT "better_auth_user_email_unique" UNIQUE("email")
);

CREATE TABLE "project_summary_snapshots" (
	"project_id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"summary_json" text NOT NULL,
	"generated_at" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "team_inbox_items" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"href" text,
	"item_key" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "governance_proposal_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"change_reason" text,
	"created_by_type" text DEFAULT 'user' NOT NULL,
	"created_by_id" text,
	"created_at" text NOT NULL
);

CREATE TABLE "governance_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text,
	"scope" text DEFAULT 'project' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body" text NOT NULL,
	"proposal_type" text DEFAULT 'implementation' NOT NULL,
	"proposal_types_json" text DEFAULT '[]' NOT NULL,
	"content_proposal_slug" text,
	"content_decision_slug" text,
	"active_version" integer DEFAULT 1 NOT NULL,
	"active_content_hash" text NOT NULL,
	"governance_provider_id" text NOT NULL,
	"governance_provider_version" text DEFAULT '1' NOT NULL,
	"governance_policy_id" text,
	"decision_id" text,
	"voting_starts_at" text,
	"voting_ends_at" text,
	"closed_at" text,
	"closed_reason" text,
	"created_by_type" text DEFAULT 'user' NOT NULL,
	"created_by_id" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "project_governance_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_version" text DEFAULT '1' NOT NULL,
	"config_json" text DEFAULT '{}' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"superseded_at" text
);

CREATE TABLE "team_governance_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"scope" text DEFAULT 'team' NOT NULL,
	"provider_id" text NOT NULL,
	"provider_version" text DEFAULT '1' NOT NULL,
	"config_json" text DEFAULT '{}' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"superseded_at" text
);

CREATE TABLE "entitlements" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text,
	"project_id" text,
	"tier" text NOT NULL,
	"status" text NOT NULL,
	"metadata_json" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "governance_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text,
	"proposal_id" text NOT NULL,
	"proposal_version" integer NOT NULL,
	"proposal_content_hash" text NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"content_decision_slug" text,
	"governance_provider_id" text NOT NULL,
	"governance_rule_json" text DEFAULT '{}' NOT NULL,
	"electorate_snapshot_id" text,
	"vote_result_json" text DEFAULT '{}' NOT NULL,
	"voter_reasons_json" text DEFAULT '[]' NOT NULL,
	"proposal_snapshot_json" text DEFAULT '{}' NOT NULL,
	"decision_record_json" text DEFAULT '{}' NOT NULL,
	"created_by_type" text DEFAULT 'system' NOT NULL,
	"created_by_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"superseded_at" text
);

CREATE TABLE "governance_delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"scope" text DEFAULT 'team' NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"chambers_json" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"created_at" text NOT NULL,
	"revoked_at" text,
	"expires_at" text,
	"metadata_json" text DEFAULT '{}' NOT NULL
);

CREATE TABLE "governance_electorate_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"proposal_version" integer NOT NULL,
	"provider_id" text NOT NULL,
	"provider_version" text DEFAULT '1' NOT NULL,
	"rule_snapshot_json" text DEFAULT '{}' NOT NULL,
	"chambers_json" text DEFAULT '[]' NOT NULL,
	"eligible_voters_json" text DEFAULT '[]' NOT NULL,
	"delegations_json" text DEFAULT '[]' NOT NULL,
	"eligible_weight_total" real DEFAULT 0 NOT NULL,
	"active_weight_total" real DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "governance_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"team_id" text NOT NULL,
	"project_id" text,
	"proposal_id" text,
	"decision_id" text,
	"proposal_version" integer,
	"prior_state" text,
	"next_state" text,
	"message" text,
	"evidence_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "governance_proposal_votes" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"proposal_version" integer NOT NULL,
	"user_id" text NOT NULL,
	"vote" text NOT NULL,
	"reason" text,
	"chamber_votes_json" text DEFAULT '{}' NOT NULL,
	"effective_weights_json" text DEFAULT '{}' NOT NULL,
	"delegated_from_json" text DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "governance_vote_events" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"proposal_version" integer NOT NULL,
	"user_id" text NOT NULL,
	"prior_vote" text,
	"next_vote" text NOT NULL,
	"reason" text,
	"effective_weights_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"metadata_json" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "remote_job_events" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"data_json" text,
	"created_at" text NOT NULL
);

CREATE TABLE "remote_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"namespace" text NOT NULL,
	"operation" text NOT NULL,
	"status" text NOT NULL,
	"preferred_mode" text NOT NULL,
	"selected_target" text NOT NULL,
	"capability_json" text NOT NULL,
	"input_json" text NOT NULL,
	"output_json" text,
	"error_json" text,
	"requested_by_type" text NOT NULL,
	"requested_by_id" text,
	"assigned_runner_id" text,
	"idempotency_key" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"started_at" text,
	"finished_at" text,
	"cancelled_at" text
);

CREATE TABLE "team_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"permissions_json" text NOT NULL,
	"expires_at" text,
	"last_used_at" text,
	"revoked_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "team_storage_locators" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"bucket_name" text NOT NULL,
	"manifest_key_template" text NOT NULL,
	"preview_root_template" text NOT NULL,
	"public_base_url" text,
	"metadata_json" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "team_storage_locators_team_id_unique" UNIQUE("team_id")
);

CREATE TABLE "auth_provider_states" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"code_verifier" text,
	"nonce" text,
	"callback_url" text NOT NULL,
	"return_to" text NOT NULL,
	"link_user_id" text,
	"purpose" text DEFAULT 'sign-in' NOT NULL,
	"action" text,
	"expires_at" text NOT NULL,
	"used_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "auth_provider_states_state_hash_unique" UNIQUE("state_hash")
);

CREATE TABLE "auth_reauthentication_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"action" text NOT NULL,
	"expires_at" text NOT NULL,
	"consumed_at" text,
	"created_at" text NOT NULL
);

CREATE TABLE "treedx_deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"instance_id" text,
	"provider" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"image_ref" text,
	"volume_mount_path" text,
	"service_refs_json" text DEFAULT '{}' NOT NULL,
	"result_json" text DEFAULT '{}' NOT NULL,
	"error_json" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text
);

CREATE TABLE "treedx_mirrors" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"name" text NOT NULL,
	"direction" text DEFAULT 'bidirectional' NOT NULL,
	"target_kind" text NOT NULL,
	"target_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"instructions" text,
	"last_sync_at" text,
	"last_sync_status" text,
	"last_sync_metadata_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "treedx_project_libraries" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"library_id" text NOT NULL,
	"repository_id" text,
	"content_path" text DEFAULT 'src/content' NOT NULL,
	"content_repository_url" text,
	"content_repository_default_branch" text,
	"content_repository_ref" text,
	"r2_bucket_name" text,
	"r2_manifest_key" text,
	"topology_json" text DEFAULT '{}' NOT NULL,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "treedx_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"instance_id" text,
	"project_id" text,
	"library_id" text,
	"scope" text NOT NULL,
	"target_team_id" text,
	"trust_grant_json" text DEFAULT '{}' NOT NULL,
	"public_read" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"revoked_at" text
);

CREATE TABLE "user_notification_global_content_types" (
	"user_id" text NOT NULL,
	"content_type" text NOT NULL,
	CONSTRAINT "user_notification_global_content_types_user_id_content_type_pk" PRIMARY KEY("user_id","content_type")
);

CREATE TABLE "user_notification_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email_cadence" text DEFAULT 'daily' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "user_notification_project_content_types" (
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"content_type" text NOT NULL,
	CONSTRAINT "user_notification_project_content_types_user_id_project_id_content_type_pk" PRIMARY KEY("user_id","project_id","content_type")
);

CREATE TABLE "user_notification_project_overrides" (
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "user_notification_project_overrides_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);

CREATE TABLE "user_personal_themes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"base_scheme" text NOT NULL,
	"palette_json" text NOT NULL,
	"compiler_version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"color_scheme" text DEFAULT 'fern' NOT NULL,
	"theme_mode" text DEFAULT 'system' NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"real_time_updates" integer DEFAULT 1 NOT NULL,
	"real_time_polling_interval_seconds" integer DEFAULT 5 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"work_day_id" text,
	"task_id" text,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"requested_by_type" text DEFAULT 'worker' NOT NULL,
	"requested_by_id" text,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"options_json" text DEFAULT '[]' NOT NULL,
	"recommendation_json" text DEFAULT '{}' NOT NULL,
	"policy_snapshot_json" text DEFAULT '{}' NOT NULL,
	"expires_at" text,
	"decided_by_type" text,
	"decided_by_id" text,
	"decided_at" text,
	"decision_json" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "hub_content_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"hub_id" text NOT NULL,
	"team_id" text NOT NULL,
	"content_repository_id" text,
	"production_source" text NOT NULL,
	"overlay_policy" text NOT NULL,
	"r2_bucket_name" text,
	"r2_manifest_key" text,
	"r2_public_base_url" text,
	"latest_publish_id" text,
	"latest_content_version" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "hub_content_sources_hub_id_unique" UNIQUE("hub_id")
);

CREATE TABLE "hub_repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"hub_id" text NOT NULL,
	"team_id" text NOT NULL,
	"role" text NOT NULL,
	"provider" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"default_branch" text,
	"current_branch" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"access_policy_json" text DEFAULT '{}' NOT NULL,
	"release_policy_json" text DEFAULT '{}' NOT NULL,
	"publish_policy_json" text DEFAULT '{}' NOT NULL,
	"submodule_path" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "treedx_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"registry_url" text,
	"public_read" integer DEFAULT 0 NOT NULL,
	"primary" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"image_ref" text,
	"railway_project_id" text,
	"railway_service_id" text,
	"railway_environment_id" text,
	"volume_mount_path" text,
	"metadata_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "book_collections" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"summary" text,
	"book_ids_json" text DEFAULT '[]' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "knowledge_authoring_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"treedx_workspace_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"base_ref" text NOT NULL,
	"base_commit_sha" text NOT NULL,
	"branch_name" text NOT NULL,
	"allowed_paths_json" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "knowledge_pack_builds" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"collection_id" text,
	"requested_by_user_id" text NOT NULL,
	"book_ids_json" text DEFAULT '[]' NOT NULL,
	"source_closure" text,
	"publication_revision" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"artifact_json" text DEFAULT '{}' NOT NULL,
	"error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text
);

CREATE TABLE "knowledge_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"review_id" text NOT NULL,
	"project_id" text NOT NULL,
	"commit_sha" text NOT NULL,
	"published_ref" text NOT NULL,
	"published_revision" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" text NOT NULL,
	"completed_at" text
);

CREATE TABLE "knowledge_review_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"path" text NOT NULL,
	"line_start" integer,
	"line_end" integer,
	"body" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "knowledge_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"submitted_by_user_id" text NOT NULL,
	"decided_by_user_id" text,
	"notes" text,
	"commit_sha" text,
	"changed_paths_json" text DEFAULT '[]' NOT NULL,
	"context_digest" text,
	"requires_editorial_review" integer DEFAULT 0 NOT NULL,
	"editorial_gate_satisfied" integer DEFAULT 0 NOT NULL,
	"technical_review_json" text,
	"audience_review_json" text,
	"required_reviewer_ids_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "knowledge_workspace_presence" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"last_seen_at" text NOT NULL
);

CREATE TABLE "project_remote_repository_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"team_id" text NOT NULL,
	"service_connection_id" text NOT NULL,
	"capability_binding_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_repository_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"clone_url" text NOT NULL,
	"default_ref" text NOT NULL,
	"publication_ref" text NOT NULL,
	"authority_id" text NOT NULL,
	"expected_head" text,
	"observed_head" text,
	"grant_status" text DEFAULT 'missing' NOT NULL,
	"drift" text DEFAULT 'unknown' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "project_remote_repository_bindings_project_id_unique" UNIQUE("project_id")
);

CREATE TABLE "project_workflow_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"team_id" text NOT NULL,
	"workflow_binding_id" text NOT NULL,
	"repository_binding_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"ref_policy_json" text DEFAULT '[]' NOT NULL,
	"allowed_inputs_json" text DEFAULT '{}' NOT NULL,
	"required_secrets_json" text DEFAULT '[]' NOT NULL,
	"required_variables_json" text DEFAULT '[]' NOT NULL,
	"actor_policy_json" text DEFAULT '[]' NOT NULL,
	"mode_policy_json" text DEFAULT '[]' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "provider_connector_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"connector_kind" text NOT NULL,
	"team_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"phase" text NOT NULL,
	"installation_id" text,
	"account_id" text,
	"account_login" text,
	"expires_at" text NOT NULL,
	"consumed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "provider_connector_authorizations_state_hash_unique" UNIQUE("state_hash")
);

CREATE TABLE "provider_credential_authorities" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"credential_profile_id" text NOT NULL,
	"scheme" text NOT NULL,
	"reference" text NOT NULL,
	"capabilities_json" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'reauthorization-required' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "provider_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"body_digest" text NOT NULL,
	"correlation_id" text,
	"received_at" text NOT NULL,
	"processed_at" text
);

CREATE TABLE "remote_credential_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"node_id" text NOT NULL,
	"operation_kind" text NOT NULL,
	"allowed_host" text NOT NULL,
	"refspec_digest" text NOT NULL,
	"delivery_mode" text NOT NULL,
	"ciphertext" text,
	"algorithm" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"expires_at" text NOT NULL,
	"consumed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "remote_credential_deliveries_grant_id_unique" UNIQUE("grant_id")
);

CREATE TABLE "remote_git_operation_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"repository_binding_id" text NOT NULL,
	"treedx_node_id" text NOT NULL,
	"source_ref" text NOT NULL,
	"destination_ref" text NOT NULL,
	"reviewed_commit" text NOT NULL,
	"expected_remote_head" text NOT NULL,
	"credential_authority_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "remote_git_operation_grants_idempotency_key_unique" UNIQUE("idempotency_key")
);

CREATE TABLE "workflow_configuration_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"record_id" text NOT NULL,
	"action" text NOT NULL,
	"payload_digest" text,
	"key_id" text,
	"status" text NOT NULL,
	"expires_at" text NOT NULL,
	"consumed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "workflow_configuration_deliveries_operation_id_unique" UNIQUE("operation_id")
);

CREATE TABLE "workflow_configuration_records" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"team_id" text NOT NULL,
	"workflow_binding_id" text NOT NULL,
	"repository_binding_id" text NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"environment" text,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"value_digest" text,
	"provider_updated_at" text,
	"last_observed_at" text,
	"updated_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "workflow_operation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"project_id" text NOT NULL,
	"team_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"mode" text NOT NULL,
	"assignment_id" text,
	"handle_id" text,
	"provider_id" text NOT NULL,
	"provider_run_id" text,
	"provider_run_url" text,
	"source_sha" text NOT NULL,
	"ref" text NOT NULL,
	"correlation_id" text NOT NULL,
	"status" text DEFAULT 'authorizing' NOT NULL,
	"artifacts_json" text DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "workflow_operation_runs_correlation_id_unique" UNIQUE("correlation_id")
);

CREATE TABLE "agent_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "agent_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"agent_slug" text NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes_json" text NOT NULL,
	"expires_at" text,
	"last_used_at" text,
	"revoked_at" text,
	"metadata_json" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"event_type" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"data_json" text,
	"created_at" text NOT NULL
);

CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_type" text NOT NULL,
	"access_token_hash" text NOT NULL,
	"access_expires_at" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"scopes_json" text NOT NULL,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	"data_json" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "oauth_authorization_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL UNIQUE,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scopes_json" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	"created_at" text NOT NULL
);

CREATE TABLE "contact_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"message" text NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "device_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"client_id" text NOT NULL,
	"requested_scopes_json" text NOT NULL,
	"expires_at" text NOT NULL,
	"interval_seconds" integer NOT NULL,
	"status" text NOT NULL,
	"user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "device_codes_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "device_codes_user_code_unique" UNIQUE("user_code")
);

CREATE TABLE "permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"scope" text NOT NULL,
	"description" text,
	"created_at" text NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);

CREATE TABLE "role_permissions" (
	"role_id" text,
	"permission_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);

CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"created_at" text NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);

CREATE TABLE "runtime_envelopes" (
	"id" serial PRIMARY KEY NOT NULL,
	"record_type" text NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "seed_team_membership_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"seed_name" text NOT NULL,
	"resource_key" text NOT NULL,
	"team_id" text NOT NULL,
	"normalized_email" text NOT NULL,
	"roles_json" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"membership_id" text,
	"binding_ids_json" text DEFAULT '[]' NOT NULL,
	"bound_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "service_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"roles_json" text NOT NULL,
	"permissions_json" text NOT NULL,
	"revoked_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"last_used_at" text,
	CONSTRAINT "service_credentials_service_id_unique" UNIQUE("service_id")
);

CREATE TABLE "subscribers" (
	"email" text PRIMARY KEY NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "team_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "team_role_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"team_membership_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"metadata_json" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"display_name" text,
	"logo_url" text,
	"profile_summary" text,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" text,
	"archived_by_user_id" text,
	"restore_deadline_at" text,
	"lifecycle_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "teams_slug_unique" UNIQUE("slug")
);

CREATE TABLE "user_email_addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"is_primary" integer DEFAULT 0 NOT NULL,
	"verification_requested_at" text,
	"verified_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "user_email_addresses_normalized_email_unique" UNIQUE("normalized_email")
);

CREATE TABLE "user_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_subject" text NOT NULL,
	"email" text,
	"email_verified" integer DEFAULT 0 NOT NULL,
	"profile_json" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE TABLE "user_role_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"created_at" text NOT NULL
);

CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"display_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata_json" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"username" text
);

CREATE TABLE "web_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"identity_id" text,
	"better_auth_session_id" text,
	"provider" text NOT NULL,
	"provider_subject" text NOT NULL,
	"email" text,
	"display_name" text,
	"principal_json" text NOT NULL,
	"csrf_token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"authenticated_at" text NOT NULL,
	"last_seen_at" text,
	"expires_at" text NOT NULL,
	"revoked_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

ALTER TABLE "capacity_execution_providers" ADD CONSTRAINT "fk_capacity_execution_providers_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_credential_issuance_authorizations" ADD CONSTRAINT "fk_capacity_provider_credential_authorizations_membership" FOREIGN KEY ("membership_id") REFERENCES "public"."capacity_provider_team_memberships"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_credential_issuance_authorizations" ADD CONSTRAINT "fk_capacity_provider_credential_authorizations_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_credential_issuance_authorizations" ADD CONSTRAINT "fk_capacity_provider_credential_authorizations_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_provider_identity_rotations" ADD CONSTRAINT "fk_capacity_provider_identity_rotations_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_lanes" ADD CONSTRAINT "fk_capacity_provider_lanes_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_lanes" ADD CONSTRAINT "fk_capacity_provider_lanes_execution_provider" FOREIGN KEY ("capacity_provider_id","execution_provider_id") REFERENCES "public"."capacity_execution_providers"("capacity_provider_id","id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_registration_requests" ADD CONSTRAINT "fk_capacity_provider_registration_requests_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_registration_requests" ADD CONSTRAINT "fk_capacity_provider_registration_requests_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_provider_team_memberships" ADD CONSTRAINT "fk_capacity_provider_team_memberships_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_team_memberships" ADD CONSTRAINT "fk_capacity_provider_team_memberships_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "team_capacity_registration_keys" ADD CONSTRAINT "fk_team_capacity_registration_keys_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_fallback_outputs" ADD CONSTRAINT "fk_agent_fallback_outputs_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_fallback_outputs" ADD CONSTRAINT "fk_agent_fallback_outputs_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "agent_fallback_outputs" ADD CONSTRAINT "fk_agent_fallback_outputs_assignment" FOREIGN KEY ("assignment_id") REFERENCES "public"."capacity_provider_assignments"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "agent_invocation_requests" ADD CONSTRAINT "fk_agent_invocations_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_invocation_requests" ADD CONSTRAINT "fk_agent_invocations_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_invocation_requests" ADD CONSTRAINT "fk_agent_invocations_agent_class" FOREIGN KEY ("project_agent_class_id") REFERENCES "public"."project_agent_classes"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "agent_mode_runs" ADD CONSTRAINT "fk_agent_mode_runs_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_mode_runs" ADD CONSTRAINT "fk_agent_mode_runs_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "agent_mode_runs" ADD CONSTRAINT "fk_agent_mode_runs_assignment" FOREIGN KEY ("provider_assignment_id") REFERENCES "public"."capacity_provider_assignments"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "agent_mode_runs" ADD CONSTRAINT "fk_agent_mode_runs_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "agent_mode_runs" ADD CONSTRAINT "fk_agent_mode_runs_execution_provider" FOREIGN KEY ("capacity_provider_id","execution_provider_id") REFERENCES "public"."capacity_execution_providers"("capacity_provider_id","id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "agent_mode_runs" ADD CONSTRAINT "fk_agent_mode_runs_agent_class" FOREIGN KEY ("project_agent_class_id") REFERENCES "public"."project_agent_classes"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_runs" ADD CONSTRAINT "fk_capacity_workday_runs_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "decision_assignment_graphs" ADD CONSTRAINT "fk_decision_assignment_graphs_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "decision_assignment_graphs" ADD CONSTRAINT "fk_decision_assignment_graphs_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "decision_execution_inputs" ADD CONSTRAINT "fk_decision_execution_inputs_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "decision_execution_inputs" ADD CONSTRAINT "fk_decision_execution_inputs_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "decision_execution_inputs" ADD CONSTRAINT "fk_decision_execution_inputs_agent_class" FOREIGN KEY ("project_agent_class_id") REFERENCES "public"."project_agent_classes"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "decision_planning_statuses" ADD CONSTRAINT "fk_decision_planning_statuses_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "decision_planning_statuses" ADD CONSTRAINT "fk_decision_planning_statuses_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "deliverable_contracts" ADD CONSTRAINT "fk_deliverable_contracts_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "deliverable_contracts" ADD CONSTRAINT "fk_deliverable_contracts_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "deliverable_manifests" ADD CONSTRAINT "fk_deliverable_manifests_contract" FOREIGN KEY ("deliverable_contract_id") REFERENCES "public"."deliverable_contracts"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "deliverable_manifests" ADD CONSTRAINT "fk_deliverable_manifests_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "research_workflows" ADD CONSTRAINT "fk_research_workflows_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "research_workflows" ADD CONSTRAINT "fk_research_workflows_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "structured_agent_estimates" ADD CONSTRAINT "fk_structured_agent_estimates_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "structured_agent_estimates" ADD CONSTRAINT "fk_structured_agent_estimates_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_context_query_checks" ADD CONSTRAINT "fk_agent_context_query_checks_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_context_query_checks" ADD CONSTRAINT "fk_agent_context_query_checks_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_client_actions" ADD CONSTRAINT "fk_agent_client_actions_session" FOREIGN KEY ("session_id") REFERENCES "public"."agent_client_sessions"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "agent_client_actions" ADD CONSTRAINT "fk_agent_client_actions_assignment" FOREIGN KEY ("assignment_id") REFERENCES "public"."capacity_provider_assignments"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "agent_client_actions" ADD CONSTRAINT "fk_agent_client_actions_user" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_client_actions" ADD CONSTRAINT "fk_agent_client_actions_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_client_actions" ADD CONSTRAINT "fk_agent_client_actions_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_client_sessions" ADD CONSTRAINT "fk_agent_client_sessions_user" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_client_sessions" ADD CONSTRAINT "fk_agent_client_sessions_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_client_sessions" ADD CONSTRAINT "fk_agent_client_sessions_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_operation_handoffs" ADD CONSTRAINT "fk_agent_operation_handoffs_assignment" FOREIGN KEY ("assignment_id") REFERENCES "public"."capacity_provider_assignments"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "agent_operation_handoffs" ADD CONSTRAINT "fk_agent_operation_handoffs_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_operation_handoffs" ADD CONSTRAINT "fk_agent_operation_handoffs_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_allocation_sets" ADD CONSTRAINT "fk_capacity_allocation_sets_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_allocation_sets" ADD CONSTRAINT "fk_capacity_allocation_sets_superseded_by" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."capacity_allocation_sets"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_ledger_entries" ADD CONSTRAINT "fk_capacity_ledger_membership" FOREIGN KEY ("membership_id") REFERENCES "public"."capacity_provider_team_memberships"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_ledger_entries" ADD CONSTRAINT "fk_capacity_ledger_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_ledger_entries" ADD CONSTRAINT "fk_capacity_ledger_execution_provider" FOREIGN KEY ("capacity_provider_id","execution_provider_id") REFERENCES "public"."capacity_execution_providers"("capacity_provider_id","id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_ledger_entries" ADD CONSTRAINT "fk_capacity_ledger_lane" FOREIGN KEY ("capacity_provider_id","lane_id") REFERENCES "public"."capacity_provider_lanes"("capacity_provider_id","id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_ledger_entries" ADD CONSTRAINT "fk_capacity_ledger_reservation" FOREIGN KEY ("reservation_id") REFERENCES "public"."capacity_reservations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_ledger_entries" ADD CONSTRAINT "fk_capacity_ledger_assignment" FOREIGN KEY ("assignment_id") REFERENCES "public"."capacity_provider_assignments"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_ledger_entries" ADD CONSTRAINT "fk_capacity_ledger_mode_run" FOREIGN KEY ("mode_run_id") REFERENCES "public"."agent_mode_runs"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_ledger_entries" ADD CONSTRAINT "fk_capacity_ledger_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_ledger_entries" ADD CONSTRAINT "fk_capacity_ledger_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_provider_assignments" ADD CONSTRAINT "fk_capacity_provider_assignments_membership" FOREIGN KEY ("membership_id") REFERENCES "public"."capacity_provider_team_memberships"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_provider_assignments" ADD CONSTRAINT "fk_capacity_provider_assignments_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_assignments" ADD CONSTRAINT "fk_capacity_provider_assignments_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_provider_assignments" ADD CONSTRAINT "fk_capacity_provider_assignments_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_provider_assignments" ADD CONSTRAINT "fk_capacity_provider_assignments_session" FOREIGN KEY ("provider_session_id") REFERENCES "public"."capacity_provider_availability_sessions"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "capacity_provider_assignments" ADD CONSTRAINT "fk_capacity_provider_assignments_execution_provider" FOREIGN KEY ("capacity_provider_id","execution_provider_id") REFERENCES "public"."capacity_execution_providers"("capacity_provider_id","id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_provider_assignments" ADD CONSTRAINT "fk_capacity_provider_assignments_lane" FOREIGN KEY ("capacity_provider_id","lane_id") REFERENCES "public"."capacity_provider_lanes"("capacity_provider_id","id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_provider_assignments" ADD CONSTRAINT "fk_capacity_provider_assignments_allocation" FOREIGN KEY ("allocation_set_id") REFERENCES "public"."capacity_allocation_sets"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_provider_assignments" ADD CONSTRAINT "fk_capacity_provider_assignments_agent_class" FOREIGN KEY ("project_agent_class_id") REFERENCES "public"."project_agent_classes"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_provider_assignments" ADD CONSTRAINT "fk_capacity_provider_assignments_reservation" FOREIGN KEY ("reservation_id") REFERENCES "public"."capacity_reservations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_usage_actuals" ADD CONSTRAINT "fk_capacity_usage_actuals_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_usage_actuals" ADD CONSTRAINT "fk_capacity_usage_actuals_assignment" FOREIGN KEY ("assignment_id") REFERENCES "public"."capacity_provider_assignments"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_usage_actuals" ADD CONSTRAINT "fk_capacity_usage_actuals_mode_run" FOREIGN KEY ("mode_run_id") REFERENCES "public"."agent_mode_runs"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_usage_actuals" ADD CONSTRAINT "fk_capacity_usage_actuals_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_usage_actuals" ADD CONSTRAINT "fk_capacity_usage_actuals_execution_provider" FOREIGN KEY ("capacity_provider_id","execution_provider_id") REFERENCES "public"."capacity_execution_providers"("capacity_provider_id","id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_usage_actuals" ADD CONSTRAINT "fk_capacity_usage_actuals_lane" FOREIGN KEY ("capacity_provider_id","lane_id") REFERENCES "public"."capacity_provider_lanes"("capacity_provider_id","id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "project_agent_classes" ADD CONSTRAINT "fk_project_agent_classes_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "project_agent_classes" ADD CONSTRAINT "fk_project_agent_classes_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_availability_sessions" ADD CONSTRAINT "fk_capacity_provider_availability_sessions_membership" FOREIGN KEY ("membership_id") REFERENCES "public"."capacity_provider_team_memberships"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_availability_sessions" ADD CONSTRAINT "fk_capacity_provider_availability_sessions_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_availability_sessions" ADD CONSTRAINT "fk_capacity_provider_availability_sessions_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_grants" ADD CONSTRAINT "fk_capacity_grants_membership" FOREIGN KEY ("membership_id") REFERENCES "public"."capacity_provider_team_memberships"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_grants" ADD CONSTRAINT "fk_capacity_grants_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_grants" ADD CONSTRAINT "fk_capacity_grants_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_grants" ADD CONSTRAINT "fk_capacity_grants_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_operation_receipts" ADD CONSTRAINT "fk_capacity_operation_receipts_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_access_tokens" ADD CONSTRAINT "fk_capacity_provider_access_tokens_membership" FOREIGN KEY ("membership_id") REFERENCES "public"."capacity_provider_team_memberships"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_access_tokens" ADD CONSTRAINT "fk_capacity_provider_access_tokens_credential" FOREIGN KEY ("credential_id") REFERENCES "public"."capacity_provider_team_credentials"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_team_credentials" ADD CONSTRAINT "fk_capacity_provider_team_credentials_membership" FOREIGN KEY ("membership_id") REFERENCES "public"."capacity_provider_team_memberships"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_team_credentials" ADD CONSTRAINT "fk_capacity_provider_team_credentials_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_provider_team_credentials" ADD CONSTRAINT "fk_capacity_provider_team_credentials_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_provider_team_credentials" ADD CONSTRAINT "fk_capacity_provider_team_credentials_authorization" FOREIGN KEY ("issuance_authorization_id") REFERENCES "public"."capacity_provider_credential_issuance_authorizations"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_provider_team_credentials" ADD CONSTRAINT "fk_capacity_provider_team_credentials_rotated_from" FOREIGN KEY ("rotated_from_credential_id") REFERENCES "public"."capacity_provider_team_credentials"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "capacity_reservations" ADD CONSTRAINT "fk_capacity_reservations_membership" FOREIGN KEY ("membership_id") REFERENCES "public"."capacity_provider_team_memberships"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_reservations" ADD CONSTRAINT "fk_capacity_reservations_grant" FOREIGN KEY ("grant_id") REFERENCES "public"."capacity_grants"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_reservations" ADD CONSTRAINT "fk_capacity_reservations_provider" FOREIGN KEY ("capacity_provider_id") REFERENCES "public"."capacity_providers"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_reservations" ADD CONSTRAINT "fk_capacity_reservations_execution_provider" FOREIGN KEY ("capacity_provider_id","execution_provider_id") REFERENCES "public"."capacity_execution_providers"("capacity_provider_id","id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_reservations" ADD CONSTRAINT "fk_capacity_reservations_lane" FOREIGN KEY ("capacity_provider_id","lane_id") REFERENCES "public"."capacity_provider_lanes"("capacity_provider_id","id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_reservations" ADD CONSTRAINT "fk_capacity_reservations_allocation" FOREIGN KEY ("allocation_set_id") REFERENCES "public"."capacity_allocation_sets"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_reservations" ADD CONSTRAINT "fk_capacity_reservations_agent_class" FOREIGN KEY ("project_agent_class_id") REFERENCES "public"."project_agent_classes"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_reservations" ADD CONSTRAINT "fk_capacity_reservations_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_reservations" ADD CONSTRAINT "fk_capacity_reservations_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "agent_capacity_plans" ADD CONSTRAINT "fk_agent_capacity_plans_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_capacity_plans" ADD CONSTRAINT "fk_agent_capacity_plans_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_capacity_plans" ADD CONSTRAINT "fk_agent_capacity_plans_allocation" FOREIGN KEY ("allocation_set_id") REFERENCES "public"."capacity_allocation_sets"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "agent_capacity_plans" ADD CONSTRAINT "fk_agent_capacity_plans_workday" FOREIGN KEY ("work_day_id") REFERENCES "public"."workday_capacity_envelopes"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "agent_signals" ADD CONSTRAINT "fk_agent_signals_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_signals" ADD CONSTRAINT "fk_agent_signals_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "agent_signals" ADD CONSTRAINT "fk_agent_signals_assignment" FOREIGN KEY ("assignment_id") REFERENCES "public"."capacity_provider_assignments"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_demands" ADD CONSTRAINT "fk_capacity_workday_demands_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_workday_demands" ADD CONSTRAINT "fk_capacity_workday_demands_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_demands" ADD CONSTRAINT "fk_capacity_workday_demands_run" FOREIGN KEY ("workday_run_id") REFERENCES "public"."capacity_workday_runs"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_demands" ADD CONSTRAINT "fk_capacity_workday_demands_workday" FOREIGN KEY ("workday_id") REFERENCES "public"."workday_capacity_envelopes"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_demands" ADD CONSTRAINT "fk_capacity_workday_demands_agent_class" FOREIGN KEY ("project_agent_class_id") REFERENCES "public"."project_agent_classes"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_demands" ADD CONSTRAINT "fk_capacity_workday_demands_assignment" FOREIGN KEY ("assignment_id") REFERENCES "public"."capacity_provider_assignments"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_demands" ADD CONSTRAINT "fk_capacity_workday_demands_capacity_plan" FOREIGN KEY ("capacity_plan_id") REFERENCES "public"."agent_capacity_plans"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_events" ADD CONSTRAINT "fk_capacity_workday_events_run" FOREIGN KEY ("run_id") REFERENCES "public"."capacity_workday_runs"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_events" ADD CONSTRAINT "fk_capacity_workday_events_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_workday_events" ADD CONSTRAINT "fk_capacity_workday_events_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_participation_cycles" ADD CONSTRAINT "fk_capacity_workday_participation_cycles_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_workday_participation_cycles" ADD CONSTRAINT "fk_capacity_workday_participation_cycles_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_participation_cycles" ADD CONSTRAINT "fk_capacity_workday_participation_cycles_run" FOREIGN KEY ("workday_run_id") REFERENCES "public"."capacity_workday_runs"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_participation_entries" ADD CONSTRAINT "fk_capacity_workday_participation_entries_cycle" FOREIGN KEY ("cycle_id") REFERENCES "public"."capacity_workday_participation_cycles"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_participation_entries" ADD CONSTRAINT "fk_capacity_workday_participation_entries_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "capacity_workday_participation_entries" ADD CONSTRAINT "fk_capacity_workday_participation_entries_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_participation_entries" ADD CONSTRAINT "fk_capacity_workday_participation_entries_run" FOREIGN KEY ("workday_run_id") REFERENCES "public"."capacity_workday_runs"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_participation_entries" ADD CONSTRAINT "fk_capacity_workday_participation_entries_agent_class" FOREIGN KEY ("project_agent_class_id") REFERENCES "public"."project_agent_classes"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_participation_entries" ADD CONSTRAINT "fk_capacity_workday_participation_entries_demand" FOREIGN KEY ("demand_id") REFERENCES "public"."capacity_workday_demands"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_participation_entries" ADD CONSTRAINT "fk_capacity_workday_participation_entries_assignment" FOREIGN KEY ("assignment_id") REFERENCES "public"."capacity_provider_assignments"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "capacity_workday_schedules" ADD CONSTRAINT "fk_capacity_workday_schedules_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "workday_capacity_envelopes" ADD CONSTRAINT "workday_capacity_envelopes_workday_run_id_capacity_workday_runs_id_fk" FOREIGN KEY ("workday_run_id") REFERENCES "public"."capacity_workday_runs"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "workday_capacity_envelopes" ADD CONSTRAINT "fk_workday_capacity_envelopes_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "workday_capacity_envelopes" ADD CONSTRAINT "fk_workday_capacity_envelopes_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "workday_capacity_envelopes" ADD CONSTRAINT "fk_workday_capacity_envelopes_allocation" FOREIGN KEY ("allocation_set_id") REFERENCES "public"."capacity_allocation_sets"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "workday_planning_participants" ADD CONSTRAINT "fk_workday_planning_participants_session" FOREIGN KEY ("session_id") REFERENCES "public"."workday_planning_sessions"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "workday_planning_participants" ADD CONSTRAINT "fk_workday_planning_participants_signal" FOREIGN KEY ("requested_by_signal_id") REFERENCES "public"."agent_signals"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "workday_planning_sessions" ADD CONSTRAINT "fk_workday_planning_sessions_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "workday_planning_sessions" ADD CONSTRAINT "fk_workday_planning_sessions_run" FOREIGN KEY ("workday_run_id") REFERENCES "public"."capacity_workday_runs"("id") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "workday_planning_waves" ADD CONSTRAINT "fk_workday_planning_waves_session" FOREIGN KEY ("session_id") REFERENCES "public"."workday_planning_sessions"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "seed_team_membership_claims" ADD CONSTRAINT "fk_seed_team_membership_claim_team" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "seed_team_membership_claims" ADD CONSTRAINT "fk_seed_team_membership_claim_membership" FOREIGN KEY ("membership_id") REFERENCES "public"."team_memberships"("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX "idx_better_auth_account_userId" ON "better_auth_account" USING btree ("userId");

CREATE UNIQUE INDEX "idx_better_auth_account_provider_account" ON "better_auth_account" USING btree ("providerId","accountId");

CREATE INDEX "idx_better_auth_verification_identifier" ON "better_auth_verification" USING btree ("identifier");

CREATE UNIQUE INDEX "idx_capacity_execution_providers_provider_adapter" ON "capacity_execution_providers" USING btree ("capacity_provider_id","adapter","id");

CREATE INDEX "idx_capacity_execution_providers_provider_status" ON "capacity_execution_providers" USING btree ("capacity_provider_id","status","updated_at");

CREATE UNIQUE INDEX "idx_capacity_provider_credential_authorizations_generation" ON "capacity_provider_credential_issuance_authorizations" USING btree ("membership_id","generation");

CREATE UNIQUE INDEX "idx_capacity_provider_credential_authorizations_idempotency" ON "capacity_provider_credential_issuance_authorizations" USING btree ("membership_id","idempotency_key");

CREATE INDEX "idx_capacity_provider_credential_authorizations_pending" ON "capacity_provider_credential_issuance_authorizations" USING btree ("membership_id","status","created_at");

CREATE UNIQUE INDEX "idx_capacity_provider_identity_rotations_idempotency" ON "capacity_provider_identity_rotations" USING btree ("capacity_provider_id","idempotency_key");

CREATE UNIQUE INDEX "idx_capacity_provider_identity_rotations_version" ON "capacity_provider_identity_rotations" USING btree ("capacity_provider_id","to_identity_version");

CREATE UNIQUE INDEX "idx_capacity_provider_lanes_provider_execution_name" ON "capacity_provider_lanes" USING btree ("capacity_provider_id","execution_provider_id","display_name");

CREATE INDEX "idx_capacity_provider_lanes_provider_status" ON "capacity_provider_lanes" USING btree ("capacity_provider_id","status","updated_at");

CREATE UNIQUE INDEX "idx_capacity_provider_registration_request_pending" ON "capacity_provider_registration_requests" USING btree ("team_id","capacity_provider_id","registration_key_generation");

CREATE UNIQUE INDEX "idx_capacity_provider_registration_request_proof" ON "capacity_provider_registration_requests" USING btree ("provider_fingerprint","proof_jti");

CREATE UNIQUE INDEX "idx_capacity_provider_registration_request_idempotency" ON "capacity_provider_registration_requests" USING btree ("team_id","idempotency_key");

CREATE INDEX "idx_capacity_provider_registration_requests_team" ON "capacity_provider_registration_requests" USING btree ("team_id","status","created_at");

CREATE INDEX "idx_capacity_provider_registration_requests_provider" ON "capacity_provider_registration_requests" USING btree ("capacity_provider_id","status","created_at");

CREATE UNIQUE INDEX "idx_capacity_provider_team_memberships_unique" ON "capacity_provider_team_memberships" USING btree ("team_id","capacity_provider_id");

CREATE INDEX "idx_capacity_provider_team_memberships_team" ON "capacity_provider_team_memberships" USING btree ("team_id","status","updated_at");

CREATE INDEX "idx_capacity_provider_team_memberships_provider" ON "capacity_provider_team_memberships" USING btree ("capacity_provider_id","status","updated_at");

CREATE UNIQUE INDEX "idx_capacity_providers_fingerprint" ON "capacity_providers" USING btree ("fingerprint");

CREATE INDEX "idx_capacity_providers_status" ON "capacity_providers" USING btree ("status","updated_at");

CREATE UNIQUE INDEX "idx_team_capacity_registration_keys_generation" ON "team_capacity_registration_keys" USING btree ("team_id","generation");

CREATE UNIQUE INDEX "idx_team_capacity_registration_keys_prefix" ON "team_capacity_registration_keys" USING btree ("key_prefix");

CREATE UNIQUE INDEX "idx_team_capacity_registration_keys_rotation" ON "team_capacity_registration_keys" USING btree ("team_id","rotation_idempotency_key");

CREATE INDEX "idx_team_capacity_registration_keys_current" ON "team_capacity_registration_keys" USING btree ("team_id","status","generation");

CREATE INDEX "idx_team_invites_team_status" ON "team_invites" USING btree ("team_id","status","created_at");

CREATE INDEX "idx_team_invites_token_prefix" ON "team_invites" USING btree ("token_prefix");

CREATE UNIQUE INDEX "idx_agent_lab_view_state_owner_entity" ON "agent_lab_view_state" USING btree ("user_id","team_id","namespace","entity_kind","entity_id");

CREATE INDEX "idx_agent_lab_view_state_owner_namespace" ON "agent_lab_view_state" USING btree ("user_id","team_id","namespace","updated_at");

CREATE INDEX "idx_cursor_state_updated" ON "cursor_state" USING btree ("updated_at");

CREATE INDEX "idx_lease_state_status_expires" ON "lease_state" USING btree ("status","lease_expires_at");

CREATE INDEX "idx_lease_state_claimed_by" ON "lease_state" USING btree ("claimed_by","updated_at");

CREATE UNIQUE INDEX "idx_credit_conversion_profiles_profile_key" ON "credit_conversion_profiles" USING btree ("task_signature","execution_profile_id","execution_provider_kind","native_unit");

CREATE INDEX "idx_credit_conversion_profiles_kind_unit" ON "credit_conversion_profiles" USING btree ("execution_provider_kind","native_unit","updated_at");

CREATE INDEX "idx_message_queue_claimable" ON "message_queue" USING btree ("status","available_at","priority");

CREATE INDEX "idx_message_queue_related" ON "message_queue" USING btree ("related_model","related_id","created_at");

CREATE INDEX "idx_notification_email_deliveries_due" ON "notification_email_deliveries" USING btree ("status","due_at");

CREATE INDEX "idx_notification_events_project" ON "notification_events" USING btree ("project_id","created_at");

CREATE UNIQUE INDEX "idx_platform_operation_events_seq" ON "platform_operation_events" USING btree ("operation_id","seq");

CREATE UNIQUE INDEX "idx_platform_operations_idempotency" ON "platform_operations" USING btree ("namespace","operation","idempotency_key");

CREATE INDEX "idx_platform_operations_runnable" ON "platform_operations" USING btree ("status","created_at");

CREATE INDEX "idx_runtime_records_type_lookup_updated" ON "runtime_records" USING btree ("record_type","lookup_key","updated_at");

CREATE INDEX "idx_runtime_records_type_status_updated" ON "runtime_records" USING btree ("record_type","status","updated_at");

CREATE INDEX "idx_seed_runs_seed_created" ON "seed_runs" USING btree ("seed_name","created_at");

CREATE INDEX "idx_seed_runs_state_created" ON "seed_runs" USING btree ("state","created_at");

CREATE INDEX "idx_session_events_team_sequence" ON "session_events" USING btree ("team_id","sequence");

CREATE INDEX "idx_session_events_expiry" ON "session_events" USING btree ("expires_at");

CREATE UNIQUE INDEX "idx_user_notifications_event" ON "user_notifications" USING btree ("user_id","event_id");

CREATE INDEX "idx_user_notifications_user" ON "user_notifications" USING btree ("user_id","read_at","created_at");

CREATE INDEX "idx_team_service_capabilities_team_type" ON "team_service_capability_bindings" USING btree ("team_id","capability_type","status");

CREATE UNIQUE INDEX "idx_team_service_capabilities_connection_type" ON "team_service_capability_bindings" USING btree ("connection_id","capability_type");

CREATE INDEX "idx_team_service_connections_team_status" ON "team_service_connections" USING btree ("team_id","status","updated_at");

CREATE UNIQUE INDEX "idx_team_service_connections_team_provider_name" ON "team_service_connections" USING btree ("team_id","provider_id","display_name");

CREATE INDEX "idx_team_service_credentials_connection" ON "team_service_credential_profiles" USING btree ("connection_id","status");

CREATE UNIQUE INDEX "idx_team_service_credentials_connection_definition" ON "team_service_credential_profiles" USING btree ("connection_id","definition_id");

CREATE INDEX "idx_agent_fallback_outputs_project_created" ON "agent_fallback_outputs" USING btree ("project_id","created_at");

CREATE INDEX "idx_agent_fallback_outputs_project_mode_status" ON "agent_fallback_outputs" USING btree ("project_id","mode","status","created_at");

CREATE INDEX "idx_agent_fallback_outputs_assignment" ON "agent_fallback_outputs" USING btree ("assignment_id","created_at");

CREATE UNIQUE INDEX "idx_agent_invocations_idempotency" ON "agent_invocation_requests" USING btree ("team_id","idempotency_key");

CREATE INDEX "idx_agent_invocations_decision" ON "agent_invocation_requests" USING btree ("decision_id","status","requested_at");

CREATE INDEX "idx_agent_invocations_admission" ON "agent_invocation_requests" USING btree ("team_id","status","priority_class","available_at");

CREATE INDEX "idx_agent_invocations_discussion_agent" ON "agent_invocation_requests" USING btree ("project_id","agent_id","subject_digest","status");

CREATE INDEX "idx_agent_mode_runs_assignment" ON "agent_mode_runs" USING btree ("provider_assignment_id","status");

CREATE INDEX "idx_agent_mode_runs_project_mode" ON "agent_mode_runs" USING btree ("project_id","mode","created_at");

CREATE INDEX "idx_agent_mode_runs_provider" ON "agent_mode_runs" USING btree ("capacity_provider_id","created_at");

CREATE INDEX "idx_capacity_workday_runs_team_status" ON "capacity_workday_runs" USING btree ("team_id","status","updated_at");

CREATE INDEX "idx_capacity_workday_runs_provider" ON "capacity_workday_runs" USING btree ("capacity_provider_id","updated_at");

CREATE UNIQUE INDEX "idx_decision_assignment_graphs_version" ON "decision_assignment_graphs" USING btree ("decision_id","version");

CREATE UNIQUE INDEX "idx_decision_assignment_graphs_one_active" ON "decision_assignment_graphs" USING btree ("decision_id") WHERE "decision_assignment_graphs"."active" = 1;

CREATE INDEX "idx_decision_assignment_graphs_decision" ON "decision_assignment_graphs" USING btree ("decision_id","active","version");

CREATE INDEX "idx_decision_execution_inputs_decision" ON "decision_execution_inputs" USING btree ("decision_id","status","created_at");

CREATE INDEX "idx_decision_execution_inputs_graph_node" ON "decision_execution_inputs" USING btree ("decision_id","work_graph_node_id","status");

CREATE UNIQUE INDEX "idx_decision_execution_inputs_graph_scope" ON "decision_execution_inputs" USING btree ("decision_id","work_graph_node_id","scope_hash") WHERE "decision_execution_inputs"."work_graph_node_id" IS NOT NULL;

CREATE INDEX "idx_decision_execution_inputs_project" ON "decision_execution_inputs" USING btree ("project_id","status","mode","created_at");

CREATE UNIQUE INDEX "idx_decision_planning_statuses_decision" ON "decision_planning_statuses" USING btree ("decision_id");

CREATE INDEX "idx_decision_planning_statuses_project" ON "decision_planning_statuses" USING btree ("project_id","execution_readiness","updated_at");

CREATE INDEX "idx_deliverable_contracts_decision" ON "deliverable_contracts" USING btree ("decision_id","status","deliverable_type");

CREATE INDEX "idx_deliverable_manifests_contract" ON "deliverable_manifests" USING btree ("deliverable_contract_id","submitted_at");

CREATE UNIQUE INDEX "idx_research_workflows_idempotency" ON "research_workflows" USING btree ("project_id","idempotency_key");

CREATE INDEX "idx_research_workflows_question" ON "research_workflows" USING btree ("project_id","question_ref","status","updated_at");

CREATE INDEX "idx_structured_agent_estimates_decision" ON "structured_agent_estimates" USING btree ("decision_id","status","created_at");

CREATE UNIQUE INDEX "idx_agent_context_query_checks_idempotency" ON "agent_context_query_checks" USING btree ("team_id","idempotency_key");

CREATE INDEX "idx_agent_context_query_checks_latest" ON "agent_context_query_checks" USING btree ("project_id","definition_kind","definition_id","definition_revision","checked_at");

CREATE UNIQUE INDEX "idx_agent_client_actions_idempotency" ON "agent_client_actions" USING btree ("assignment_id","idempotency_key");

CREATE INDEX "idx_agent_client_actions_session_status" ON "agent_client_actions" USING btree ("session_id","status","created_at");

CREATE INDEX "idx_agent_client_sessions_scope" ON "agent_client_sessions" USING btree ("user_id","team_id","project_id","status","expires_at");

CREATE UNIQUE INDEX "idx_agent_operation_handoffs_idempotency" ON "agent_operation_handoffs" USING btree ("assignment_id","idempotency_key");

CREATE INDEX "idx_agent_operation_handoffs_discussion" ON "agent_operation_handoffs" USING btree ("project_id","discussion_id","status","created_at");

CREATE UNIQUE INDEX "idx_capacity_allocation_sets_team_version" ON "capacity_allocation_sets" USING btree ("team_id","version");

CREATE INDEX "idx_capacity_allocation_sets_team_status" ON "capacity_allocation_sets" USING btree ("team_id","status","effective_from");

CREATE INDEX "idx_capacity_allocation_sets_team_created" ON "capacity_allocation_sets" USING btree ("team_id","created_at");

CREATE UNIQUE INDEX "idx_capacity_ledger_settlement_key" ON "capacity_ledger_entries" USING btree ("settlement_key");

CREATE UNIQUE INDEX "idx_capacity_ledger_reservation_phase" ON "capacity_ledger_entries" USING btree ("reservation_id","phase");

CREATE INDEX "idx_capacity_ledger_assignment" ON "capacity_ledger_entries" USING btree ("assignment_id","created_at");

CREATE INDEX "idx_capacity_ledger_project_workday_created" ON "capacity_ledger_entries" USING btree ("project_id","work_day_id","created_at");

CREATE INDEX "idx_capacity_provider_assignments_membership_status" ON "capacity_provider_assignments" USING btree ("membership_id","status","lease_expires_at");

CREATE INDEX "idx_capacity_provider_assignments_provider_status" ON "capacity_provider_assignments" USING btree ("capacity_provider_id","status","lease_expires_at");

CREATE INDEX "idx_capacity_provider_assignments_lane_status" ON "capacity_provider_assignments" USING btree ("lane_id","status","lease_expires_at");

CREATE INDEX "idx_capacity_provider_assignments_project_mode" ON "capacity_provider_assignments" USING btree ("project_id","mode","status");

CREATE INDEX "idx_capacity_provider_assignments_lease" ON "capacity_provider_assignments" USING btree ("capacity_provider_id","lease_state","lease_expires_at");

CREATE INDEX "idx_capacity_provider_assignments_runner" ON "capacity_provider_assignments" USING btree ("runner_id","lease_state");

CREATE UNIQUE INDEX "idx_capacity_provider_assignments_synthesis_key" ON "capacity_provider_assignments" USING btree ("team_id","synthesis_key");

CREATE INDEX "idx_capacity_provider_assignments_decision" ON "capacity_provider_assignments" USING btree ("decision_id","status");

CREATE INDEX "idx_capacity_provider_assignments_team_created" ON "capacity_provider_assignments" USING btree ("team_id","created_at");

CREATE UNIQUE INDEX "idx_capacity_usage_actuals_idempotency" ON "capacity_usage_actuals" USING btree ("idempotency_key");

CREATE UNIQUE INDEX "idx_capacity_usage_actuals_attempt_dimension" ON "capacity_usage_actuals" USING btree ("assignment_id","assignment_attempt","usage_dimension");

CREATE INDEX "idx_capacity_usage_actuals_project_signature" ON "capacity_usage_actuals" USING btree ("project_id","task_signature","created_at");

CREATE INDEX "idx_capacity_usage_actuals_project_signature_profile" ON "capacity_usage_actuals" USING btree ("project_id","task_signature","execution_profile_id","created_at");

CREATE INDEX "idx_capacity_usage_actuals_execution_provider" ON "capacity_usage_actuals" USING btree ("execution_provider_id","created_at");

CREATE INDEX "idx_capacity_usage_actuals_lane" ON "capacity_usage_actuals" USING btree ("lane_id","created_at");

CREATE UNIQUE INDEX "idx_project_agent_classes_project_slug" ON "project_agent_classes" USING btree ("project_id","slug");

CREATE INDEX "idx_project_agent_classes_team_project" ON "project_agent_classes" USING btree ("team_id","project_id","status");

CREATE INDEX "idx_capacity_provider_availability_sessions_membership_status" ON "capacity_provider_availability_sessions" USING btree ("membership_id","status","expires_at");

CREATE INDEX "idx_capacity_provider_availability_sessions_provider_status" ON "capacity_provider_availability_sessions" USING btree ("capacity_provider_id","status","refreshed_at");

CREATE INDEX "idx_capacity_provider_availability_sessions_team_status" ON "capacity_provider_availability_sessions" USING btree ("team_id","status","refreshed_at");

CREATE UNIQUE INDEX "idx_capacity_admission_counters_scope" ON "capacity_admission_counters" USING btree ("team_id","scope","scope_id","period_key");

CREATE INDEX "idx_capacity_admission_counters_team" ON "capacity_admission_counters" USING btree ("team_id","updated_at");

CREATE INDEX "idx_capacity_audit_events_team_created" ON "capacity_audit_events" USING btree ("team_id","created_at");

CREATE INDEX "idx_capacity_audit_events_provider_created" ON "capacity_audit_events" USING btree ("capacity_provider_id","created_at");

CREATE INDEX "idx_capacity_audit_events_membership_created" ON "capacity_audit_events" USING btree ("membership_id","created_at");

CREATE INDEX "idx_capacity_audit_events_resource" ON "capacity_audit_events" USING btree ("resource_type","resource_id","created_at");

CREATE UNIQUE INDEX "idx_capacity_audit_events_idempotency" ON "capacity_audit_events" USING btree ("team_id","action","resource_type","resource_id","idempotency_key");

CREATE INDEX "idx_capacity_grants_team_project" ON "capacity_grants" USING btree ("team_id","project_id","status");

CREATE INDEX "idx_capacity_grants_membership" ON "capacity_grants" USING btree ("membership_id","status","expires_at");

CREATE INDEX "idx_capacity_grants_provider" ON "capacity_grants" USING btree ("capacity_provider_id","status");

CREATE UNIQUE INDEX "idx_capacity_operation_receipts_idempotency" ON "capacity_operation_receipts" USING btree ("team_id","operation","idempotency_key");

CREATE INDEX "idx_capacity_operation_receipts_resource" ON "capacity_operation_receipts" USING btree ("team_id","resource_type","resource_id","created_at");

CREATE UNIQUE INDEX "idx_capacity_provider_access_tokens_prefix" ON "capacity_provider_access_tokens" USING btree ("token_prefix");

CREATE UNIQUE INDEX "idx_capacity_provider_access_tokens_issue" ON "capacity_provider_access_tokens" USING btree ("membership_id","idempotency_key");

CREATE INDEX "idx_capacity_provider_access_tokens_membership" ON "capacity_provider_access_tokens" USING btree ("membership_id","status","expires_at");

CREATE INDEX "idx_capacity_provider_proof_nonces_expiry" ON "capacity_provider_proof_nonces" USING btree ("expires_at");

CREATE INDEX "idx_capacity_provider_registration_rate_limits_expiry" ON "capacity_provider_registration_rate_limits" USING btree ("expires_at");

CREATE UNIQUE INDEX "idx_capacity_provider_team_credentials_prefix" ON "capacity_provider_team_credentials" USING btree ("key_prefix");

CREATE UNIQUE INDEX "idx_capacity_provider_team_credentials_issue" ON "capacity_provider_team_credentials" USING btree ("membership_id","issue_idempotency_key");

CREATE UNIQUE INDEX "idx_capacity_provider_team_credentials_generation" ON "capacity_provider_team_credentials" USING btree ("membership_id","issuance_generation");

CREATE INDEX "idx_capacity_provider_team_credentials_membership" ON "capacity_provider_team_credentials" USING btree ("membership_id","status","created_at");

CREATE UNIQUE INDEX "idx_capacity_reservation_counter_claim" ON "capacity_reservation_counter_claims" USING btree ("reservation_id","counter_id");

CREATE INDEX "idx_capacity_reservation_counter_counter" ON "capacity_reservation_counter_claims" USING btree ("counter_id","created_at");

CREATE UNIQUE INDEX "idx_capacity_reservations_idempotency" ON "capacity_reservations" USING btree ("team_id","idempotency_key");

CREATE INDEX "idx_capacity_reservations_project_workday_state" ON "capacity_reservations" USING btree ("project_id","work_day_id","state","created_at");

CREATE INDEX "idx_capacity_reservations_membership_state" ON "capacity_reservations" USING btree ("membership_id","state","created_at");

CREATE INDEX "idx_capacity_reservations_provider_state" ON "capacity_reservations" USING btree ("capacity_provider_id","state","created_at");

CREATE INDEX "idx_capacity_reservations_execution_provider_state" ON "capacity_reservations" USING btree ("execution_provider_id","state","created_at");

CREATE INDEX "idx_capacity_reservations_lane_state" ON "capacity_reservations" USING btree ("lane_id","state","created_at");

CREATE INDEX "idx_agent_capacity_plans_decision" ON "agent_capacity_plans" USING btree ("decision_id","status","created_at");

CREATE INDEX "idx_agent_capacity_plans_project" ON "agent_capacity_plans" USING btree ("project_id","status","created_at");

CREATE INDEX "idx_agent_capacity_plans_workday" ON "agent_capacity_plans" USING btree ("work_day_id","status","created_at");

CREATE UNIQUE INDEX "idx_agent_signals_causation" ON "agent_signals" USING btree ("assignment_id","contract_id","subject_id","causation_id");

CREATE INDEX "idx_agent_signals_workday" ON "agent_signals" USING btree ("workday_run_id","contract_id","created_at");

CREATE INDEX "idx_agent_signals_subject" ON "agent_signals" USING btree ("team_id","project_id","subject_kind","subject_id","created_at");

CREATE INDEX "idx_agent_signals_commit" ON "agent_signals" USING btree ("project_id","commit_sha");

CREATE UNIQUE INDEX "idx_capacity_workday_demands_idempotency" ON "capacity_workday_demands" USING btree ("team_id","idempotency_key");

CREATE UNIQUE INDEX "idx_capacity_workday_demands_assignment" ON "capacity_workday_demands" USING btree ("assignment_id");

CREATE UNIQUE INDEX "idx_capacity_workday_demands_claim" ON "capacity_workday_demands" USING btree ("claim_token");

CREATE INDEX "idx_capacity_workday_demands_ready" ON "capacity_workday_demands" USING btree ("team_id","status","available_at","priority");

CREATE INDEX "idx_capacity_workday_demands_run" ON "capacity_workday_demands" USING btree ("workday_run_id","project_id","status","created_at");

CREATE UNIQUE INDEX "idx_capacity_workday_events_run_index" ON "capacity_workday_events" USING btree ("run_id","event_index");

CREATE INDEX "idx_capacity_workday_events_project" ON "capacity_workday_events" USING btree ("project_id","created_at");

CREATE UNIQUE INDEX "idx_capacity_workday_participation_cycles_number" ON "capacity_workday_participation_cycles" USING btree ("workday_run_id","project_id","cycle_number");

CREATE INDEX "idx_capacity_workday_participation_cycles_status" ON "capacity_workday_participation_cycles" USING btree ("workday_run_id","status","project_id");

CREATE UNIQUE INDEX "idx_capacity_workday_participation_entries_agent" ON "capacity_workday_participation_entries" USING btree ("cycle_id","agent_id");

CREATE UNIQUE INDEX "idx_capacity_workday_participation_entries_demand" ON "capacity_workday_participation_entries" USING btree ("demand_id");

CREATE INDEX "idx_capacity_workday_participation_entries_status" ON "capacity_workday_participation_entries" USING btree ("workday_run_id","project_id","status","agent_id");

CREATE INDEX "idx_capacity_workday_schedules_due" ON "capacity_workday_schedules" USING btree ("status","next_run_at");

CREATE INDEX "idx_capacity_workday_schedules_team" ON "capacity_workday_schedules" USING btree ("team_id","updated_at");

CREATE INDEX "idx_treedx_project_proxy_audit_project" ON "treedx_project_proxy_audit" USING btree ("project_id","created_at");

CREATE INDEX "idx_treedx_project_proxy_audit_assignment" ON "treedx_project_proxy_audit" USING btree ("assignment_id","created_at");

CREATE INDEX "idx_treedx_project_proxy_audit_result" ON "treedx_project_proxy_audit" USING btree ("project_id","result_status","created_at");

CREATE INDEX "idx_treedx_proxy_handles_assignment" ON "treedx_proxy_handles" USING btree ("assignment_id","status","expires_at");

CREATE INDEX "idx_treedx_proxy_handles_project" ON "treedx_proxy_handles" USING btree ("project_id","status","updated_at");

CREATE INDEX "idx_workday_capacity_envelopes_run_status" ON "workday_capacity_envelopes" USING btree ("workday_run_id","status","id");

CREATE INDEX "idx_workday_capacity_envelopes_project_status" ON "workday_capacity_envelopes" USING btree ("project_id","status","created_at");

CREATE INDEX "idx_workday_capacity_envelopes_team_status" ON "workday_capacity_envelopes" USING btree ("team_id","status","created_at");

CREATE UNIQUE INDEX "idx_workday_planning_participants_node" ON "workday_planning_participants" USING btree ("session_id","node_id");

CREATE INDEX "idx_workday_planning_participants_agent" ON "workday_planning_participants" USING btree ("session_id","agent_id");

CREATE UNIQUE INDEX "idx_workday_planning_sessions_run" ON "workday_planning_sessions" USING btree ("workday_run_id");

CREATE UNIQUE INDEX "idx_workday_planning_waves_order" ON "workday_planning_waves" USING btree ("session_id","round","wave");

CREATE INDEX "idx_better_auth_session_token" ON "better_auth_session" USING btree ("token");

CREATE INDEX "idx_better_auth_session_userId" ON "better_auth_session" USING btree ("userId");

CREATE UNIQUE INDEX "idx_better_auth_user_username" ON "better_auth_user" USING btree ("username");

CREATE INDEX "idx_project_summary_snapshots_team_generated" ON "project_summary_snapshots" USING btree ("team_id","generated_at");

CREATE INDEX "idx_team_inbox_items_team_created" ON "team_inbox_items" USING btree ("team_id","created_at");

CREATE UNIQUE INDEX "idx_governance_proposal_versions_unique" ON "governance_proposal_versions" USING btree ("proposal_id","version");

CREATE INDEX "idx_governance_proposal_versions_proposal" ON "governance_proposal_versions" USING btree ("proposal_id","created_at");

CREATE INDEX "idx_governance_proposals_team_status" ON "governance_proposals" USING btree ("team_id","status","updated_at");

CREATE INDEX "idx_governance_proposals_project_status" ON "governance_proposals" USING btree ("project_id","status","updated_at");

CREATE INDEX "idx_governance_proposals_scope_status" ON "governance_proposals" USING btree ("scope","status","updated_at");

CREATE INDEX "idx_governance_proposals_content_slug" ON "governance_proposals" USING btree ("content_proposal_slug");

CREATE INDEX "idx_project_governance_policies_project" ON "project_governance_policies" USING btree ("project_id","active");

CREATE INDEX "idx_team_governance_policies_team_scope" ON "team_governance_policies" USING btree ("team_id","scope","active");

CREATE UNIQUE INDEX "idx_entitlements_project" ON "entitlements" USING btree ("project_id");

CREATE UNIQUE INDEX "idx_governance_decisions_proposal" ON "governance_decisions" USING btree ("proposal_id");

CREATE INDEX "idx_governance_decisions_project_status" ON "governance_decisions" USING btree ("project_id","status","updated_at");

CREATE INDEX "idx_governance_delegations_team_status" ON "governance_delegations" USING btree ("team_id","status");

CREATE INDEX "idx_governance_delegations_from" ON "governance_delegations" USING btree ("from_user_id","status");

CREATE INDEX "idx_governance_delegations_to" ON "governance_delegations" USING btree ("to_user_id","status");

CREATE INDEX "idx_governance_electorate_snapshots_proposal" ON "governance_electorate_snapshots" USING btree ("proposal_id","proposal_version");

CREATE INDEX "idx_governance_events_proposal" ON "governance_events" USING btree ("proposal_id","created_at");

CREATE INDEX "idx_governance_events_decision" ON "governance_events" USING btree ("decision_id","created_at");

CREATE INDEX "idx_governance_events_team" ON "governance_events" USING btree ("team_id","created_at");

CREATE INDEX "idx_governance_events_project" ON "governance_events" USING btree ("project_id","created_at");

CREATE UNIQUE INDEX "idx_governance_proposal_votes_once" ON "governance_proposal_votes" USING btree ("proposal_id","proposal_version","user_id");

CREATE INDEX "idx_governance_proposal_votes_proposal" ON "governance_proposal_votes" USING btree ("proposal_id","proposal_version","vote");

CREATE INDEX "idx_governance_vote_events_proposal" ON "governance_vote_events" USING btree ("proposal_id","proposal_version","created_at");

CREATE UNIQUE INDEX "idx_projects_team_slug" ON "projects" USING btree ("team_id","slug");

CREATE INDEX "idx_projects_team_id" ON "projects" USING btree ("team_id");

CREATE UNIQUE INDEX "idx_remote_job_events_job_seq" ON "remote_job_events" USING btree ("job_id","seq");

CREATE INDEX "idx_remote_jobs_project_status" ON "remote_jobs" USING btree ("project_id","status","created_at");

CREATE INDEX "idx_remote_jobs_project_idempotency" ON "remote_jobs" USING btree ("project_id","idempotency_key");

CREATE INDEX "idx_team_api_keys_prefix" ON "team_api_keys" USING btree ("key_prefix");

CREATE INDEX "idx_auth_provider_states_expiry" ON "auth_provider_states" USING btree ("expires_at","used_at");

CREATE INDEX "idx_auth_reauthentication_grants_session" ON "auth_reauthentication_grants" USING btree ("user_id","session_id","action","expires_at");

CREATE INDEX "idx_treedx_deployments_team_instance" ON "treedx_deployments" USING btree ("team_id","instance_id","created_at");

CREATE INDEX "idx_treedx_mirrors_team_instance" ON "treedx_mirrors" USING btree ("team_id","instance_id");

CREATE UNIQUE INDEX "idx_treedx_project_libraries_project" ON "treedx_project_libraries" USING btree ("project_id");

CREATE INDEX "idx_treedx_project_libraries_instance" ON "treedx_project_libraries" USING btree ("instance_id");

CREATE INDEX "idx_treedx_shares_team_scope" ON "treedx_shares" USING btree ("team_id","scope","status");

CREATE UNIQUE INDEX "idx_user_personal_themes_name" ON "user_personal_themes" USING btree ("user_id","normalized_name");

CREATE INDEX "idx_user_personal_themes_user" ON "user_personal_themes" USING btree ("user_id","updated_at");

CREATE INDEX "idx_approval_requests_team_state" ON "approval_requests" USING btree ("team_id","state","created_at");

CREATE INDEX "idx_approval_requests_project_workday" ON "approval_requests" USING btree ("project_id","work_day_id","state","created_at");

CREATE UNIQUE INDEX "idx_hub_repositories_hub_role" ON "hub_repositories" USING btree ("hub_id","role");

CREATE INDEX "idx_treedx_instances_team_status" ON "treedx_instances" USING btree ("team_id","status");

CREATE UNIQUE INDEX "idx_book_collections_team_name" ON "book_collections" USING btree ("team_id","name");

CREATE UNIQUE INDEX "idx_knowledge_workspaces_treedx" ON "knowledge_authoring_workspaces" USING btree ("treedx_workspace_id");

CREATE INDEX "idx_knowledge_workspaces_project_actor" ON "knowledge_authoring_workspaces" USING btree ("project_id","actor_user_id","status");

CREATE INDEX "idx_knowledge_pack_builds_team_status" ON "knowledge_pack_builds" USING btree ("team_id","status");

CREATE INDEX "idx_knowledge_publications_project_status" ON "knowledge_publications" USING btree ("project_id","status");

CREATE UNIQUE INDEX "idx_knowledge_publications_review" ON "knowledge_publications" USING btree ("review_id");

CREATE INDEX "idx_knowledge_review_comments_review_status" ON "knowledge_review_comments" USING btree ("review_id","status");

CREATE INDEX "idx_knowledge_reviews_workspace_status" ON "knowledge_reviews" USING btree ("workspace_id","status");

CREATE UNIQUE INDEX "idx_knowledge_workspace_presence_actor" ON "knowledge_workspace_presence" USING btree ("workspace_id","user_id");

CREATE INDEX "idx_remote_repository_team_provider" ON "project_remote_repository_bindings" USING btree ("team_id","provider_id");

CREATE UNIQUE INDEX "idx_remote_repository_provider_id" ON "project_remote_repository_bindings" USING btree ("provider_id","provider_repository_id");

CREATE INDEX "idx_workflow_operations_project" ON "project_workflow_operations" USING btree ("project_id","workflow_id");

CREATE INDEX "idx_provider_connector_authorizations" ON "provider_connector_authorizations" USING btree ("provider_id","connector_kind","expires_at");

CREATE INDEX "idx_provider_authorities_team_status" ON "provider_credential_authorities" USING btree ("team_id","status");

CREATE UNIQUE INDEX "idx_provider_authorities_connection_profile" ON "provider_credential_authorities" USING btree ("connection_id","credential_profile_id");

CREATE UNIQUE INDEX "idx_provider_webhook_delivery" ON "provider_webhook_deliveries" USING btree ("provider_id","delivery_id");

CREATE INDEX "idx_remote_deliveries_node_status" ON "remote_credential_deliveries" USING btree ("node_id","status","expires_at");

CREATE INDEX "idx_remote_git_grants_status" ON "remote_git_operation_grants" USING btree ("status","expires_at");

CREATE INDEX "idx_workflow_configuration_delivery_status" ON "workflow_configuration_deliveries" USING btree ("status","expires_at");

CREATE UNIQUE INDEX "idx_workflow_configuration_target" ON "workflow_configuration_records" USING btree ("repository_binding_id","workflow_binding_id","kind","scope","environment","name");

CREATE INDEX "idx_workflow_configuration_project" ON "workflow_configuration_records" USING btree ("project_id","kind","status");

CREATE INDEX "idx_workflow_runs_operation_status" ON "workflow_operation_runs" USING btree ("operation_id","status","updated_at");

CREATE INDEX "idx_workflow_runs_assignment" ON "workflow_operation_runs" USING btree ("assignment_id","status","updated_at");

CREATE UNIQUE INDEX "idx_workflow_runs_provider_id" ON "workflow_operation_runs" USING btree ("provider_id","provider_run_id");

CREATE INDEX "idx_api_tokens_user_id" ON "api_tokens" USING btree ("user_id");

CREATE INDEX "idx_api_tokens_prefix" ON "api_tokens" USING btree ("token_prefix");

CREATE INDEX "idx_audit_events_target" ON "audit_events" USING btree ("target_type","target_id");

CREATE INDEX "idx_auth_sessions_user_id" ON "auth_sessions" USING btree ("user_id");

CREATE UNIQUE INDEX "idx_seed_team_membership_claim_resource" ON "seed_team_membership_claims" USING btree ("seed_name","resource_key");

CREATE INDEX "idx_seed_team_membership_claim_email" ON "seed_team_membership_claims" USING btree ("normalized_email","status");

CREATE UNIQUE INDEX "idx_team_memberships_team_user" ON "team_memberships" USING btree ("team_id","user_id");

CREATE UNIQUE INDEX "idx_teams_name" ON "teams" USING btree ("name");

CREATE INDEX "idx_user_email_addresses_user" ON "user_email_addresses" USING btree ("user_id","status","is_primary");

CREATE UNIQUE INDEX "idx_user_email_addresses_normalized" ON "user_email_addresses" USING btree ("normalized_email");

CREATE UNIQUE INDEX "idx_user_identities_provider_subject" ON "user_identities" USING btree ("provider","provider_subject");

CREATE UNIQUE INDEX "idx_user_role_bindings_user_role" ON "user_role_bindings" USING btree ("user_id","role_id");

CREATE UNIQUE INDEX "idx_users_username" ON "users" USING btree ("username");

CREATE INDEX "idx_web_sessions_user_id" ON "web_sessions" USING btree ("user_id");

CREATE TABLE IF NOT EXISTS "feedback_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"message" text NOT NULL,
	"submitter_user_id" text NOT NULL,
	"team_id" text,
	"project_id" text,
	"canonical_path" text NOT NULL,
	"route_pattern" text,
	"capability_id" text,
	"environment" text,
	"build_id" text,
	"revision" text,
	"context_json" text NOT NULL,
	"client_json" text NOT NULL,
	"allow_contact" integer DEFAULT 0 NOT NULL,
	"contact_email" text,
	"idempotency_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"resolved_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_feedback_status_created" ON "feedback_submissions" ("status", "created_at");

CREATE INDEX IF NOT EXISTS "idx_feedback_submitter_created" ON "feedback_submissions" ("submitter_user_id", "created_at");

CREATE INDEX IF NOT EXISTS "idx_feedback_team_created" ON "feedback_submissions" ("team_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_feedback_submitter_idempotency" ON "feedback_submissions" ("submitter_user_id", "idempotency_key");

CREATE TABLE IF NOT EXISTS "feedback_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"feedback_id" text NOT NULL,
	"storage_key" text NOT NULL UNIQUE,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"digest" text NOT NULL,
	"redaction_version" text,
	"masked_region_count" integer,
	"expires_at" text,
	"expired_at" text,
	"created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_feedback_attachments_feedback" ON "feedback_attachments" ("feedback_id", "created_at");

CREATE TABLE IF NOT EXISTS "feedback_status_events" (
	"id" text PRIMARY KEY NOT NULL,
	"feedback_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"actor_user_id" text NOT NULL,
	"created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_feedback_status_events_feedback" ON "feedback_status_events" ("feedback_id", "created_at");

CREATE TABLE IF NOT EXISTS "feedback_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"filters_json" text NOT NULL,
	"include_screenshots" integer DEFAULT 0 NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"storage_key" text,
	"digest" text,
	"byte_size" integer,
	"source_closure" text,
	"error" text,
	"expires_at" text NOT NULL,
	"completed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_feedback_exports_status_expiry" ON "feedback_exports" ("status", "expires_at");

CREATE TABLE IF NOT EXISTS "feedback_export_items" (
	"export_id" text NOT NULL,
	"feedback_id" text NOT NULL,
	"created_at" text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_feedback_export_items_pair" ON "feedback_export_items" ("export_id", "feedback_id");

INSERT INTO "feedback_submissions" (
	"id", "type", "status", "message", "submitter_user_id", "team_id", "project_id", "canonical_path",
	"route_pattern", "capability_id", "environment", "build_id", "revision", "context_json", "client_json",
	"allow_contact", "contact_email", "idempotency_key", "version", "resolved_at", "created_at", "updated_at"
)
SELECT
	CASE WHEN data_json::jsonb->>'id' IS NULL OR data_json::jsonb->>'id' = '' THEN id ELSE data_json::jsonb->>'id' END,
	data_json::jsonb->>'type', 'new', data_json::jsonb->>'message', actor_id,
	NULL, NULL, '/', NULL, NULL, NULL, NULL, NULL, '{}', '{}',
	CASE WHEN data_json::jsonb->>'contactEmail' IS NULL OR data_json::jsonb->>'contactEmail' = '' THEN 0 ELSE 1 END,
	CASE WHEN data_json::jsonb->>'contactEmail' = '' THEN NULL ELSE data_json::jsonb->>'contactEmail' END,
	'legacy-audit-' || id, 1, NULL, created_at, created_at
FROM "audit_events"
WHERE event_type = 'feedback.submitted'
	AND actor_id IS NOT NULL
	AND data_json IS NOT NULL
	AND data_json::jsonb->>'type' IN ('bug', 'feature_suggestion', 'question', 'content_issue', 'ux_issue')
	AND data_json::jsonb->>'message' IS NOT NULL
	AND data_json::jsonb->>'message' <> ''
ON CONFLICT DO NOTHING;

UPDATE "audit_events"
SET data_json = '{"feedbackId":"' || CASE WHEN data_json::jsonb->>'id' IS NULL OR data_json::jsonb->>'id' = '' THEN id ELSE data_json::jsonb->>'id' END
	|| '","type":"' || COALESCE(data_json::jsonb->>'type', 'unknown') || '","legacy":true}'
WHERE event_type = 'feedback.submitted' AND data_json IS NOT NULL;

DELETE FROM "team_inbox_items" WHERE kind = 'feedback' OR id LIKE 'feedback:%';
