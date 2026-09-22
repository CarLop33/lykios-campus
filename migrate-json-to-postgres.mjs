import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const source=process.argv[2] || process.env.LYKIOS_JSON_SOURCE || path.join(__dirname,'..','data','db.json');
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL obligatorio');
const db=JSON.parse(await readFile(source,'utf8'));
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try{
  await pool.query(`CREATE TABLE IF NOT EXISTS lykios_app_state (id smallint PRIMARY KEY CHECK(id=1),version bigint NOT NULL DEFAULT 1,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
  const existing=await pool.query('SELECT version FROM lykios_app_state WHERE id=1');
  if(existing.rowCount && process.env.LYKIOS_MIGRATION_FORCE!=='1') throw new Error('PostgreSQL ya contiene estado. Usa LYKIOS_MIGRATION_FORCE=1 solo tras backup.');
  if(existing.rowCount){
    await pool.query('UPDATE lykios_app_state SET data=$1::jsonb, version=version+1, updated_at=now() WHERE id=1',[JSON.stringify(db)]);
  }else{
    await pool.query('INSERT INTO lykios_app_state(id,version,data) VALUES(1,1,$1::jsonb)',[JSON.stringify(db)]);
  }
  console.log(JSON.stringify({ok:true,source,users:db.users?.length||0,courses:db.courses?.length||0,enrollments:db.enrollments?.length||0,certificates:db.certificates?.length||0}));
}finally{await pool.end();}
