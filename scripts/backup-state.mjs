import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Pool } from 'pg';

if(process.env.VERCEL){
  throw new Error('El backup debe ejecutarse desde un entorno persistente, no dentro de Vercel.');
}

const databaseUrl=String(process.env.DATABASE_URL||'').trim();
if(!databaseUrl) throw new Error('Falta DATABASE_URL');

function hardenedDatabaseUrl(value){
  const url=new URL(value);
  const mode=(url.searchParams.get('sslmode')||'').toLowerCase();
  if(['prefer','require','verify-ca'].includes(mode)) url.searchParams.set('sslmode','verify-full');
  return url.toString();
}

const outDir=path.resolve(process.env.LYKIOS_BACKUP_DIR||'backups');
await mkdir(outDir,{recursive:true});

const pool=new Pool({
  connectionString:hardenedDatabaseUrl(databaseUrl),
  max:1,
  idleTimeoutMillis:5000,
  connectionTimeoutMillis:10000
});

try{
  const r=await pool.query('SELECT version,data,updated_at FROM lykios_app_state WHERE id=1');
  if(!r.rowCount) throw new Error('No existe estado de Lykios en PostgreSQL');

  const row=r.rows[0];
  const exportedAt=new Date().toISOString();
  const payload={
    format:'lykios-state-backup-v1',
    exportedAt,
    storageVersion:Number(row.version),
    databaseUpdatedAt:row.updated_at,
    data:row.data
  };

  const json=JSON.stringify(payload,null,2)+'\n';
  const checksum=crypto.createHash('sha256').update(json).digest('hex');
  const stamp=exportedAt.replace(/[:.]/g,'-');
  const base=`lykios-state-${stamp}-v${payload.storageVersion}`;
  const file=path.join(outDir,base+'.json');
  const sumFile=path.join(outDir,base+'.sha256');

  await writeFile(file,json,{mode:0o600});
  await writeFile(sumFile,`${checksum}  ${path.basename(file)}\n`,{mode:0o600});

  console.log(JSON.stringify({
    ok:true,
    file,
    checksumFile:sumFile,
    sha256:checksum,
    storageVersion:payload.storageVersion,
    exportedAt
  },null,2));
}finally{
  await pool.end();
}
