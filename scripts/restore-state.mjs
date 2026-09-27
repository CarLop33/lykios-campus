import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { Pool } from 'pg';

const [fileArg,...rest]=process.argv.slice(2);
if(!fileArg) throw new Error('Uso: node scripts/restore-state.mjs backups/archivo.json --confirm');
if(!rest.includes('--confirm')) throw new Error('Falta --confirm. La restauración sobrescribe el estado actual.');
if(String(process.env.LYKIOS_ALLOW_RESTORE||'')!=='YES') throw new Error('Define LYKIOS_ALLOW_RESTORE=YES para permitir la restauración.');

const databaseUrl=String(process.env.DATABASE_URL||'').trim();
if(!databaseUrl) throw new Error('Falta DATABASE_URL');

function hardenedDatabaseUrl(value){
  const url=new URL(value);
  const mode=(url.searchParams.get('sslmode')||'').toLowerCase();
  if(['prefer','require','verify-ca'].includes(mode)) url.searchParams.set('sslmode','verify-full');
  return url.toString();
}

const raw=await readFile(fileArg,'utf8');
const parsed=JSON.parse(raw);
if(parsed?.format!=='lykios-state-backup-v1') throw new Error('Formato de backup no reconocido');
if(!parsed?.data||typeof parsed.data!=='object') throw new Error('El backup no contiene un estado válido');

const checksum=crypto.createHash('sha256').update(raw).digest('hex');
const expectedFile=fileArg.replace(/\.json$/i,'.sha256');
try{
  const sum=await readFile(expectedFile,'utf8');
  const expected=String(sum).trim().split(/\s+/)[0];
  if(expected&&expected!==checksum) throw new Error('Checksum SHA-256 no coincide');
}catch(error){
  if(error?.code!=='ENOENT') throw error;
  console.warn('AVISO: no se encontró archivo .sha256; se continuará sin comparación externa.');
}

const pool=new Pool({
  connectionString:hardenedDatabaseUrl(databaseUrl),
  max:1,
  idleTimeoutMillis:5000,
  connectionTimeoutMillis:10000
});

try{
  await pool.query('BEGIN');
  const current=await pool.query('SELECT version FROM lykios_app_state WHERE id=1 FOR UPDATE');
  if(!current.rowCount) throw new Error('No existe estado actual de Lykios en PostgreSQL');
  const nextVersion=Number(current.rows[0].version)+1;
  await pool.query(
    'UPDATE lykios_app_state SET data=$1::jsonb, version=$2, updated_at=now() WHERE id=1',
    [JSON.stringify(parsed.data),nextVersion]
  );
  await pool.query('COMMIT');
  console.log(JSON.stringify({
    ok:true,
    restoredFrom:fileArg,
    backupStorageVersion:parsed.storageVersion??null,
    newStorageVersion:nextVersion,
    schemaVersion:parsed.schemaVersion??parsed.data?.meta?.schemaVersion??null,
    sha256:checksum
  },null,2));
}catch(error){
  try{await pool.query('ROLLBACK')}catch{}
  throw error;
}finally{
  await pool.end();
}
