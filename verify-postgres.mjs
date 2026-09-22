import { Pool } from 'pg';
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL obligatorio');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try{
  const r=await pool.query('SELECT version,data,updated_at FROM lykios_app_state WHERE id=1');
  if(!r.rowCount) throw new Error('No existe lykios_app_state id=1');
  const d=r.rows[0].data;
  const required=['users','courses','modules','lessons','enrollments','progress','sessions','certificates','orders','payments','tutorQueries'];
  const missing=required.filter(k=>!Array.isArray(d[k]));
  if(missing.length) throw new Error('Colecciones ausentes: '+missing.join(', '));
  const ids=new Set(); let duplicate=0;
  for(const k of required){for(const item of d[k]){if(item?.id){if(ids.has(`${k}:${item.id}`))duplicate++;ids.add(`${k}:${item.id}`)}}}
  const brokenEnrollments=d.enrollments.filter(e=>!d.users.some(u=>u.id===e.userId)||!d.courses.some(c=>c.id===e.courseId));
  const brokenLessons=d.lessons.filter(l=>!d.courses.some(c=>c.id===l.courseId)||!d.modules.some(m=>m.id===l.moduleId));
  if(duplicate||brokenEnrollments.length||brokenLessons.length) throw new Error(`Integridad fallida duplicate=${duplicate} enrollments=${brokenEnrollments.length} lessons=${brokenLessons.length}`);
  console.log(JSON.stringify({ok:true,version:Number(r.rows[0].version),schemaVersion:d.meta?.schemaVersion,users:d.users.length,courses:d.courses.length,enrollments:d.enrollments.length,certificates:d.certificates.length,updatedAt:r.rows[0].updated_at}));
}finally{await pool.end();}
