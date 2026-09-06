-- Authorization metadata only; no grants are inferred for existing teams.
-- Deployment audience/default policy publication and adapter boundary verification
-- remain API responsibilities. Persistence is not an authorization resolver.
CREATE TABLE shared_resource_grants (
  id text PRIMARY KEY,
  connection_id text REFERENCES team_service_connections(id) ON DELETE RESTRICT,
  vault_id text REFERENCES vault_registrations(id) ON DELETE RESTRICT,
  owner_team_id text REFERENCES teams(id) ON DELETE RESTRICT,
  recipient_team_id text NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  organization_id text REFERENCES organizations(id) ON DELETE RESTRICT,
  audience_policy_id text,
  origin text NOT NULL CHECK (origin IN ('explicit','default-policy')),
  default_policy_id text,
  permissions text[] NOT NULL CHECK (cardinality(permissions)>0 AND array_position(permissions,NULL) IS NULL AND NOT (''=ANY(permissions))),
  environment text NOT NULL CHECK (environment IN ('staging','production','shared')),
  resource_ids text[] NOT NULL CHECK (cardinality(resource_ids)>0 AND array_position(resource_ids,NULL) IS NULL AND NOT ('*'=ANY(resource_ids)) AND NOT (''=ANY(resource_ids))),
  project_ids text[] NOT NULL DEFAULT '{}',
  assignment_ids text[] NOT NULL DEFAULT '{}',
  max_concurrent_operations integer NOT NULL CHECK (max_concurrent_operations>0),
  max_operations_per_window integer NOT NULL CHECK (max_operations_per_window>0),
  window_seconds integer NOT NULL CHECK (window_seconds>0),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((connection_id IS NULL) <> (vault_id IS NULL)),
  CHECK ((organization_id IS NULL) <> (audience_policy_id IS NULL)),
  CHECK (organization_id IS NULL OR owner_team_id IS NOT NULL),
  CHECK ((origin='default-policy') = (default_policy_id IS NOT NULL))
);
CREATE INDEX idx_shared_grants_recipient ON shared_resource_grants(recipient_team_id,status);
CREATE INDEX idx_shared_grants_organization ON shared_resource_grants(organization_id,status);

CREATE FUNCTION enforce_shared_grant_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_owner text;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.vault_id IS DISTINCT FROM OLD.vault_id
    OR NEW.owner_team_id IS DISTINCT FROM OLD.owner_team_id OR NEW.recipient_team_id<>OLD.recipient_team_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.audience_policy_id IS DISTINCT FROM OLD.audience_policy_id) THEN
    RAISE EXCEPTION 'shared_resource_grant_identity_immutable';
  END IF;
  IF NEW.connection_id IS NOT NULL THEN
    SELECT team_id INTO actual_owner FROM team_service_connections WHERE id=NEW.connection_id FOR SHARE;
  ELSE
    SELECT owner_team_id INTO actual_owner FROM vault_registrations WHERE id=NEW.vault_id FOR SHARE;
  END IF;
  IF actual_owner IS DISTINCT FROM NEW.owner_team_id THEN
    RAISE EXCEPTION 'shared_resource_owner_mismatch';
  END IF;
  IF NEW.status='active' AND NEW.organization_id IS NOT NULL THEN
    -- Membership removals conflict with these locks. A race may abort and retry,
    -- but must never leave an active grant after successful removal.
    PERFORM team_id FROM organization_teams
      WHERE organization_id=NEW.organization_id AND team_id IN (NEW.owner_team_id,NEW.recipient_team_id)
      ORDER BY team_id FOR SHARE;
    IF NOT EXISTS (SELECT 1 FROM organization_teams WHERE team_id=NEW.owner_team_id AND organization_id=NEW.organization_id)
      OR NOT EXISTS (SELECT 1 FROM organization_teams WHERE team_id=NEW.recipient_team_id AND organization_id=NEW.organization_id) THEN
      RAISE EXCEPTION 'shared_resource_organization_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shared_grant_authority BEFORE INSERT OR UPDATE ON shared_resource_grants
  FOR EACH ROW EXECUTE FUNCTION enforce_shared_grant_authority();

CREATE FUNCTION revoke_departing_team_grants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.organization_id<>OLD.organization_id OR NEW.team_id<>OLD.team_id THEN
    UPDATE shared_resource_grants SET status='revoked',version=version+1
      WHERE organization_id=OLD.organization_id AND status='active'
        AND (owner_team_id=OLD.team_id OR recipient_team_id=OLD.team_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER organization_team_grant_revocation AFTER DELETE OR UPDATE ON organization_teams
  FOR EACH ROW EXECUTE FUNCTION revoke_departing_team_grants();

-- A vault grant can authorize only the recipient's explicit allocation.
ALTER TABLE vault_allocations ADD COLUMN grant_id text REFERENCES shared_resource_grants(id) ON DELETE RESTRICT;
CREATE FUNCTION enforce_allocation_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.grant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shared_resource_grants g
    WHERE g.id=NEW.grant_id AND g.vault_id=NEW.vault_id AND g.recipient_team_id=NEW.team_id
      AND NEW.permissions <@ g.permissions) THEN
    RAISE EXCEPTION 'vault_allocation_grant_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER allocation_grant BEFORE INSERT OR UPDATE ON vault_allocations
  FOR EACH ROW EXECUTE FUNCTION enforce_allocation_grant();

-- Reservations remain visible after revocation: in-flight work is not reported
-- as cancelled merely because new operations are denied.
CREATE TABLE shared_resource_operation_reservations (
  id text PRIMARY KEY,
  grant_id text NOT NULL REFERENCES shared_resource_grants(id) ON DELETE RESTRICT,
  grant_version bigint NOT NULL CHECK (grant_version>0),
  operation_key text NOT NULL CHECK (length(operation_key)>0),
  status text NOT NULL CHECK (status IN ('active','completed','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (grant_id,operation_key),
  CHECK ((status='active') = (completed_at IS NULL))
);
CREATE INDEX idx_shared_reservations_limits ON shared_resource_operation_reservations(grant_id,created_at,status);
