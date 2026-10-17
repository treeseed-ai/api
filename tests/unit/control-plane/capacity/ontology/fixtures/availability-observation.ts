/** Original owning fault SQL, shared by grammar regression and native PostgreSQL. */
export function availabilityObservationFaultSql(mode:'missing'|'interrupted'|'altered'):string{
 return "CREATE OR REPLACE FUNCTION retained_availability_observation_fault() RETURNS trigger LANGUAGE plpgsql AS $availability$ BEGIN IF NEW.action='provider.availability.updated' THEN "+(mode==='missing'?"RETURN NULL;":mode==='altered'?"NEW.metadata_json = '{}'; RETURN NEW;":"RAISE EXCEPTION 'retained native availability observation interruption';")+" END IF; RETURN NEW; END $availability$";
}
