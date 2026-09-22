import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(__dirname,'..');
const file=process.argv[2];
if(!file) throw new Error('Uso: node scripts/import-course.mjs <manifest.json>');
const dbPath=path.join(root,'data','db.json');
const db=JSON.parse(await readFile(dbPath,'utf8'));
const manifest=JSON.parse(await readFile(path.resolve(file),'utf8'));
const c=manifest.course;
const id=crypto.randomUUID();
const iso=()=>new Date().toISOString();
const normalizeStatus=(s)=>['published','completed'].includes(s)?'published':'draft';
if(db.courses.some(x=>x.slug===c.slug)) throw new Error(`Ya existe el curso ${c.slug}`);
db.courses.push({id,slug:c.slug,title:c.title,subtitle:c.subtitle||'',description:c.description||'',status:normalizeStatus(c.status),certificateEnabled:!!c.certificateEnabled,createdAt:iso(),updatedAt:iso()});
for(const m of c.modules||[]){
  const mid=crypto.randomUUID();
  db.modules.push({id:mid,courseId:id,code:m.code,title:m.title,position:m.position,status:normalizeStatus(m.status),createdAt:iso(),updatedAt:iso()});
  for(const [i,l] of (m.lessons||[]).entries()){
    const approved=Boolean(l.tutor?.approved);
    db.lessons.push({
      id:crypto.randomUUID(),moduleId:mid,courseId:id,code:l.code,title:l.title,summary:l.summary||'',position:i+1,
      status:normalizeStatus(l.status),durationMinutes:l.durationMinutes||10,video:l.video||null,resources:[],
      tutorContent:l.tutor?.content||'',tutorApproved:approved,tutorApprovedAt:approved?iso():null,
      createdAt:iso(),updatedAt:iso()
    });
  }
}
db.tutorQueries ||= [];
await writeFile(dbPath,JSON.stringify(db,null,2));
console.log(`Importado: ${c.title}`);
