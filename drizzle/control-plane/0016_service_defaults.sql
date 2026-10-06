-- Defaults are configuration, not permission. Selection must resolve an active
-- grant before persisting a shared binding. Existing workloads are never rebound.
CREATE TABLE service_default_policies (
  id text PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('team','organization','deployment')),
  team_id text REFERENCES teams(id) ON DELETE RESTRICT,
  organization_id text REFERENCES organizations(id) ON DELETE RESTRICT,
  capability text NOT NULL CHECK (length(trim(capability))>0),
  environment text NOT NULL CHECK (environment IN ('staging','production','shared')),
  connection_id text REFERENCES team_service_connections(id) ON DELETE RESTRICT,
  vault_id text REFERENCES vault_registrations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive','active')),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  CHECK ((connection_id IS NULL) <> (vault_id IS NULL)),
  CHECK ((scope='team' AND team_id IS NOT NULL AND organization_id IS NULL)
    OR (scope='organization' AND team_id IS NULL AND organization_id IS NOT NULL)
    OR (scope='deployment' AND team_id IS NULL AND organization_id IS NULL))
);
-- Reject competing defaults at configuration time, rather than choosing by row order.
CREATE UNIQUE INDEX idx_service_default_team ON service_default_policies
  (team_id,capability,environment,(connection_id IS NOT NULL)) WHERE scope='team' AND status='active';
CREATE UNIQUE INDEX idx_service_default_org ON service_default_policies
  (organization_id,capability,environment,(connection_id IS NOT NULL)) WHERE scope='organization' AND status='active';
CREATE UNIQUE INDEX idx_service_default_deployment ON service_default_policies
  (capability,environment,(connection_id IS NOT NULL)) WHERE scope='deployment' AND status='active';

CREATE TABLE project_service_bindings (
  id text PRIMARY KEY,
  team_id text NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  capability text NOT NULL CHECK (length(trim(capability))>0),
  environment text NOT NULL CHECK (environment IN ('staging','production','shared')),
  connection_id text NOT NULL REFERENCES team_service_connections(id) ON DELETE RESTRICT,
  owner_team_id text NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  grant_id text REFERENCES shared_resource_grants(id) ON DELETE RESTRICT,
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  UNIQUE (project_id,capability,environment),
  CHECK (team_id=owner_team_id OR grant_id IS NOT NULL)
);
CREATE FUNCTION enforce_project_service_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id AND team_id=NEW.team_id)
    OR NOT EXISTS (SELECT 1 FROM team_service_connections WHERE id=NEW.connection_id AND team_id=NEW.owner_team_id) THEN
    RAISE EXCEPTION 'service_binding_owner_mismatch';
  END IF;
  IF NEW.grant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM shared_resource_grants
    WHERE id=NEW.grant_id AND connection_id=NEW.connection_id AND recipient_team_id=NEW.team_id
      AND owner_team_id=NEW.owner_team_id AND environment=NEW.environment AND NEW.capability=ANY(permissions)
      AND (cardinality(project_ids)=0 OR NEW.project_id=ANY(project_ids))) THEN
    RAISE EXCEPTION 'service_binding_grant_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_service_binding_authority BEFORE INSERT OR UPDATE ON project_service_bindings
  FOR EACH ROW EXECUTE FUNCTION enforce_project_service_binding();
