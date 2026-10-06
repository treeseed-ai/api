-- Graph nodes and immutable assignments are the only scheduling authority.
-- Retired demand, participation, and capacity-plan rows cannot be replayed.
DROP TABLE IF EXISTS capacity_workday_participation_entries;
DROP TABLE IF EXISTS capacity_workday_participation_cycles;
DROP TABLE IF EXISTS capacity_workday_demands;
DROP TABLE IF EXISTS agent_capacity_plans;
