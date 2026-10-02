import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';

function hardenedDatabaseUrl(value=''){
  const raw=String(value||'').trim();
  if(!raw)return raw;
  try{
    const url=new URL(raw);
    const mode=(url.searchParams.get('sslmode')||'').toLowerCase();
    if(['prefer','require','verify-ca'].includes(mode)) url.searchParams.set('sslmode','verify-full');
    return url.toString();
  }catch{return raw}
}

export function createResourceStore({backend='fs', uploadDir, databaseUrl=''}){
  let blob=null;
  let pool=null;

  async function ensureBlob(){
    blob ||= await import('@vercel/blob');
    return blob;
  }

  async function init(){
    if(backend==='postgres'){
      if(!databaseUrl) throw new Error('DATABASE_URL es obligatorio para recursos Postgres');
      const {Pool}=await import('pg');
      pool=new Pool({
        connectionString:hardenedDatabaseUrl(databaseUrl),
        max:4,
        idleTimeoutMillis:30000,
        connectionTimeoutMillis:10000
      });
      await pool.query(`CREATE TABLE IF NOT EXISTS lykios_resource_files (
        storage_key text PRIMARY KEY,
        data bytea NOT NULL,
        mime text,
        size_bytes bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
      await pool.query('SELECT 1');
      return;
    }
    if(backend==='blob'){await ensureBlob();return;}
    await mkdir(uploadDir,{recursive:true});
  }

  async function save(storageName,buf,mime){
    if(backend==='postgres'){
      const key=String(storageName||'').replace(/^pg:/,'');
      if(!key) throw new Error('Nombre de recurso inválido');
      await pool.query(
        'INSERT INTO lykios_resource_files(storage_key,data,mime,size_bytes) VALUES($1,$2,$3,$4) ON CONFLICT(storage_key) DO UPDATE SET data=EXCLUDED.data,mime=EXCLUDED.mime,size_bytes=EXCLUDED.size_bytes',
        [key,buf,mime||'application/octet-stream',buf.length]
      );
      return 'pg:'+key;
    }
    if(backend==='blob'){
      const b=await ensureBlob();
      const r=await b.put(`resources/${storageName}`,buf,{access:'private',contentType:mime,addRandomSuffix:false});
      return r.pathname || `resources/${storageName}`;
    }
    await writeFile(path.join(uploadDir,path.basename(storageName)),buf);
    return storageName;
  }

  async function read(ref){
    const value=String(ref||'');
    if(value.startsWith('pg:')){
      if(!pool) throw new Error('Almacenamiento Postgres no inicializado');
      const key=value.slice(3);
      const r=await pool.query('SELECT data FROM lykios_resource_files WHERE storage_key=$1',[key]);
      if(!r.rowCount) throw new Error('Recurso no encontrado');
      return Buffer.from(r.rows[0].data);
    }
    if(backend==='blob'){
      const b=await ensureBlob();
      const r=await b.get(value,{access:'private'});
      if(!r) throw new Error('Blob no encontrado');
      const chunks=[];for await(const c of r.stream)chunks.push(Buffer.from(c));
      return Buffer.concat(chunks);
    }
    if(backend==='postgres'){
      // Compatibilidad con recursos históricos guardados en Vercel Blob.
      const b=await ensureBlob();
      const r=await b.get(value,{access:'private'});
      if(!r) throw new Error('Blob no encontrado');
      const chunks=[];for await(const c of r.stream)chunks.push(Buffer.from(c));
      return Buffer.concat(chunks);
    }
    return readFile(path.join(uploadDir,path.basename(value)));
  }

  async function remove(ref){
    const value=String(ref||'');
    if(!value)return;
    if(value.startsWith('pg:')){
      if(pool) await pool.query('DELETE FROM lykios_resource_files WHERE storage_key=$1',[value.slice(3)]);
      return;
    }
    if(backend==='blob'||backend==='postgres'){
      try{const b=await ensureBlob();await b.del(value);}catch{}
      return;
    }
    try{await unlink(path.join(uploadDir,path.basename(value)));}catch{}
  }

  return {backend,init,save,read,remove};
}
