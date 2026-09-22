import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function createPersistence({backend='json', dataDir, dbFile, databaseUrl, log=()=>{}}={}){
  let pool=null;
  let jsonChain=Promise.resolve();

  async function init(){
    if(backend==='postgres'){
      if(!databaseUrl) throw new Error('DATABASE_URL es obligatorio con LYKIOS_STORAGE_BACKEND=postgres');
      const { Pool } = await import('pg');
      pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
      await pool.query(`CREATE TABLE IF NOT EXISTS lykios_app_state (
        id smallint PRIMARY KEY CHECK (id = 1),
        version bigint NOT NULL DEFAULT 1,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await pool.query('SELECT 1');
      log('info','storage_init',{backend:'postgres'});
      return;
    }
    await mkdir(dataDir,{recursive:true});
    log('info','storage_init',{backend:'json'});
  }

  async function exists(){
    if(backend==='postgres'){
      const r=await pool.query('SELECT 1 FROM lykios_app_state WHERE id=1');
      return r.rowCount===1;
    }
    return existsSync(dbFile);
  }

  async function load(){
    if(backend==='postgres'){
      const r=await pool.query('SELECT version,data FROM lykios_app_state WHERE id=1');
      if(!r.rowCount) return null;
      return { data:r.rows[0].data, version:Number(r.rows[0].version) };
    }
    if(!existsSync(dbFile)) return null;
    const data=JSON.parse(await readFile(dbFile,'utf8'));
    const version=Number(data?.meta?.storageVersion||1);
    return {data,version};
  }

  async function save(data, expectedVersion=null){
    if(backend==='postgres'){
      if(expectedVersion==null){
        try{
          const r=await pool.query('INSERT INTO lykios_app_state(id,version,data) VALUES(1,1,$1::jsonb) RETURNING version',[JSON.stringify(data)]);
          return Number(r.rows[0].version);
        }catch(e){
          if(e?.code!=='23505') throw e;
          throw Object.assign(new Error('Conflicto de inicialización del almacenamiento'),{code:'STORAGE_CONFLICT'});
        }
      }
      const r=await pool.query('UPDATE lykios_app_state SET data=$1::jsonb, version=version+1, updated_at=now() WHERE id=1 AND version=$2 RETURNING version',[JSON.stringify(data),expectedVersion]);
      if(!r.rowCount) throw Object.assign(new Error('Conflicto de escritura: el estado cambió en otra instancia'),{code:'STORAGE_CONFLICT'});
      return Number(r.rows[0].version);
    }
    jsonChain=jsonChain.then(async()=>{
      const copy=structuredClone(data);
      copy.meta ||= {};
      copy.meta.storageVersion=(expectedVersion||0)+1;
      const tmp=dbFile+`.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp,JSON.stringify(copy,null,2),{mode:0o600});
      await rename(tmp,dbFile);
    });
    await jsonChain;
    return (expectedVersion||0)+1;
  }

  async function health(){
    if(backend==='postgres'){
      const started=Date.now();
      await pool.query('SELECT 1');
      return {backend:'postgres',ok:true,latencyMs:Date.now()-started};
    }
    return {backend:'json',ok:true,path:path.basename(dbFile)};
  }

  async function close(){ if(pool) await pool.end(); }
  return {backend,init,exists,load,save,health,close};
}
