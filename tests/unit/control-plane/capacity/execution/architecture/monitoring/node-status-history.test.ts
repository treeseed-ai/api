import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {closeoutDatabase} from '../../graph/architecture/closeout-sql-fixture.ts';
import {splitPostgresSqlStatements} from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import {CapacityWorkdayEventRepository} from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import {assignment} from '../../fixtures/assignment.ts';

it('retains every exact owning node status transition in the original public workday history without replacing unrelated resources or synthesizing prior history',async()=>{
 const f=await closeoutDatabase();
 try{
  const ddl=splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql','utf8')).filter(sql=>sql.startsWith('CREATE TABLE "capacity_workday_events" ('));expect(ddl).toHaveLength(1);await f.db.exec(ddl[0]!);
  // Load owning migrations by their native declaration; the original schema has no node-observation producer.
  for(const path of readdirSync('drizzle/control-plane').filter(path=>/^[0-9]+_execution_node_observations\.sql$/u.test(path)).sort())await f.db.exec(readFileSync('drizzle/control-plane/'+path,'utf8'));
  const original=(await f.query('SELECT * FROM execution_nodes WHERE id=?',['report-node'])).rows;
  const stamp='2026-10-02T21:00:00.000Z',id='observed-native-node';
  await f.query(`INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,source_ref_json,authority_refs_json,rule_revision,node_revision,agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,'team','project','workday','acting',JSON.stringify(assignment.sourceRef),JSON.stringify(assignment.authorityRefs),1,1,'engineer','proposed',1,1,stamp,stamp]);
  const steps=['proposed','blocked','ready','assigned','running','completed','ready','assigned','running','failed','cancelled','stale'];
  let revision=1;
  for(const [index,status]of steps.entries()){
   if(index){if(status==='ready'&&index>5)revision++;await f.query('UPDATE execution_nodes SET status=?,node_revision=?,updated_at=? WHERE id=?',[status,revision,new Date(Date.parse(stamp)+index).toISOString(),id]);}
   const events=await new CapacityWorkdayEventRepository(f.owner).list('team','workday',{limit:100});
   expect(events.items.map(event=>event.eventType)).toEqual(steps.slice(0,index+1).map(()=>'execution.node.state'));
   expect(events.items.map(event=>event.eventIndex)).toEqual(Array.from({length:index+1},(_,n)=>n));
   expect(events.items.map(event=>event.context.status)).toEqual(steps.slice(0,index+1));
   expect(events.items.at(-1)?.context).toEqual({nodeId:id,nodeRevision:revision,graphRevision:1,status,previousStatus:index?steps[index-1]:null});
   expect(events.items.every(event=>event.runId==='workday'&&event.workdayId==='workday'&&event.teamId==='team'&&event.projectId==='project'&&event.assignmentId===null)).toBe(true);
   expect(events.page.hasMore).toBe(false);
  }
  const before=(await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows;
  await f.query('UPDATE execution_nodes SET status=status,updated_at=updated_at WHERE id=?',[id]);expect((await f.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows).toEqual(before);
  expect((await f.query('SELECT * FROM execution_nodes WHERE id=?',['report-node'])).rows).toEqual(original);
 }finally{await f.db.close();}
 // Real original DDL/public repository with controlled state inputs, not native PostgreSQL concurrency or a managed workday.
});
