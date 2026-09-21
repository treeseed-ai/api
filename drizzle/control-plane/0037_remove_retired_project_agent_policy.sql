-- Activity profiles in exact project-library content own handler and mode policy.
ALTER TABLE project_agent_classes DROP COLUMN IF EXISTS allowed_modes_json;
ALTER TABLE project_agent_classes DROP COLUMN IF EXISTS required_capabilities_json;
ALTER TABLE project_agent_classes DROP COLUMN IF EXISTS kernel_profile_json;
ALTER TABLE project_agent_classes DROP COLUMN IF EXISTS kernel_policy_json;
ALTER TABLE project_agent_classes DROP COLUMN IF EXISTS output_contracts_json;
