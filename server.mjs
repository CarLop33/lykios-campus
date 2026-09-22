import http from 'node:http';
import { readFile, writeFile, mkdir, stat, unlink, rename, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createPersistence } from './persistence.mjs';
import { createResourceStore } from './resource-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ON_VERCEL = Boolean(process.env.VERCEL);
const VERCEL_ENV = process.env.VERCEL_ENV || '';
const IS_PROD = ON_VERCEL ? VERCEL_ENV === 'production' : NODE_ENV === 'production';
const IS_PREVIEW = ON_VERCEL && VERCEL_ENV === 'preview';
const ADMIN_EMAIL = IS_PREVIEW ? 'admin@lykiosacademy.com' : (process.env.LYKIOS_ADMIN_EMAIL || '');
const ADMIN_PASSWORD = IS_PREVIEW ? 'AdminLykios2026!' : (process.env.LYKIOS_ADMIN_PASSWORD || '');
const IS_SECURE = IS_PROD || ON_VERCEL;
const APP_VERSION = process.env.LYKIOS_VERSION || '1.0.0-rc5';
const APP_ORIGIN = (ON_VERCEL && VERCEL_ENV !== 'production' && process.env.VERCEL_URL) ? `https://${process.env.VERCEL_URL}` : (process.env.LYKIOS_APP_ORIGIN || `http://localhost:${PORT}`);
const TRUST_PROXY = process.env.LYKIOS_TRUST_PROXY === '1';
const DATA_DIR = process.env.LYKIOS_DATA_DIR || (process.env.VERCEL ? '/tmp/lykios-data' : path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const STORAGE_BACKEND = process.env.LYKIOS_STORAGE_BACKEND || (ON_VERCEL || IS_PROD ? 'postgres' : 'json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const PAYMENT_PROVIDER = process.env.LYKIOS_PAYMENT_PROVIDER || (IS_PROD ? 'stripe' : 'mock');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = process.env.LYKIOS_UPLOAD_DIR || (process.env.VERCEL ? '/tmp/lykios-uploads' : path.join(__dirname, 'uploads'));
const FILE_BACKEND = process.env.LYKIOS_FILE_BACKEND || (process.env.VERCEL ? 'blob' : 'fs');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_JSON_BYTES = 9_000_000;
const MAX_RESOURCE_BYTES = 6_000_000;
const MAX_TEST_VIDEO_BYTES = 3_000_000;
const MAX_VIDEO_BYTES = 1_000_000_000;
const VIDEO_TOKEN_TTL_MS = 1000 * 60 * 10;
const VIDEO_TOKEN_SECRET = process.env.LYKIOS_VIDEO_SECRET || (IS_PROD ? '' : crypto.randomBytes(32).toString('hex'));

if (ON_VERCEL && !DATABASE_URL) throw new Error('Vercel requiere DATABASE_URL persistente');

if (IS_PROD) {
  const required = ['LYKIOS_VIDEO_SECRET','LYKIOS_APP_ORIGIN','LYKIOS_ADMIN_EMAIL','LYKIOS_ADMIN_PASSWORD','DATABASE_URL'];
  const missing = required.filter(k=>!process.env[k]);
  if (missing.length) throw new Error(`Configuración de producción incompleta: ${missing.join(', ')}`);
  if (String(process.env.LYKIOS_ADMIN_PASSWORD).length < 14) throw new Error('LYKIOS_ADMIN_PASSWORD debe tener al menos 14 caracteres en producción');
  if (process.env.LYKIOS_VIDEO_SECRET.length < 32) throw new Error('LYKIOS_VIDEO_SECRET debe tener al menos 32 caracteres');
  if (STORAGE_BACKEND !== 'postgres') throw new Error('Producción requiere LYKIOS_STORAGE_BACKEND=postgres');
  if (PAYMENT_PROVIDER !== 'stripe') throw new Error('Producción requiere LYKIOS_PAYMENT_PROVIDER=stripe');
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) throw new Error('Producción requiere STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET');
}

await mkdir(DATA_DIR, { recursive: true });
if(FILE_BACKEND==='fs') await mkdir(UPLOAD_DIR, { recursive: true });

const persistence=createPersistence({backend:STORAGE_BACKEND,dataDir:DATA_DIR,dbFile:DB_FILE,databaseUrl:DATABASE_URL,log:logEvent});
await persistence.init();
const resourceStore=createResourceStore({backend:FILE_BACKEND,uploadDir:UPLOAD_DIR});
await resourceStore.init();


const securityHeaders = {
  'x-content-type-options':'nosniff',
  'x-frame-options':'DENY',
  'referrer-policy':'strict-origin-when-cross-origin',
  'permissions-policy':'camera=(), microphone=(), geolocation=(), payment=(self)',
  'cross-origin-opener-policy':'same-origin',
  'cross-origin-resource-policy':'same-origin',
  'content-security-policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; media-src 'self' blob: https://*.private.blob.vercel-storage.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://*.private.blob.vercel-storage.com"
};
if (IS_PROD) securityHeaders['strict-transport-security']='max-age=31536000; includeSubDomains';

function requestId(req){ return cleanText(req.headers['x-request-id'] || req.headers['x-vercel-id'] || crypto.randomUUID(),120); }
function logEvent(level,event,data={}){ console[level==='error'?'error':'log'](JSON.stringify({ts:new Date().toISOString(),level,event,version:APP_VERSION,...data})); }
function clientIp(req){
  if(TRUST_PROXY){ const x=String(req.headers['x-forwarded-for']||'').split(',')[0].trim(); if(x)return x; }
  return req.socket.remoteAddress || 'unknown';
}
const rateBuckets=new Map();
function rateLimit(key,limit,windowMs){
  const t=Date.now(); let b=rateBuckets.get(key);
  if(!b||b.reset<=t){b={count:0,reset:t+windowMs};rateBuckets.set(key,b)}
  b.count++; return {ok:b.count<=limit,remaining:Math.max(0,limit-b.count),reset:b.reset};
}
function sameOrigin(req){
  if(['GET','HEAD','OPTIONS'].includes(req.method)) return true;
  const origin=req.headers.origin;
  if(!origin) return !IS_PROD; // browsers should send Origin for fetch POSTs
  try{
    const originUrl=new URL(origin);
    const allowed=new Set([new URL(APP_ORIGIN).origin]);
    const host=String(req.headers['x-forwarded-host']||req.headers.host||'').trim();
    if(host) allowed.add(`https://${host}`);
    return allowed.has(originUrl.origin);
  }catch{return false}
}
function sessionCookie(token,maxAge=SESSION_TTL_MS/1000){
  const secure=IS_SECURE?'; Secure':'';
  return `lykios_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAge)}${secure}`;
}

const json = (res, status, body, headers={}) => {
  res.writeHead(status, { ...securityHeaders, 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const text = (res, status, body, type='text/plain; charset=utf-8', headers={}) => {
  res.writeHead(status, { ...securityHeaders, 'content-type':type, 'cache-control':'no-store', ...headers });
  res.end(body);
};
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map(v=>v.trim()).filter(Boolean).map(v=>{ const i=v.indexOf('='); return i<0?[v,'']:[v.slice(0,i),decodeURIComponent(v.slice(i+1))]; }));
const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const slugify = (value='') => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80);
const cleanText = (v,max=5000) => String(v??'').trim().slice(0,max);
const safeStatus = (v) => ['draft','published'].includes(v) ? v : 'draft';
const positionOf = (arr, predicate) => Math.max(0,...arr.filter(predicate).map(x=>Number(x.position)||0))+1;
const SAFE_RESOURCE_MIME = new Set([
  'application/pdf','image/png','image/jpeg','image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain','text/csv'
]);
function safeResourceMime(v){ const m=cleanText(v,120).toLowerCase(); return SAFE_RESOURCE_MIME.has(m)?m:null; }


function hashPassword(password, salt=crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expected) {
  const actual = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256');
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

async function readDb(){
  if (!await persistence.exists()) await seedDb();
  const loaded=await persistence.load();
  if(!loaded) throw new Error('Almacenamiento sin estado inicial');
  const db=loaded.data;
  if(ADMIN_EMAIL && ADMIN_PASSWORD){
    db.meta ||= {};
    const email=String(ADMIN_EMAIL).trim().toLowerCase();
    const fingerprint=crypto.createHash('sha256').update(email+'\0'+String(ADMIN_PASSWORD)).digest('hex');
    if(db.meta.adminCredentialFingerprint!==fingerprint){
      let admin=db.users.find(u=>u.role==='admin');
      const hp=hashPassword(String(ADMIN_PASSWORD));
      if(!admin){
        admin={id:newId(),email,firstName:'Lykios',lastName:'Admin',role:'admin',status:'active',lastLoginAt:null,passwordSalt:hp.salt,passwordHash:hp.hash,createdAt:now()};
        db.users.push(admin);
      }else{
        admin.email=email;
        admin.passwordSalt=hp.salt;
        admin.passwordHash=hp.hash;
        admin.status='active';
      }
      db.meta.adminCredentialFingerprint=fingerprint;
      const savedVersion=Number.isFinite(loaded.version)?loaded.version:null;
      Object.defineProperty(db,'__storageVersion',{value:savedVersion,writable:true,enumerable:false,configurable:true});
      await writeDb(db);
    }
  }
  if(!Object.prototype.hasOwnProperty.call(db,'__storageVersion')){
    Object.defineProperty(db,'__storageVersion',{value:loaded.version,writable:true,enumerable:false,configurable:true});
  }
  let changed=false;
  if ((db.meta?.schemaVersion||1) < 2) {
    db.modules.forEach(m=>{ if(!['draft','published'].includes(m.status)){m.status='published';changed=true;} });
    db.lessons.forEach(l=>{ if(!['draft','published'].includes(l.status)){l.status=l.status==='production'?'draft':'published';changed=true;} if(!Array.isArray(l.resources)){l.resources=[];changed=true;} });
    db.courses.forEach(c=>{ if(!['draft','published'].includes(c.status)){c.status='published';changed=true;} c.updatedAt ||= c.createdAt || now(); });
    db.meta.schemaVersion=2; changed=true;
  }
  if ((db.meta?.schemaVersion||1) < 3) { db.assessments ||= []; db.questions ||= []; db.attempts ||= []; db.meta.schemaVersion=3; changed=true; }
  if ((db.meta?.schemaVersion||1) < 4) { db.certificates ||= []; db.meta.schemaVersion=4; changed=true; }
  if ((db.meta?.schemaVersion||1) < 5) { db.orders ||= []; db.payments ||= []; db.courses.forEach(c=>{ if(c.priceCents===undefined)c.priceCents=c.slug==='peeling-quimico'?4900:3200; if(!c.currency)c.currency='EUR'; if(c.saleEnabled===undefined)c.saleEnabled=true; }); db.meta.schemaVersion=5; changed=true; }
  if ((db.meta?.schemaVersion||1) < 6) { db.studentNotes ||= []; db.users.forEach(u=>{ if(!u.status)u.status='active'; if(u.lastLoginAt===undefined)u.lastLoginAt=null; }); db.meta.schemaVersion=6; changed=true; }
  if ((db.meta?.schemaVersion||1) < 7) { db.emailOutbox ||= []; db.passwordResetTokens ||= []; db.meta.schemaVersion=7; changed=true; }
  if ((db.meta?.schemaVersion||1) < 8) { db.videoProgress ||= []; db.meta.schemaVersion=8; changed=true; }
  if ((db.meta?.schemaVersion||1) < 9) { db.bundles ||= []; db.coupons ||= []; db.promotions ||= []; db.couponRedemptions ||= []; db.meta.schemaVersion=9; changed=true; }
  if ((db.meta?.schemaVersion||1) < 10) { db.teacherAssignments ||= []; db.meta.schemaVersion=10; changed=true; }
  if ((db.meta?.schemaVersion||1) < 11) { db.tutorQueries ||= []; db.lessons.forEach(l=>{ if(l.tutorApproved===undefined) l.tutorApproved = l.status==='published'; if(l.tutorContent===undefined) l.tutorContent = ''; if(l.tutorApprovedAt===undefined) l.tutorApprovedAt = l.tutorApproved ? (l.updatedAt||l.createdAt||now()) : null; }); db.meta.schemaVersion=11; changed=true; }
  if ((db.meta?.schemaVersion||1) < 12) { db.tutorFeedback ||= []; db.meta.tutorPolicy ||= { retainQueriesDays:30, storeQuestionText:true, feedbackEnabled:true }; db.meta.schemaVersion=12; changed=true; }
  if ((db.meta?.schemaVersion||1) < 13) { db.paymentEvents ||= []; db.meta.schemaVersion=13; changed=true; }
  if (db.meta?.tutorPolicy) { const days=Math.max(0,Number(db.meta.tutorPolicy.retainQueriesDays)||0); if(days>0 && Array.isArray(db.tutorQueries)){ const cutoff=Date.now()-days*86400000; const before=db.tutorQueries.length; db.tutorQueries=db.tutorQueries.filter(q=>new Date(q.createdAt).getTime()>=cutoff); if(db.tutorQueries.length!==before) changed=true; } }
  if(changed) await writeDb(db);
  return db;
}
let dbWriteChain = Promise.resolve();
async function writeDb(db){
  const expected=Number.isFinite(db.__storageVersion)?db.__storageVersion:null;
  dbWriteChain=dbWriteChain.then(async()=>{
    const next=await persistence.save(db,expected);
    Object.defineProperty(db,'__storageVersion',{value:next,writable:true,enumerable:false,configurable:true});
  });
  return dbWriteChain;
}

async function seedDb(){
  const studentPass = IS_PROD ? null : hashPassword('Lykios2026!');
  const adminPass = hashPassword(IS_PREVIEW ? ADMIN_PASSWORD : (IS_PROD ? ADMIN_PASSWORD : 'AdminLykios2026!'));
  const teacherPass = IS_PROD ? null : hashPassword('ProfesorLykios2026!');
  const manifest = JSON.parse(await readFile(path.join(__dirname,'content','peeling-quimico.json'),'utf8'));
  const course = manifest.course;
  const courseId = newId();
  const modules = course.modules.map(m=>({ id:newId(), courseId, code:m.code, title:m.title, position:m.position, status:'published', createdAt:now(), updatedAt:now() }));
  const lessons = [];
  for (const m of course.modules) {
    const mod = modules.find(x=>x.code===m.code);
    m.lessons.forEach((l,idx)=>lessons.push({ id:newId(), moduleId:mod.id, courseId, code:l.code, title:l.title, summary:'', position:idx+1, status:l.status==='production'?'draft':'published', durationMinutes:12, video:null, resources:[], tutorApproved:true, tutorContent:'', tutorApprovedAt:now(), createdAt:now(), updatedAt:now() }));
  }
  const studentId = newId();
  const adminId = newId();
  const teacherId = newId();
  const enrollmentId = newId();
  const completedCodes = ['1.1','1.2','1.3','1.4','2.1','2.2'];
  const db = {
    meta:{ schemaVersion:13, createdAt:now(), app:'Lykios LMS', tutorPolicy:{retainQueriesDays:30,storeQuestionText:true,feedbackEnabled:true} },
    users: IS_PROD ? [
      { id:adminId, email:String(ADMIN_EMAIL).toLowerCase(), firstName:'Lykios', lastName:'Admin', role:'admin', status:'active', lastLoginAt:null, passwordSalt:adminPass.salt, passwordHash:adminPass.hash, createdAt:now() }
    ] : [
      { id:studentId, email:'alumno@lykiosacademy.com', firstName:'Carlos', lastName:'Alumno', role:'student', status:'active', lastLoginAt:null, passwordSalt:studentPass.salt, passwordHash:studentPass.hash, createdAt:now() },
      { id:adminId, email:'admin@lykiosacademy.com', firstName:'Lykios', lastName:'Admin', role:'admin', status:'active', lastLoginAt:null, passwordSalt:adminPass.salt, passwordHash:adminPass.hash, createdAt:now() },
      { id:teacherId, email:'profesor@lykiosacademy.com', firstName:'Docente', lastName:'Lykios', role:'teacher', status:'active', lastLoginAt:null, passwordSalt:teacherPass.salt, passwordHash:teacherPass.hash, createdAt:now() }
    ],
    sessions:[],
    courses:[{ id:courseId, slug:'peeling-quimico', title:course.title, subtitle:course.subtitle, description:'Curso clínico avanzado, estructurado por módulos, con progreso y evaluación.', status:'published', certificateEnabled:true, priceCents:4900, currency:'EUR', saleEnabled:true, createdAt:now(), updatedAt:now() },
             { id:newId(), slug:'piel-perfecta-20', title:'Piel Perfecta 2.0', subtitle:'Dermocosmética práctica para el cuidado diario', description:'Curso práctico de cuidado de la piel.', status:'published', certificateEnabled:true, priceCents:3200, currency:'EUR', saleEnabled:true, createdAt:now(), updatedAt:now() }],
    modules,
    lessons,
    enrollments:IS_PROD?[]:[{ id:enrollmentId, userId:studentId, courseId, status:'active', enrolledAt:now() }],
    progress:IS_PROD?[]:lessons.filter(l=>completedCodes.includes(l.code)).map(l=>({ id:newId(), enrollmentId, lessonId:l.id, completed:true, progressPercent:100, updatedAt:now(), completedAt:now() })),
    activity:IS_PROD?[]:completedCodes.slice(-3).map(code=>({ id:newId(), userId:studentId, type:'lesson_completed', label:`Clase ${code} completada`, at:now() })),
    certificates:[],
    orders:[],
    payments:[],
    assessments:[],
    questions:[],
    attempts:[],
    studentNotes:[],
    emailOutbox:[],
    passwordResetTokens:[],
    videoProgress:[],
    bundles:[],
    coupons:[],
    promotions:[],
    couponRedemptions:[],
    teacherAssignments:IS_PROD?[]:[{id:newId(),teacherId,courseId,role:'author',createdAt:now()}],
    tutorQueries:[],
    tutorFeedback:[],
    paymentEvents:[]
  };
  await writeDb(db);
}

async function readRawBody(req){
  const chunks=[]; let size=0;
  for await (const c of req){ size += c.length; if(size>MAX_JSON_BYTES) throw Object.assign(new Error('Payload demasiado grande'),{statusCode:413}); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
async function readBody(req){
  const raw=await readRawBody(req);
  if(!raw) return {};
  return JSON.parse(raw);
}

async function auth(req, db){
  const sid = parseCookies(req).lykios_session;
  if(!sid) return null;
  const session = db.sessions.find(s=>s.token===sid && new Date(s.expiresAt)>new Date());
  if(!session) return null;
  const user=db.users.find(u=>u.id===session.userId) || null;
  if(user && (user.status||'active')!=='active' && user.role!=='admin') return null;
  return user;
}
const ensureAdmin = (user,res) => { if(user.role!=='admin'){ json(res,403,{error:'Solo administrador'}); return false; } return true; };
const teacherCourseIds=(db,user)=>new Set((db.teacherAssignments||[]).filter(a=>a.teacherId===user.id).map(a=>a.courseId));
const canTeachCourse=(db,user,courseId)=>user.role==='admin'||(user.role==='teacher'&&teacherCourseIds(db,user).has(courseId));
const courseForScope=(db,scopeType,scopeId)=>scopeType==='lesson'?db.lessons.find(l=>l.id===scopeId)?.courseId:db.modules.find(m=>m.id===scopeId)?.courseId;
function teacherContentPayload(db,user){const allowed=teacherCourseIds(db,user);return adminContentPayload(db).filter(c=>allowed.has(c.id));}
function teacherAnalyticsPayload(db,user){const allowed=teacherCourseIds(db,user);const a=adminAnalyticsPayload(db);return {...a,courses:a.courses.filter(c=>allowed.has(c.courseId)),lessonFunnel:a.lessonFunnel.filter(l=>{const lesson=db.lessons.find(x=>x.id===l.lessonId);return lesson&&allowed.has(lesson.courseId)}),overall:{...a.overall,students:new Set(db.enrollments.filter(e=>allowed.has(e.courseId)).map(e=>e.userId)).size,enrollments:db.enrollments.filter(e=>allowed.has(e.courseId)).length}}}



function signVideoToken({userId,lessonId,expiresAt}){
  const payload=`${userId}.${lessonId}.${expiresAt}`;
  const sig=crypto.createHmac('sha256',VIDEO_TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}
function verifyVideoToken(token){
  try{
    const decoded=Buffer.from(String(token||''),'base64url').toString('utf8');
    const parts=decoded.split('.'); if(parts.length!==4)return null;
    const [userId,lessonId,expiresAt,sig]=parts;
    if(Number(expiresAt)<Date.now())return null;
    const expected=crypto.createHmac('sha256',VIDEO_TOKEN_SECRET).update(`${userId}.${lessonId}.${expiresAt}`).digest('hex');
    if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
    return {userId,lessonId,expiresAt:Number(expiresAt)};
  }catch{return null}
}
function signVideoUploadTicket(payload){
  const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig=crypto.createHmac('sha256',VIDEO_TOKEN_SECRET).update(body).digest('base64url');
  return body+'.'+sig;
}
function verifyVideoUploadTicket(ticket){
  try{
    const [body,sig]=String(ticket||'').split('.');
    if(!body||!sig)return null;
    const expected=crypto.createHmac('sha256',VIDEO_TOKEN_SECRET).update(body).digest('base64url');
    const a=Buffer.from(sig), b=Buffer.from(expected);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return null;
    const payload=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(!payload?.lessonId||!payload?.pathname||Number(payload.expiresAt)<Date.now())return null;
    return payload;
  }catch{return null}
}

function videoProgressPayload(db,user,lessonId){
  const v=db.videoProgress.find(x=>x.userId===user.id&&x.lessonId===lessonId);
  return v?{currentTime:v.currentTime||0,duration:v.duration||0,percent:v.percent||0,lastPlayedAt:v.lastPlayedAt||null,completed:Boolean(v.completed)}:{currentTime:0,duration:0,percent:0,lastPlayedAt:null,completed:false};
}
function canAccessLesson(db,user,lesson){
  if(user.role==='admin')return true;
  return lesson.status==='published' && db.enrollments.some(e=>e.userId===user.id&&e.courseId===lesson.courseId&&e.status==='active');
}
function coursePayload(db, user, slug='peeling-quimico'){
  const course=db.courses.find(c=>c.slug===slug);
  if(!course || (user.role!=='admin' && course.status!=='published')) return null;
  const modules=db.modules.filter(m=>m.courseId===course.id && (user.role==='admin'||m.status==='published')).sort((a,b)=>a.position-b.position).map(m=>({
    ...m,
    assessment:(()=>{const a=assessmentForScope(db,'module',m.id);return a&&a.status==='published'?{id:a.id,title:a.title,passingScore:a.passingScore,maxAttempts:a.maxAttempts}:null})(),
    lessons:db.lessons.filter(l=>l.moduleId===m.id && (user.role==='admin'||l.status==='published')).sort((a,b)=>a.position-b.position).map(l=>({
      ...l,
      videoProgress: videoProgressPayload(db,user,l.id),
      assessment:(()=>{const a=assessmentForScope(db,'lesson',l.id);return a&&a.status==='published'?{id:a.id,title:a.title,passingScore:a.passingScore,maxAttempts:a.maxAttempts}:null})()
    }))
  }));
  const enrollment=db.enrollments.find(e=>e.userId===user.id && e.courseId===course.id);
  const progress=enrollment?db.progress.filter(p=>p.enrollmentId===enrollment.id):[];
  const completed=new Set(progress.filter(p=>p.completed).map(p=>p.lessonId));
  const visibleLessons=modules.flatMap(m=>m.lessons);
  const total=visibleLessons.length;
  const completedCount=visibleLessons.filter(l=>completed.has(l.id)).length;
  const assessmentStatus=courseAssessmentStatus(db,user,course.id);
  return { ...course, modules, enrollment, progressPercent: total?Math.round(completedCount/total*100):0, completedLessonIds:[...completed], assessmentStatus };
}


const TUTOR_STOPWORDS=new Set('a al algo algunas algunos ante antes como con contra cual cuales cuando de del desde donde dos el ella ellas ellos en entre era eran es esa esas ese eso esos esta estas este esto estos fue fueron ha han hasta hay la las le les lo los mas me mi mis muy no nos o para pero por porque que se ser si sin sobre su sus te tu tus un una unas uno unos y ya'.split(' '));
function tutorTokens(value=''){
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9ñáéíóúü]+/g,' ').split(/\s+/).filter(x=>x.length>2&&!TUTOR_STOPWORDS.has(x));
}
function tutorCourseAccess(db,user,course){
  if(!course||course.status!=='published') return false;
  if(user.role==='admin') return true;
  if(user.role==='teacher') return canTeachCourse(db,user,course.id);
  return db.enrollments.some(e=>e.userId===user.id&&e.courseId===course.id&&e.status==='active');
}
function tutorSourcesForCourse(db,course){
  const moduleIds=new Set(db.modules.filter(m=>m.courseId===course.id&&m.status==='published').map(m=>m.id));
  return db.lessons.filter(l=>l.courseId===course.id&&moduleIds.has(l.moduleId)&&l.status==='published'&&l.tutorApproved===true).sort((a,b)=>a.position-b.position).map(l=>{
    const mod=db.modules.find(m=>m.id===l.moduleId);
    const body=[l.title,l.summary||'',l.tutorContent||''].filter(Boolean).join('\n').trim();
    return {lesson:l,module:mod,text:body,href:`/lesson?course=${encodeURIComponent(course.slug)}&lessonId=${encodeURIComponent(l.id)}`};
  });
}
function tutorAsk(db,user,course,question){
  const q=cleanText(question,1200); const qTokens=tutorTokens(q); const sources=tutorSourcesForCourse(db,course);
  if(!q||qTokens.length===0) return {grounded:false,confidence:'low',answer:'Escribe una pregunta concreta sobre el contenido del curso.',sources:[]};
  const ranked=sources.map(src=>{
    const titleTokens=tutorTokens(`${src.lesson.code} ${src.lesson.title} ${src.module?.title||''}`);
    const bodyTokens=tutorTokens(src.text); let score=0;
    for(const t of qTokens){ if(titleTokens.includes(t))score+=6; score+=Math.min(4,bodyTokens.filter(x=>x===t).length*2); }
    const phrases=q.toLowerCase().split(/\s+/).filter(x=>x.length>4); for(const ph of phrases){if(src.text.toLowerCase().includes(ph))score+=1;}
    return {...src,score};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  const directLocation=/\b(donde|clase|modulo|tema|explica|encuentro|ver)\b/i.test(q);
  const maxScore=ranked[0]?.score||0; const top=ranked.filter(x=>x.score>=Math.max(2,maxScore*0.55)).slice(0,3);
  if(!top.length){
    return {grounded:false,confidence:'low',answer:'No encuentro esa respuesta en el contenido aprobado de este curso. Puedo ayudarte a localizar una clase si reformulas la pregunta con el concepto concreto que buscas.',sources:[]};
  }
  const useful=top.filter(x=>(x.lesson.tutorContent||x.lesson.summary||'').trim().length>=40);
  if(!useful.length && !directLocation){
    return {grounded:false,confidence:'low',answer:`El tema aparece relacionado con ${top[0].lesson.code} · ${top[0].lesson.title}, pero el contenido aprobado disponible para el tutor todavía no contiene suficiente detalle para responder con rigor.`,sources:top.slice(0,2).map((x,i)=>({ref:i+1,lessonId:x.lesson.id,code:x.lesson.code,title:x.lesson.title,moduleTitle:x.module?.title||'',href:x.href,excerpt:''}))};
  }
  const chosen=(useful.length?useful:top).slice(0,2);
  const sourcePayload=chosen.map((x,i)=>{
    const raw=(x.lesson.tutorContent||x.lesson.summary||'').trim();
    const excerpt=raw.length>420?raw.slice(0,417).trim()+'…':raw;
    return {ref:i+1,lessonId:x.lesson.id,code:x.lesson.code,title:x.lesson.title,moduleTitle:x.module?.title||'',href:x.href,excerpt,score:x.score};
  });
  const confidence=maxScore>=14&&useful.length?'high':maxScore>=7?'medium':'low';
  let answer;
  if(directLocation && sourcePayload.length){
    answer=`Este tema se aborda en ${sourcePayload.map(s=>`[${s.ref}] Clase ${s.code} · ${s.title}`).join(' y ')}.`;
  }else{
    const parts=sourcePayload.filter(s=>s.excerpt).map(s=>`${s.excerpt} [${s.ref}]`);
    answer=parts.length?parts.join('\n\n'):`Este tema está localizado en [1] Clase ${sourcePayload[0].code} · ${sourcePayload[0].title}.`;
  }
  return {grounded:true,confidence,answer,sources:sourcePayload.map(({score,...x})=>x)};
}

function tutorAuditPayload(db){
  const policy=db.meta?.tutorPolicy||{retainQueriesDays:30,storeQuestionText:true,feedbackEnabled:true};
  const items=(db.tutorQueries||[]).slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,100).map(q=>{
    const user=db.users.find(u=>u.id===q.userId), course=db.courses.find(c=>c.id===q.courseId);
    const feedback=(db.tutorFeedback||[]).filter(f=>f.queryId===q.id);
    return {...q,userName:user?`${user.firstName} ${user.lastName||''}`.trim():'Usuario',userEmail:user?.email||'',courseTitle:course?.title||'',feedback};
  });
  return {policy,items};
}



function assessmentForScope(db,scopeType,scopeId){
  return db.assessments.find(a=>a.scopeType===scopeType&&a.scopeId===scopeId) || null;
}
function assessmentPayload(db,assessment,{includeAnswers=false,userId=null}={}){
  if(!assessment) return null;
  const questions=db.questions.filter(q=>q.assessmentId===assessment.id).sort((a,b)=>a.position-b.position).map(q=>({
    id:q.id, assessmentId:q.assessmentId, prompt:q.prompt, type:q.type, options:q.options, position:q.position, explanation:q.explanation||'',
    ...(includeAnswers?{correctOption:q.correctOption}:{})
  }));
  const attempts=userId?db.attempts.filter(a=>a.assessmentId===assessment.id&&a.userId===userId).sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt)):[];
  return {...assessment,questions,attempts,attemptsUsed:attempts.length,bestScore:attempts.length?Math.max(...attempts.map(a=>a.score)):null,passed:attempts.some(a=>a.passed)};
}
function visibleAssessment(db,user,assessment){
  if(!assessment || assessment.status!=='published') return false;
  if(user.role==='admin') return true;
  let courseId=null;
  if(assessment.scopeType==='lesson'){
    const l=db.lessons.find(x=>x.id===assessment.scopeId);
    if(!l || l.status!=='published') return false;
    const m=db.modules.find(x=>x.id===l.moduleId);
    const c=db.courses.find(x=>x.id===l.courseId);
    if(!m||m.status!=='published'||!c||c.status!=='published') return false;
    courseId=l.courseId;
  } else if(assessment.scopeType==='module'){
    const m=db.modules.find(x=>x.id===assessment.scopeId);
    if(!m||m.status!=='published') return false;
    const c=db.courses.find(x=>x.id===m.courseId);
    if(!c||c.status!=='published') return false;
    courseId=m.courseId;
  }
  return db.enrollments.some(e=>e.userId===user.id&&e.courseId===courseId&&e.status==='active');
}
function courseAssessmentStatus(db,user,courseId){
  const moduleIds=db.modules.filter(m=>m.courseId===courseId&&m.status==='published').map(m=>m.id);
  const lessonIds=db.lessons.filter(l=>l.courseId===courseId&&l.status==='published').map(l=>l.id);
  const assessments=db.assessments.filter(a=>a.status==='published'&&((a.scopeType==='module'&&moduleIds.includes(a.scopeId))||(a.scopeType==='lesson'&&lessonIds.includes(a.scopeId))));
  const passedIds=new Set(db.attempts.filter(a=>a.userId===user.id&&a.passed).map(a=>a.assessmentId));
  return {required:assessments.length,passed:assessments.filter(a=>passedIds.has(a.id)).length,allPassed:assessments.every(a=>passedIds.has(a.id))};
}


function courseCompletionStatus(db,user,courseId){
  const course=db.courses.find(c=>c.id===courseId);
  if(!course) return {eligible:false,error:'Curso no encontrado'};
  const enrollment=db.enrollments.find(e=>e.userId===user.id&&e.courseId===courseId&&e.status==='active');
  if(!enrollment) return {eligible:false,error:'Sin matrícula activa'};
  const publishedModules=db.modules.filter(m=>m.courseId===courseId&&m.status==='published').map(m=>m.id);
  const lessons=db.lessons.filter(l=>l.courseId===courseId&&l.status==='published'&&publishedModules.includes(l.moduleId));
  const completed=new Set(db.progress.filter(p=>p.enrollmentId===enrollment.id&&p.completed).map(p=>p.lessonId));
  const incompleteLessons=lessons.filter(l=>!completed.has(l.id));
  const assessmentStatus=courseAssessmentStatus(db,user,courseId);
  const eligible=course.certificateEnabled!==false && incompleteLessons.length===0 && assessmentStatus.allPassed;
  return {eligible,certificateEnabled:course.certificateEnabled!==false,lessonsTotal:lessons.length,lessonsCompleted:lessons.length-incompleteLessons.length,incompleteLessons:incompleteLessons.map(l=>({id:l.id,code:l.code,title:l.title})),assessmentsRequired:assessmentStatus.required,assessmentsPassed:assessmentStatus.passed,allAssessmentsPassed:assessmentStatus.allPassed};
}
function certificateCode(){
  const y=new Date().getFullYear();
  return `LYK-${y}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}
function publicCertificate(db,cert){
  const user=db.users.find(u=>u.id===cert.userId); const course=db.courses.find(c=>c.id===cert.courseId);
  if(!user||!course) return null;
  return {code:cert.code,status:cert.status||'valid',studentName:`${user.firstName} ${user.lastName}`.trim(),courseTitle:course.title,courseSubtitle:course.subtitle||'',issuedAt:cert.issuedAt,revokedAt:cert.revokedAt||null,issuer:'Lykios Academy',verificationPath:`/verify/${cert.code}`};
}
function pdfEscape(v=''){ return String(v).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)'); }
function certificatePdf(cert){
  const lines=[];
  const txt=(x,y,size,text,font='F1')=>lines.push(`BT /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(text)}) Tj ET`);
  lines.push('0.02 0.24 0.28 rg 0 0 842 595 re f');
  lines.push('0.99 1 1 rg 28 28 786 539 re f');
  lines.push('0.78 0.66 0.43 RG 2 w 42 42 758 511 re S');
  txt(82,500,15,'LYKIOS ACADEMY','F2');
  txt(82,462,11,'CERTIFICADO DE FINALIZACION','F2');
  txt(82,415,13,'Se certifica que','F1');
  txt(82,372,28,cert.studentName,'F2');
  txt(82,330,13,'ha completado satisfactoriamente el curso','F1');
  txt(82,290,22,cert.courseTitle,'F2');
  txt(82,246,11,`Emitido: ${new Date(cert.issuedAt).toLocaleDateString('es-ES')}`,'F1');
  txt(82,220,10,`Codigo de verificacion: ${cert.code}`,'F1');
  txt(82,194,9,`Verificar en: campus.lykiosacademy.com/verify/${cert.code}`,'F1');
  txt(82,112,11,'Lykios Academy · Formación que transforma conocimiento en práctica','F1');
  const stream=lines.join('\n');
  const objs=[];
  objs[1]='<< /Type /Catalog /Pages 2 0 R >>';
  objs[2]='<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3]='<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>';
  objs[4]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[5]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objs[6]=`<< /Length ${Buffer.byteLength(stream,'latin1')} >>\nstream\n${stream}\nendstream`;
  let out='%PDF-1.4\n'; const offsets=[0];
  for(let i=1;i<=6;i++){offsets[i]=Buffer.byteLength(out,'latin1');out+=`${i} 0 obj\n${objs[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(out,'latin1'); out+=`xref\n0 7\n0000000000 65535 f \n`;
  for(let i=1;i<=6;i++)out+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';
  out+=`trailer << /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out,'latin1');
}
async function qrPng(data){
  if(process.env.VERCEL){
    const QRCode=await import('qrcode');
    return QRCode.toBuffer(data,{type:'png',errorCorrectionLevel:'M',margin:2,width:280});
  }
  return new Promise((resolve,reject)=>{
    const code=`import qrcode,sys
img=qrcode.make(sys.argv[1])
img.save(sys.stdout.buffer,format='PNG')`;
    const p=spawn('python3',['-c',code,data]); const chunks=[]; const err=[];
    p.stdout.on('data',c=>chunks.push(c)); p.stderr.on('data',c=>err.push(c));
    p.on('error',reject); p.on('close',n=>n===0?resolve(Buffer.concat(chunks)):reject(new Error(Buffer.concat(err).toString()||'QR no disponible')));
  });
}
function htmlEsc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function verificationHtml(cert){
  const valid=cert&&cert.status==='valid';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verificar certificado · Lykios Academy</title><link rel="stylesheet" href="/styles.css"></head><body><main class="verify-page"><div class="verify-brand">LYKIOS <span>ACADEMY</span></div><section class="verify-card ${valid?'valid':'invalid'}"><div class="verify-icon">${valid?'✓':'!'}</div><div class="page-kicker">VERIFICACION PUBLICA</div><h1>${valid?'Certificado auténtico':'Certificado no válido'}</h1>${cert?`<p>Este certificado figura en el registro de Lykios Academy.</p><dl><dt>Alumno</dt><dd>${htmlEsc(cleanText(cert.studentName,200))}</dd><dt>Curso</dt><dd>${htmlEsc(cleanText(cert.courseTitle,250))}</dd><dt>Fecha de emisión</dt><dd>${new Date(cert.issuedAt).toLocaleDateString('es-ES')}</dd><dt>Código</dt><dd>${htmlEsc(cleanText(cert.code,80))}</dd><dt>Estado</dt><dd>${valid?'Válido':'Revocado'}</dd></dl><img class="verify-qr" src="/api/public/certificate/qr?code=${encodeURIComponent(cert.code)}" alt="QR de verificación">`:''}<a class="btn" href="/">Ir a Lykios Academy</a></section></main></body></html>`;
}


function adminAnalyticsPayload(db){
  const publishedCourses=db.courses.filter(c=>c.status==='published');
  const activeStudents=db.users.filter(u=>u.role==='student'&&(u.status||'active')==='active');
  const activeEnrollments=db.enrollments.filter(e=>e.status==='active');
  const completedProgress=db.progress.filter(p=>p.completed);
  const totalWatchSeconds=(db.videoProgress||[]).reduce((sum,v)=>sum+Math.max(0,Number(v.currentTime)||0),0);
  const passedAttempts=db.attempts.filter(a=>a.passed);
  const overall={
    students:activeStudents.length,
    enrollments:activeEnrollments.length,
    completionRate:0,
    avgProgress:0,
    avgAssessmentScore:db.attempts.length?Math.round(db.attempts.reduce((s,a)=>s+(Number(a.score)||0),0)/db.attempts.length):0,
    assessmentPassRate:db.attempts.length?Math.round(passedAttempts.length/db.attempts.length*100):0,
    watchHours:Number((totalWatchSeconds/3600).toFixed(1))
  };
  let progressTotal=0,progressCount=0,completedEnrollments=0;
  const courseRows=publishedCourses.map(course=>{
    const enrollments=activeEnrollments.filter(e=>e.courseId===course.id);
    const lessons=db.lessons.filter(l=>l.courseId===course.id&&l.status==='published');
    const lessonIds=new Set(lessons.map(l=>l.id));
    const assessmentIds=new Set(db.assessments.filter(a=>a.status==='published'&&((a.scopeType==='lesson'&&lessonIds.has(a.scopeId))||(a.scopeType==='module'&&db.modules.some(m=>m.id===a.scopeId&&m.courseId===course.id)))).map(a=>a.id));
    let sumProgress=0, finished=0;
    for(const e of enrollments){
      const done=new Set(db.progress.filter(p=>p.enrollmentId===e.id&&p.completed&&lessonIds.has(p.lessonId)).map(p=>p.lessonId));
      const pct=lessons.length?Math.round(done.size/lessons.length*100):0;
      sumProgress+=pct; progressTotal+=pct; progressCount++;
      if(lessons.length&&done.size===lessons.length){finished++;completedEnrollments++;}
    }
    const attempts=db.attempts.filter(a=>assessmentIds.has(a.assessmentId));
    const passed=attempts.filter(a=>a.passed).length;
    const watch=(db.videoProgress||[]).filter(v=>lessonIds.has(v.lessonId));
    const avgWatch=watch.length?Math.round(watch.reduce((s,v)=>s+(Number(v.percent)||0),0)/watch.length):0;
    return {courseId:course.id,title:course.title,students:enrollments.length,lessons:lessons.length,avgProgress:enrollments.length?Math.round(sumProgress/enrollments.length):0,completionRate:enrollments.length?Math.round(finished/enrollments.length*100):0,avgVideoPercent:avgWatch,avgScore:attempts.length?Math.round(attempts.reduce((s,a)=>s+(Number(a.score)||0),0)/attempts.length):0,passRate:attempts.length?Math.round(passed/attempts.length*100):0};
  });
  overall.avgProgress=progressCount?Math.round(progressTotal/progressCount):0;
  overall.completionRate=activeEnrollments.length?Math.round(completedEnrollments/activeEnrollments.length*100):0;

  const lessonFunnel=[];
  for(const course of publishedCourses){
    const enrollments=activeEnrollments.filter(e=>e.courseId===course.id);
    const lessons=db.lessons.filter(l=>l.courseId===course.id&&l.status==='published').sort((a,b)=>a.position-b.position);
    for(const lesson of lessons){
      let started=0,completed=0;
      for(const e of enrollments){
        const userId=e.userId;
        const p=db.progress.find(x=>x.enrollmentId===e.id&&x.lessonId===lesson.id);
        const v=(db.videoProgress||[]).find(x=>x.userId===userId&&x.lessonId===lesson.id);
        if((p&&((p.progressPercent||0)>0||p.completed))||(v&&(v.percent||0)>0)) started++;
        if(p?.completed) completed++;
      }
      const incomplete=started?started-completed:0;
      lessonFunnel.push({courseTitle:course.title,lessonId:lesson.id,code:lesson.code,title:lesson.title,started,completed,dropoffRate:started?Math.round(incomplete/started*100):0,avgVideoPercent:(()=>{const rows=(db.videoProgress||[]).filter(v=>v.lessonId===lesson.id);return rows.length?Math.round(rows.reduce((s,v)=>s+(Number(v.percent)||0),0)/rows.length):0})()});
    }
  }
  lessonFunnel.sort((a,b)=>b.dropoffRate-a.dropoffRate||b.started-a.started);

  const questionMap=new Map();
  for(const attempt of db.attempts){
    for(const ans of attempt.answers||[]){
      const q=db.questions.find(x=>x.id===ans.questionId); if(!q)continue;
      const row=questionMap.get(q.id)||{questionId:q.id,prompt:q.prompt,total:0,wrong:0,assessmentTitle:db.assessments.find(a=>a.id===q.assessmentId)?.title||'Evaluación'};
      row.total++; if(!ans.correct)row.wrong++; questionMap.set(q.id,row);
    }
  }
  const hardestQuestions=[...questionMap.values()].map(q=>({...q,errorRate:q.total?Math.round(q.wrong/q.total*100):0})).sort((a,b)=>b.errorRate-a.errorRate||b.total-a.total).slice(0,12);

  const cohortMap=new Map();
  for(const e of activeEnrollments){
    const d=new Date(e.enrolledAt||Date.now()); const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const row=cohortMap.get(key)||{month:key,enrollments:0,avgProgress:0,_sum:0};
    const lessons=db.lessons.filter(l=>l.courseId===e.courseId&&l.status==='published');
    const done=db.progress.filter(p=>p.enrollmentId===e.id&&p.completed&&lessons.some(l=>l.id===p.lessonId)).length;
    const pct=lessons.length?Math.round(done/lessons.length*100):0; row.enrollments++;row._sum+=pct;cohortMap.set(key,row);
  }
  const cohorts=[...cohortMap.values()].sort((a,b)=>a.month.localeCompare(b.month)).map(r=>({month:r.month,enrollments:r.enrollments,avgProgress:r.enrollments?Math.round(r._sum/r.enrollments):0}));
  return {generatedAt:now(),overall,courses:courseRows,lessonFunnel:lessonFunnel.slice(0,20),hardestQuestions,cohorts};
}

function adminContentPayload(db){
  return db.courses.slice().sort((a,b)=>new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt)).map(c=>({
    ...c,
    modules:db.modules.filter(m=>m.courseId===c.id).sort((a,b)=>a.position-b.position).map(m=>({
      ...m,
      assessment: assessmentForScope(db,'module',m.id) ? assessmentPayload(db,assessmentForScope(db,'module',m.id),{includeAnswers:true}) : null,
      lessons:db.lessons.filter(l=>l.moduleId===m.id).sort((a,b)=>a.position-b.position).map(l=>({
        ...l,
        assessment: assessmentForScope(db,'lesson',l.id) ? assessmentPayload(db,assessmentForScope(db,'lesson',l.id),{includeAnswers:true}) : null
      }))
    }))
  }));
}
function uniqueSlug(db, requested, exceptId=null){
  let base=slugify(requested)||'curso'; let slug=base; let n=2;
  while(db.courses.some(c=>c.slug===slug&&c.id!==exceptId)) slug=`${base}-${n++}`;
  return slug;
}
function findResource(db,id){
  for(const lesson of db.lessons){ const resource=(lesson.resources||[]).find(r=>r.id===id); if(resource) return {lesson,resource}; }
  return null;
}
async function deleteResourceFile(resource){
  if(!resource?.storageName) return;
  try{await resourceStore.remove(resource.storageName);}catch{}
}



function mailTemplate(type,ctx={}){
  const firstName=cleanText(ctx.firstName||'Alumno',120);
  const course=cleanText(ctx.courseTitle||'',220);
  const order=cleanText(ctx.orderNumber||'',80);
  const code=cleanText(ctx.certificateCode||'',100);
  const resetUrl=cleanText(ctx.resetUrl||'',1000);
  const templates={
    welcome:{subject:'Bienvenido a Lykios Academy',html:`<h1>Bienvenido, ${firstName}</h1><p>Tu cuenta de Lykios Academy ya está activa.</p><p>Desde tu campus podrás acceder a tus cursos, progreso, evaluaciones y certificados.</p>`},
    purchase:{subject:`Matrícula confirmada · ${course}`,html:`<h1>Matrícula confirmada</h1><p>Hola ${firstName}, tu acceso a <b>${course}</b> ya está activo.</p><p>Pedido: <b>${order}</b></p><p>Puedes entrar al campus y comenzar cuando quieras.</p>`},
    password_reset:{subject:'Recupera tu acceso a Lykios Academy',html:`<h1>Recuperar contraseña</h1><p>Hola ${firstName}. Hemos recibido una solicitud para restablecer tu contraseña.</p><p><a href="${resetUrl}">Crear nueva contraseña</a></p><p>Este enlace caduca en 60 minutos.</p>`},
    course_completed:{subject:`Curso completado · ${course}`,html:`<h1>Curso completado</h1><p>Enhorabuena, ${firstName}. Has completado <b>${course}</b>.</p><p>Si has superado todas las evaluaciones obligatorias, ya puedes emitir tu certificado desde el campus.</p>`},
    certificate:{subject:`Tu certificado Lykios · ${course}`,html:`<h1>Certificado emitido</h1><p>Hola ${firstName}. Tu certificado de <b>${course}</b> ya está disponible.</p><p>Código: <b>${code}</b></p><p>Puedes descargarlo y verificarlo desde tu campus.</p>`},
    reminder:{subject:`Continúa tu formación · ${course}`,html:`<h1>Tu curso te espera</h1><p>Hola ${firstName}. Tienes pendiente continuar <b>${course}</b>.</p><p>Entra en Lykios Academy y retoma la siguiente clase cuando te venga bien.</p>`}
  };
  return templates[type]||{subject:'Lykios Academy',html:'<p>Notificación de Lykios Academy.</p>'};
}
function queueEmail(db,{to,type,userId=null,courseId=null,meta={}}){
  if(!to) return null;
  const user=userId?db.users.find(u=>u.id===userId):null;
  const course=courseId?db.courses.find(c=>c.id===courseId):null;
  const tpl=mailTemplate(type,{firstName:user?.firstName||meta.firstName,courseTitle:course?.title||meta.courseTitle,orderNumber:meta.orderNumber,certificateCode:meta.certificateCode,resetUrl:meta.resetUrl});
  const item={id:newId(),to:cleanText(to,220).toLowerCase(),type,subject:tpl.subject,html:tpl.html,status:'queued',provider:'local',userId,courseId,meta,createdAt:now(),sentAt:null};
  db.emailOutbox ||= []; db.emailOutbox.push(item); return item;
}
function markLocalEmailsSent(db){
  for(const e of (db.emailOutbox||[])) if(e.status==='queued'){e.status='sent';e.sentAt=now();}
}
function emailAdminPayload(db){return (db.emailOutbox||[]).slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(e=>{const u=db.users.find(x=>x.id===e.userId),c=db.courses.find(x=>x.id===e.courseId);return {...e,studentName:u?`${u.firstName} ${u.lastName}`.trim():'',courseTitle:c?.title||''};});}
function maybeQueueCourseCompleted(db,user,courseId){
  const course=db.courses.find(c=>c.id===courseId); if(!course) return null;
  const completion=courseCompletionStatus(db,user,courseId);
  if(!completion.eligible) return null;
  const already=(db.emailOutbox||[]).some(e=>e.userId===user.id&&e.courseId===courseId&&e.type==='course_completed');
  if(already) return null;
  return queueEmail(db,{to:user.email,type:'course_completed',userId:user.id,courseId});
}

function money(cents=0,currency='EUR'){return new Intl.NumberFormat('es-ES',{style:'currency',currency}).format((Number(cents)||0)/100)}
function windowActive(x,at=new Date()){
  if(x.active===false||x.status==='draft')return false;
  if(x.startsAt&&new Date(x.startsAt)>at)return false;
  if(x.endsAt&&new Date(x.endsAt)<at)return false;
  return true;
}
function activePromotion(db,targetType,targetId){
  return (db.promotions||[]).filter(p=>p.targetType===targetType&&p.targetId===targetId&&windowActive(p)).sort((a,b)=>(Number(b.priority)||0)-(Number(a.priority)||0))[0]||null;
}
function applyDiscount(baseCents,kind,value){
  const base=Math.max(0,Number(baseCents)||0),v=Math.max(0,Number(value)||0);
  if(kind==='percent')return Math.min(base,Math.round(base*v/100));
  if(kind==='fixed')return Math.min(base,Math.round(v));
  if(kind==='free')return base;
  return 0;
}
function pricingFor(db,targetType,target){
  const base=Number(target.priceCents)||0; const promo=activePromotion(db,targetType,target.id);
  const promoDiscount=promo?applyDiscount(base,promo.discountType,promo.value):0;
  return {baseCents:base,promo,discountCents:promoDiscount,finalCents:Math.max(0,base-promoDiscount)};
}
function bundleCourses(db,bundle){return (bundle.courseIds||[]).map(id=>db.courses.find(c=>c.id===id)).filter(Boolean)}
function catalogPayload(db){
  const courses=db.courses.filter(c=>c.status==='published'&&c.saleEnabled!==false).map(c=>{const pr=pricingFor(db,'course',c);return {type:'course',id:c.id,slug:c.slug,title:c.title,subtitle:c.subtitle||'',description:c.description||'',priceCents:pr.finalCents,basePriceCents:pr.baseCents,currency:c.currency||'EUR',priceLabel:money(pr.finalCents,c.currency||'EUR'),basePriceLabel:money(pr.baseCents,c.currency||'EUR'),promotion:pr.promo?{id:pr.promo.id,name:pr.promo.name,badge:pr.promo.badge||'Oferta'}:null};});
  const bundles=(db.bundles||[]).filter(b=>b.status==='published'&&b.saleEnabled!==false).map(b=>{const pr=pricingFor(db,'bundle',b);const cs=bundleCourses(db,b);return {type:'bundle',id:b.id,slug:b.slug,title:b.title,subtitle:b.subtitle||'',description:b.description||'',courseIds:b.courseIds||[],courseTitles:cs.map(c=>c.title),priceCents:pr.finalCents,basePriceCents:pr.baseCents,currency:b.currency||'EUR',priceLabel:money(pr.finalCents,b.currency||'EUR'),basePriceLabel:money(pr.baseCents,b.currency||'EUR'),promotion:pr.promo?{id:pr.promo.id,name:pr.promo.name,badge:pr.promo.badge||'Oferta'}:null};});
  return {courses,bundles,checkoutProvider:PAYMENT_PROVIDER==='stripe'?'stripe':'mock'};
}
function validateCoupon(db,code,{user=null,targetType,targetId,subtotalCents=0}={}){
  const normalized=cleanText(code,80).toUpperCase(); if(!normalized)return {coupon:null,discountCents:0};
  const c=(db.coupons||[]).find(x=>String(x.code||'').toUpperCase()===normalized);
  if(!c||!windowActive(c))return {error:'Cupón no válido o caducado',status:400};
  const used=(db.couponRedemptions||[]).filter(r=>r.couponId===c.id);
  if(Number(c.maxRedemptions)>0&&used.length>=Number(c.maxRedemptions))return {error:'Este cupón ha alcanzado su límite de usos',status:409};
  if(user&&Number(c.perUserLimit||1)>0&&used.filter(r=>r.userId===user.id).length>=Number(c.perUserLimit||1))return {error:'Ya has utilizado este cupón',status:409};
  if(c.targetType&&c.targetType!=='all'&&c.targetType!==targetType)return {error:'Este cupón no se aplica a este producto',status:400};
  if(Array.isArray(c.targetIds)&&c.targetIds.length&&!c.targetIds.includes(targetId))return {error:'Este cupón no se aplica a este producto',status:400};
  if(Number(c.minSubtotalCents)>0&&subtotalCents<Number(c.minSubtotalCents))return {error:'No se alcanza el importe mínimo del cupón',status:400};
  return {coupon:c,discountCents:applyDiscount(subtotalCents,c.discountType,c.value)};
}
function checkoutMock(db,body){
  const itemType=body.itemType==='bundle'?'bundle':'course';
  const target=itemType==='bundle'
    ?(db.bundles||[]).find(b=>b.slug===cleanText(body.itemSlug||body.bundleSlug,120)&&b.status==='published'&&b.saleEnabled!==false)
    :db.courses.find(c=>c.slug===cleanText(body.itemSlug||body.courseSlug,120)&&c.status==='published'&&c.saleEnabled!==false);
  if(!target) return {error:itemType==='bundle'?'Pack no disponible':'Curso no disponible para compra',status:404};
  const email=cleanText(body.email,220).toLowerCase(); const firstName=cleanText(body.firstName,120); const lastName=cleanText(body.lastName,120); const password=String(body.password||'');
  if(!email||!email.includes('@')||!firstName) return {error:'Completa nombre y email',status:400};
  let user=db.users.find(u=>u.email.toLowerCase()===email);
  if(!user){ if(password.length<8)return {error:'La contraseña debe tener al menos 8 caracteres',status:400}; const hp=hashPassword(password); user={id:newId(),email,firstName,lastName,role:'student',status:'active',lastLoginAt:null,passwordSalt:hp.salt,passwordHash:hp.hash,createdAt:now()}; db.users.push(user); }
  if(user.role==='admin') return {error:'Usa una cuenta de alumno para comprar cursos',status:409};

  const courseIds=itemType==='bundle'?(target.courseIds||[]):[target.id];
  const validCourses=courseIds.map(id=>db.courses.find(c=>c.id===id&&c.status==='published')).filter(Boolean);
  if(!validCourses.length)return {error:'No hay cursos disponibles en este producto',status:409};
  const activeOwned=new Set(db.enrollments.filter(e=>e.userId===user.id&&e.status==='active').map(e=>e.courseId));
  const missingCourses=validCourses.filter(c=>!activeOwned.has(c.id));
  if(!missingCourses.length)return {error:'Este usuario ya tiene acceso a todo el contenido incluido',status:409};

  const pr=pricingFor(db,itemType,target);
  const couponResult=validateCoupon(db,body.couponCode,{user,targetType:itemType,targetId:target.id,subtotalCents:pr.finalCents});
  if(couponResult.error)return couponResult;
  const couponDiscount=couponResult.discountCents||0;
  const total=Math.max(0,pr.finalCents-couponDiscount);
  const order={id:newId(),number:`ORD-${new Date().getFullYear()}-${String(db.orders.length+1).padStart(5,'0')}`,userId:user.id,courseId:itemType==='course'?target.id:null,bundleId:itemType==='bundle'?target.id:null,itemType,itemTitle:target.title,lineCourseIds:validCourses.map(c=>c.id),subtotalCents:pr.baseCents,promotionDiscountCents:pr.discountCents,couponDiscountCents:couponDiscount,discountCents:pr.discountCents+couponDiscount,couponCode:couponResult.coupon?.code||null,totalCents:total,currency:target.currency||'EUR',status:'paid',provider:'mock',createdAt:now(),paidAt:now()};
  const payment={id:newId(),orderId:order.id,userId:user.id,amountCents:order.totalCents,currency:order.currency,status:'succeeded',provider:'mock',providerRef:`mock_${crypto.randomBytes(8).toString('hex')}`,createdAt:now()};
  const enrollments=[];
  for(const course of missingCourses){let enrollment=db.enrollments.find(e=>e.userId===user.id&&e.courseId===course.id);if(enrollment){enrollment.status='active';enrollment.orderId=order.id;}else{enrollment={id:newId(),userId:user.id,courseId:course.id,status:'active',enrolledAt:now(),orderId:order.id};db.enrollments.push(enrollment)}enrollments.push(enrollment);db.activity.push({id:newId(),userId:user.id,type:'enrollment_created',label:`Matrícula activada: ${course.title}`,at:now()});}
  db.orders.push(order); db.payments.push(payment);
  if(couponResult.coupon){db.couponRedemptions.push({id:newId(),couponId:couponResult.coupon.id,userId:user.id,orderId:order.id,discountCents:couponDiscount,redeemedAt:now()});}
  const isFirstWelcome=!(db.emailOutbox||[]).some(e=>e.userId===user.id&&e.type==='welcome');
  if(isFirstWelcome) queueEmail(db,{to:user.email,type:'welcome',userId:user.id});
  queueEmail(db,{to:user.email,type:'purchase',userId:user.id,courseId:missingCourses[0]?.id||null,meta:{orderNumber:order.number,courseTitle:target.title}}); markLocalEmailsSent(db);
  const token=crypto.randomBytes(32).toString('base64url'); db.sessions.push({id:newId(),token,userId:user.id,createdAt:now(),expiresAt:new Date(Date.now()+SESSION_TTL_MS).toISOString()});
  return {user,target,order,payment,enrollments,token};
}

function prepareCheckout(db,body){
  const itemType=body.itemType==='bundle'?'bundle':'course';
  const target=itemType==='bundle'
    ?(db.bundles||[]).find(b=>b.slug===cleanText(body.itemSlug||body.bundleSlug,120)&&b.status==='published'&&b.saleEnabled!==false)
    :db.courses.find(c=>c.slug===cleanText(body.itemSlug||body.courseSlug,120)&&c.status==='published'&&c.saleEnabled!==false);
  if(!target) return {error:itemType==='bundle'?'Pack no disponible':'Curso no disponible para compra',status:404};
  const email=cleanText(body.email,220).toLowerCase(); const firstName=cleanText(body.firstName,120); const lastName=cleanText(body.lastName,120); const password=String(body.password||'');
  if(!email||!email.includes('@')||!firstName) return {error:'Completa nombre y email',status:400};
  let user=db.users.find(u=>u.email.toLowerCase()===email);
  if(!user){ if(password.length<8)return {error:'La contraseña debe tener al menos 8 caracteres',status:400}; const hp=hashPassword(password); user={id:newId(),email,firstName,lastName,role:'student',status:'active',lastLoginAt:null,passwordSalt:hp.salt,passwordHash:hp.hash,createdAt:now()}; db.users.push(user); }
  if(user.role!=='student') return {error:'Usa una cuenta de alumno para comprar cursos',status:409};
  const courseIds=itemType==='bundle'?(target.courseIds||[]):[target.id];
  const validCourses=courseIds.map(id=>db.courses.find(c=>c.id===id&&c.status==='published')).filter(Boolean);
  if(!validCourses.length)return {error:'No hay cursos disponibles en este producto',status:409};
  const activeOwned=new Set(db.enrollments.filter(e=>e.userId===user.id&&e.status==='active').map(e=>e.courseId));
  const missingCourses=validCourses.filter(c=>!activeOwned.has(c.id));
  if(!missingCourses.length)return {error:'Este usuario ya tiene acceso a todo el contenido incluido',status:409};
  const pr=pricingFor(db,itemType,target);
  const couponResult=validateCoupon(db,body.couponCode,{user,targetType:itemType,targetId:target.id,subtotalCents:pr.finalCents});
  if(couponResult.error)return couponResult;
  const couponDiscount=couponResult.discountCents||0;
  const total=Math.max(0,pr.finalCents-couponDiscount);
  const order={id:newId(),number:`ORD-${new Date().getFullYear()}-${String(db.orders.length+1).padStart(5,'0')}`,userId:user.id,courseId:itemType==='course'?target.id:null,bundleId:itemType==='bundle'?target.id:null,itemType,itemTitle:target.title,lineCourseIds:validCourses.map(c=>c.id),subtotalCents:pr.baseCents,promotionDiscountCents:pr.discountCents,couponDiscountCents:couponDiscount,discountCents:pr.discountCents+couponDiscount,couponCode:couponResult.coupon?.code||null,totalCents:total,currency:(target.currency||'EUR').toUpperCase(),status:total===0?'pending_free':'pending_payment',provider:total===0?'free':PAYMENT_PROVIDER,createdAt:now(),paidAt:null};
  const payment={id:newId(),orderId:order.id,userId:user.id,amountCents:order.totalCents,currency:order.currency,status:total===0?'pending':'pending',provider:total===0?'free':PAYMENT_PROVIDER,providerRef:null,createdAt:now()};
  db.orders.push(order); db.payments.push(payment);
  const token=crypto.randomBytes(32).toString('base64url'); db.sessions.push({id:newId(),token,userId:user.id,createdAt:now(),expiresAt:new Date(Date.now()+SESSION_TTL_MS).toISOString()});
  return {user,target,order,payment,missingCourses,coupon:couponResult.coupon,token};
}
function fulfillOrder(db,order,{providerRef=null,eventId=null}={}){
  if(!order) return {error:'Pedido no encontrado',status:404};
  if(order.status==='paid') return {ok:true,alreadyFulfilled:true,enrollments:db.enrollments.filter(e=>e.orderId===order.id)};
  const user=db.users.find(u=>u.id===order.userId); if(!user)return {error:'Usuario del pedido no encontrado',status:409};
  const validCourses=(order.lineCourseIds||[]).map(id=>db.courses.find(c=>c.id===id)).filter(Boolean);
  if(!validCourses.length)return {error:'El pedido no contiene cursos válidos',status:409};
  const enrollments=[];
  for(const course of validCourses){let enrollment=db.enrollments.find(e=>e.userId===user.id&&e.courseId===course.id);if(enrollment){enrollment.status='active';enrollment.orderId=order.id;enrollment.enrolledAt=enrollment.enrolledAt||now();}else{enrollment={id:newId(),userId:user.id,courseId:course.id,status:'active',enrolledAt:now(),orderId:order.id};db.enrollments.push(enrollment)}enrollments.push(enrollment);db.activity.push({id:newId(),userId:user.id,type:'enrollment_created',label:`Matrícula activada: ${course.title}`,at:now()});}
  order.status='paid'; order.paidAt=now(); if(providerRef)order.providerRef=providerRef; if(eventId)order.paymentEventId=eventId;
  const payment=db.payments.find(p=>p.orderId===order.id); if(payment){payment.status='succeeded';payment.providerRef=providerRef||payment.providerRef;payment.succeededAt=now();}
  if(order.couponCode){const coupon=(db.coupons||[]).find(c=>String(c.code||'').toUpperCase()===String(order.couponCode).toUpperCase());if(coupon&&!(db.couponRedemptions||[]).some(r=>r.orderId===order.id)){db.couponRedemptions.push({id:newId(),couponId:coupon.id,userId:user.id,orderId:order.id,discountCents:order.couponDiscountCents||0,redeemedAt:now()});}}
  const isFirstWelcome=!(db.emailOutbox||[]).some(e=>e.userId===user.id&&e.type==='welcome'); if(isFirstWelcome)queueEmail(db,{to:user.email,type:'welcome',userId:user.id});
  queueEmail(db,{to:user.email,type:'purchase',userId:user.id,courseId:validCourses[0]?.id||null,meta:{orderNumber:order.number,courseTitle:order.itemTitle}}); markLocalEmailsSent(db);
  return {ok:true,enrollments};
}
async function stripeCreateCheckoutSession(order,user){
  const params=new URLSearchParams();
  params.set('mode','payment');
  params.set('client_reference_id',order.id);
  params.set('customer_email',user.email);
  params.set('success_url',`${APP_ORIGIN}/?payment=success&order=${encodeURIComponent(order.id)}`);
  params.set('cancel_url',`${APP_ORIGIN}/?payment=cancel&order=${encodeURIComponent(order.id)}`);
  params.set('line_items[0][price_data][currency]',String(order.currency||'EUR').toLowerCase());
  params.set('line_items[0][price_data][product_data][name]',order.itemTitle);
  params.set('line_items[0][price_data][unit_amount]',String(order.totalCents));
  params.set('line_items[0][quantity]','1');
  params.set('metadata[order_id]',order.id); params.set('metadata[order_number]',order.number);
  const r=await fetch(`${STRIPE_API_BASE}/checkout/sessions`,{method:'POST',headers:{authorization:`Bearer ${STRIPE_SECRET_KEY}`,'content-type':'application/x-www-form-urlencoded','idempotency-key':`lykios-checkout-${order.id}`},body:params});
  const data=await r.json().catch(()=>({})); if(!r.ok)throw new Error(data?.error?.message||`Stripe HTTP ${r.status}`); return data;
}
function verifyStripeWebhook(raw,signatureHeader){
  const parts=String(signatureHeader||'').split(',').map(x=>x.trim()); const timestamp=parts.find(x=>x.startsWith('t='))?.slice(2); const signatures=parts.filter(x=>x.startsWith('v1=')).map(x=>x.slice(3));
  if(!timestamp||!signatures.length)return false; const age=Math.abs(Date.now()/1000-Number(timestamp)); if(!Number.isFinite(age)||age>300)return false;
  const expected=crypto.createHmac('sha256',STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
  return signatures.some(sig=>{try{return sig.length===expected.length&&crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))}catch{return false}});
}
function markPaymentFailed(db,order,reason,providerRef=null){if(!order||order.status==='paid')return;order.status='payment_failed';order.paymentFailureReason=cleanText(reason,300);const payment=db.payments.find(p=>p.orderId===order.id);if(payment){payment.status='failed';payment.providerRef=providerRef||payment.providerRef;payment.failureReason=cleanText(reason,300);}}
async function handleStripeEvent(db,event){
  db.paymentEvents ||= []; if(db.paymentEvents.some(e=>e.provider==='stripe'&&e.eventId===event.id))return {duplicate:true};
  const session=event?.data?.object||{}; const orderId=session?.metadata?.order_id||session?.client_reference_id; const order=db.orders.find(o=>o.id===orderId);
  let result={ignored:true};
  if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)){
    if(!order) result={error:'order_not_found'};
    else if(Number(session.amount_total)!==Number(order.totalCents)||String(session.currency||'').toUpperCase()!==String(order.currency||'').toUpperCase()){markPaymentFailed(db,order,'Importe o moneda no coinciden',session.id);result={error:'amount_mismatch'};}
    else if(event.type==='checkout.session.completed'&&session.payment_status!=='paid'){result={pending:true};}
    else result=fulfillOrder(db,order,{providerRef:session.payment_intent||session.id,eventId:event.id});
  } else if(['checkout.session.async_payment_failed','checkout.session.expired'].includes(event.type)){
    if(order)markPaymentFailed(db,order,event.type,session.id); result={failed:true};
  }
  db.paymentEvents.push({id:newId(),provider:'stripe',eventId:event.id,type:event.type,orderId:order?.id||null,processedAt:now(),result});
  return result;
}

function commerceAdminPayload(db){return {orders:db.orders.slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(o=>{const u=db.users.find(x=>x.id===o.userId),c=o.courseId?db.courses.find(x=>x.id===o.courseId):null,b=o.bundleId?(db.bundles||[]).find(x=>x.id===o.bundleId):null;return {...o,studentName:u?`${u.firstName} ${u.lastName}`.trim():'',email:u?.email||'',courseTitle:c?.title||b?.title||o.itemTitle||'',subtotalLabel:money(o.subtotalCents??o.totalCents,o.currency),discountLabel:money(o.discountCents||0,o.currency),totalLabel:money(o.totalCents,o.currency)}}),payments:db.payments.slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(p=>({...p,amountLabel:money(p.amountCents,p.currency)}))};}
function monetizationAdminPayload(db){
  const usages=Object.fromEntries((db.coupons||[]).map(c=>[c.id,(db.couponRedemptions||[]).filter(r=>r.couponId===c.id).length]));
  return {
    bundles:(db.bundles||[]).map(b=>({...b,courseTitles:bundleCourses(db,b).map(c=>c.title),priceLabel:money(b.priceCents,b.currency||'EUR')})),
    coupons:(db.coupons||[]).map(c=>({...c,uses:usages[c.id]||0,valueLabel:c.discountType==='percent'?`${c.value}%`:c.discountType==='free'?'100%':money(c.value,c.currency||'EUR')})),
    promotions:(db.promotions||[]).map(p=>{const target=p.targetType==='course'?db.courses.find(c=>c.id===p.targetId):(db.bundles||[]).find(b=>b.id===p.targetId);return {...p,targetTitle:target?.title||'Producto',valueLabel:p.discountType==='percent'?`${p.value}%`:money(p.value,p.currency||'EUR')};}),
    courses:db.courses.map(c=>({id:c.id,title:c.title,status:c.status}))
  };
}


function studentProgressForCourse(db,userId,courseId){
  const enrollment=db.enrollments.find(e=>e.userId===userId&&e.courseId===courseId&&e.status==='active');
  const moduleIds=db.modules.filter(m=>m.courseId===courseId&&m.status==='published').map(m=>m.id);
  const lessons=db.lessons.filter(l=>l.courseId===courseId&&l.status==='published'&&moduleIds.includes(l.moduleId));
  const completed=new Set(enrollment?db.progress.filter(p=>p.enrollmentId===enrollment.id&&p.completed).map(p=>p.lessonId):[]);
  return {enrollment,lessonsTotal:lessons.length,lessonsCompleted:lessons.filter(l=>completed.has(l.id)).length,progressPercent:lessons.length?Math.round(lessons.filter(l=>completed.has(l.id)).length/lessons.length*100):0};
}
function studentAdminPayload(db,user){
  const enrollments=db.enrollments.filter(e=>e.userId===user.id).map(e=>{const c=db.courses.find(x=>x.id===e.courseId);const p=studentProgressForCourse(db,user.id,e.courseId);return {...e,courseTitle:c?.title||'Curso',courseSlug:c?.slug||'',progressPercent:p.progressPercent,lessonsCompleted:p.lessonsCompleted,lessonsTotal:p.lessonsTotal};});
  const attempts=db.attempts.filter(a=>a.userId===user.id).sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt)).map(a=>{const ass=db.assessments.find(x=>x.id===a.assessmentId);return {...a,assessmentTitle:ass?.title||'Evaluación'};});
  const certificates=db.certificates.filter(c=>c.userId===user.id).map(c=>({...publicCertificate(db,c),id:c.id}));
  const orders=db.orders.filter(o=>o.userId===user.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(o=>{const c=db.courses.find(x=>x.id===o.courseId);return {...o,courseTitle:c?.title||'',totalLabel:money(o.totalCents,o.currency)};});
  const notes=(db.studentNotes||[]).filter(n=>n.userId===user.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  return {id:user.id,email:user.email,firstName:user.firstName,lastName:user.lastName,role:user.role,status:user.status||'active',createdAt:user.createdAt,lastLoginAt:user.lastLoginAt||null,enrollments,attempts,certificates,orders,notes};
}
function studentsAdminPayload(db){
  return db.users.filter(u=>u.role==='student').map(u=>{const p=studentAdminPayload(db,u);return {...p,activeEnrollments:p.enrollments.filter(e=>e.status==='active').length,avgProgress:p.enrollments.length?Math.round(p.enrollments.reduce((a,e)=>a+e.progressPercent,0)/p.enrollments.length):0};}).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
}

function mime(file){
  const ext=path.extname(file).toLowerCase();
  return ({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf','.ico':'image/x-icon'}[ext]||'application/octet-stream');
}
async function serveStatic(req,res){
  let p=new URL(req.url,'http://localhost').pathname;
  if(p==='/'||['/login','/dashboard','/courses','/course','/lesson','/profile','/admin'].includes(p)) p='/index.html';
  const file=path.normalize(path.join(PUBLIC_DIR,p));
  if(!file.startsWith(PUBLIC_DIR)) return false;
  try { const s=await stat(file); if(!s.isFile()) return false; text(res,200,await readFile(file),mime(file)); return true; } catch { return false; }
}

export const handleRequest=async (req,res)=>{
  const started=Date.now(); const rid=requestId(req); res.setHeader('x-request-id',rid);
  res.on('finish',()=>logEvent('info','http_request',{requestId:rid,method:req.method,path:String(req.url||'').split('?')[0],status:res.statusCode,durationMs:Date.now()-started,ip:clientIp(req)}));
  try{
    const url=new URL(req.url,'http://localhost');
    if(!sameOrigin(req) && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/public/') && url.pathname!=='/api/webhooks/stripe') return json(res,403,{error:'Origen no permitido'});
    if(url.pathname==='/api/health' || url.pathname==='/api/health/live') return json(res,200,{ok:true,app:'Lykios LMS',version:APP_VERSION,mode:NODE_ENV});
    if(url.pathname==='/api/health/ready'){ try{const db=await readDb(); const sh=await persistence.health(); return json(res,200,{ok:true,version:APP_VERSION,schemaVersion:db.meta?.schemaVersion||null,storage:sh});}catch(e){return json(res,503,{ok:false,error:'storage_unavailable'});} }
    if(url.pathname==='/api/public/catalog' && req.method==='GET'){const db=await readDb();return json(res,200,catalogPayload(db));}
    if(url.pathname==='/api/checkout/create' && req.method==='POST'){
      if(PAYMENT_PROVIDER!=='stripe'&&IS_PROD)return json(res,503,{error:'Pasarela de pago no configurada'});
      const body=await readBody(req); const db=await readDb(); const result=prepareCheckout(db,body); if(result.error)return json(res,result.status||400,{error:result.error});
      if(result.order.totalCents===0){const fulfilled=fulfillOrder(db,result.order,{providerRef:'free'});await writeDb(db);return json(res,201,{ok:true,free:true,user:{id:result.user.id,email:result.user.email,firstName:result.user.firstName,role:result.user.role},order:result.order,enrollments:fulfilled.enrollments},{'set-cookie':sessionCookie(result.token)});}
      if(PAYMENT_PROVIDER!=='stripe')return json(res,503,{error:'Pago real no disponible en este entorno'});
      try{const session=await stripeCreateCheckoutSession(result.order,result.user);result.order.checkoutSessionId=session.id;result.order.checkoutUrl=session.url;result.order.checkoutExpiresAt=session.expires_at?new Date(session.expires_at*1000).toISOString():null;result.payment.providerRef=session.id;await writeDb(db);return json(res,201,{ok:true,user:{id:result.user.id,email:result.user.email,firstName:result.user.firstName,role:result.user.role},order:{id:result.order.id,number:result.order.number,status:result.order.status,totalCents:result.order.totalCents,currency:result.order.currency},checkoutUrl:session.url},{'set-cookie':sessionCookie(result.token)});}catch(e){markPaymentFailed(db,result.order,e.message);await writeDb(db);logEvent('error','stripe_checkout_failed',{orderId:result.order.id,error:e.message});return json(res,502,{error:'No se pudo iniciar el pago. Inténtalo de nuevo.'});}
    }
    if(url.pathname==='/api/checkout/status' && req.method==='GET'){const db=await readDb();const user=await auth(req,db);if(!user)return json(res,401,{error:'No autenticado'});const order=db.orders.find(o=>o.id===url.searchParams.get('order')&&o.userId===user.id);if(!order)return json(res,404,{error:'Pedido no encontrado'});return json(res,200,{order:{id:order.id,number:order.number,status:order.status,totalCents:order.totalCents,currency:order.currency,paidAt:order.paidAt||null}});}
    if(url.pathname==='/api/webhooks/stripe' && req.method==='POST'){
      if(PAYMENT_PROVIDER!=='stripe')return json(res,404,{error:'No disponible'});const raw=await readRawBody(req);if(!verifyStripeWebhook(raw,req.headers['stripe-signature']))return json(res,400,{error:'Firma inválida'});let event;try{event=JSON.parse(raw)}catch{return json(res,400,{error:'Payload inválido'})}const db=await readDb();const result=await handleStripeEvent(db,event);await writeDb(db);logEvent('info','stripe_webhook',{eventId:event.id,type:event.type,result});return json(res,200,{received:true});
    }
    if(url.pathname==='/api/checkout/mock' && req.method==='POST'){if(IS_PROD)return json(res,404,{error:'No disponible'});const body=await readBody(req);const db=await readDb();const result=checkoutMock(db,body);if(result.error)return json(res,result.status||400,{error:result.error});await writeDb(db);return json(res,201,{ok:true,user:{id:result.user.id,email:result.user.email,firstName:result.user.firstName,role:result.user.role},item:{type:body.itemType==='bundle'?'bundle':'course',slug:result.target.slug,title:result.target.title},order:result.order,enrollments:result.enrollments},{'set-cookie':sessionCookie(result.token)});}
    if(url.pathname==='/api/checkout/coupon' && req.method==='POST'){const body=await readBody(req);const db=await readDb();const itemType=body.itemType==='bundle'?'bundle':'course';const target=itemType==='bundle'?(db.bundles||[]).find(b=>b.slug===body.itemSlug):db.courses.find(c=>c.slug===body.itemSlug);if(!target)return json(res,404,{error:'Producto no encontrado'});const pr=pricingFor(db,itemType,target);const user=(body.email?db.users.find(u=>u.email.toLowerCase()===String(body.email).toLowerCase()):null);const r=validateCoupon(db,body.couponCode,{user,targetType:itemType,targetId:target.id,subtotalCents:pr.finalCents});if(r.error)return json(res,r.status||400,{error:r.error});return json(res,200,{ok:true,discountCents:r.discountCents,discountLabel:money(r.discountCents,target.currency||'EUR'),totalCents:Math.max(0,pr.finalCents-r.discountCents),totalLabel:money(Math.max(0,pr.finalCents-r.discountCents),target.currency||'EUR'),coupon:r.coupon?{code:r.coupon.code,label:r.coupon.label||r.coupon.code,category:r.coupon.category||'coupon'}:null});}

    if(url.pathname==='/api/password/forgot' && req.method==='POST'){
      const rl=rateLimit(`forgot:${clientIp(req)}`,5,15*60*1000); if(!rl.ok)return json(res,429,{error:'Demasiados intentos. Prueba más tarde.'},{'retry-after':String(Math.ceil((rl.reset-Date.now())/1000))});
      const body=await readBody(req); const db=await readDb(); const email=cleanText(body.email,220).toLowerCase();
      const user=db.users.find(u=>u.email.toLowerCase()===email&&u.role==='student');
      if(user){db.passwordResetTokens=(db.passwordResetTokens||[]).filter(t=>!(t.userId===user.id&&new Date(t.expiresAt)>new Date()));const token=crypto.randomBytes(32).toString('base64url');db.passwordResetTokens.push({id:newId(),token,userId:user.id,createdAt:now(),expiresAt:new Date(Date.now()+60*60*1000).toISOString(),usedAt:null});queueEmail(db,{to:user.email,type:'password_reset',userId:user.id,meta:{resetUrl:`${APP_ORIGIN}/?reset=${encodeURIComponent(token)}`}});markLocalEmailsSent(db);await writeDb(db);}
      return json(res,200,{ok:true,message:'Si existe una cuenta con ese email, recibirás instrucciones.'});
    }
    if(url.pathname==='/api/password/reset' && req.method==='POST'){
      const body=await readBody(req); const db=await readDb(); const token=cleanText(body.token,200); const password=String(body.password||'');
      if(password.length<8)return json(res,400,{error:'La contraseña debe tener al menos 8 caracteres'});
      const item=(db.passwordResetTokens||[]).find(t=>t.token===token&&!t.usedAt&&new Date(t.expiresAt)>new Date()); if(!item)return json(res,400,{error:'El enlace no es válido o ha caducado'});
      const user=db.users.find(u=>u.id===item.userId); if(!user)return json(res,404,{error:'Cuenta no encontrada'}); const hp=hashPassword(password); user.passwordSalt=hp.salt;user.passwordHash=hp.hash;item.usedAt=now();db.sessions=db.sessions.filter(s=>s.userId!==user.id);await writeDb(db);return json(res,200,{ok:true});
    }
    if(url.pathname==='/api/login' && req.method==='POST'){
      const rl=rateLimit(`login:${clientIp(req)}`,10,15*60*1000); if(!rl.ok)return json(res,429,{error:'Demasiados intentos. Prueba más tarde.'},{'retry-after':String(Math.ceil((rl.reset-Date.now())/1000))});
      const body=await readBody(req); const db=await readDb();
      const user=db.users.find(u=>u.email.toLowerCase()===String(body.email||'').toLowerCase());
      if(!user || !verifyPassword(String(body.password||''),user.passwordSalt,user.passwordHash)) return json(res,401,{error:'Credenciales incorrectas'});
      if((user.status||'active')!=='active' && user.role!=='admin') return json(res,403,{error:'Cuenta bloqueada. Contacta con Lykios Academy.'});
      db.sessions=db.sessions.filter(s=>new Date(s.expiresAt)>new Date());
      const token=crypto.randomBytes(32).toString('base64url');
      user.lastLoginAt=now();
      db.sessions.push({id:newId(),token,userId:user.id,createdAt:now(),expiresAt:new Date(Date.now()+SESSION_TTL_MS).toISOString()});
      await writeDb(db);
      return json(res,200,{user:{id:user.id,email:user.email,firstName:user.firstName,lastName:user.lastName,role:user.role,status:user.status||'active'}},{'set-cookie':sessionCookie(token)});
    }
    if(url.pathname==='/api/logout' && req.method==='POST'){
      const db=await readDb(); const sid=parseCookies(req).lykios_session; db.sessions=db.sessions.filter(s=>s.token!==sid); await writeDb(db);
      return json(res,200,{ok:true},{'set-cookie':sessionCookie('',0)});
    }

    const verifyMatch=url.pathname.match(/^\/verify\/([A-Z0-9-]+)$/i);
    if(verifyMatch && req.method==='GET'){
      const db=await readDb(); const cert=db.certificates.find(c=>c.code===verifyMatch[1].toUpperCase());
      const payload=cert?publicCertificate(db,cert):null;
      return text(res,payload?200:404,verificationHtml(payload),'text/html; charset=utf-8');
    }
    if(url.pathname==='/api/public/certificate' && req.method==='GET'){
      const db=await readDb(); const code=String(url.searchParams.get('code')||'').toUpperCase(); const cert=db.certificates.find(c=>c.code===code);
      const payload=cert?publicCertificate(db,cert):null; return payload?json(res,200,payload):json(res,404,{error:'Certificado no encontrado'});
    }
    if(url.pathname==='/api/public/certificate/qr' && req.method==='GET'){
      const db=await readDb(); const code=String(url.searchParams.get('code')||'').toUpperCase(); const cert=db.certificates.find(c=>c.code===code); if(!cert)return json(res,404,{error:'Certificado no encontrado'});
      const host=req.headers.host||'campus.lykiosacademy.com'; const proto=host.includes('localhost')?'http':'https'; const target=`${proto}://${host}/verify/${cert.code}`;
      try{return text(res,200,await qrPng(target),'image/png',{'cache-control':'public, max-age=86400'});}catch{return json(res,503,{error:'QR no disponible en este entorno'});}
    }

    if(url.pathname==='/api/video/stream' && req.method==='GET'){
      const db=await readDb(); const claims=verifyVideoToken(url.searchParams.get('token'));
      if(!claims)return json(res,401,{error:'Enlace de vídeo inválido o caducado'});
      const user=db.users.find(u=>u.id===claims.userId), lesson=db.lessons.find(l=>l.id===claims.lessonId);
      if(!user||!lesson||!canAccessLesson(db,user,lesson))return json(res,403,{error:'Sin acceso'});
      const ref=String(lesson.video||'');
      if(ref.startsWith('local:')){
        const file=path.join(UPLOAD_DIR,path.basename(ref.slice(6)));
        try{const buf=await readFile(file);res.writeHead(200,{'content-type':'video/mp4','cache-control':'private, max-age=60','accept-ranges':'bytes','content-length':buf.length});return res.end(buf)}catch{return json(res,404,{error:'Vídeo no disponible'})}
      }
      if(ref.startsWith('blob:')){
        try{
          const buf=await resourceStore.read(ref.slice(5));
          res.writeHead(200,{'content-type':lesson.videoMime||'video/mp4','cache-control':'private, max-age=60','accept-ranges':'bytes','content-length':buf.length});
          return res.end(buf);
        }catch{return json(res,404,{error:'Vídeo no disponible'})}
      }
      return json(res,409,{error:'Proveedor de vídeo externo aún no conectado','reference':ref});
    }
    if(url.pathname.startsWith('/api/')){
      const db=await readDb(); const user=await auth(req,db);
      if(!user) return json(res,401,{error:'No autenticado'});
      if(url.pathname==='/api/me') return json(res,200,{id:user.id,email:user.email,firstName:user.firstName,lastName:user.lastName,role:user.role,status:user.status||'active'});
      if(url.pathname==='/api/dashboard'){
        const enrollments=db.enrollments.filter(e=>e.userId===user.id&&e.status==='active');
        const courses=enrollments.map(e=>coursePayload(db,user,db.courses.find(c=>c.id===e.courseId)?.slug)).filter(Boolean);
        const completed=db.progress.filter(p=>enrollments.some(e=>e.id===p.enrollmentId)&&p.completed).length;
        return json(res,200,{stats:{activeCourses:enrollments.filter(e=>e.status==='active').length,completedLessons:completed,certificates:db.certificates.filter(c=>c.userId===user.id).length,streakDays:6},courses,activity:db.activity.filter(a=>a.userId===user.id).slice(-8).reverse()});
      }
      if(url.pathname==='/api/course' && req.method==='GET'){
        const course=coursePayload(db,user,url.searchParams.get('slug')||'peeling-quimico'); if(!course) return json(res,404,{error:'Curso no encontrado'}); return json(res,200,course);
      }
      if(url.pathname==='/api/tutor/ask' && req.method==='POST'){
        const body=await readBody(req); const course=db.courses.find(c=>c.slug===cleanText(body.courseSlug,100));
        if(!course || !tutorCourseAccess(db,user,course)) return json(res,403,{error:'Sin acceso a este curso'});
        const result=tutorAsk(db,user,course,body.question);
        const queryId=newId(); const privateMode=Boolean(body.privateMode); const policy=db.meta?.tutorPolicy||{};
        db.tutorQueries ||= []; db.tutorQueries.push({id:queryId,userId:user.id,courseId:course.id,question:(!privateMode&&policy.storeQuestionText!==false)?cleanText(body.question,1200):null,questionHash:crypto.createHash('sha256').update(cleanText(body.question,1200)).digest('hex'),privateMode,grounded:result.grounded,confidence:result.confidence,sourceLessonIds:result.sources.map(s=>s.lessonId),createdAt:now()});
        if(db.tutorQueries.length>2000) db.tutorQueries=db.tutorQueries.slice(-2000);
        await writeDb(db); return json(res,200,{...result,queryId,privateMode});
      }
      if(url.pathname==='/api/tutor/feedback' && req.method==='POST'){
        const body=await readBody(req); const q=db.tutorQueries.find(x=>x.id===body.queryId&&x.userId===user.id); if(!q)return json(res,404,{error:'Consulta no encontrada'});
        if(db.meta?.tutorPolicy?.feedbackEnabled===false)return json(res,409,{error:'Feedback desactivado'});
        const rating=['helpful','not_helpful'].includes(body.rating)?body.rating:null; if(!rating)return json(res,400,{error:'Valoración inválida'});
        db.tutorFeedback ||= []; db.tutorFeedback=db.tutorFeedback.filter(f=>!(f.queryId===q.id&&f.userId===user.id)); db.tutorFeedback.push({id:newId(),queryId:q.id,userId:user.id,rating,comment:cleanText(body.comment,500),createdAt:now()});
        await writeDb(db); return json(res,200,{ok:true});
      }
      if(url.pathname==='/api/progress' && req.method==='POST'){
        const body=await readBody(req); const lesson=db.lessons.find(l=>l.id===body.lessonId); if(!lesson || lesson.status!=='published') return json(res,404,{error:'Clase no encontrada'});
        const enrollment=db.enrollments.find(e=>e.userId===user.id && e.courseId===lesson.courseId && e.status==='active'); if(!enrollment) return json(res,403,{error:'Sin matrícula activa'});
        let p=db.progress.find(x=>x.enrollmentId===enrollment.id&&x.lessonId===lesson.id);
        if(!p){ p={id:newId(),enrollmentId:enrollment.id,lessonId:lesson.id,completed:false,progressPercent:0,updatedAt:now()}; db.progress.push(p); }
        p.completed=body.completed!==false; p.progressPercent=p.completed?100:Number(body.progressPercent||0); p.updatedAt=now(); if(p.completed&&!p.completedAt)p.completedAt=now();
        db.activity.push({id:newId(),userId:user.id,type:'lesson_completed',label:`Clase ${lesson.code} completada`,at:now()});
        maybeQueueCourseCompleted(db,user,lesson.courseId); markLocalEmailsSent(db);
        await writeDb(db); return json(res,200,{ok:true,progress:p,course:coursePayload(db,user,db.courses.find(c=>c.id===lesson.courseId).slug)});
      }

      if(url.pathname==='/api/assessment' && req.method==='GET'){
        const id=url.searchParams.get('id');
        const assessment=id?db.assessments.find(a=>a.id===id):assessmentForScope(db,url.searchParams.get('scopeType'),url.searchParams.get('scopeId'));
        if(!assessment || !visibleAssessment(db,user,assessment)) return json(res,404,{error:'Evaluación no disponible'});
        return json(res,200,assessmentPayload(db,assessment,{includeAnswers:false,userId:user.id}));
      }
      if(url.pathname==='/api/assessment/submit' && req.method==='POST'){
        const body=await readBody(req);
        const assessment=db.assessments.find(a=>a.id===body.assessmentId);
        if(!assessment || !visibleAssessment(db,user,assessment)) return json(res,404,{error:'Evaluación no disponible'});
        const prior=db.attempts.filter(a=>a.assessmentId===assessment.id&&a.userId===user.id);
        if(assessment.maxAttempts>0 && prior.length>=assessment.maxAttempts) return json(res,409,{error:'Has alcanzado el número máximo de intentos'});
        const questions=db.questions.filter(q=>q.assessmentId===assessment.id).sort((a,b)=>a.position-b.position);
        if(!questions.length) return json(res,409,{error:'La evaluación no tiene preguntas'});
        const answers=body.answers && typeof body.answers==='object' ? body.answers : {};
        let correct=0;
        const review=questions.map(q=>{
          const selected=Number(answers[q.id]);
          const ok=Number.isInteger(selected)&&selected===q.correctOption;
          if(ok) correct++;
          return {questionId:q.id,selectedOption:Number.isInteger(selected)?selected:null,correct:ok,correctOption:q.correctOption,explanation:q.explanation||''};
        });
        const score=Math.round(correct/questions.length*100);
        const passed=score>=assessment.passingScore;
        const attempt={id:newId(),assessmentId:assessment.id,userId:user.id,score,passed,answers:review,submittedAt:now()};
        db.attempts.push(attempt);
        db.activity.push({id:newId(),userId:user.id,type:'assessment_submitted',label:`Evaluación: ${assessment.title} · ${score}%`,at:now()});
        let assessmentCourseId=null; if(assessment.scopeType==='lesson')assessmentCourseId=db.lessons.find(l=>l.id===assessment.scopeId)?.courseId||null; else assessmentCourseId=db.modules.find(m=>m.id===assessment.scopeId)?.courseId||null;
        if(assessmentCourseId) maybeQueueCourseCompleted(db,user,assessmentCourseId); markLocalEmailsSent(db);
        await writeDb(db);
        return json(res,200,{attempt,passingScore:assessment.passingScore,attemptsUsed:prior.length+1,attemptsRemaining:assessment.maxAttempts>0?Math.max(0,assessment.maxAttempts-(prior.length+1)):null});
      }

      if(url.pathname==='/api/certificate/status' && req.method==='GET'){
        const course=db.courses.find(c=>c.slug===(url.searchParams.get('slug')||'peeling-quimico')); if(!course)return json(res,404,{error:'Curso no encontrado'});
        const existing=db.certificates.find(c=>c.userId===user.id&&c.courseId===course.id&&c.status!=='revoked');
        return json(res,200,{completion:courseCompletionStatus(db,user,course.id),certificate:existing?publicCertificate(db,existing):null});
      }
      if(url.pathname==='/api/certificate/issue' && req.method==='POST'){
        const body=await readBody(req); const course=db.courses.find(c=>c.id===body.courseId||c.slug===body.slug); if(!course)return json(res,404,{error:'Curso no encontrado'});
        const completion=courseCompletionStatus(db,user,course.id); if(!completion.eligible)return json(res,409,{error:'Aún no cumples los requisitos para emitir el certificado',completion});
        let cert=db.certificates.find(c=>c.userId===user.id&&c.courseId===course.id&&c.status!=='revoked');
        if(!cert){cert={id:newId(),code:certificateCode(),userId:user.id,courseId:course.id,status:'valid',issuedAt:now(),createdAt:now()};db.certificates.push(cert);db.activity.push({id:newId(),userId:user.id,type:'certificate_issued',label:`Certificado emitido: ${course.title}`,at:now()});queueEmail(db,{to:user.email,type:'certificate',userId:user.id,courseId:course.id,meta:{certificateCode:cert.code}});markLocalEmailsSent(db);await writeDb(db);}
        return json(res,201,{certificate:publicCertificate(db,cert)});
      }
      if(url.pathname==='/api/certificate/pdf' && req.method==='GET'){
        const code=String(url.searchParams.get('code')||'').toUpperCase(); const cert=db.certificates.find(c=>c.code===code); if(!cert)return json(res,404,{error:'Certificado no encontrado'});
        if(user.role!=='admin'&&cert.userId!==user.id)return json(res,403,{error:'Sin acceso'}); const payload=publicCertificate(db,cert); const buf=certificatePdf(payload);
        return text(res,200,buf,'application/pdf',{'content-disposition':`attachment; filename="Certificado-Lykios-${cert.code}.pdf"`});
      }

      if(url.pathname==='/api/video/session' && req.method==='POST'){
        const body=await readBody(req); const lesson=db.lessons.find(l=>l.id===body.lessonId);
        if(!lesson || !canAccessLesson(db,user,lesson)) return json(res,403,{error:'Sin acceso a esta clase'});
        if(!lesson.video) return json(res,404,{error:'Esta clase aún no tiene vídeo configurado'});
        const expiresAt=Date.now()+VIDEO_TOKEN_TTL_MS;
        const token=signVideoToken({userId:user.id,lessonId:lesson.id,expiresAt});
        let streamUrl=`/api/video/stream?token=${encodeURIComponent(token)}`;
        const ref=String(lesson.video||'');
        if(ref.startsWith('blob:')){
          const pathname=ref.slice(5);
          const {issueSignedToken,presignUrl}=await import('@vercel/blob');
          const signedToken=await issueSignedToken({pathname,operations:['get'],validUntil:expiresAt});
          const signed=await presignUrl(signedToken,{pathname,operation:'get',access:'private',validUntil:expiresAt});
          streamUrl=signed.presignedUrl;
        }
        return json(res,200,{token,expiresAt,streamUrl,progress:videoProgressPayload(db,user,lesson.id)});
      }
      if(url.pathname==='/api/video/progress' && req.method==='POST'){
        const body=await readBody(req); const lesson=db.lessons.find(l=>l.id===body.lessonId);
        if(!lesson || !canAccessLesson(db,user,lesson)) return json(res,403,{error:'Sin acceso a esta clase'});
        const currentTime=Math.max(0,Number(body.currentTime)||0), duration=Math.max(0,Number(body.duration)||0);
        const percent=duration>0?Math.min(100,Math.round(currentTime/duration*100)):0;
        let vp=db.videoProgress.find(x=>x.userId===user.id&&x.lessonId===lesson.id);
        if(!vp){vp={id:newId(),userId:user.id,lessonId:lesson.id,currentTime:0,duration:0,percent:0,completed:false,lastPlayedAt:null};db.videoProgress.push(vp)}
        vp.currentTime=currentTime; vp.duration=duration; vp.percent=Math.max(vp.percent||0,percent); vp.completed=vp.completed||percent>=90; vp.lastPlayedAt=now();
        await writeDb(db); return json(res,200,{progress:videoProgressPayload(db,user,lesson.id)});
      }
      if(url.pathname==='/api/resource' && req.method==='GET'){
        const found=findResource(db,url.searchParams.get('id')); if(!found) return json(res,404,{error:'Recurso no encontrado'});
        const {lesson,resource}=found;
        const allowed=user.role==='admin'||canTeachCourse(db,user,lesson.courseId)||db.enrollments.some(e=>e.userId===user.id&&e.courseId===lesson.courseId&&e.status==='active');
        if(!allowed) return json(res,403,{error:'Sin acceso al recurso'});
        const file=path.join(UPLOAD_DIR,path.basename(resource.storageName||''));
        try{const buf=await resourceStore.read(resource.storageName);return text(res,200,buf,resource.mime||'application/octet-stream',{'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(resource.name)}`,'x-content-type-options':'nosniff'});}catch{return json(res,404,{error:'Archivo no disponible'});}
      }

      // TEACHER / AUTHOR
      if(url.pathname.startsWith('/api/teacher/')){
        if(user.role!=='teacher'&&user.role!=='admin') return json(res,403,{error:'Solo profesor o administrador'});
        const allowed=teacherCourseIds(db,user);
        if(url.pathname==='/api/teacher/content'&&req.method==='GET') return json(res,200,{courses:user.role==='admin'?adminContentPayload(db):teacherContentPayload(db,user)});
        if(url.pathname==='/api/teacher/summary'&&req.method==='GET'){
          const courseIds=user.role==='admin'?new Set(db.courses.map(c=>c.id)):allowed;
          const lessons=db.lessons.filter(l=>courseIds.has(l.courseId)); const enrollments=db.enrollments.filter(e=>courseIds.has(e.courseId));
          return json(res,200,{courses:courseIds.size,lessons:lessons.length,students:new Set(enrollments.map(e=>e.userId)).size,enrollments:enrollments.length});
        }
        if(url.pathname==='/api/teacher/analytics'&&req.method==='GET') return json(res,200,user.role==='admin'?adminAnalyticsPayload(db):teacherAnalyticsPayload(db,user));
        if(url.pathname==='/api/teacher/students'&&req.method==='GET'){
          const courseIds=user.role==='admin'?new Set(db.courses.map(c=>c.id)):allowed;
          const rows=db.enrollments.filter(e=>courseIds.has(e.courseId)&&e.status==='active').map(e=>{const u=db.users.find(x=>x.id===e.userId);const c=db.courses.find(x=>x.id===e.courseId);const lessons=db.lessons.filter(l=>l.courseId===e.courseId&&l.status==='published');const done=db.progress.filter(p=>p.enrollmentId===e.id&&p.completed).length;return {userId:u?.id,name:`${u?.firstName||''} ${u?.lastName||''}`.trim(),email:u?.email,courseId:c?.id,courseTitle:c?.title,progress:lessons.length?Math.round(done/lessons.length*100):0};});
          return json(res,200,{students:rows});
        }
        if(url.pathname==='/api/teacher/module'&&req.method==='POST'){const body=await readBody(req);if(!canTeachCourse(db,user,body.courseId))return json(res,403,{error:'Curso no asignado'});const course=db.courses.find(c=>c.id===body.courseId);if(!course)return json(res,404,{error:'Curso no encontrado'});const module={id:newId(),courseId:course.id,code:cleanText(body.code,30)||`M${positionOf(db.modules,m=>m.courseId===course.id)}`,title:cleanText(body.title,180),position:Number(body.position)||positionOf(db.modules,m=>m.courseId===course.id),status:safeStatus(body.status),createdAt:now(),updatedAt:now()};if(!module.title)return json(res,400,{error:'Título obligatorio'});db.modules.push(module);course.updatedAt=now();await writeDb(db);return json(res,201,{module});}
        const tm=url.pathname.match(/^\/api\/teacher\/module\/([^/]+)$/); if(tm){const module=db.modules.find(m=>m.id===tm[1]);if(!module)return json(res,404,{error:'Módulo no encontrado'});if(!canTeachCourse(db,user,module.courseId))return json(res,403,{error:'Curso no asignado'});if(req.method==='PUT'){const body=await readBody(req);module.code=cleanText(body.code??module.code,30);module.title=cleanText(body.title||module.title,180);module.position=Math.max(1,Number(body.position)||module.position);module.status=safeStatus(body.status??module.status);module.updatedAt=now();await writeDb(db);return json(res,200,{module});}}
        if(url.pathname==='/api/teacher/lesson'&&req.method==='POST'){const body=await readBody(req);const module=db.modules.find(m=>m.id===body.moduleId);if(!module)return json(res,404,{error:'Módulo no encontrado'});if(!canTeachCourse(db,user,module.courseId))return json(res,403,{error:'Curso no asignado'});const lesson={id:newId(),moduleId:module.id,courseId:module.courseId,code:cleanText(body.code,30)||`${module.code}.${positionOf(db.lessons,l=>l.moduleId===module.id)}`,title:cleanText(body.title,180),summary:cleanText(body.summary,5000),position:Number(body.position)||positionOf(db.lessons,l=>l.moduleId===module.id),status:safeStatus(body.status),durationMinutes:Math.max(1,Number(body.durationMinutes)||10),video:body.video?cleanText(body.video,1000):null,resources:[],tutorApproved:false,tutorContent:cleanText(body.tutorContent,20000),tutorApprovedAt:null,createdAt:now(),updatedAt:now()};if(!lesson.title)return json(res,400,{error:'Título obligatorio'});db.lessons.push(lesson);await writeDb(db);return json(res,201,{lesson});}
        const tl=url.pathname.match(/^\/api\/teacher\/lesson\/([^/]+)$/); if(tl){const lesson=db.lessons.find(l=>l.id===tl[1]);if(!lesson)return json(res,404,{error:'Clase no encontrada'});if(!canTeachCourse(db,user,lesson.courseId))return json(res,403,{error:'Curso no asignado'});if(req.method==='PUT'){const body=await readBody(req);lesson.code=cleanText(body.code??lesson.code,30);lesson.title=cleanText(body.title||lesson.title,180);lesson.summary=cleanText(body.summary??lesson.summary,5000);lesson.position=Math.max(1,Number(body.position)||lesson.position);lesson.status=safeStatus(body.status??lesson.status);lesson.durationMinutes=Math.max(1,Number(body.durationMinutes)||lesson.durationMinutes);lesson.video=body.video===null?null:cleanText(body.video??lesson.video,1000)||null;if(body.tutorContent!==undefined){const nextTutor=cleanText(body.tutorContent,20000);if(nextTutor!==lesson.tutorContent){lesson.tutorContent=nextTutor;lesson.tutorApproved=false;lesson.tutorApprovedAt=null;}}lesson.updatedAt=now();await writeDb(db);return json(res,200,{lesson});}}
        if(url.pathname==='/api/teacher/resource'&&req.method==='POST'){const body=await readBody(req);const lesson=db.lessons.find(l=>l.id===body.lessonId);if(!lesson)return json(res,404,{error:'Clase no encontrada'});if(!canTeachCourse(db,user,lesson.courseId))return json(res,403,{error:'Curso no asignado'});const name=cleanText(body.name,220),data=String(body.dataBase64||''),mimeType=safeResourceMime(body.mime);if(!name||!data)return json(res,400,{error:'Archivo incompleto'});if(!mimeType)return json(res,415,{error:'Tipo de archivo no permitido'});const buf=Buffer.from(data,'base64');if(!buf.length||buf.length>MAX_RESOURCE_BYTES)return json(res,413,{error:'Máximo 6 MB'});const ext=path.extname(name).slice(0,10).replace(/[^.a-zA-Z0-9]/g,'');const storageName=`${newId()}${ext}`;const storageRef=await resourceStore.save(storageName,buf,mimeType);const resource={id:newId(),name,mime:mimeType,size:buf.length,storageName:storageRef,createdAt:now()};lesson.resources||=[];lesson.resources.push(resource);await writeDb(db);return json(res,201,{resource});}
        return json(res,404,{error:'Endpoint docente no encontrado'});
      }

      // ADMIN
      if(url.pathname.startsWith('/api/admin/')){
        if(!ensureAdmin(user,res)) return;
        if(url.pathname==='/api/admin/summary' && req.method==='GET'){
          return json(res,200,{students:db.users.filter(u=>u.role==='student').length,courses:db.courses.length,lessons:db.lessons.length,enrollments:db.enrollments.length,publishedCourses:db.courses.filter(c=>c.status==='published').length,draftCourses:db.courses.filter(c=>c.status==='draft').length,assessments:db.assessments.length,publishedAssessments:db.assessments.filter(a=>a.status==='published').length,attempts:db.attempts.length,certificates:db.certificates.length,validCertificates:db.certificates.filter(c=>c.status!=='revoked').length});
        }
        if(url.pathname==='/api/admin/content' && req.method==='GET') return json(res,200,{courses:adminContentPayload(db)});
        if(url.pathname==='/api/admin/teachers'&&req.method==='GET'){const teachers=db.users.filter(u=>u.role==='teacher').map(t=>({...t,passwordHash:undefined,passwordSalt:undefined,assignments:(db.teacherAssignments||[]).filter(a=>a.teacherId===t.id).map(a=>({id:a.id,courseId:a.courseId,courseTitle:db.courses.find(c=>c.id===a.courseId)?.title||'Curso'}))}));return json(res,200,{teachers,courses:db.courses.map(c=>({id:c.id,title:c.title}))});}
        if(url.pathname==='/api/admin/tutor/audit'&&req.method==='GET')return json(res,200,tutorAuditPayload(db));
        if(url.pathname==='/api/admin/tutor/settings'&&req.method==='PUT'){
          const body=await readBody(req); db.meta.tutorPolicy ||= {retainQueriesDays:30,storeQuestionText:true,feedbackEnabled:true};
          db.meta.tutorPolicy.retainQueriesDays=Math.max(0,Math.min(365,Number(body.retainQueriesDays)||0));
          db.meta.tutorPolicy.storeQuestionText=body.storeQuestionText!==false;
          db.meta.tutorPolicy.feedbackEnabled=body.feedbackEnabled!==false;
          await writeDb(db); return json(res,200,{policy:db.meta.tutorPolicy});
        }
        if(url.pathname==='/api/admin/teacher'&&req.method==='POST'){const body=await readBody(req);const email=cleanText(body.email,220).toLowerCase();if(db.users.some(u=>u.email.toLowerCase()===email))return json(res,409,{error:'Email ya registrado'});const pw=hashPassword(String(body.password||'ProfesorLykios2026!'));const teacher={id:newId(),email,firstName:cleanText(body.firstName,120),lastName:cleanText(body.lastName,120),role:'teacher',status:'active',lastLoginAt:null,passwordSalt:pw.salt,passwordHash:pw.hash,createdAt:now()};if(!email||!teacher.firstName)return json(res,400,{error:'Nombre y email obligatorios'});db.users.push(teacher);await writeDb(db);return json(res,201,{teacher:{...teacher,passwordHash:undefined,passwordSalt:undefined}});}
        if(url.pathname==='/api/admin/teacher/assign'&&req.method==='POST'){const body=await readBody(req);const teacher=db.users.find(u=>u.id===body.teacherId&&u.role==='teacher');const course=db.courses.find(c=>c.id===body.courseId);if(!teacher||!course)return json(res,404,{error:'Docente o curso no encontrado'});if(!(db.teacherAssignments||[]).some(a=>a.teacherId===teacher.id&&a.courseId===course.id))db.teacherAssignments.push({id:newId(),teacherId:teacher.id,courseId:course.id,role:'author',createdAt:now()});await writeDb(db);return json(res,201,{ok:true});}
        if(url.pathname==='/api/admin/teacher/unassign'&&req.method==='POST'){const body=await readBody(req);db.teacherAssignments=(db.teacherAssignments||[]).filter(a=>!(a.teacherId===body.teacherId&&a.courseId===body.courseId));await writeDb(db);return json(res,200,{ok:true});}
        if(url.pathname==='/api/admin/commerce' && req.method==='GET') return json(res,200,commerceAdminPayload(db));
        if(url.pathname==='/api/admin/monetization' && req.method==='GET') return json(res,200,monetizationAdminPayload(db));
        if(url.pathname==='/api/admin/bundle' && req.method==='POST'){const body=await readBody(req);const b={id:newId(),slug:slugify(body.slug||body.title),title:cleanText(body.title,180),subtitle:cleanText(body.subtitle,300),description:cleanText(body.description,2000),courseIds:Array.isArray(body.courseIds)?body.courseIds.filter(id=>db.courses.some(c=>c.id===id)):[],priceCents:Math.max(0,Math.round(Number(body.priceCents)||0)),currency:'EUR',status:safeStatus(body.status),saleEnabled:body.saleEnabled!==false&&body.saleEnabled!=='false',createdAt:now(),updatedAt:now()};if(!b.title||!b.courseIds.length)return json(res,400,{error:'Título y al menos un curso son obligatorios'});if((db.bundles||[]).some(x=>x.slug===b.slug))return json(res,409,{error:'Ya existe un pack con ese slug'});db.bundles.push(b);await writeDb(db);return json(res,201,{bundle:b});}
        const bundleMatch=url.pathname.match(/^\/api\/admin\/bundle\/([^/]+)$/);
        if(bundleMatch){const b=(db.bundles||[]).find(x=>x.id===bundleMatch[1]);if(!b)return json(res,404,{error:'Pack no encontrado'});if(req.method==='PUT'){const body=await readBody(req);if(body.title!==undefined)b.title=cleanText(body.title,180);if(body.slug!==undefined)b.slug=slugify(body.slug||b.title);if(body.subtitle!==undefined)b.subtitle=cleanText(body.subtitle,300);if(body.description!==undefined)b.description=cleanText(body.description,2000);if(Array.isArray(body.courseIds))b.courseIds=body.courseIds.filter(id=>db.courses.some(c=>c.id===id));if(body.priceCents!==undefined)b.priceCents=Math.max(0,Math.round(Number(body.priceCents)||0));if(body.status!==undefined)b.status=safeStatus(body.status);if(body.saleEnabled!==undefined)b.saleEnabled=body.saleEnabled!==false&&body.saleEnabled!=='false';b.updatedAt=now();await writeDb(db);return json(res,200,{bundle:b});}if(req.method==='DELETE'){if(db.orders.some(o=>o.bundleId===b.id))return json(res,409,{error:'No se puede eliminar un pack con pedidos; despublícalo'});db.bundles=db.bundles.filter(x=>x.id!==b.id);db.promotions=(db.promotions||[]).filter(p=>!(p.targetType==='bundle'&&p.targetId===b.id));await writeDb(db);return json(res,200,{ok:true});}}
        if(url.pathname==='/api/admin/coupon' && req.method==='POST'){const body=await readBody(req);const c={id:newId(),code:cleanText(body.code,80).toUpperCase(),label:cleanText(body.label,120),category:['coupon','promotion','scholarship'].includes(body.category)?body.category:'coupon',discountType:['percent','fixed','free'].includes(body.discountType)?body.discountType:'percent',value:Math.max(0,Number(body.value)||0),currency:'EUR',targetType:['all','course','bundle'].includes(body.targetType)?body.targetType:'all',targetIds:Array.isArray(body.targetIds)?body.targetIds:[],minSubtotalCents:Math.max(0,Math.round(Number(body.minSubtotalCents)||0)),maxRedemptions:Math.max(0,Math.round(Number(body.maxRedemptions)||0)),perUserLimit:Math.max(0,Math.round(Number(body.perUserLimit)||1)),startsAt:body.startsAt||null,endsAt:body.endsAt||null,active:body.active!==false&&body.active!=='false',createdAt:now(),updatedAt:now()};if(!c.code)return json(res,400,{error:'Código obligatorio'});if((db.coupons||[]).some(x=>x.code===c.code))return json(res,409,{error:'Ese código ya existe'});db.coupons.push(c);await writeDb(db);return json(res,201,{coupon:c});}
        const couponMatch=url.pathname.match(/^\/api\/admin\/coupon\/([^/]+)$/);
        if(couponMatch){const c=(db.coupons||[]).find(x=>x.id===couponMatch[1]);if(!c)return json(res,404,{error:'Cupón no encontrado'});if(req.method==='PUT'){const body=await readBody(req);for(const k of ['label','startsAt','endsAt'])if(body[k]!==undefined)c[k]=body[k]||null;if(body.code!==undefined)c.code=cleanText(body.code,80).toUpperCase();if(body.category!==undefined)c.category=['coupon','promotion','scholarship'].includes(body.category)?body.category:c.category;if(body.discountType!==undefined)c.discountType=['percent','fixed','free'].includes(body.discountType)?body.discountType:c.discountType;if(body.value!==undefined)c.value=Math.max(0,Number(body.value)||0);if(body.targetType!==undefined)c.targetType=['all','course','bundle'].includes(body.targetType)?body.targetType:c.targetType;if(Array.isArray(body.targetIds))c.targetIds=body.targetIds;if(body.minSubtotalCents!==undefined)c.minSubtotalCents=Math.max(0,Math.round(Number(body.minSubtotalCents)||0));if(body.maxRedemptions!==undefined)c.maxRedemptions=Math.max(0,Math.round(Number(body.maxRedemptions)||0));if(body.perUserLimit!==undefined)c.perUserLimit=Math.max(0,Math.round(Number(body.perUserLimit)||0));if(body.active!==undefined)c.active=body.active!==false&&body.active!=='false';c.updatedAt=now();await writeDb(db);return json(res,200,{coupon:c});}if(req.method==='DELETE'){if((db.couponRedemptions||[]).some(r=>r.couponId===c.id))return json(res,409,{error:'No se puede eliminar un cupón ya utilizado; desactívalo'});db.coupons=db.coupons.filter(x=>x.id!==c.id);await writeDb(db);return json(res,200,{ok:true});}}
        if(url.pathname==='/api/admin/promotion' && req.method==='POST'){const body=await readBody(req);const p={id:newId(),name:cleanText(body.name,160),badge:cleanText(body.badge||'Oferta',40),targetType:body.targetType==='bundle'?'bundle':'course',targetId:cleanText(body.targetId,80),discountType:['percent','fixed'].includes(body.discountType)?body.discountType:'percent',value:Math.max(0,Number(body.value)||0),currency:'EUR',priority:Math.round(Number(body.priority)||0),startsAt:body.startsAt||null,endsAt:body.endsAt||null,active:body.active!==false&&body.active!=='false',createdAt:now(),updatedAt:now()};if(!p.name||!p.targetId)return json(res,400,{error:'Nombre y producto son obligatorios'});db.promotions.push(p);await writeDb(db);return json(res,201,{promotion:p});}
        const promotionMatch=url.pathname.match(/^\/api\/admin\/promotion\/([^/]+)$/);
        if(promotionMatch){const p=(db.promotions||[]).find(x=>x.id===promotionMatch[1]);if(!p)return json(res,404,{error:'Promoción no encontrada'});if(req.method==='PUT'){const body=await readBody(req);for(const k of ['name','badge','startsAt','endsAt'])if(body[k]!==undefined)p[k]=body[k]||null;if(body.targetType!==undefined)p.targetType=body.targetType==='bundle'?'bundle':'course';if(body.targetId!==undefined)p.targetId=cleanText(body.targetId,80);if(body.discountType!==undefined)p.discountType=['percent','fixed'].includes(body.discountType)?body.discountType:p.discountType;if(body.value!==undefined)p.value=Math.max(0,Number(body.value)||0);if(body.priority!==undefined)p.priority=Math.round(Number(body.priority)||0);if(body.active!==undefined)p.active=body.active!==false&&body.active!=='false';p.updatedAt=now();await writeDb(db);return json(res,200,{promotion:p});}if(req.method==='DELETE'){db.promotions=db.promotions.filter(x=>x.id!==p.id);await writeDb(db);return json(res,200,{ok:true});}}
        if(url.pathname==='/api/admin/certificates' && req.method==='GET') return json(res,200,{certificates:db.certificates.slice().sort((a,b)=>new Date(b.issuedAt)-new Date(a.issuedAt)).map(c=>({id:c.id,...publicCertificate(db,c)}))});
        if(url.pathname==='/api/admin/emails' && req.method==='GET') return json(res,200,{emails:emailAdminPayload(db)});
        if(url.pathname==='/api/admin/analytics' && req.method==='GET') return json(res,200,adminAnalyticsPayload(db));
        if(url.pathname==='/api/admin/email/reminder' && req.method==='POST'){const body=await readBody(req);const student=db.users.find(u=>u.id===body.userId&&u.role==='student');const course=db.courses.find(c=>c.id===body.courseId);if(!student||!course)return json(res,404,{error:'Alumno o curso no encontrado'});const mail=queueEmail(db,{to:student.email,type:'reminder',userId:student.id,courseId:course.id});markLocalEmailsSent(db);await writeDb(db);return json(res,201,{email:mail});}

        if(url.pathname==='/api/admin/students' && req.method==='GET') return json(res,200,{students:studentsAdminPayload(db),courses:db.courses.map(c=>({id:c.id,title:c.title,slug:c.slug,status:c.status}))});
        const studentMatch=url.pathname.match(/^\/api\/admin\/student\/([^/]+)$/);
        if(studentMatch){
          const student=db.users.find(u=>u.id===studentMatch[1]&&u.role==='student');if(!student)return json(res,404,{error:'Alumno no encontrado'});
          if(req.method==='GET') return json(res,200,{student:studentAdminPayload(db,student)});
          if(req.method==='PUT'){const body=await readBody(req);student.firstName=cleanText(body.firstName??student.firstName,120);student.lastName=cleanText(body.lastName??student.lastName,120);if(body.email){const email=cleanText(body.email,220).toLowerCase();if(db.users.some(u=>u.id!==student.id&&u.email.toLowerCase()===email))return json(res,409,{error:'Ese email ya existe'});student.email=email;}if(['active','blocked'].includes(body.status))student.status=body.status;if(student.status==='blocked')db.sessions=db.sessions.filter(s=>s.userId!==student.id);await writeDb(db);return json(res,200,{student:studentAdminPayload(db,student)});}
        }
        const studentEnrollMatch=url.pathname.match(/^\/api\/admin\/student\/([^/]+)\/enrollment$/);
        if(studentEnrollMatch&&req.method==='POST'){const student=db.users.find(u=>u.id===studentEnrollMatch[1]&&u.role==='student');if(!student)return json(res,404,{error:'Alumno no encontrado'});const body=await readBody(req);const course=db.courses.find(c=>c.id===body.courseId);if(!course)return json(res,404,{error:'Curso no encontrado'});let e=db.enrollments.find(x=>x.userId===student.id&&x.courseId===course.id);if(e){e.status='active';e.enrolledAt=e.enrolledAt||now();}else{e={id:newId(),userId:student.id,courseId:course.id,status:'active',enrolledAt:now(),source:'manual'};db.enrollments.push(e);}db.activity.push({id:newId(),userId:student.id,type:'enrollment_created',label:`Matrícula manual: ${course.title}`,at:now()});await writeDb(db);return json(res,201,{enrollment:e});}
        const studentEnrollmentDelete=url.pathname.match(/^\/api\/admin\/student\/([^/]+)\/enrollment\/([^/]+)$/);
        if(studentEnrollmentDelete&&req.method==='DELETE'){const studentId=studentEnrollmentDelete[1],courseId=studentEnrollmentDelete[2];const e=db.enrollments.find(x=>x.userId===studentId&&x.courseId===courseId);if(!e)return json(res,404,{error:'Matrícula no encontrada'});e.status='inactive';await writeDb(db);return json(res,200,{ok:true});}
        const studentNoteMatch=url.pathname.match(/^\/api\/admin\/student\/([^/]+)\/note$/);
        if(studentNoteMatch&&req.method==='POST'){const student=db.users.find(u=>u.id===studentNoteMatch[1]&&u.role==='student');if(!student)return json(res,404,{error:'Alumno no encontrado'});const body=await readBody(req);const note=cleanText(body.note,3000);if(!note)return json(res,400,{error:'La nota está vacía'});const item={id:newId(),userId:student.id,note,createdAt:now(),authorId:user.id};db.studentNotes ||= [];db.studentNotes.push(item);await writeDb(db);return json(res,201,{note:item});}
        const studentResetMatch=url.pathname.match(/^\/api\/admin\/student\/([^/]+)\/course\/([^/]+)\/reset-progress$/);
        if(studentResetMatch&&req.method==='POST'){const studentId=studentResetMatch[1],courseId=studentResetMatch[2];const enrollment=db.enrollments.find(e=>e.userId===studentId&&e.courseId===courseId);if(!enrollment)return json(res,404,{error:'Matrícula no encontrada'});const lessonIds=db.lessons.filter(l=>l.courseId===courseId).map(l=>l.id);db.progress=db.progress.filter(p=>!(p.enrollmentId===enrollment.id&&lessonIds.includes(p.lessonId)));db.videoProgress=db.videoProgress.filter(v=>!(v.userId===studentId&&lessonIds.includes(v.lessonId)));const assessmentIds=db.assessments.filter(a=>(a.scopeType==='lesson'&&lessonIds.includes(a.scopeId))||(a.scopeType==='module'&&db.modules.some(m=>m.id===a.scopeId&&m.courseId===courseId))).map(a=>a.id);db.attempts=db.attempts.filter(a=>!(a.userId===studentId&&assessmentIds.includes(a.assessmentId)));await writeDb(db);return json(res,200,{ok:true});}

        if(url.pathname==='/api/admin/course' && req.method==='POST'){
          const body=await readBody(req); if(!cleanText(body.title,160)) return json(res,400,{error:'El título es obligatorio'});
          const id=newId(); const course={id,slug:uniqueSlug(db,body.slug||body.title),title:cleanText(body.title,160),subtitle:cleanText(body.subtitle,220),description:cleanText(body.description,5000),status:safeStatus(body.status),certificateEnabled:body.certificateEnabled!==false,priceCents:Math.max(0,Number(body.priceCents)||0),currency:cleanText(body.currency,3)||'EUR',saleEnabled:body.saleEnabled!==false,createdAt:now(),updatedAt:now()};
          db.courses.push(course); await writeDb(db); return json(res,201,{course});
        }
        const courseMatch=url.pathname.match(/^\/api\/admin\/course\/([^/]+)$/);
        if(courseMatch){
          const course=db.courses.find(c=>c.id===courseMatch[1]); if(!course)return json(res,404,{error:'Curso no encontrado'});
          if(req.method==='PUT'){const body=await readBody(req);course.title=cleanText(body.title||course.title,160);course.subtitle=cleanText(body.subtitle??course.subtitle,220);course.description=cleanText(body.description??course.description,5000);course.slug=uniqueSlug(db,body.slug||course.slug,course.id);course.status=safeStatus(body.status??course.status);course.certificateEnabled=body.certificateEnabled!==false;course.updatedAt=now();await writeDb(db);return json(res,200,{course});}
          if(req.method==='DELETE'){
            if(db.enrollments.some(e=>e.courseId===course.id)) return json(res,409,{error:'No se puede eliminar un curso con matrículas. Puedes despublicarlo.'});
            const lessonIds=db.lessons.filter(l=>l.courseId===course.id).map(l=>l.id);for(const l of db.lessons.filter(l=>lessonIds.includes(l.id)))for(const r of l.resources||[])await deleteResourceFile(r);
            const moduleIds=db.modules.filter(m=>m.courseId===course.id).map(m=>m.id);const assessmentIds=db.assessments.filter(a=>(a.scopeType==='module'&&moduleIds.includes(a.scopeId))||(a.scopeType==='lesson'&&lessonIds.includes(a.scopeId))).map(a=>a.id);db.questions=db.questions.filter(q=>!assessmentIds.includes(q.assessmentId));db.attempts=db.attempts.filter(a=>!assessmentIds.includes(a.assessmentId));db.assessments=db.assessments.filter(a=>!assessmentIds.includes(a.id));db.progress=db.progress.filter(p=>!lessonIds.includes(p.lessonId));db.lessons=db.lessons.filter(l=>l.courseId!==course.id);db.modules=db.modules.filter(m=>m.courseId!==course.id);db.courses=db.courses.filter(c=>c.id!==course.id);await writeDb(db);return json(res,200,{ok:true});
          }
        }

        if(url.pathname==='/api/admin/module' && req.method==='POST'){
          const body=await readBody(req); const course=db.courses.find(c=>c.id===body.courseId); if(!course)return json(res,404,{error:'Curso no encontrado'}); if(!cleanText(body.title,160))return json(res,400,{error:'El título es obligatorio'});
          const module={id:newId(),courseId:course.id,code:cleanText(body.code,24)||`M${positionOf(db.modules,m=>m.courseId===course.id)}`,title:cleanText(body.title,160),position:Number(body.position)||positionOf(db.modules,m=>m.courseId===course.id),status:safeStatus(body.status),createdAt:now(),updatedAt:now()};db.modules.push(module);course.updatedAt=now();await writeDb(db);return json(res,201,{module});
        }
        const moduleMatch=url.pathname.match(/^\/api\/admin\/module\/([^/]+)$/);
        if(moduleMatch){
          const module=db.modules.find(m=>m.id===moduleMatch[1]); if(!module)return json(res,404,{error:'Módulo no encontrado'});
          if(req.method==='PUT'){const body=await readBody(req);module.code=cleanText(body.code??module.code,24);module.title=cleanText(body.title||module.title,160);module.position=Math.max(1,Number(body.position)||module.position);module.status=safeStatus(body.status??module.status);module.updatedAt=now();const course=db.courses.find(c=>c.id===module.courseId);if(course)course.updatedAt=now();await writeDb(db);return json(res,200,{module});}
          if(req.method==='DELETE'){const lessonIds=db.lessons.filter(l=>l.moduleId===module.id).map(l=>l.id);for(const l of db.lessons.filter(l=>lessonIds.includes(l.id)))for(const r of l.resources||[])await deleteResourceFile(r);const assessmentIds=db.assessments.filter(a=>(a.scopeType==='module'&&a.scopeId===module.id)||(a.scopeType==='lesson'&&lessonIds.includes(a.scopeId))).map(a=>a.id);db.questions=db.questions.filter(q=>!assessmentIds.includes(q.assessmentId));db.attempts=db.attempts.filter(a=>!assessmentIds.includes(a.assessmentId));db.assessments=db.assessments.filter(a=>!assessmentIds.includes(a.id));db.progress=db.progress.filter(p=>!lessonIds.includes(p.lessonId));db.lessons=db.lessons.filter(l=>l.moduleId!==module.id);db.modules=db.modules.filter(m=>m.id!==module.id);await writeDb(db);return json(res,200,{ok:true});}
        }

        if(url.pathname==='/api/admin/lesson' && req.method==='POST'){
          const body=await readBody(req);const module=db.modules.find(m=>m.id===body.moduleId);if(!module)return json(res,404,{error:'Módulo no encontrado'});if(!cleanText(body.title,180))return json(res,400,{error:'El título es obligatorio'});
          const lesson={id:newId(),moduleId:module.id,courseId:module.courseId,code:cleanText(body.code,30)||`${module.code}.${positionOf(db.lessons,l=>l.moduleId===module.id)}`,title:cleanText(body.title,180),summary:cleanText(body.summary,5000),position:Number(body.position)||positionOf(db.lessons,l=>l.moduleId===module.id),status:safeStatus(body.status),durationMinutes:Math.max(1,Number(body.durationMinutes)||10),video:body.video?cleanText(body.video,1000):null,resources:[],tutorApproved:Boolean(body.tutorApproved),tutorContent:cleanText(body.tutorContent,20000),tutorApprovedAt:body.tutorApproved?now():null,createdAt:now(),updatedAt:now()};db.lessons.push(lesson);const course=db.courses.find(c=>c.id===module.courseId);if(course)course.updatedAt=now();await writeDb(db);return json(res,201,{lesson});
        }
        const lessonMatch=url.pathname.match(/^\/api\/admin\/lesson\/([^/]+)$/);
        if(lessonMatch){
          const lesson=db.lessons.find(l=>l.id===lessonMatch[1]);if(!lesson)return json(res,404,{error:'Clase no encontrada'});
          if(req.method==='PUT'){const body=await readBody(req);lesson.code=cleanText(body.code??lesson.code,30);lesson.title=cleanText(body.title||lesson.title,180);lesson.summary=cleanText(body.summary??lesson.summary,5000);lesson.position=Math.max(1,Number(body.position)||lesson.position);lesson.status=safeStatus(body.status??lesson.status);lesson.durationMinutes=Math.max(1,Number(body.durationMinutes)||lesson.durationMinutes);lesson.video=body.video===null?null:cleanText(body.video??lesson.video,1000)||null;if(body.tutorContent!==undefined)lesson.tutorContent=cleanText(body.tutorContent,20000);if(body.tutorApproved!==undefined){lesson.tutorApproved=Boolean(body.tutorApproved);lesson.tutorApprovedAt=lesson.tutorApproved?now():null;}lesson.updatedAt=now();const course=db.courses.find(c=>c.id===lesson.courseId);if(course)course.updatedAt=now();await writeDb(db);return json(res,200,{lesson});}
          if(req.method==='DELETE'){for(const r of lesson.resources||[])await deleteResourceFile(r);const assessmentIds=db.assessments.filter(a=>a.scopeType==='lesson'&&a.scopeId===lesson.id).map(a=>a.id);db.questions=db.questions.filter(q=>!assessmentIds.includes(q.assessmentId));db.attempts=db.attempts.filter(a=>!assessmentIds.includes(a.assessmentId));db.assessments=db.assessments.filter(a=>!assessmentIds.includes(a.id));db.progress=db.progress.filter(p=>p.lessonId!==lesson.id);db.videoProgress=db.videoProgress.filter(v=>v.lessonId!==lesson.id);db.lessons=db.lessons.filter(l=>l.id!==lesson.id);await writeDb(db);return json(res,200,{ok:true});}
        }


        if(url.pathname==='/api/admin/assessment' && req.method==='POST'){
          const body=await readBody(req);
          const scopeType=['lesson','module'].includes(body.scopeType)?body.scopeType:null;
          if(!scopeType) return json(res,400,{error:'Ámbito de evaluación no válido'});
          const scopeExists=scopeType==='lesson'?db.lessons.some(l=>l.id===body.scopeId):db.modules.some(m=>m.id===body.scopeId);
          if(!scopeExists) return json(res,404,{error:'Contenido asociado no encontrado'});
          if(assessmentForScope(db,scopeType,body.scopeId)) return json(res,409,{error:'Este contenido ya tiene una evaluación'});
          const assessment={id:newId(),scopeType,scopeId:body.scopeId,title:cleanText(body.title,180)||'Evaluación',instructions:cleanText(body.instructions,2000),passingScore:Math.min(100,Math.max(1,Number(body.passingScore)||80)),maxAttempts:Math.max(0,Number(body.maxAttempts)||3),status:safeStatus(body.status),createdAt:now(),updatedAt:now()};
          db.assessments.push(assessment);await writeDb(db);return json(res,201,{assessment});
        }
        const assessmentMatch=url.pathname.match(/^\/api\/admin\/assessment\/([^/]+)$/);
        if(assessmentMatch){
          const assessment=db.assessments.find(a=>a.id===assessmentMatch[1]);if(!assessment)return json(res,404,{error:'Evaluación no encontrada'});
          if(req.method==='PUT'){const body=await readBody(req);assessment.title=cleanText(body.title||assessment.title,180);assessment.instructions=cleanText(body.instructions??assessment.instructions,2000);assessment.passingScore=Math.min(100,Math.max(1,Number(body.passingScore)||assessment.passingScore));assessment.maxAttempts=Math.max(0,body.maxAttempts===undefined?assessment.maxAttempts:Number(body.maxAttempts));assessment.status=safeStatus(body.status??assessment.status);assessment.updatedAt=now();await writeDb(db);return json(res,200,{assessment});}
          if(req.method==='DELETE'){db.questions=db.questions.filter(q=>q.assessmentId!==assessment.id);db.attempts=db.attempts.filter(a=>a.assessmentId!==assessment.id);db.assessments=db.assessments.filter(a=>a.id!==assessment.id);await writeDb(db);return json(res,200,{ok:true});}
        }
        if(url.pathname==='/api/admin/question' && req.method==='POST'){
          const body=await readBody(req);const assessment=db.assessments.find(a=>a.id===body.assessmentId);if(!assessment)return json(res,404,{error:'Evaluación no encontrada'});
          const prompt=cleanText(body.prompt,2000);const options=Array.isArray(body.options)?body.options.map(x=>cleanText(x,700)).filter(Boolean).slice(0,6):[];
          if(!prompt||options.length<2)return json(res,400,{error:'La pregunta necesita enunciado y al menos 2 opciones'});
          const correctOption=Number(body.correctOption);if(!Number.isInteger(correctOption)||correctOption<0||correctOption>=options.length)return json(res,400,{error:'Respuesta correcta no válida'});
          const question={id:newId(),assessmentId:assessment.id,prompt,type:'single_choice',options,correctOption,explanation:cleanText(body.explanation,1500),position:Number(body.position)||positionOf(db.questions,q=>q.assessmentId===assessment.id),createdAt:now(),updatedAt:now()};db.questions.push(question);assessment.updatedAt=now();await writeDb(db);return json(res,201,{question});
        }
        const questionMatch=url.pathname.match(/^\/api\/admin\/question\/([^/]+)$/);
        if(questionMatch){
          const question=db.questions.find(q=>q.id===questionMatch[1]);if(!question)return json(res,404,{error:'Pregunta no encontrada'});
          if(req.method==='PUT'){const body=await readBody(req);question.prompt=cleanText(body.prompt||question.prompt,2000);if(Array.isArray(body.options)){const options=body.options.map(x=>cleanText(x,700)).filter(Boolean).slice(0,6);if(options.length<2)return json(res,400,{error:'Se requieren al menos 2 opciones'});question.options=options;}const correct=body.correctOption===undefined?question.correctOption:Number(body.correctOption);if(!Number.isInteger(correct)||correct<0||correct>=question.options.length)return json(res,400,{error:'Respuesta correcta no válida'});question.correctOption=correct;question.explanation=cleanText(body.explanation??question.explanation,1500);question.position=Math.max(1,Number(body.position)||question.position);question.updatedAt=now();await writeDb(db);return json(res,200,{question});}
          if(req.method==='DELETE'){db.questions=db.questions.filter(q=>q.id!==question.id);db.attempts=db.attempts.filter(a=>a.assessmentId!==question.assessmentId);await writeDb(db);return json(res,200,{ok:true});}
        }

        const certMatch=url.pathname.match(/^\/api\/admin\/certificate\/([^/]+)\/revoke$/);
        if(certMatch&&req.method==='POST'){const cert=db.certificates.find(c=>c.id===certMatch[1]);if(!cert)return json(res,404,{error:'Certificado no encontrado'});cert.status='revoked';cert.revokedAt=now();await writeDb(db);return json(res,200,{certificate:publicCertificate(db,cert)});}

        if(url.pathname==='/api/admin/video/upload-url' && req.method==='POST'){
          const body=await readBody(req);const lesson=db.lessons.find(l=>l.id===body.lessonId);if(!lesson)return json(res,404,{error:'Clase no encontrada'});
          const name=cleanText(body.name,220);const mime=cleanText(body.mime,120).toLowerCase();const size=Math.max(0,Number(body.size)||0);
          if(!name||!size)return json(res,400,{error:'Datos de vídeo incompletos'});
          if(!['video/mp4','video/webm','video/quicktime'].includes(mime))return json(res,415,{error:'Formato de vídeo no permitido'});
          if(size>MAX_VIDEO_BYTES)return json(res,413,{error:'El vídeo supera el límite de 1 GB por archivo'});
          const ext=path.extname(name).slice(0,10).replace(/[^.a-zA-Z0-9]/g,'')||'.mp4';
          const pathname=`videos/${lesson.id}/${newId()}${ext}`;
          const expiresAt=Date.now()+15*60*1000;
          const {issueSignedToken,presignUrl}=await import('@vercel/blob');
          const signedToken=await issueSignedToken({pathname,operations:['put'],validUntil:expiresAt});
          const signed=await presignUrl(signedToken,{pathname,operation:'put',access:'private',validUntil:expiresAt,allowedContentTypes:[mime],maximumSizeInBytes:MAX_VIDEO_BYTES,allowOverwrite:false});
          const ticket=signVideoUploadTicket({lessonId:lesson.id,pathname,name,mime,size,expiresAt});
          return json(res,200,{uploadUrl:signed.presignedUrl,ticket,expiresAt});
        }
        if(url.pathname==='/api/admin/video/complete' && req.method==='POST'){
          const body=await readBody(req);const claims=verifyVideoUploadTicket(body.ticket);if(!claims)return json(res,400,{error:'Carga de vídeo inválida o caducada'});
          const lesson=db.lessons.find(l=>l.id===claims.lessonId);if(!lesson)return json(res,404,{error:'Clase no encontrada'});
          const {issueSignedToken,presignUrl}=await import('@vercel/blob');
          const headExpiry=Date.now()+60*1000;
          const headToken=await issueSignedToken({pathname:claims.pathname,operations:['head'],validUntil:headExpiry});
          const headSigned=await presignUrl(headToken,{pathname:claims.pathname,operation:'head',access:'private',validUntil:headExpiry});
          const check=await fetch(headSigned.presignedUrl,{method:'HEAD'});
          if(!check.ok)return json(res,409,{error:'El archivo todavía no está disponible en Blob'});
          const storedSize=Number(check.headers.get('content-length')||0);
          if(storedSize&&Number(claims.size)&&storedSize!==Number(claims.size))return json(res,409,{error:'El tamaño almacenado no coincide con el archivo seleccionado'});
          if(String(lesson.video||'').startsWith('blob:')){const oldRef=String(lesson.video).slice(5);if(oldRef!==claims.pathname){try{await resourceStore.remove(oldRef);}catch{}}}
          lesson.video=`blob:${claims.pathname}`;lesson.videoMime=claims.mime;lesson.videoName=claims.name;lesson.videoSize=storedSize||Number(claims.size)||null;lesson.updatedAt=now();
          await writeDb(db);return json(res,201,{ok:true,video:{name:lesson.videoName,mime:lesson.videoMime,size:lesson.videoSize}});
        }

        if(url.pathname==='/api/admin/video' && req.method==='POST'){
          const body=await readBody(req);const lesson=db.lessons.find(l=>l.id===body.lessonId);if(!lesson)return json(res,404,{error:'Clase no encontrada'});
          const name=cleanText(body.name,220);const mime=cleanText(body.mime,120).toLowerCase();const data=String(body.dataBase64||'');
          if(!name||!data)return json(res,400,{error:'Vídeo incompleto'});
          if(!['video/mp4','video/webm','video/quicktime'].includes(mime))return json(res,415,{error:'Formato de vídeo no permitido'});
          const buf=Buffer.from(data,'base64');if(!buf.length||buf.length>MAX_TEST_VIDEO_BYTES)return json(res,413,{error:'El vídeo de prueba debe pesar como máximo 3 MB'});
          if(String(lesson.video||'').startsWith('blob:')){try{await resourceStore.remove(String(lesson.video).slice(5));}catch{}}
          const ext=path.extname(name).slice(0,10).replace(/[^.a-zA-Z0-9]/g,'')||'.mp4';
          const storageName=`videos/${newId()}${ext}`;const storageRef=await resourceStore.save(storageName,buf,mime);
          lesson.video=`blob:${storageRef}`;lesson.videoMime=mime;lesson.videoName=name;lesson.updatedAt=now();
          await writeDb(db);return json(res,201,{ok:true,video:{name,mime,size:buf.length}});
        }
        const videoDeleteMatch=url.pathname.match(/^\/api\/admin\/video\/([^/]+)$/);
        if(videoDeleteMatch&&req.method==='DELETE'){
          const lesson=db.lessons.find(l=>l.id===videoDeleteMatch[1]);if(!lesson)return json(res,404,{error:'Clase no encontrada'});
          if(String(lesson.video||'').startsWith('blob:')){try{await resourceStore.remove(String(lesson.video).slice(5));}catch{}}
          lesson.video=null;lesson.videoMime=null;lesson.videoName=null;lesson.updatedAt=now();await writeDb(db);return json(res,200,{ok:true});
        }

        if(url.pathname==='/api/admin/resource' && req.method==='POST'){
          const body=await readBody(req);const lesson=db.lessons.find(l=>l.id===body.lessonId);if(!lesson)return json(res,404,{error:'Clase no encontrada'});
          const name=cleanText(body.name,220); const mimeType=safeResourceMime(body.mime); const data=String(body.dataBase64||'');
          if(!name||!data)return json(res,400,{error:'Archivo incompleto'}); if(!mimeType)return json(res,415,{error:'Tipo de archivo no permitido'});
          const buf=Buffer.from(data,'base64'); if(!buf.length||buf.length>MAX_RESOURCE_BYTES)return json(res,413,{error:'El recurso supera el límite de 6 MB'});
          const ext=path.extname(name).slice(0,10).replace(/[^.a-zA-Z0-9]/g,''); const storageName=`${newId()}${ext}`;const storageRef=await resourceStore.save(storageName,buf,mimeType);
          const resource={id:newId(),name,mime:mimeType,size:buf.length,storageName:storageRef,createdAt:now()};lesson.resources ||= [];lesson.resources.push(resource);lesson.updatedAt=now();await writeDb(db);return json(res,201,{resource});
        }
        const resourceMatch=url.pathname.match(/^\/api\/admin\/resource\/([^/]+)$/);
        if(resourceMatch&&req.method==='DELETE'){const found=findResource(db,resourceMatch[1]);if(!found)return json(res,404,{error:'Recurso no encontrado'});await deleteResourceFile(found.resource);found.lesson.resources=found.lesson.resources.filter(r=>r.id!==found.resource.id);await writeDb(db);return json(res,200,{ok:true});}
      }
      return json(res,404,{error:'Endpoint no encontrado'});
    }
    if(await serveStatic(req,res)) return;
    text(res,404,'No encontrado');
  }catch(err){ logEvent('error','request_failed',{requestId:rid,method:req.method,path:String(req.url||'').split('?')[0],error:err instanceof Error?err.message:String(err),stack:IS_PROD?undefined:(err instanceof Error?err.stack:undefined)}); json(res,err.statusCode||500,{error:err.statusCode===413?err.message:'Error interno',detail:NODE_ENV==='development'?String(err):undefined}); }
};
if(!process.env.VERCEL){
  const server=http.createServer(handleRequest);
  server.requestTimeout=30_000; server.headersTimeout=35_000; server.keepAliveTimeout=5_000;
  server.listen(PORT,()=>logEvent('info','server_started',{port:PORT,env:NODE_ENV,dataDir:DATA_DIR,uploadDir:UPLOAD_DIR}));
}


export default handleRequest;
