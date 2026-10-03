import http from 'node:http';
import { readFile, writeFile, mkdir, stat, unlink, rename, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createPersistence } from './persistence.mjs';
import { createResourceStore } from './resource-store.mjs';
import { inspectEnvironment } from './scripts/env-requirements.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const NODE_ENV = process.env.NODE_ENV || 'development';
const ON_VERCEL = Boolean(process.env.VERCEL);
const VERCEL_ENV = process.env.VERCEL_ENV || '';
const IS_PROD = ON_VERCEL ? VERCEL_ENV === 'production' : NODE_ENV === 'production';
const IS_PREVIEW = ON_VERCEL && VERCEL_ENV === 'preview';
const ADMIN_EMAIL = process.env.LYKIOS_ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.LYKIOS_ADMIN_PASSWORD || '';
const IS_SECURE = IS_PROD || ON_VERCEL;
const APP_VERSION = process.env.LYKIOS_VERSION || '1.0.0-rc5';
const APP_ORIGIN = (ON_VERCEL && VERCEL_ENV !== 'production' && process.env.VERCEL_URL) ? `https://${process.env.VERCEL_URL}` : (process.env.LYKIOS_APP_ORIGIN || `http://localhost:${PORT}`);
const PUBLIC_APP_ORIGIN = (process.env.LYKIOS_PUBLIC_ORIGIN || process.env.LYKIOS_APP_ORIGIN || (IS_PREVIEW ? 'https://lykios-campus-git-preview-carlopsco-projects.vercel.app' : APP_ORIGIN)).replace(/\/$/,'');
const TRUST_PROXY = process.env.LYKIOS_TRUST_PROXY === '1';
const DATA_DIR = process.env.LYKIOS_DATA_DIR || (process.env.VERCEL ? '/tmp/lykios-data' : path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const STORAGE_BACKEND = process.env.LYKIOS_STORAGE_BACKEND || (ON_VERCEL || IS_PROD ? 'postgres' : 'json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const PAYMENT_PROVIDER = process.env.LYKIOS_PAYMENT_PROVIDER || (IS_PROD ? 'stripe' : 'mock');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const MAIL_FROM = process.env.LYKIOS_MAIL_FROM || 'campus@lykiosacademy.com';
const MAIL_FROM_NAME = process.env.LYKIOS_MAIL_FROM_NAME || 'Lykios Academy Campus';
const MAIL_REPLY_TO = process.env.LYKIOS_MAIL_REPLY_TO || 'info@lykiosacademy.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_API_BASE = 'https://api.resend.com';
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = process.env.LYKIOS_UPLOAD_DIR || (process.env.VERCEL ? '/tmp/lykios-uploads' : path.join(__dirname, 'uploads'));
const FILE_BACKEND = process.env.LYKIOS_FILE_BACKEND || (process.env.VERCEL ? 'blob' : 'fs');
const RESOURCE_BACKEND = (ON_VERCEL && STORAGE_BACKEND==='postgres') ? 'postgres' : FILE_BACKEND;
const VIDEO_PROVIDER = String(process.env.LYKIOS_VIDEO_PROVIDER || 'vercel').trim().toLowerCase();
const BUNNY_STREAM_LIBRARY_ID = String(process.env.BUNNY_STREAM_LIBRARY_ID || '').trim();
const BUNNY_STREAM_CDN_HOSTNAME = String(process.env.BUNNY_STREAM_CDN_HOSTNAME || '').trim();
const BUNNY_STREAM_API_KEY = String(process.env.BUNNY_STREAM_API_KEY || '').trim();
const BUNNY_STREAM_TOKEN_KEY = String(process.env.BUNNY_STREAM_TOKEN_KEY || '').trim();
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_JSON_BYTES = 9_000_000;
const MAX_RESOURCE_BYTES = 6_000_000;
const MAX_TEST_VIDEO_BYTES = 3_000_000;
const MAX_VIDEO_BYTES = 2_000_000_000;
const VIDEO_TOKEN_TTL_MS = 1000 * 60 * 10;
const MAX_STUDENT_SESSIONS = 2;
const VIDEO_LEASE_TTL_MS = 45 * 1000;
const SECURITY_SCORE_WINDOW_MS = 60 * 60 * 1000;
const SECURITY_HIGH_RISK_SCORE = 6;
const VIDEO_TOKEN_SECRET = process.env.LYKIOS_VIDEO_SECRET || (IS_PROD ? '' : crypto.randomBytes(32).toString('hex'));

if (ON_VERCEL) {
  const envCheck=inspectEnvironment(VERCEL_ENV||'preview');
  if(envCheck.status!=='GO'){
    const problems=[...envCheck.missing.map(x=>`falta ${x}`),...envCheck.invalid];
    throw new Error(`Configuración Vercel incompleta: ${problems.join('; ')}`);
  }
}

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
if(RESOURCE_BACKEND==='fs') await mkdir(UPLOAD_DIR, { recursive: true });

const persistence=createPersistence({backend:STORAGE_BACKEND,dataDir:DATA_DIR,dbFile:DB_FILE,databaseUrl:DATABASE_URL,log:logEvent});
await persistence.init();
const resourceStore=createResourceStore({backend:RESOURCE_BACKEND,uploadDir:UPLOAD_DIR,databaseUrl:DATABASE_URL});
await resourceStore.init();


const securityHeaders = {
  'x-content-type-options':'nosniff',
  'x-frame-options':'DENY',
  'referrer-policy':'strict-origin-when-cross-origin',
  'permissions-policy':'camera=(), microphone=(), geolocation=(), payment=(self)',
  'cross-origin-opener-policy':'same-origin',
  'cross-origin-resource-policy':'same-origin',
  'content-security-policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob: https://*.mediadelivery.net https://*.b-cdn.net; media-src 'self' blob: https://*.private.blob.vercel-storage.com https://*.mediadelivery.net https://*.b-cdn.net; frame-src https://player.mediadelivery.net https://iframe.mediadelivery.net; style-src 'self' 'unsafe-inline'; script-src 'self' https://assets.mediadelivery.net; connect-src 'self' https://*.private.blob.vercel-storage.com https://video.bunnycdn.com https://*.mediadelivery.net https://*.b-cdn.net"
};
if (IS_PROD) securityHeaders['strict-transport-security']='max-age=31536000; includeSubDomains';

function requestId(req){ return cleanText(req.headers['x-request-id'] || req.headers['x-vercel-id'] || crypto.randomUUID(),120); }
function logEvent(level,event,data={}){ console[level==='error'?'error':'log'](JSON.stringify({ts:new Date().toISOString(),level,event,version:APP_VERSION,...data})); }
function clientIp(req){
  if(ON_VERCEL||TRUST_PROXY){
    const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
    if(forwarded)return cleanText(forwarded,80);
    const real=String(req.headers['x-real-ip']||'').trim();
    if(real)return cleanText(real,80);
  }
  return cleanText(req.socket.remoteAddress||'unknown',80);
}
function maskIp(value){
  const ip=String(value||'unknown').trim();
  if(/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)){
    const p=ip.split('.'); return p.slice(0,3).join('.')+'.x';
  }
  if(ip.includes(':')){
    const p=ip.split(':').filter(Boolean); return p.slice(0,4).join(':')+'::/64';
  }
  return ip==='unknown'?'unknown':'red protegida';
}
function securityHash(value){
  return crypto.createHmac('sha256',VIDEO_TOKEN_SECRET||'lykios-preview-security').update(String(value||'')).digest('hex').slice(0,24);
}
function deviceLabelFromUa(ua=''){
  const value=String(ua||'');
  const browser=/Edg\//.test(value)?'Edge':/Chrome\//.test(value)?'Chrome':/Safari\//.test(value)&&!/Chrome\//.test(value)?'Safari':/Firefox\//.test(value)?'Firefox':'Navegador';
  const platform=/iPhone|iPad/.test(value)?'iPhone/iPad':/Android/.test(value)?'Android':/Macintosh|Mac OS X/.test(value)?'Mac':/Windows/.test(value)?'Windows':/Linux/.test(value)?'Linux':'Dispositivo';
  return browser+' · '+platform;
}
function requestSecurityContext(req){
  if(!req)return {deviceKey:null,deviceLabel:'Sesión web',ipHash:null,ipLabel:'unknown',userAgent:''};
  const rawDevice=cleanText(req.headers['x-lykios-device-id']||'',160);
  const ip=clientIp(req);
  const ua=cleanText(req.headers['user-agent']||'',500);
  return {
    deviceKey:rawDevice?crypto.createHash('sha256').update(rawDevice).digest('hex').slice(0,32):null,
    deviceLabel:deviceLabelFromUa(ua),
    ipHash:ip&&ip!=='unknown'?securityHash(ip):null,
    ipLabel:maskIp(ip),
    userAgent:ua
  };
}
function securityEvent(db,{userId,type,label,score=0,sessionId=null,deviceKey=null,deviceLabel=null,ipLabel=null,meta={},dedupeMinutes=0}){
  db.securityEvents ||= [];
  const cutoff=dedupeMinutes?Date.now()-dedupeMinutes*60*1000:0;
  if(dedupeMinutes){
    const duplicate=db.securityEvents.find(e=>e.userId===userId&&e.type===type&&String(e.deviceKey||'')===String(deviceKey||'')&&new Date(e.at).getTime()>=cutoff);
    if(duplicate)return null;
  }
  const item={id:newId(),userId,type,label:cleanText(label,300),score:Math.max(0,Number(score)||0),sessionId,deviceKey,deviceLabel:cleanText(deviceLabel||'',120)||null,ipLabel:cleanText(ipLabel||'',100)||null,meta,at:now()};
  db.securityEvents.push(item);
  if(db.securityEvents.length>5000)db.securityEvents=db.securityEvents.slice(-5000);
  return item;
}
function recentSecurityScore(db,userId,windowMs=SECURITY_SCORE_WINDOW_MS){
  const cutoff=Date.now()-windowMs;
  return (db.securityEvents||[]).filter(e=>e.userId===userId&&new Date(e.at).getTime()>=cutoff).reduce((n,e)=>n+(Number(e.score)||0),0);
}
function registerKnownDevice(db,user,ctx,{notify=true}={}){
  db.knownDevices ||= [];
  if(!ctx.deviceKey)return {device:null,isNew:false,networkChanged:false};
  let device=db.knownDevices.find(d=>d.userId===user.id&&d.deviceKey===ctx.deviceKey)||null;
  const isNew=!device;
  const networkChanged=Boolean(device?.lastIpHash&&ctx.ipHash&&device.lastIpHash!==ctx.ipHash);
  if(!device){
    device={id:newId(),userId:user.id,deviceKey:ctx.deviceKey,label:ctx.deviceLabel,firstSeenAt:now(),lastSeenAt:now(),lastIpHash:ctx.ipHash,lastIpLabel:ctx.ipLabel,status:'known'};
    db.knownDevices.push(device);
    securityEvent(db,{userId:user.id,type:'new_device',label:'Nuevo dispositivo: '+ctx.deviceLabel,score:1,deviceKey:ctx.deviceKey,deviceLabel:ctx.deviceLabel,ipLabel:ctx.ipLabel,dedupeMinutes:60});
    if(notify&&user.role==='student'&&user.lastLoginAt){
      queueEmail(db,{to:user.email,type:'new_device',userId:user.id,meta:{deviceLabel:ctx.deviceLabel,ipLabel:ctx.ipLabel}});
      markLocalEmailsSent(db);
    }
  }else{
    device.label=ctx.deviceLabel||device.label;
    device.lastSeenAt=now();
    if(networkChanged)securityEvent(db,{userId:user.id,type:'network_changed',label:'Cambio de red en '+ctx.deviceLabel,score:1,deviceKey:ctx.deviceKey,deviceLabel:ctx.deviceLabel,ipLabel:ctx.ipLabel,dedupeMinutes:60});
    device.lastIpHash=ctx.ipHash||device.lastIpHash;
    device.lastIpLabel=ctx.ipLabel||device.lastIpLabel;
  }
  return {device,isNew,networkChanged};
}
function currentSession(req,db){
  const sid=parseCookies(req).lykios_session;
  if(!sid)return null;
  const sidHash=sessionTokenHash(sid);
  return (db.sessions||[]).find(s=>(s.tokenHash===sidHash||s.token===sid)&&new Date(s.expiresAt)>new Date())||null;
}
function trimStudentSessions(db,user,keepSessionId=null){
  const t=Date.now();
  db.sessions=(db.sessions||[]).filter(s=>new Date(s.expiresAt).getTime()>t);
  if(user.role!=='student')return [];
  let rows=db.sessions.filter(s=>s.userId===user.id).sort((a,b)=>new Date(b.lastSeenAt||b.createdAt)-new Date(a.lastSeenAt||a.createdAt));
  const keep=new Set(rows.slice(0,MAX_STUDENT_SESSIONS).map(x=>x.id));
  if(keepSessionId)keep.add(keepSessionId);
  while(keep.size>MAX_STUDENT_SESSIONS){
    const removable=rows.slice().reverse().find(x=>keep.has(x.id)&&x.id!==keepSessionId);
    if(!removable)break;
    keep.delete(removable.id);
  }
  const evicted=rows.filter(x=>!keep.has(x.id));
  if(evicted.length){
    const ids=new Set(evicted.map(x=>x.id));
    db.sessions=db.sessions.filter(x=>!ids.has(x.id));
    evicted.forEach(x=>securityEvent(db,{userId:user.id,type:'session_limit',label:'Sesión antigua cerrada al superar el límite de 2 dispositivos',score:2,sessionId:x.id,deviceKey:x.deviceKey,deviceLabel:x.deviceLabel,ipLabel:x.ipLabel,dedupeMinutes:5}));
  }
  return evicted;
}
function createManagedSession(db,user,{req=null,context=null,source='login',notifyNewDevice=true}={}){
  db.sessions ||= [];
  const ctx=context||requestSecurityContext(req);
  registerKnownDevice(db,user,ctx,{notify:notifyNewDevice});
  if(user.role==='student'&&ctx.deviceKey){
    db.sessions=db.sessions.filter(s=>!(s.userId===user.id&&s.deviceKey===ctx.deviceKey));
  }
  const token=crypto.randomBytes(32).toString('base64url');
  const session={id:newId(),tokenHash:sessionTokenHash(token),userId:user.id,deviceKey:ctx.deviceKey,deviceLabel:ctx.deviceLabel,ipHash:ctx.ipHash,ipLabel:ctx.ipLabel,source,createdAt:now(),lastSeenAt:now(),expiresAt:new Date(Date.now()+SESSION_TTL_MS).toISOString()};
  db.sessions.push(session);
  trimStudentSessions(db,user,session.id);
  if(user.role==='student'&&recentSecurityScore(db,user.id)>=SECURITY_HIGH_RISK_SCORE){
    const event=securityEvent(db,{userId:user.id,type:'high_risk_login',label:'Actividad de acceso inusual detectada',score:0,sessionId:session.id,deviceKey:ctx.deviceKey,deviceLabel:ctx.deviceLabel,ipLabel:ctx.ipLabel,dedupeMinutes:60});
    db.sessions=db.sessions.filter(s=>s.userId!==user.id||s.id===session.id);
    if(event){
      queueEmail(db,{to:user.email,type:'security_alert',userId:user.id,meta:{deviceLabel:ctx.deviceLabel,ipLabel:ctx.ipLabel}});
      markLocalEmailsSent(db);
    }
  }
  return {token,session,context:ctx};
}
function releaseVideoLease(db,userId,sessionId){
  db.videoLeases ||= [];
  const before=db.videoLeases.length;
  db.videoLeases=db.videoLeases.filter(l=>!(l.userId===userId&&(sessionId==='*'||l.sessionId===sessionId)));
  return before!==db.videoLeases.length;
}
function acquireVideoLease(db,user,session,{lessonId,videoId,reserveMs=VIDEO_LEASE_TTL_MS}={}){
  db.videoLeases ||= [];
  const t=Date.now();
  db.videoLeases=db.videoLeases.filter(l=>new Date(l.expiresAt).getTime()>t);
  const other=db.videoLeases.find(l=>l.userId===user.id&&l.sessionId!==session.id);
  if(other){
    securityEvent(db,{userId:user.id,type:'simultaneous_video',label:'Reproducción simultánea detectada en otro dispositivo',score:4,sessionId:session.id,deviceKey:session.deviceKey,deviceLabel:session.deviceLabel,ipLabel:session.ipLabel,dedupeMinutes:2});
    return {ok:false,other};
  }
  let lease=db.videoLeases.find(l=>l.userId===user.id&&l.sessionId===session.id)||null;
  if(!lease){
    lease={id:newId(),userId:user.id,sessionId:session.id,lessonId,videoId,startedAt:now(),lastSeenAt:now(),expiresAt:new Date(t+reserveMs).toISOString()};
    db.videoLeases.push(lease);
  }else{
    lease.lessonId=lessonId;lease.videoId=videoId;lease.lastSeenAt=now();lease.expiresAt=new Date(t+reserveMs).toISOString();
  }
  return {ok:true,lease};
}
function enforceHighRiskAfterPlayback(db,user,session){
  if(user.role!=='student'||recentSecurityScore(db,user.id)<SECURITY_HIGH_RISK_SCORE)return false;
  const event=securityEvent(db,{userId:user.id,type:'high_risk_activity',label:'Patrón de acceso incompatible con uso personal',score:0,sessionId:session.id,deviceKey:session.deviceKey,deviceLabel:session.deviceLabel,ipLabel:session.ipLabel,dedupeMinutes:60});
  db.sessions=db.sessions.filter(s=>s.userId!==user.id||s.id===session.id);
  db.videoLeases=(db.videoLeases||[]).filter(l=>l.userId!==user.id||l.sessionId===session.id);
  if(event){
    queueEmail(db,{to:user.email,type:'security_alert',userId:user.id,meta:{deviceLabel:session.deviceLabel,ipLabel:session.ipLabel}});
    markLocalEmailsSent(db);
  }
  return Boolean(event);
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
  return `lykios_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAge)}; Priority=High${secure}`;
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


const PIEL_PERFECTA_STRUCTURE_VERSION = 1;
const PIEL_PERFECTA_STRUCTURE = [
  {
    code:'M0',
    title:'Módulo 0 · Bienvenida y punto de partida',
    description:'Orientación inicial para entender cómo funciona el curso, definir objetivos realistas y registrar el punto de partida antes de cambiar la rutina.',
    lessons:[
      {code:'0.1',title:'Bienvenido al curso',summary:'Presentación de Piel Perfecta 2.0 y de su idea central: menos ruido, más criterio. El alumno entiende qué va a aprender y por qué no necesita perseguir tendencias ni rutinas imposibles.',durationMinutes:3,plannedResources:['Guía práctica de inicio · Tu rutina de piel, con criterio']},
      {code:'0.2',title:'Cómo funciona y qué necesitas',summary:'Explica el recorrido del curso, cómo utilizar vídeos, materiales y ejercicios, y qué hace falta para avanzar. La indicación inicial es clara: empezar con lo que ya se tiene y no comprar por impulso.',durationMinutes:3,plannedResources:['Mapa del curso · 11 módulos y proyecto final']},
      {code:'0.3',title:'Tu punto de partida',summary:'Autobservación inicial: fotografía de referencia, objetivos realistas, hábitos actuales y compromiso mínimo. Sirve como línea de base para comparar el progreso al final del curso.',durationMinutes:3,plannedResources:['Cuaderno · Mi punto de partida','Ficha · Objetivos y fotografía inicial']}
    ]
  },
  {
    code:'M1',
    title:'Módulo 1 · Tu piel por dentro',
    description:'Bases sencillas para entender cómo funciona la piel y reconocer qué señales merece la pena observar antes de elegir productos.',
    lessons:[
      {code:'1.1',title:'La piel por dentro: cómo funciona',summary:'Una explicación accesible de la piel como órgano vivo: sus capas, sus funciones principales y por qué conocer lo básico cambia la forma de cuidarla.',durationMinutes:4,plannedResources:[]},
      {code:'1.2',title:'La barrera cutánea: la base del equilibrio',summary:'Qué es la barrera cutánea, qué factores pueden alterarla y por qué una rutina eficaz debe protegerla antes de añadir pasos o activos.',durationMinutes:4,plannedResources:[]},
      {code:'1.3',title:'Aprende a observar las señales de tu piel',summary:'Cómo observar confort, tirantez, brillo, descamación, sensibilidad y cambios sin convertir la observación en un autodiagnóstico médico.',durationMinutes:4,plannedResources:['Mapa de señales de tu piel']}
    ]
  },
  {
    code:'M2',
    title:'Módulo 2 · Tipo, estado y necesidades de la piel',
    description:'Distinguir lo relativamente estable de lo que cambia con el contexto para tomar decisiones más personalizadas y realistas.',
    lessons:[
      {code:'2.1',title:'Tipo de piel y estado de la piel',summary:'Diferencia entre tipo de piel, estado actual y necesidades concretas. El objetivo es evitar etiquetas rígidas y entender que la piel puede cambiar.',durationMinutes:4,plannedResources:[]},
      {code:'2.2',title:'Qué necesita tu piel hoy',summary:'Cómo relacionar las señales observadas con necesidades de limpieza, hidratación, protección o tratamiento, sin asumir que más productos significan mejor cuidado.',durationMinutes:4,plannedResources:[]},
      {code:'2.3',title:'Tu mapa personal de piel',summary:'Ejercicio práctico para reunir tipo, estado, señales, contexto y objetivos en una ficha sencilla que guiará las decisiones del resto del curso.',durationMinutes:4,plannedResources:['Ficha · Tipo, estado y necesidades','Cuaderno · Observación durante 7 días']}
    ]
  },
  {
    code:'M3',
    title:'Módulo 3 · Los tres pilares',
    description:'Construir una base simple y sostenible alrededor de tres funciones esenciales: limpiar, hidratar y proteger.',
    lessons:[
      {code:'3.1',title:'Limpiar sin agredir',summary:'Qué debe conseguir una buena limpieza, cómo adaptar frecuencia y textura y qué señales indican que la piel está quedando demasiado tirante o incómoda.',durationMinutes:4,plannedResources:[]},
      {code:'3.2',title:'Hidratar con sentido',summary:'Qué significa hidratar, cómo influye la barrera cutánea y por qué la textura y la tolerancia importan tanto como la promesa del producto.',durationMinutes:4,plannedResources:[]},
      {code:'3.3',title:'Proteger: fotoprotección diaria',summary:'La fotoprotección como tercer pilar de la rutina. Cómo integrarla de forma realista y elegir un formato que pueda utilizarse con constancia.',durationMinutes:4,plannedResources:['Checklist · Limpiar, hidratar y proteger','Plantilla · Rutina mínima mañana y noche']}
    ]
  },
  {
    code:'M4',
    title:'Módulo 4 · El arsenal cosmético',
    description:'Aprender a entender productos, etiquetas y activos para comprar por función y necesidad, no por promesas o tendencias.',
    lessons:[
      {code:'4.1',title:'Qué función cumple cada producto',summary:'Ordena el arsenal cosmético por función: limpiar, hidratar, proteger y tratar objetivos concretos. Ayuda a detectar duplicados y pasos innecesarios.',durationMinutes:4,plannedResources:[]},
      {code:'4.2',title:'Cómo leer una etiqueta sin perderte',summary:'Una forma práctica de leer nombre, función, modo de uso, advertencias y formulación sin perseguir cada ingrediente viral ni convertir la rutina en un examen de química.',durationMinutes:4,plannedResources:['Guía · Cómo leer un cosmético']},
      {code:'4.3',title:'Activos: menos, pero mejor elegidos',summary:'Qué es un activo cosmético, cómo relacionarlo con un objetivo y por qué conviene introducir cambios de uno en uno para poder evaluar tolerancia y respuesta.',durationMinutes:4,plannedResources:['Ficha · Decisión de compra por función','Checklist · Introducir un producto nuevo']}
    ]
  },
  {
    code:'M5',
    title:'Módulo 5 · Belleza desde dentro',
    description:'Poner la cosmética en contexto: alimentación, hidratación y hábitos diarios que acompañan a la piel sin promesas mágicas.',
    lessons:[
      {code:'5.1',title:'Alimentación y piel: lo que sí suma',summary:'Cómo encajar la alimentación dentro del cuidado global de la piel, con expectativas razonables y sin convertir alimentos concretos en tratamientos milagro.',durationMinutes:4,plannedResources:[]},
      {code:'5.2',title:'Hidratación y hábitos cotidianos',summary:'El papel de la hidratación, la regularidad y otros hábitos sencillos dentro de una estrategia de cuidado sostenible.',durationMinutes:4,plannedResources:[]},
      {code:'5.3',title:'Construye hábitos que puedas mantener',summary:'Pasar de consejos sueltos a decisiones realistas: escoger pocos hábitos, medir adherencia y ajustar sin buscar perfección.',durationMinutes:4,plannedResources:['Cuaderno · Hábitos que acompañan a tu piel']}
    ]
  },
  {
    code:'M6',
    title:'Módulo 6 · Piel y mente',
    description:'Entender cómo descanso, estrés, movimiento y bienestar pueden acompañar la respuesta de la piel y la constancia de la rutina.',
    lessons:[
      {code:'6.1',title:'Estrés y piel: una relación de ida y vuelta',summary:'Cómo el estrés y la percepción de la piel pueden influirse mutuamente y por qué el cuidado debe evitar convertirse en una fuente adicional de presión.',durationMinutes:4,plannedResources:[]},
      {code:'6.2',title:'Sueño y recuperación',summary:'El descanso como parte del contexto general del cuidado: observar patrones, reducir fricción en la rutina nocturna y priorizar constancia.',durationMinutes:4,plannedResources:[]},
      {code:'6.3',title:'Movimiento, bienestar y constancia',summary:'Cómo integrar actividad, pausas y autocuidado en una rutina que sea compatible con la vida real y pueda mantenerse en el tiempo.',durationMinutes:4,plannedResources:['Diario · Sueño, estrés, movimiento y piel']}
    ]
  },
  {
    code:'M7',
    title:'Módulo 7 · Rituales y sabiduría del mundo',
    description:'Explorar rituales de cuidado de distintas culturas con mirada crítica para rescatar ideas útiles, seguras y adaptables sin copiar tradiciones a ciegas.',
    lessons:[
      {code:'7.1',title:'Cuando el cuidado se convierte en ritual',summary:'El valor del ritual como pausa, disfrute y constancia. Diferencia entre una experiencia agradable y añadir pasos que la piel no necesita.',durationMinutes:4,plannedResources:[]},
      {code:'7.2',title:'La vuelta al mundo',summary:'Recorrido por rituales de cuidado conocidos en diferentes culturas: qué aportan, qué conviene contextualizar y qué ideas pueden adaptarse con sensatez.',durationMinutes:4,plannedResources:[]},
      {code:'7.3',title:'Diséñala (y hazla con cabeza)',summary:'Construcción de un ritual personal, breve y seguro que encaje con la rutina, el tiempo disponible y las preferencias del alumno.',durationMinutes:4,plannedResources:['Plantilla · Diseña tu ritual de cuidado']}
    ]
  },
  {
    code:'M8',
    title:'Módulo 8 · Maquillaje natural',
    description:'Utilizar el maquillaje como herramienta para realzar y expresar, no como obligación para esconder la piel.',
    lessons:[
      {code:'8.1',title:'Realza, no disfraza',summary:'Una filosofía de maquillaje natural centrada en realzar rasgos y respetar la piel, evitando la idea de que una piel real necesita ser ocultada.',durationMinutes:4,plannedResources:[]},
      {code:'8.2',title:'Textura, tono y equilibrio',summary:'Decisiones sencillas sobre preparación, base, acabado y equilibrio visual para conseguir un resultado natural sin acumular capas innecesarias.',durationMinutes:4,plannedResources:[]},
      {code:'8.3',title:'Tu maquillaje en 10 minutos',summary:'Rutina práctica y rápida de maquillaje natural, pensada para ser repetible y compatible con el cuidado previo de la piel.',durationMinutes:4,plannedResources:['Checklist · Maquillaje natural en 10 minutos']}
    ]
  },
  {
    code:'M9',
    title:'Módulo 9 · Cuidado en contexto',
    description:'Adaptar el cuidado cuando cambian el clima, los viajes, la exposición o la sensibilidad sin reconstruir toda la rutina desde cero.',
    lessons:[
      {code:'9.1',title:'Tu piel y el clima cambian juntos',summary:'Cómo frío, calor, viento, humedad, sol, aire seco, agua salada o cloro pueden cambiar las prioridades de la rutina.',durationMinutes:4,plannedResources:[]},
      {code:'9.2',title:'Tu piel viaja contigo',summary:'Cómo mantener la base —limpiar, hidratar y proteger— y ajustar texturas, cantidades y prioridades cuando cambia el entorno.',durationMinutes:4,plannedResources:[]},
      {code:'9.3',title:'Tu kit inteligente de viaje',summary:'Seleccionar lo realmente necesario para viajar, evitar duplicados y preparar una estrategia sencilla para vuelos, playa, montaña o cambios bruscos de clima.',durationMinutes:4,plannedResources:['Checklist · Kit inteligente de viaje','Ficha · Cómo adaptar tu rutina al clima']}
    ]
  },
  {
    code:'M10',
    title:'Módulo 10 · Tu Rutina Maestra',
    description:'Proyecto final que integra lo aprendido en una rutina personalizada, justificable, realista y flexible.',
    lessons:[
      {code:'10.1',title:'El proyecto final: tu Rutina Maestra',summary:'Reunir todas las piezas del curso y convertir conocimientos aislados en decisiones concretas para la propia piel, objetivos y contexto.',durationMinutes:4,plannedResources:[]},
      {code:'10.2',title:'Constrúyela paso a paso',summary:'Diseñar la rutina de mañana y de noche, elegir funciones y productos, definir frecuencia y prever cómo adaptarla cuando cambien las circunstancias.',durationMinutes:4,plannedResources:['Cuaderno · Tu Rutina Maestra']},
      {code:'10.3',title:'Evalúala y… ¡enhorabuena!',summary:'Revisar la Rutina Maestra con cuatro criterios: personalización, capacidad de justificar decisiones, integración de aprendizajes y sostenibilidad en la vida real.',durationMinutes:4,plannedResources:['Rúbrica · Evalúa tu Rutina Maestra','Checklist final · Antes y después']}
    ]
  }
];

function ensurePielPerfectaStructure(db){
  db.meta ||= {};
  const current=Number(db.meta.pielPerfectaStructureVersion)||0;
  if(current>=PIEL_PERFECTA_STRUCTURE_VERSION)return {changed:false,reason:'already_current'};
  const course=db.courses.find(c=>c.slug==='piel-perfecta-20');
  if(!course)return {changed:false,reason:'course_missing'};

  const t=now();
  let changed=false;
  Object.assign(course,{
    title:'Piel Perfecta 2.0',
    subtitle:'Entiende tu piel, elige con criterio y construye tu Rutina Maestra',
    description:'Curso online para público general que transforma el cuidado de la piel en decisiones sencillas, personalizadas y sostenibles. Incluye 11 módulos, materiales descargables, tests de repaso y proyecto final.',
    status:'draft',
    certificateEnabled:true,
    priceCents:3200,
    currency:'EUR',
    saleEnabled:false,
    sequentialAccess:true,
    updatedAt:t
  });
  changed=true;

  for(const [moduleIndex,definition] of PIEL_PERFECTA_STRUCTURE.entries()){
    let module=db.modules.find(m=>m.courseId===course.id&&m.code===definition.code);
    if(!module){
      module={id:newId(),courseId:course.id,code:definition.code,title:definition.title,description:definition.description,position:moduleIndex+1,status:'draft',createdAt:t,updatedAt:t};
      db.modules.push(module); changed=true;
    }else{
      Object.assign(module,{title:definition.title,description:definition.description,position:moduleIndex+1,status:'draft',updatedAt:t}); changed=true;
    }

    for(const [lessonIndex,definitionLesson] of definition.lessons.entries()){
      let lesson=db.lessons.find(l=>l.courseId===course.id&&l.code===definitionLesson.code);
      if(!lesson){
        lesson={
          id:newId(),moduleId:module.id,courseId:course.id,code:definitionLesson.code,title:definitionLesson.title,
          summary:definitionLesson.summary,position:lessonIndex+1,status:'draft',durationMinutes:definitionLesson.durationMinutes||4,
          video:null,videos:[],resources:[],plannedResources:definitionLesson.plannedResources||[],
          tutorApproved:false,tutorContent:'',tutorApprovedAt:null,createdAt:t,updatedAt:t
        };
        db.lessons.push(lesson); changed=true;
      }else{
        lesson.moduleId=module.id;
        lesson.title=definitionLesson.title;
        lesson.summary=definitionLesson.summary;
        lesson.position=lessonIndex+1;
        lesson.status='draft';
        lesson.durationMinutes=definitionLesson.durationMinutes||lesson.durationMinutes||4;
        lesson.plannedResources=definitionLesson.plannedResources||[];
        lesson.resources ||= [];
        lesson.videos ||= lesson.video?[{id:lesson.videoId||newId(),ref:lesson.video,name:lesson.videoName||'Vídeo 1',mime:lesson.videoMime||'video/mp4',size:lesson.videoSize||null,position:1,createdAt:lesson.updatedAt||lesson.createdAt||t}]:[];
        lesson.updatedAt=t;
        changed=true;
      }
    }
  }

  db.meta.pielPerfectaStructureVersion=PIEL_PERFECTA_STRUCTURE_VERSION;
  return {
    changed,
    courseId:course.id,
    moduleCount:PIEL_PERFECTA_STRUCTURE.length,
    lessonCount:PIEL_PERFECTA_STRUCTURE.reduce((n,m)=>n+m.lessons.length,0),
    status:course.status,
    saleEnabled:course.saleEnabled
  };
}



const PIEL_PERFECTA_EXTRAS_VERSION = 3;

const PIEL_PERFECTA_RESOURCE_BOOKLETS = {
  M0:{name:'Cuaderno 0 - Mi punto de partida.pdf',title:'Mi punto de partida',subtitle:'Piel Perfecta 2.0 - Modulo 0',intro:'Antes de cambiar tu rutina, registra como esta hoy tu piel, que usas y que quieres conseguir. No es un diagnostico medico: es una fotografia inicial para comparar tu progreso.',sections:[
    {heading:'1. Inventario actual',prompts:['¿Que productos utilizas por la mañana?','¿Que productos utilizas por la noche?','¿Hay productos que has comprado pero casi nunca utilizas?']},
    {heading:'2. Señales que observas',prompts:['¿Como se siente tu piel despues de limpiar?','¿Notas brillo, tirantez, descamacion, sensibilidad o cambios segun el dia?','¿Que situaciones parecen modificarla: clima, descanso, estres, ciclo, viajes?']},
    {heading:'3. Tus objetivos',prompts:['Escribe dos objetivos realistas para las proximas semanas.','Define un compromiso minimo que puedas mantener incluso en dias complicados.']},
    {heading:'4. Foto inicial',prompts:['Haz una fotografia con luz natural, sin filtros y, si es posible, sin maquillaje. Anota la fecha para compararla al final.']}
  ]},
  M1:{name:'Cuaderno 1 - Mapa de senales de tu piel.pdf',title:'Mapa de señales de tu piel',subtitle:'Piel Perfecta 2.0 - Modulo 1',intro:'La piel da informacion a traves de sensaciones y cambios visibles. Observa sin intentar etiquetar ni diagnosticar enfermedades.',sections:[
    {heading:'Confort',prompts:['¿Tu piel queda comoda despues de la limpieza?','¿Hay tirantez, picor o escozor repetido?']},
    {heading:'Aspecto',prompts:['¿Donde aparece brillo?','¿Hay zonas secas o descamacion?','¿Notas enrojecimiento o sensibilidad?']},
    {heading:'Contexto',prompts:['¿Que producto utilizaste antes del cambio?','¿Como estaban el clima, el descanso y el estres?']},
    {heading:'Regla de seguridad',prompts:['Si aparece dolor, hinchazon, ampollas, dificultad respiratoria o empeoramiento persistente, suspende el producto y busca valoracion sanitaria.']}
  ]},
  M2:{name:'Cuaderno 2 - Tipo estado y necesidades.pdf',title:'Tipo, estado y necesidades',subtitle:'Piel Perfecta 2.0 - Modulo 2',intro:'Separa lo relativamente estable de lo que puede cambiar. Tu rutina debe responder a la piel que tienes hoy, no solo a una etiqueta.',sections:[
    {heading:'Tipo de piel orientativo',prompts:['¿Tiende a sentirse seca, grasa, mixta o equilibrada?','¿En que zonas cambia mas?']},
    {heading:'Estado actual',prompts:['¿Esta mas sensible, deshidratada, reactiva, congestionada o estable que de costumbre?','¿Desde cuando?']},
    {heading:'Necesidades prioritarias',prompts:['Elige como maximo tres prioridades: limpiar, hidratar, proteger o tratar un objetivo concreto.','¿Cual es la prioridad numero uno esta semana?']},
    {heading:'Observacion durante 7 dias',prompts:['Registra una vez al dia sensacion, productos usados, contexto y respuesta. Busca patrones, no perfeccion.']}
  ]},
  M3:{name:'Cuaderno 3 - Rutina minima AM PM.pdf',title:'Rutina minima AM / PM',subtitle:'Piel Perfecta 2.0 - Modulo 3',intro:'Construye primero una base sencilla. Una rutina corta que utilizas con constancia suele aportar mas informacion que una rutina larga que cambia cada semana.',sections:[
    {heading:'Mañana',prompts:['1. Limpieza: ¿la necesitas y que producto toleras?','2. Hidratacion: ¿que textura te resulta comoda?','3. Proteccion: ¿que protector puedes usar y reaplicar?']},
    {heading:'Noche',prompts:['1. Limpieza: ¿retira bien protector y maquillaje?','2. Tratamiento opcional: un objetivo cada vez.','3. Hidratacion: ¿como queda la piel al finalizar?']},
    {heading:'Señales de ajuste',prompts:['¿Aparece tirantez, escozor, pesadez o sequedad persistente?','¿Que unico cambio probaras primero?']}
  ]},
  M4:{name:'Cuaderno 4 - Elegir cosmeticos con criterio.pdf',title:'Elegir cosméticos con criterio',subtitle:'Piel Perfecta 2.0 - Modulo 4',intro:'Compra por funcion y necesidad. Una buena decision empieza entendiendo para que sirve un producto, como se usa y como vas a evaluar si encaja contigo.',sections:[
    {heading:'Lee la etiqueta',prompts:['Producto y marca:','Funcion principal:','Modo de uso y frecuencia indicada:','Advertencias o precauciones:']},
    {heading:'Antes de comprar',prompts:['¿Ya tienes otro producto que cumple la misma funcion?','¿Encaja en tu presupuesto y en tu rutina real?','¿Sabes cuando y como lo vas a probar?']},
    {heading:'Activos',prompts:['¿Que objetivo concreto buscas?','Introduce un cambio cada vez y registra tolerancia y respuesta.']},
    {heading:'Ficha de decision',prompts:['Producto:','Funcion:','Como lo probare:','Que señal observable usare para decidir si me va bien:']}
  ]},
  M5:{name:'Cuaderno 5 - Habitos que acompanan a tu piel.pdf',title:'Hábitos que acompañan a tu piel',subtitle:'Piel Perfecta 2.0 - Modulo 5',intro:'La cosmética es una parte del cuidado. Alimentacion, hidratacion y regularidad pueden acompañar a la piel, pero no sustituyen tratamientos ni justifican promesas milagro.',sections:[
    {heading:'Alimentacion',prompts:['¿Tu alimentacion es variada y sostenible?','¿Que pequeño cambio realista puedes mantener esta semana?']},
    {heading:'Hidratacion',prompts:['¿Bebes de forma regular a lo largo del dia?','¿Hay momentos en los que sueles olvidarte?']},
    {heading:'Constancia',prompts:['Elige dos habitos que quieras mantener durante 14 dias.','¿Como los haras faciles de recordar?']},
    {heading:'Revision',prompts:['¿Que cambio fue facil?','¿Que cambio genero friccion y como puedes simplificarlo?']}
  ]},
  M6:{name:'Cuaderno 6 - Sueno estres movimiento y piel.pdf',title:'Sueño, estrés, movimiento y piel',subtitle:'Piel Perfecta 2.0 - Modulo 6',intro:'No se trata de controlar cada variable, sino de observar si descanso, estres y actividad cambian tu bienestar, tu adherencia a la rutina o como percibes tu piel.',sections:[
    {heading:'Registro breve',prompts:['Horas y calidad de sueño:','Nivel de estres percibido 0-10:','Movimiento o actividad del dia:','Como se sintio tu piel:']},
    {heading:'Patrones',prompts:['¿Hay dias en que abandonas la rutina por cansancio?','¿Que paso podrias simplificar para mantener lo esencial?']},
    {heading:'Plan realista',prompts:['Define una rutina nocturna minima para dias normales.','Define una version de emergencia para dias muy cansados.']}
  ]},
  M7:{name:'Cuaderno 7 - Disena tu ritual de cuidado.pdf',title:'Diseña tu ritual de cuidado',subtitle:'Piel Perfecta 2.0 - Modulo 7',intro:'Un ritual puede convertir el cuidado en una pausa agradable. La clave es que aporte bienestar sin añadir pasos innecesarios ni practicas agresivas.',sections:[
    {heading:'Lo que quieres sentir',prompts:['¿Buscas calma, energia, orden, disfrute o simplemente unos minutos para ti?']},
    {heading:'Tus elementos',prompts:['Elige un momento del dia.','Elige como maximo tres pasos de cuidado.','Añade un elemento no cosmetico si te ayuda: musica, respiracion, luz o silencio.']},
    {heading:'Filtro de sensatez',prompts:['¿Cada paso tiene una funcion o un motivo claro?','¿Hay algo que irrite, friccione o complique la rutina?','¿Podrias mantenerlo tres veces por semana?']}
  ]},
  M8:{name:'Cuaderno 8 - Maquillaje natural en 10 minutos.pdf',title:'Maquillaje natural en 10 minutos',subtitle:'Piel Perfecta 2.0 - Modulo 8',intro:'El objetivo no es esconder una piel real, sino realzar rasgos con el minimo de capas necesarias y respetando la preparacion previa.',sections:[
    {heading:'Preparacion',prompts:['¿La piel esta comoda e hidratada antes de maquillar?','¿Has dejado asentar el protector solar?']},
    {heading:'Cinco decisiones',prompts:['1. ¿Necesitas base completa o solo correccion puntual?','2. ¿Que acabado te resulta natural?','3. ¿Que rasgo quieres realzar?','4. ¿Que producto puedes omitir?','5. ¿Como lo retiraras al final del dia?']},
    {heading:'Tu version de 10 minutos',prompts:['Paso 1:','Paso 2:','Paso 3:','Paso 4:','Paso 5:']}
  ]},
  M9:{name:'Cuaderno 9 - Kit inteligente de viaje.pdf',title:'Kit inteligente de viaje',subtitle:'Piel Perfecta 2.0 - Modulo 9',intro:'Tu piel viaja contigo, pero el ambiente cambia. Conserva la base y adapta texturas, cantidades y prioridades sin llevar medio baño en la maleta.',sections:[
    {heading:'Destino',prompts:['Clima previsto: frio, calor, humedad, sequedad, viento o alta exposicion solar.','Duracion del viaje:','Actividades previstas: playa, nieve, vuelos, piscina, ciudad.']},
    {heading:'Imprescindibles',prompts:['Limpiador:','Hidratante:','Protector solar:','Tratamiento realmente necesario:']},
    {heading:'Plan de adaptacion',prompts:['¿Que textura cambiarias si el ambiente es mas seco?','¿Que haras si aumenta la sensibilidad?','¿Que producto puedes dejar en casa?']}
  ]},
  M10:{name:'Cuaderno 10 - Tu Rutina Maestra.pdf',title:'Tu Rutina Maestra',subtitle:'Piel Perfecta 2.0 - Proyecto final',intro:'Este es el resultado del curso: una rutina diseñada desde tu realidad, con decisiones que puedes explicar, mantener y adaptar.',sections:[
    {heading:'Rutina de mañana',prompts:['Paso / producto / funcion:','Paso / producto / funcion:','Paso / producto / funcion:','Tratamiento opcional y motivo:']},
    {heading:'Rutina de noche',prompts:['Paso / producto / funcion:','Paso / producto / funcion:','Paso / producto / funcion:','Tratamiento opcional y motivo:']},
    {heading:'Plan de adaptacion',prompts:['¿Que cambia con frio o sequedad?','¿Que cambia con calor o humedad?','¿Que simplificas en viajes o dias complicados?']},
    {heading:'Rubrica final',prompts:['Personalizacion: ¿responde a tu piel y objetivos?','Criterio: ¿puedes justificar para que sirve cada paso?','Integracion: ¿incorpora lo aprendido sin intentar incluirlo todo?','Sostenibilidad: ¿puedes mantenerla en tiempo, presupuesto y esfuerzo?']}
  ]}
};

const PIEL_PERFECTA_TESTS = {
  M1:[
    {prompt:'¿Cual es una funcion importante de la barrera cutanea?',options:['Ayudar a limitar la perdida de agua y proteger frente al entorno.','Cambiar el tipo de piel cada semana.','Eliminar la necesidad de protector solar.','Evitar cualquier sensacion en la piel.'],correctOption:0,explanation:'La barrera cutanea ayuda a mantener el equilibrio y a reducir la perdida de agua frente al entorno.'},
    {prompt:'¿Que enfoque es mas util al observar tu piel?',options:['Buscar patrones de sensaciones y cambios.','Diagnosticarte una enfermedad por una foto.','Cambiar varios productos a la vez.','Ignorar el contexto.'],correctOption:0,explanation:'Observar patrones y contexto ayuda a tomar decisiones sin convertir la observacion en autodiagnostico.'},
    {prompt:'Si un limpiador deja tirantez y escozor repetidos, ¿que conviene hacer?',options:['Revisar el producto o la forma de uso.','Duplicar la cantidad.','Añadir mas exfoliantes.','Mantenerlo siempre porque la tirantez es obligatoria.'],correctOption:0,explanation:'La tirantez o el escozor repetidos son señales para revisar la limpieza y la tolerancia.'},
    {prompt:'¿La piel debe entenderse como algo completamente aislado del entorno?',options:['No, puede responder al clima, productos y otros factores.','Si, nunca cambia con el contexto.','Solo cambia por la edad.','Solo cambia por el maquillaje.'],correctOption:0,explanation:'La piel responde a multiples factores y el contexto ayuda a interpretar cambios.'},
    {prompt:'Ante dolor intenso, hinchazon o ampollas tras un producto, la conducta prudente es:',options:['Suspenderlo y buscar valoracion sanitaria.','Aplicar mas cantidad.','Esperar indefinidamente.','Cubrirlo con maquillaje.'],correctOption:0,explanation:'Las reacciones intensas o persistentes requieren suspender el producto y valorar atencion sanitaria.'}
  ],
  M2:[
    {prompt:'¿Tipo de piel y estado de la piel significan exactamente lo mismo?',options:['No. El estado puede cambiar con el contexto.','Si, siempre son identicos.','Solo se diferencian por la edad.','Solo se diferencian en verano.'],correctOption:0,explanation:'El tipo describe tendencias generales; el estado puede variar con circunstancias y momentos.'},
    {prompt:'¿Que es mas util al elegir una rutina?',options:['Priorizar las necesidades actuales de la piel.','Copiar una rutina viral completa.','Comprar un producto para cada tendencia.','Cambiar todo cada semana.'],correctOption:0,explanation:'Las decisiones deben partir de necesidades reales y observables.'},
    {prompt:'¿Cuantas prioridades conviene intentar resolver al mismo tiempo al empezar?',options:['Pocas y claras.','Todas las posibles.','Ninguna durante meses.','Tantas como productos existan.'],correctOption:0,explanation:'Pocas prioridades facilitan evaluar la respuesta y mantener la rutina.'},
    {prompt:'¿Para que sirve un registro de varios dias?',options:['Para reconocer patrones y contexto.','Para obtener un diagnostico medico automatico.','Para demostrar que una marca es mejor.','Para evitar usar protector solar.'],correctOption:0,explanation:'El registro ayuda a observar tendencias y relacionarlas con productos y contexto.'},
    {prompt:'Si la piel cambia al viajar o con el clima, eso significa que:',options:['El estado puede modificarse aunque tus tendencias generales sean parecidas.','Tu tipo de piel ha desaparecido para siempre.','Necesitas cambiar toda la rutina.','Debes usar mas productos.'],correctOption:0,explanation:'El estado cutaneo puede cambiar sin que sea necesario reconstruir toda la rutina.'}
  ],
  M3:[
    {prompt:'¿Cuales son los tres pilares basicos del curso?',options:['Limpiar, hidratar y proteger.','Exfoliar, perfumar y cubrir.','Comprar, mezclar y cambiar.','Maquillar, exfoliar y broncear.'],correctOption:0,explanation:'La base propuesta es limpiar, hidratar y proteger.'},
    {prompt:'Una buena limpieza deberia:',options:['Retirar suciedad y productos sin dejar agresion repetida.','Dejar siempre la piel muy tirante.','Eliminar toda la grasa de la piel.','Necesitar varios limpiadores siempre.'],correctOption:0,explanation:'La limpieza debe ser eficaz y compatible con la tolerancia de la piel.'},
    {prompt:'¿Que criterio ayuda a elegir una hidratante?',options:['Una textura que puedas usar con constancia y toleres bien.','Que sea la mas cara.','Que tenga el envase mas grande.','Que prometa muchos resultados a la vez.'],correctOption:0,explanation:'La comodidad y la adherencia importan para mantener la hidratacion.'},
    {prompt:'En la rutina de mañana, el protector solar:',options:['Forma parte de la base de proteccion.','Solo se usa si llevas maquillaje.','Sustituye siempre a la limpieza.','No tiene relacion con el cuidado diario.'],correctOption:0,explanation:'La fotoproteccion completa la base de cuidado diario.'},
    {prompt:'Al construir una rutina nueva, ¿que estrategia facilita saber que funciona?',options:['Introducir cambios de uno en uno.','Cambiar cinco productos a la vez.','No observar ninguna respuesta.','Elegir solo por tendencias.'],correctOption:0,explanation:'Un cambio cada vez permite identificar mejor tolerancia y respuesta.'}
  ],
  M4:[
    {prompt:'Antes de comprar un cosmetico, la primera pregunta util es:',options:['¿Que funcion necesito cubrir?','¿Es viral?','¿Tiene el envase mas llamativo?','¿Lo usa una persona famosa?'],correctOption:0,explanation:'La funcion y la necesidad deben ir antes que la tendencia.'},
    {prompt:'¿Que informacion de una etiqueta resulta practica?',options:['Funcion, modo de uso y advertencias.','Solo el nombre comercial.','Solo el precio.','Solo el color del envase.'],correctOption:0,explanation:'La etiqueta debe ayudarte a entender que hace y como usar el producto.'},
    {prompt:'¿Es necesario perseguir cada ingrediente que se hace viral?',options:['No. Conviene relacionar ingredientes y productos con objetivos concretos.','Si, siempre.','Solo si es caro.','Solo durante el verano.'],correctOption:0,explanation:'El criterio parte de una necesidad, no de acumular ingredientes de moda.'},
    {prompt:'Al introducir un activo nuevo conviene:',options:['Probar un cambio cada vez y observar tolerancia.','Añadir varios activos nuevos el mismo dia.','Duplicar la frecuencia si pica.','Ignorar las instrucciones del producto.'],correctOption:0,explanation:'Cambios progresivos facilitan valorar tolerancia y respuesta.'},
    {prompt:'¿Que puede indicar que una compra es innecesaria?',options:['Ya tienes otro producto que cumple la misma funcion.','El producto tiene instrucciones claras.','Su textura te resulta comoda.','Puedes mantenerlo en tu presupuesto.'],correctOption:0,explanation:'Los duplicados de funcion son una fuente frecuente de acumulacion innecesaria.'}
  ],
  M5:[
    {prompt:'La alimentacion dentro del cuidado de la piel debe entenderse como:',options:['Parte de un enfoque global, sin promesas milagro.','Un sustituto universal del tratamiento medico.','La unica causa del estado de la piel.','Una forma de evitar el protector solar.'],correctOption:0,explanation:'La alimentacion acompaña al cuidado, pero no sustituye valoracion ni tratamiento cuando son necesarios.'},
    {prompt:'¿Que cambio suele ser mas sostenible?',options:['Uno pequeño que puedas mantener.','Cambiar toda tu alimentacion de un dia para otro.','Seguir una lista muy restrictiva sin motivo.','Buscar un alimento milagro.'],correctOption:0,explanation:'La sostenibilidad mejora cuando los cambios son realistas y mantenibles.'},
    {prompt:'¿Mas productos significa necesariamente mejor piel?',options:['No. La utilidad depende de la necesidad y la tolerancia.','Si, siempre.','Solo los fines de semana.','Solo si todos son de la misma marca.'],correctOption:0,explanation:'El curso prioriza decisiones y constancia por encima de acumular productos.'},
    {prompt:'Un habito util debe:',options:['Encajar en tu vida real.','Ser dificil para que funcione.','Cambiar cada dia.','Necesitar muchos productos.'],correctOption:0,explanation:'Un habito realista tiene mas posibilidades de mantenerse.'},
    {prompt:'¿Que es mas util al revisar un habito?',options:['Observar si lo mantienes y que friccion aparece.','Castigarte si un dia no lo cumples.','Duplicarlo al dia siguiente.','Cambiarlo antes de probarlo.'],correctOption:0,explanation:'La revision sirve para simplificar y mejorar adherencia, no para buscar perfeccion.'}
  ],
  M6:[
    {prompt:'El objetivo al observar estres y piel es:',options:['Reconocer patrones sin convertir el cuidado en otra fuente de presion.','Controlar cada variable de forma perfecta.','Culparte por cualquier cambio.','Eliminar todos los productos.'],correctOption:0,explanation:'La observacion debe aportar informacion y bienestar, no aumentar la presion.'},
    {prompt:'En dias de mucho cansancio puede ser util:',options:['Tener una version minima de la rutina.','Abandonar siempre el cuidado durante semanas.','Añadir mas pasos.','Probar varios activos nuevos.'],correctOption:0,explanation:'Una rutina minima ayuda a conservar lo esencial incluso en dias dificiles.'},
    {prompt:'¿Que variable puede influir en la constancia de una rutina?',options:['El descanso y el nivel de estres.','Solo el color del envase.','Solo el precio.','Ninguna.'],correctOption:0,explanation:'Descanso, estres y organizacion pueden afectar la adherencia.'},
    {prompt:'El movimiento y el bienestar se incluyen en el curso para:',options:['Integrar el cuidado en un contexto de vida real.','Prometer curar enfermedades cutaneas.','Sustituir la fotoproteccion.','Hacer la rutina mas larga.'],correctOption:0,explanation:'Se incorporan como contexto general de bienestar y sostenibilidad.'},
    {prompt:'¿Que es preferible?',options:['Una rutina realista y constante.','Una rutina perfecta que nunca puedes cumplir.','Cambiar de rutina cada dia.','Usar todos los productos disponibles.'],correctOption:0,explanation:'La constancia sostenible es uno de los principios centrales del curso.'}
  ],
  M7:[
    {prompt:'Un ritual de cuidado aporta valor cuando:',options:['Es agradable, seguro y compatible con las necesidades de la piel.','Incluye el mayor numero posible de pasos.','Copia cualquier tradicion sin contexto.','Produce irritacion para demostrar que funciona.'],correctOption:0,explanation:'El ritual debe aportar bienestar sin añadir agresion o complejidad innecesaria.'},
    {prompt:'Al conocer rituales de otras culturas conviene:',options:['Rescatar ideas utiles y adaptarlas con criterio.','Copiarlos literalmente siempre.','Asumir que todo lo tradicional es seguro.','Añadir todos los pasos a la vez.'],correctOption:0,explanation:'La adaptacion critica permite aprovechar ideas sin perder seguridad ni contexto.'},
    {prompt:'¿Que filtro ayuda a diseñar tu propio ritual?',options:['Preguntarte si cada paso tiene una funcion o un motivo claro.','Elegir solo por apariencia.','Añadir pasos hasta ocupar una hora.','Evitar cualquier rutina sencilla.'],correctOption:0,explanation:'Cada paso debe tener un motivo y encajar en tu realidad.'},
    {prompt:'Si un ritual genera irritacion repetida, conviene:',options:['Revisarlo y retirar el elemento problematico.','Mantenerlo porque es un ritual.','Aumentar la friccion.','Añadir un exfoliante.'],correctOption:0,explanation:'El disfrute nunca debe justificar practicas que la piel no tolera.'},
    {prompt:'La sostenibilidad de un ritual depende en parte de:',options:['Que puedas repetirlo sin demasiada friccion.','Que sea caro.','Que tenga muchos productos.','Que sea identico al de otra persona.'],correctOption:0,explanation:'Un ritual sostenible debe ser realista para tu tiempo y preferencias.'}
  ],
  M8:[
    {prompt:'La idea central del maquillaje natural en el curso es:',options:['Realzar, no esconder obligatoriamente la piel.','Cubrir toda textura visible.','Usar siempre una base de alta cobertura.','Añadir el mayor numero de capas.'],correctOption:0,explanation:'El maquillaje se plantea como una herramienta de expresion y realce.'},
    {prompt:'Antes de maquillar es util comprobar que:',options:['La piel esta comoda y la preparacion previa ha asentado.','La piel esta tirante.','Has usado muchos activos nuevos.','No has aplicado ningun cuidado.'],correctOption:0,explanation:'Una preparacion comoda facilita un acabado natural.'},
    {prompt:'Para un resultado natural suele ayudar:',options:['Usar solo la cobertura que realmente necesitas.','Cubrir siempre todo el rostro por igual.','No retirar el maquillaje por la noche.','Aplicar varias bases diferentes.'],correctOption:0,explanation:'La correccion selectiva puede reducir capas y mantener un resultado natural.'},
    {prompt:'¿Que pregunta encaja con el criterio del curso?',options:['¿Que producto puedo omitir sin perder el resultado que busco?','¿Como puedo añadir tres pasos mas?','¿Que tendencia debo copiar hoy?','¿Como oculto por completo mi piel?'],correctOption:0,explanation:'Simplificar es parte del criterio: cada producto debe tener una razon de estar.'},
    {prompt:'Al finalizar el dia, el maquillaje debe:',options:['Retirarse con una limpieza adecuada y tolerable.','Quedarse para proteger la piel.','Cubrirse con otra capa.','Retirarse siempre con friccion intensa.'],correctOption:0,explanation:'La limpieza nocturna debe retirar maquillaje y protector sin agresion innecesaria.'}
  ],
  M9:[
    {prompt:'Cuando cambia el clima, la mejor estrategia suele ser:',options:['Mantener la base y ajustar texturas, cantidades o prioridades.','Cambiar toda la rutina automaticamente.','Comprar una rutina nueva completa.','Eliminar la fotoproteccion.'],correctOption:0,explanation:'La base puede mantenerse mientras se ajustan detalles al nuevo entorno.'},
    {prompt:'¿Que factores ambientales pueden modificar como se siente la piel?',options:['Frio, calor, viento, humedad o aire seco.','Solo la hora del reloj.','Solo el maquillaje.','Ninguno.'],correctOption:0,explanation:'El ambiente puede cambiar confort, sequedad, sensibilidad y otras señales.'},
    {prompt:'Un kit inteligente de viaje debe:',options:['Incluir lo esencial y evitar duplicados.','Llevar todos tus productos.','Cambiar todos los productos habituales.','Excluir siempre el protector solar.'],correctOption:0,explanation:'Viajar es una buena oportunidad para simplificar a lo realmente necesario.'},
    {prompt:'La base que el curso mantiene durante los viajes es:',options:['Limpiar, hidratar y proteger.','Exfoliar, perfumar y cubrir.','Cambiar, acumular y experimentar.','Solo maquillar.'],correctOption:0,explanation:'Los tres pilares siguen siendo la referencia aunque cambie el contexto.'},
    {prompt:'Si durante un viaje la piel se vuelve mas sensible, conviene:',options:['Simplificar y priorizar tolerancia y proteccion.','Añadir varios activos nuevos.','Aumentar la friccion.','Ignorar las señales.'],correctOption:0,explanation:'Ante sensibilidad, simplificar ayuda a reducir variables y priorizar confort.'}
  ],
  M10:[
    {prompt:'¿Has construido por escrito tu rutina de mañana indicando la funcion de cada paso?',options:['Si, esta completa y puedo explicar cada paso.','Todavia no.'],correctOption:0,explanation:'La Rutina Maestra debe convertir lo aprendido en decisiones concretas y justificables.'},
    {prompt:'¿Has construido por escrito tu rutina de noche indicando la funcion de cada paso?',options:['Si, esta completa y puedo explicar cada paso.','Todavia no.'],correctOption:0,explanation:'La rutina nocturna debe tener una logica clara y adaptada a tus necesidades.'},
    {prompt:'¿Has revisado que no haya productos duplicados o pasos que no puedas justificar?',options:['Si, he simplificado lo innecesario.','Todavia no.'],correctOption:0,explanation:'Una Rutina Maestra prioriza criterio y evita acumular pasos sin una funcion clara.'},
    {prompt:'¿Has definido como adaptar tu rutina a viajes, cambios de clima o dias complicados?',options:['Si, tengo una version adaptable.','Todavia no.'],correctOption:0,explanation:'Una buena rutina debe poder adaptarse al contexto sin empezar de cero.'},
    {prompt:'¿Consideras que tu Rutina Maestra es realista para tu tiempo, presupuesto y constancia?',options:['Si, puedo mantenerla y revisarla con el tiempo.','Todavia no.'],correctOption:0,explanation:'El proyecto final se considera completo cuando la rutina es personalizada, justificable y sostenible.'}
  ]
};

async function pielPerfectaGeneratedPdf(def){
  const pdfLib=await import('pdf-lib');
  const PDFDocument=pdfLib.PDFDocument,StandardFonts=pdfLib.StandardFonts,rgb=pdfLib.rgb;
  const pdf=await PDFDocument.create();
  const regular=await pdf.embedFont(StandardFonts.Helvetica);
  const bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  const W=595.28,H=841.89,margin=46;
  const deep=rgb(0.02,0.24,0.28),teal=rgb(0.03,0.44,0.45),light=rgb(0.94,0.97,0.97),ink=rgb(0.04,0.16,0.18),muted=rgb(0.34,0.43,0.44);
  const wrap=(txt,font,size,maxWidth)=>{
    const words=String(txt||'').split(/\s+/).filter(Boolean),lines=[];let line='';
    for(const word of words){const trial=line?line+' '+word:word;if(!line||font.widthOfTextAtSize(trial,size)<=maxWidth)line=trial;else{lines.push(line);line=word;}}
    if(line)lines.push(line);return lines;
  };
  const newPage=()=>{
    const page=pdf.addPage([W,H]);
    page.drawRectangle({x:0,y:H-92,width:W,height:92,color:deep});
    page.drawRectangle({x:0,y:H-98,width:W,height:6,color:teal});
    page.drawText('LYKIOS ACADEMY',{x:margin,y:H-42,size:10,font:bold,color:rgb(1,1,1)});
    page.drawText(def.title,{x:margin,y:H-70,size:21,font:bold,color:rgb(1,1,1)});
    page.drawText(def.subtitle,{x:margin,y:H-84,size:9,font:regular,color:rgb(0.78,0.91,0.90)});
    page.drawText('Piel Perfecta 2.0 - Material educativo',{x:margin,y:24,size:8,font:regular,color:muted});
    return page;
  };
  let page=newPage(),y=H-128;
  const ensure=(needed=60)=>{if(y<margin+needed){page=newPage();y=H-128;}};
  const drawParagraph=(txt,size=10.2,color=ink,gap=14)=>{
    for(const line of wrap(txt,regular,size,W-margin*2)){ensure(22);page.drawText(line,{x:margin,y,size,font:regular,color});y-=gap;}
    y-=5;
  };
  drawParagraph(def.intro,10.5,ink,14.5);
  for(const section of def.sections||[]){
    ensure(90);
    page.drawRectangle({x:margin-6,y:y-6,width:W-margin*2+12,height:25,color:light});
    page.drawText(section.heading,{x:margin,y,size:12,font:bold,color:deep});
    y-=34;
    for(const prompt of section.prompts||[]){
      ensure(70);
      const lines=wrap(prompt,regular,10,W-margin*2);
      for(const line of lines){page.drawText(line,{x:margin,y,size:10,font:regular,color:ink});y-=13;}
      y-=7;
      for(let i=0;i<2;i++){ensure(18);page.drawLine({start:{x:margin,y},end:{x:W-margin,y},thickness:0.5,color:rgb(0.75,0.80,0.80)});y-=18;}
      y-=5;
    }
    y-=7;
  }
  return Buffer.from(await pdf.save());
}

function pielPerfectaTutorText(lesson,module){
  const safety='Este contenido es educativo para cuidado cosmético general. No diagnostica ni trata enfermedades dermatológicas. Ante dolor intenso, hinchazón, ampollas, dificultad respiratoria, lesiones que cambian o empeoramiento persistente, se debe suspender el producto implicado y buscar valoración sanitaria.';
  const principles='Principios del curso: observar antes de cambiar; simplificar; introducir cambios de uno en uno; priorizar limpieza, hidratación y fotoprotección; elegir productos por función y necesidad; adaptar la rutina al contexto; evitar promesas milagro y compras guiadas solo por tendencias.';
  return [module?.title||'',lesson.title,lesson.summary||'',principles,safety].filter(Boolean).join('\n');
}

function ensurePielPerfectaExtras(db){
  db.meta ||= {};
  const current=Number(db.meta.pielPerfectaExtrasVersion)||0;
  if(current>=PIEL_PERFECTA_EXTRAS_VERSION)return {changed:false,reason:'already_current'};
  const course=db.courses.find(c=>c.slug==='piel-perfecta-20');
  if(!course)return {changed:false,reason:'course_missing'};
  const t=now(); let changed=false; let resourceCount=0; let assessmentCount=0; let questionCount=0;

  for(const module of db.modules.filter(m=>m.courseId===course.id)){
    for(const lesson of db.lessons.filter(l=>l.moduleId===module.id)){
      lesson.tutorApproved=true;
      lesson.tutorContent=pielPerfectaTutorText(lesson,module);
      lesson.tutorApprovedAt=t;
      lesson.updatedAt=t;
      changed=true;
    }
    const def=PIEL_PERFECTA_RESOURCE_BOOKLETS[module.code];
    if(def){
      const lessons=db.lessons.filter(l=>l.moduleId===module.id).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0));
      const target=lessons[lessons.length-1];
      if(target){
        target.resources ||= [];
        const gkey='piel-perfecta:'+module.code;
        let resource=target.resources.find(r=>r.generatedKey===gkey);
        if(!resource){
          resource={id:newId(),name:def.name,mime:'application/pdf',size:null,generatedKey:gkey,createdAt:t};
          target.resources.push(resource);changed=true;
        }else{
          resource.name=def.name;resource.mime='application/pdf';changed=true;
        }
        resourceCount++;
      }
    }

    const questions=PIEL_PERFECTA_TESTS[module.code];
    if(questions?.length){
      const lessons=db.lessons.filter(l=>l.moduleId===module.id).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0));
      const target=lessons[lessons.length-1];
      if(target){
        const moduleAssessment=assessmentForScope(db,'module',module.id);
        let assessment=assessmentForScope(db,'lesson',target.id);
        if(moduleAssessment&&!assessment){
          moduleAssessment.scopeType='lesson';
          moduleAssessment.scopeId=target.id;
          assessment=moduleAssessment;
          changed=true;
        }else if(moduleAssessment&&assessment&&moduleAssessment.id!==assessment.id){
          const doomed=moduleAssessment.id;
          db.questions=db.questions.filter(q=>q.assessmentId!==doomed);
          db.attempts=db.attempts.filter(a=>a.assessmentId!==doomed);
          db.assessments=db.assessments.filter(a=>a.id!==doomed);
          changed=true;
        }
        const shortTitle=module.title.replace(/^Módulo \d+ · /,'');
        const isFinalProject=module.code==='M10';
        const testTitle=isFinalProject?'Proyecto final · Tu Rutina Maestra':'Test '+module.code.replace('M','')+' - '+shortTitle;
        const instructions=isFinalProject?'Completa primero el cuaderno Tu Rutina Maestra. Después confirma estos cinco criterios. Debes cumplirlos todos para cerrar el proyecto final.':'5 preguntas sencillas de repaso. Selecciona una sola respuesta en cada pregunta.';
        const passingScore=isFinalProject?100:80;
        const maxAttempts=isFinalProject?0:3;
        if(!assessment){
          assessment={id:newId(),scopeType:'lesson',scopeId:target.id,title:testTitle,instructions,passingScore,maxAttempts,status:'draft',createdAt:t,updatedAt:t};
          db.assessments.push(assessment);changed=true;
        }else{
          assessment.scopeType='lesson';assessment.scopeId=target.id;assessment.title=testTitle;
          assessment.instructions=instructions;
          assessment.passingScore=passingScore;assessment.maxAttempts=maxAttempts;assessment.status='draft';assessment.updatedAt=t;changed=true;
        }
        db.questions=db.questions.filter(q=>q.assessmentId!==assessment.id);
        questions.forEach((q,i)=>db.questions.push({id:newId(),assessmentId:assessment.id,prompt:q.prompt,type:'single_choice',options:q.options,correctOption:q.correctOption,explanation:q.explanation,position:i+1,createdAt:t,updatedAt:t}));
        assessmentCount++;questionCount+=questions.length;changed=true;
      }
    }
  }
  db.meta.pielPerfectaExtrasVersion=PIEL_PERFECTA_EXTRAS_VERSION;
  return {changed,courseId:course.id,resourceCount,assessmentCount,questionCount};
}

function passwordPolicy(password){
  const value=String(password||'');
  if(value.length<12) return 'La contraseña debe tener al menos 12 caracteres';
  if(value.length>128) return 'La contraseña es demasiado larga';
  return null;
}
function hashPassword(password, salt=crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expected) {
  try{
    if(!salt||!expected||!/^[0-9a-f]{64}$/i.test(String(expected))) return false;
    const actual = crypto.pbkdf2Sync(String(password||''), String(salt), 210000, 32, 'sha256');
    return crypto.timingSafeEqual(actual, Buffer.from(String(expected), 'hex'));
  }catch{return false}
}
function resetTokenHash(token){return crypto.createHash('sha256').update(String(token||'')).digest('hex')}
function sessionTokenHash(token){return crypto.createHash('sha256').update(String(token||'')).digest('hex')}
function accountLoginBlocked(user){return Boolean(user?.loginLockedUntil&&new Date(user.loginLockedUntil)>new Date())}
function recordFailedLogin(user){
  if(!user)return;
  const t=Date.now(),windowMs=15*60*1000;
  const started=user.failedLoginWindowStartedAt?new Date(user.failedLoginWindowStartedAt).getTime():0;
  if(!started||t-started>windowMs){user.failedLoginCount=1;user.failedLoginWindowStartedAt=new Date(t).toISOString();}
  else user.failedLoginCount=(Number(user.failedLoginCount)||0)+1;
  if((Number(user.failedLoginCount)||0)>=8) user.loginLockedUntil=new Date(t+15*60*1000).toISOString();
}
function clearFailedLogin(user){
  if(!user)return;
  user.failedLoginCount=0;user.failedLoginWindowStartedAt=null;user.loginLockedUntil=null;
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
  if ((db.meta?.schemaVersion||1) < 14) {
    db.lessons.forEach(l=>{
      if(!Array.isArray(l.videos)){
        l.videos=l.video?[{id:l.videoId||newId(),ref:l.video,name:l.videoName||'Vídeo 1',mime:l.videoMime||'video/mp4',size:l.videoSize||null,position:1,createdAt:l.updatedAt||l.createdAt||now()}]:[];
      }
      syncPrimaryVideoFields(l);
      const first=l.videos[0];
      if(first) db.videoProgress.filter(v=>v.lessonId===l.id&&!v.videoId).forEach(v=>{v.videoId=first.id;});
    });
    db.meta.schemaVersion=14; changed=true;
  }
  if ((db.meta?.schemaVersion||1) < 15) {
    const course11=db.courses.find(c=>c.slug==='peeling-quimico');
    const lesson11=course11?db.lessons.find(l=>l.courseId===course11.id&&l.code==='1.1'):null;
    if(lesson11&&!assessmentForScope(db,'lesson',lesson11.id)){
      const assessment={id:newId(),scopeType:'lesson',scopeId:lesson11.id,title:'Evaluación 1.1 · Anatomía e histología cutánea',instructions:'Selecciona una sola respuesta en cada pregunta. Cada acierto vale 1 punto.',passingScore:80,maxAttempts:3,status:'published',createdAt:now(),updatedAt:now()};
      db.assessments.push(assessment);
      const seedQuestions=[
        {prompt:'¿Cuál es la capa más superficial de la piel?',options:['Dermis.','Epidermis.','Hipodermis.','Tejido muscular.'],correctOption:1,explanation:'La epidermis es la capa más superficial de la piel.'},
        {prompt:'¿Qué células producen la melanina?',options:['Fibroblastos.','Células de Merkel.','Melanocitos.','Células de Langerhans.'],correctOption:2,explanation:'Los melanocitos producen melanina y transfieren melanosomas a los queratinocitos.'},
        {prompt:'¿Cuál de estas afirmaciones sobre la epidermis es correcta?',options:['No contiene vasos sanguíneos.','Está formada principalmente por tejido adiposo.','Se encuentra debajo de la dermis.','Carece de terminaciones nerviosas.'],correctOption:0,explanation:'La epidermis es avascular; recibe nutrientes por difusión desde la dermis.'},
        {prompt:'¿A qué capa pertenece el estrato basal?',options:['A la dermis papilar.','A la dermis reticular.','A la hipodermis.','A la epidermis.'],correctOption:3,explanation:'El estrato basal es la zona más profunda de la epidermis.'},
        {prompt:'¿Qué estructuras pueden aportar células para recuperar la superficie cutánea después de una lesión?',options:['Los adipocitos de la hipodermis.','Los epitelios conservados de la epidermis y de los anexos.','Las fibras de colágeno de la dermis.','El músculo erector del pelo.'],correctOption:1,explanation:'Los epitelios que permanecen viables en la epidermis y en los anexos pueden contribuir a la reepitelización.'}
      ];
      seedQuestions.forEach((q,i)=>db.questions.push({id:newId(),assessmentId:assessment.id,prompt:q.prompt,type:'single_choice',options:q.options,correctOption:q.correctOption,explanation:q.explanation,position:i+1,createdAt:now(),updatedAt:now()}));
      reconcileLessonForStudents(db,lesson11);
    }
    db.meta.schemaVersion=15; changed=true;
  }
  if ((db.meta?.schemaVersion||1) < 16) {
    db.users.forEach(u=>{if(u.failedLoginCount===undefined)u.failedLoginCount=0;if(u.failedLoginWindowStartedAt===undefined)u.failedLoginWindowStartedAt=null;if(u.loginLockedUntil===undefined)u.loginLockedUntil=null;if(u.passwordResetLastSentAt===undefined)u.passwordResetLastSentAt=null;});
    db.passwordResetTokens=(db.passwordResetTokens||[]).filter(t=>!t.usedAt&&new Date(t.expiresAt)>new Date());
    const demoEmails=new Set(['alumno@lykiosacademy.com','profesor@lykiosacademy.com']);
    for(const u of db.users){if((IS_PREVIEW||IS_PROD)&&demoEmails.has(String(u.email||'').toLowerCase())){u.status='blocked';db.sessions=db.sessions.filter(s=>s.userId!==u.id);}}
    db.meta.schemaVersion=16; changed=true;
  }
  if ((db.meta?.schemaVersion||1) < 17) {
    db.courses.forEach(c=>{if(c.sequentialAccess===undefined)c.sequentialAccess=c.slug==='peeling-quimico';});
    db.meta.schemaVersion=17; changed=true;
  }
  if ((db.meta?.schemaVersion||1) < 18) {
    db.sessions=(db.sessions||[]).map(s=>{
      if(!s.tokenHash&&s.token)s.tokenHash=sessionTokenHash(s.token);
      const next={...s}; delete next.token; return next;
    });
    db.meta.schemaVersion=18; changed=true;
  }
  if ((db.meta?.schemaVersion||1) < 19) {
    const emptyCourseIds=new Set();
    for(const course of db.courses){
      const publishedModuleIds=db.modules.filter(m=>m.courseId===course.id&&m.status==='published').map(m=>m.id);
      const publishedLessons=db.lessons.filter(l=>l.courseId===course.id&&l.status==='published'&&publishedModuleIds.includes(l.moduleId));
      const publishedLessonIds=publishedLessons.map(l=>l.id);
      const publishedAssessments=db.assessments.filter(a=>a.status==='published'&&((a.scopeType==='module'&&publishedModuleIds.includes(a.scopeId))||(a.scopeType==='lesson'&&publishedLessonIds.includes(a.scopeId))));
      if(publishedLessons.length===0&&publishedAssessments.length===0)emptyCourseIds.add(course.id);
    }
    for(const cert of db.certificates||[]){
      if(emptyCourseIds.has(cert.courseId)&&(cert.status||'valid')!=='revoked'){
        cert.status='revoked';
        cert.revokedAt=now();
        cert.revocationReason='Curso sin requisitos publicados';
        changed=true;
      }
    }
    for(const item of db.emailOutbox||[]){
      if(emptyCourseIds.has(item.courseId)&&['certificate','course_completed'].includes(item.type)&&['queued','sending'].includes(item.status)){
        item.status='cancelled';
        item.cancelledAt=now();
        item.lastError='Cancelado: curso sin requisitos publicados';
        changed=true;
      }
    }
    db.meta.schemaVersion=19; changed=true;
  }
  if ((db.meta?.schemaVersion||1) < 20) {
    db.knownDevices ||= [];
    db.securityEvents ||= [];
    db.videoLeases ||= [];
    db.sessions=(db.sessions||[]).map(row=>({
      ...row,
      deviceKey:row.deviceKey||null,
      deviceLabel:row.deviceLabel||'Sesión anterior',
      ipHash:row.ipHash||null,
      ipLabel:row.ipLabel||null,
      source:row.source||'legacy',
      lastSeenAt:row.lastSeenAt||row.createdAt||now()
    }));
    db.meta.schemaVersion=20; changed=true;
  }
  if (db.meta?.tutorPolicy) { const days=Math.max(0,Number(db.meta.tutorPolicy.retainQueriesDays)||0); if(days>0 && Array.isArray(db.tutorQueries)){ const cutoff=Date.now()-days*86400000; const before=db.tutorQueries.length; db.tutorQueries=db.tutorQueries.filter(q=>new Date(q.createdAt).getTime()>=cutoff); if(db.tutorQueries.length!==before) changed=true; } }
  if(IS_PREVIEW){
    const pp=ensurePielPerfectaStructure(db);
    if(pp.changed){changed=true;logEvent('info','piel_perfecta_structure_ready',pp);}
  }
  if(IS_PREVIEW){
    const px=ensurePielPerfectaExtras(db);
    if(px.changed){changed=true;logEvent('info','piel_perfecta_extras_ready',px);}
  }
  if(changed) await writeDb(db);
  return db;
}
let dbWriteChain = Promise.resolve();
async function writeDb(db){
  const expected=Number.isFinite(db.__storageVersion)?db.__storageVersion:null;
  dbWriteChain=dbWriteChain.catch(()=>{}).then(async()=>{
    // Primero confirma el estado. Ningún efecto externo debe ocurrir si esta
    // escritura pierde una carrera contra otra instancia serverless.
    const next=await persistence.save(db,expected);
    Object.defineProperty(db,'__storageVersion',{value:next,writable:true,enumerable:false,configurable:true});

    // Después procesa el outbox. Los envíos usan una clave de idempotencia
    // basada en email.id, por lo que un reintento no duplica el mensaje.
    try{
      const mailResult=await flushEmailOutbox(db);
      const mailChanged=(Number(mailResult?.sent)||0)+(Number(mailResult?.failed)||0)+(Number(mailResult?.deferred)||0)>0;
      if(mailChanged){
        try{
          const finalVersion=await persistence.save(db,next);
          Object.defineProperty(db,'__storageVersion',{value:finalVersion,writable:true,enumerable:false,configurable:true});
        }catch(error){
          if(error?.code==='STORAGE_CONFLICT'){
            logEvent('warn','email_outbox_status_persist_deferred',{reason:'storage_conflict'});
          }else{
            logEvent('error','email_outbox_status_persist_failed',{error:error?.message||String(error)});
          }
        }
      }
    }catch(error){
      logEvent('error','email_outbox_flush_failed',{error:error?.message||String(error)});
    }
  });
  return dbWriteChain;
}

async function seedDb(){
  if(!ADMIN_EMAIL||!ADMIN_PASSWORD) throw new Error('Se requieren LYKIOS_ADMIN_EMAIL y LYKIOS_ADMIN_PASSWORD para inicializar el Campus');
  const adminPass = hashPassword(ADMIN_PASSWORD);
  const manifest = JSON.parse(await readFile(path.join(__dirname,'content','peeling-quimico.json'),'utf8'));
  const course = manifest.course;
  const courseId = newId();
  const modules = course.modules.map(m=>({ id:newId(), courseId, code:m.code, title:m.title, position:m.position, status:'published', createdAt:now(), updatedAt:now() }));
  const lessons = [];
  for (const m of course.modules) {
    const mod = modules.find(x=>x.code===m.code);
    m.lessons.forEach((l,idx)=>lessons.push({ id:newId(), moduleId:mod.id, courseId, code:l.code, title:l.title, summary:'', position:idx+1, status:l.status==='production'?'draft':'published', durationMinutes:12, video:null, videos:[], resources:[], tutorApproved:true, tutorContent:'', tutorApprovedAt:now(), createdAt:now(), updatedAt:now() }));
  }
  const adminId = newId();
  const db = {
    meta:{ schemaVersion:19, createdAt:now(), app:'Lykios LMS', tutorPolicy:{retainQueriesDays:30,storeQuestionText:true,feedbackEnabled:true} },
    users:[
      { id:adminId, email:String(ADMIN_EMAIL).toLowerCase(), firstName:'Lykios', lastName:'Admin', role:'admin', status:'active', lastLoginAt:null, failedLoginCount:0, failedLoginWindowStartedAt:null, loginLockedUntil:null, passwordResetLastSentAt:null, passwordSalt:adminPass.salt, passwordHash:adminPass.hash, createdAt:now() }
    ],
    sessions:[],
    courses:[{ id:courseId, slug:'peeling-quimico', title:course.title, subtitle:course.subtitle, description:'Curso clínico avanzado, estructurado por módulos, con progreso y evaluación.', status:'published', certificateEnabled:true, sequentialAccess:true, priceCents:4900, currency:'EUR', saleEnabled:true, createdAt:now(), updatedAt:now() },
             { id:newId(), slug:'piel-perfecta-20', title:'Piel Perfecta 2.0', subtitle:'Dermocosmética práctica para el cuidado diario', description:'Curso práctico de cuidado de la piel.', status:'published', certificateEnabled:true, sequentialAccess:false, priceCents:3200, currency:'EUR', saleEnabled:true, createdAt:now(), updatedAt:now() }],
    modules,
    lessons,
    enrollments:[],
    progress:[],
    activity:[],
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
    teacherAssignments:[],
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
  const session=currentSession(req,db);
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

function bunnyConfigured(){
  return VIDEO_PROVIDER==='bunny'&&Boolean(BUNNY_STREAM_LIBRARY_ID&&BUNNY_STREAM_API_KEY&&BUNNY_STREAM_TOKEN_KEY);
}
async function bunnyApi(pathname,{method='GET',body=null}={}){
  if(!BUNNY_STREAM_LIBRARY_ID||!BUNNY_STREAM_API_KEY)throw new Error('Bunny Stream no está configurado');
  const response=await fetch('https://video.bunnycdn.com/library/'+encodeURIComponent(BUNNY_STREAM_LIBRARY_ID)+pathname,{
    method,
    headers:{AccessKey:BUNNY_STREAM_API_KEY,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined
  });
  const textBody=await response.text();
  let payload=null;try{payload=textBody?JSON.parse(textBody):null}catch{}
  if(!response.ok){
    const detail=cleanText(payload?.message||payload?.Message||payload?.error||textBody||('HTTP '+response.status),260);
    const error=new Error('Bunny Stream respondió '+response.status+(detail?' · '+detail:''));
    error.statusCode=response.status>=400&&response.status<500?502:503;
    throw error;
  }
  return payload;
}
async function bunnyCreateVideo(title){
  const payload=await bunnyApi('/videos',{method:'POST',body:{title:cleanText(title,240)||'Vídeo Lykios Academy'}});
  const guid=cleanText(payload?.guid,120);
  if(!guid)throw new Error('Bunny no devolvió el identificador del vídeo');
  return payload;
}
async function bunnyGetVideo(guid){
  return bunnyApi('/videos/'+encodeURIComponent(guid));
}
async function bunnyDeleteVideo(guid){
  if(!guid||!BUNNY_STREAM_LIBRARY_ID||!BUNNY_STREAM_API_KEY)return false;
  try{await bunnyApi('/videos/'+encodeURIComponent(guid),{method:'DELETE'});return true}catch{return false}
}
function bunnyTusCredentials(guid,expiresSeconds){
  const signature=crypto.createHash('sha256').update(BUNNY_STREAM_LIBRARY_ID+BUNNY_STREAM_API_KEY+String(expiresSeconds)+guid).digest('hex');
  return {provider:'bunny',uploadUrl:'https://video.bunnycdn.com/tusupload',libraryId:BUNNY_STREAM_LIBRARY_ID,videoId:guid,signature,expires:expiresSeconds};
}
function bunnyEmbedUrl(guid,expiresAtMs){
  const expires=Math.floor(Number(expiresAtMs)/1000);
  const token=crypto.createHash('sha256').update(BUNNY_STREAM_TOKEN_KEY+guid+String(expires)).digest('hex');
  const params=new URLSearchParams({token,expires:String(expires),autoplay:'false',preload:'true',rememberPosition:'false',rememberSettings:'false',playsinline:'true',disableIosPlayer:'true',disableAirPlay:'true',chromecast:'false',showHeatmap:'false',levelCap:'true'});
  return 'https://player.mediadelivery.net/embed/'+encodeURIComponent(BUNNY_STREAM_LIBRARY_ID)+'/'+encodeURIComponent(guid)+'?'+params.toString();
}
async function removeStoredVideoRef(ref){
  const value=String(ref||'');
  if(value.startsWith('blob:')){try{await resourceStore.remove(value.slice(5));return true}catch{return false}}
  if(value.startsWith('bunny:'))return bunnyDeleteVideo(value.slice(6));
  return false;
}

function lessonVideos(lesson){
  if(Array.isArray(lesson?.videos)&&lesson.videos.length)return lesson.videos.slice().sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0));
  if(lesson?.video)return [{id:lesson.videoId||'primary',ref:lesson.video,name:lesson.videoName||'Vídeo 1',mime:lesson.videoMime||'video/mp4',size:lesson.videoSize||null,position:1,createdAt:lesson.updatedAt||lesson.createdAt||now()}];
  return [];
}
function syncPrimaryVideoFields(lesson){
  const first=lessonVideos(lesson)[0]||null;
  lesson.video=first?.ref||null;
  lesson.videoId=first?.id||null;
  lesson.videoName=first?.name||null;
  lesson.videoMime=first?.mime||null;
  lesson.videoSize=first?.size||null;
}
function singleVideoProgress(db,user,lessonId,videoId){
  const v=db.videoProgress.find(x=>x.userId===user.id&&x.lessonId===lessonId&&String(x.videoId||'')===String(videoId||''));
  return v?{currentTime:v.currentTime||0,duration:v.duration||0,percent:v.percent||0,lastPlayedAt:v.lastPlayedAt||null,completed:Boolean(v.completed)}:{currentTime:0,duration:0,percent:0,lastPlayedAt:null,completed:false};
}
function videoProgressPayload(db,user,lessonId,videoId=null){
  if(videoId)return singleVideoProgress(db,user,lessonId,videoId);
  const lesson=db.lessons.find(l=>l.id===lessonId);const videos=lessonVideos(lesson);
  if(!videos.length)return {currentTime:0,duration:0,percent:0,lastPlayedAt:null,completed:false};
  const rows=videos.map(v=>singleVideoProgress(db,user,lessonId,v.id));
  const percent=Math.round(rows.reduce((n,p)=>n+(Number(p.percent)||0),0)/videos.length);
  const latest=rows.filter(p=>p.lastPlayedAt).sort((a,b)=>new Date(b.lastPlayedAt)-new Date(a.lastPlayedAt))[0]||rows[0];
  return {currentTime:latest.currentTime||0,duration:latest.duration||0,percent,lastPlayedAt:latest.lastPlayedAt||null,completed:rows.every(p=>p.completed)};
}
function lessonCompletionStatus(db,user,lesson){
  const videos=lessonVideos(lesson);
  const videoStates=videos.map(v=>({id:v.id,name:v.name,progress:singleVideoProgress(db,user,lesson.id,v.id)}));
  const videosCompleted=videoStates.filter(v=>v.progress.completed).length;
  const videoPercent=videos.length?Math.round(videoStates.reduce((n,v)=>n+(Number(v.progress.percent)||0),0)/videos.length):100;
  const assessment=assessmentForScope(db,'lesson',lesson.id);
  const assessmentRequired=Boolean(assessment&&(assessment.status==='published'||previewEnrolledAccess(db,user,lesson.courseId)));
  const assessmentPassed=!assessmentRequired||db.attempts.some(a=>a.userId===user.id&&a.assessmentId===assessment.id&&a.passed);
  const hasRequirements=videos.length>0||assessmentRequired;
  const requirementsMet=(videos.length===0||videosCompleted===videos.length)&&assessmentPassed;
  const parts=[];
  if(videos.length)parts.push(videoPercent);
  if(assessmentRequired)parts.push(assessmentPassed?100:0);
  const progressPercent=hasRequirements?Math.min(100,Math.round(parts.reduce((a,b)=>a+b,0)/Math.max(1,parts.length))):0;
  return {hasRequirements,requirementsMet,videosRequired:videos.length,videosCompleted,videoPercent,assessmentRequired,assessmentPassed,assessmentId:assessmentRequired?assessment.id:null,progressPercent};
}
function lessonProgressRow(db,enrollment,lessonId){
  return db.progress.find(p=>p.enrollmentId===enrollment.id&&p.lessonId===lessonId)||null;
}
function lessonAssessmentUnlocked(db,user,lesson){
  if(!lesson)return false;
  if(user?.role==='admin'||user?.role==='teacher')return true;
  const enrollment=db.enrollments.find(e=>e.userId===user.id&&e.courseId===lesson.courseId&&e.status==='active');
  if(!enrollment)return false;
  const siblings=db.lessons.filter(l=>l.moduleId===lesson.moduleId).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0));
  const index=siblings.findIndex(l=>l.id===lesson.id);
  const previousComplete=(index<=0?[]:siblings.slice(0,index)).every(prev=>lessonIsComplete(db,user,enrollment,prev));
  const videos=lessonVideos(lesson);
  const targetVideoComplete=!videos.length||videos.every(v=>singleVideoProgress(db,user,lesson.id,v.id).completed);
  return previousComplete&&targetVideoComplete;
}
function lessonIsComplete(db,user,enrollment,lesson){
  const status=lessonCompletionStatus(db,user,lesson);
  if(status.hasRequirements)return status.requirementsMet;
  return Boolean(lessonProgressRow(db,enrollment,lesson.id)?.completed);
}
function syncLessonCompletion(db,user,lesson){
  const enrollment=db.enrollments.find(e=>e.userId===user.id&&e.courseId===lesson.courseId&&e.status==='active');
  if(!enrollment)return {changed:false,completed:false,status:lessonCompletionStatus(db,user,lesson)};
  const status=lessonCompletionStatus(db,user,lesson);
  let p=lessonProgressRow(db,enrollment,lesson.id);
  if(!p){p={id:newId(),enrollmentId:enrollment.id,lessonId:lesson.id,completed:false,progressPercent:0,updatedAt:now()};db.progress.push(p)}
  const before=Boolean(p.completed);
  if(status.hasRequirements){
    p.completed=status.requirementsMet;
    p.progressPercent=status.requirementsMet?100:Math.min(99,status.progressPercent);
    p.updatedAt=now();
    if(p.completed){if(!p.completedAt)p.completedAt=now();p.completionMode='requirements';}
    else {p.completedAt=null;p.completionMode='requirements';}
  }
  const changed=before!==Boolean(p.completed);
  if(changed&&p.completed)db.activity.push({id:newId(),userId:user.id,type:'lesson_completed',label:`Clase ${lesson.code} completada automáticamente`,at:now()});
  return {changed,completed:Boolean(p.completed),progress:p,status:{...status,completed:Boolean(p.completed)}};
}
function reconcileLessonForStudents(db,lesson){
  const enrollments=db.enrollments.filter(e=>e.courseId===lesson.courseId&&e.status==='active');
  for(const enrollment of enrollments){
    const user=db.users.find(u=>u.id===enrollment.userId);
    if(user)syncLessonCompletion(db,user,lesson);
  }
}
function orderedPublishedLessons(db,courseId){
  const modules=db.modules.filter(m=>m.courseId===courseId&&m.status==='published').sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0));
  return modules.flatMap(m=>db.lessons.filter(l=>l.moduleId===m.id&&l.status==='published').sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0)));
}
function sequenceState(db,user,lesson){
  if(!lesson)return {locked:true,lockReason:'Clase no disponible'};
  if(user.role==='admin'||user.role==='teacher')return {locked:false,lockReason:null,blockingLesson:null};
  const course=db.courses.find(c=>c.id===lesson.courseId);
  if(!course||course.sequentialAccess!==true)return {locked:false,lockReason:null,blockingLesson:null};
  const enrollment=db.enrollments.find(e=>e.userId===user.id&&e.courseId===lesson.courseId&&e.status==='active');
  if(!enrollment)return {locked:true,lockReason:'Sin matrícula activa',blockingLesson:null};
  const previewSequence=IS_PREVIEW&&user.role==='student'&&Boolean(enrollment);
  const ordered=previewSequence
    ? db.modules.filter(m=>m.courseId===lesson.courseId).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0))
        .flatMap(m=>db.lessons.filter(l=>l.moduleId===m.id).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0)))
    : orderedPublishedLessons(db,lesson.courseId);
  const index=ordered.findIndex(l=>l.id===lesson.id);
  if(index<=0)return {locked:false,lockReason:null,blockingLesson:null};
  const blocking=ordered.slice(0,index).find(prev=>!lessonIsComplete(db,user,enrollment,prev));
  return blocking
    ?{locked:true,lockReason:`Completa primero la clase ${blocking.code}`,blockingLesson:{id:blocking.id,code:blocking.code,title:blocking.title}}
    :{locked:false,lockReason:null,blockingLesson:null};
}
function previewEnrolledAccess(db,user,courseId){
  return Boolean(IS_PREVIEW&&user?.role==='student'&&db.enrollments.some(e=>e.userId===user.id&&e.courseId===courseId&&e.status==='active'));
}
function canAccessLesson(db,user,lesson){
  if(!lesson)return false;
  if(user.role==='admin')return true;
  if(user.role==='teacher')return canTeachCourse(db,user,lesson.courseId);
  const enrolled=db.enrollments.some(e=>e.userId===user.id&&e.courseId===lesson.courseId&&e.status==='active');
  if(!enrolled)return false;
  if(lesson.status!=='published'&&!previewEnrolledAccess(db,user,lesson.courseId))return false;
  return !sequenceState(db,user,lesson).locked;
}
function lessonLastActivityAt(db,user,enrollment,lesson){
  const times=[];
  const row=enrollment?lessonProgressRow(db,enrollment,lesson.id):null;if(row?.updatedAt)times.push(row.updatedAt);
  for(const v of lessonVideos(lesson)){const p=singleVideoProgress(db,user,lesson.id,v.id);if(p.lastPlayedAt)times.push(p.lastPlayedAt);}
  const assessment=assessmentForScope(db,'lesson',lesson.id);
  if(assessment){for(const a of db.attempts.filter(x=>x.userId===user.id&&x.assessmentId===assessment.id))if(a.submittedAt)times.push(a.submittedAt);}
  return times.sort((a,b)=>new Date(b)-new Date(a))[0]||null;
}
function compactLessonRef(lesson,module=null){
  if(!lesson)return null;
  return {id:lesson.id,code:lesson.code,title:lesson.title,moduleCode:module?.code||'',moduleTitle:module?.title||'',durationMinutes:lesson.durationMinutes||0,progressPercent:lesson.completionStatus?.progressPercent||0,lastActivityAt:lesson.lastActivityAt||null};
}
function coursePayload(db, user, slug='peeling-quimico'){
  const course=db.courses.find(c=>c.slug===slug);
  if(!course) return null;
  const enrollment=db.enrollments.find(e=>e.userId===user.id && e.courseId===course.id && e.status==='active');
  const previewDraftAccess=Boolean(IS_PREVIEW&&user.role==='student'&&enrollment);
  if(user.role!=='admin'&&course.status!=='published'&&!previewDraftAccess) return null;
  const modules=db.modules.filter(m=>m.courseId===course.id && (user.role==='admin'||m.status==='published'||previewDraftAccess)).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0)).map(m=>({
    ...m,
    assessment:(()=>{const a=assessmentForScope(db,'module',m.id);return a&&a.status==='published'?{id:a.id,title:a.title,passingScore:a.passingScore,maxAttempts:a.maxAttempts}:null})(),
    lessons:db.lessons.filter(l=>l.moduleId===m.id && (user.role==='admin'||l.status==='published'||previewDraftAccess)).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0)).map(l=>{
      const completion=(()=>{const st=lessonCompletionStatus(db,user,l);return {...st,completed:enrollment?lessonIsComplete(db,user,enrollment,l):false};})();
      const seq=sequenceState(db,user,l);
      const {video,videoId,videoName,videoMime,videoSize,videos:storedVideos,resources:storedResources,...publicLesson}=l;
      return {
        ...publicLesson,
        resources:(storedResources||[]).map(r=>({id:r.id,name:r.name,mime:r.mime,size:r.size||null,generatedKey:r.generatedKey||null,createdAt:r.createdAt||null})),
        videos:lessonVideos(l).map(v=>({id:v.id,name:v.name,mime:v.mime,size:v.size||null,position:v.position,createdAt:v.createdAt||null,progress:videoProgressPayload(db,user,l.id,v.id)})),
        videoProgress:videoProgressPayload(db,user,l.id),
        completionStatus:completion,
        assessment:(()=>{const a=assessmentForScope(db,'lesson',l.id);if(!a||!(a.status==='published'||previewDraftAccess))return null;const passed=db.attempts.some(x=>x.userId===user.id&&x.assessmentId===a.id&&x.passed);return {id:a.id,title:a.title,passingScore:a.passingScore,maxAttempts:a.maxAttempts,passed,unlocked:passed||lessonAssessmentUnlocked(db,user,l)};})(),
        locked:seq.locked,
        lockReason:seq.lockReason,
        blockingLesson:seq.blockingLesson,
        lastActivityAt:lessonLastActivityAt(db,user,enrollment,l)
      };
    })
  }));
  const progress=enrollment?db.progress.filter(p=>p.enrollmentId===enrollment.id):[];
  const visibleLessons=modules.flatMap(m=>m.lessons);
  const completed=new Set(enrollment?visibleLessons.filter(l=>lessonIsComplete(db,user,enrollment,l)).map(l=>l.id):[]);
  const total=visibleLessons.length;
  const completedCount=visibleLessons.filter(l=>completed.has(l.id)).length;
  const assessmentStatus=courseAssessmentStatus(db,user,course.id);
  const incompleteUnlocked=visibleLessons.filter(l=>!completed.has(l.id)&&!l.locked);
  const touched=incompleteUnlocked.filter(l=>l.lastActivityAt).sort((a,b)=>new Date(b.lastActivityAt)-new Date(a.lastActivityAt));
  const resume=touched[0]||incompleteUnlocked[0]||null;
  const next=incompleteUnlocked[0]||null;
  const moduleFor=id=>modules.find(m=>m.lessons.some(l=>l.id===id))||null;
  return {
    ...course,
    sequentialAccess:course.sequentialAccess===true,
    modules,
    enrollment,
    progressPercent:total?Math.round(completedCount/total*100):0,
    completedCount,
    totalLessons:total,
    completedLessonIds:[...completed],
    assessmentStatus,
    resumeLesson:resume?compactLessonRef(resume,moduleFor(resume.id)):null,
    nextLesson:next?compactLessonRef(next,moduleFor(next.id)):null
  };
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
function tutorSourcesForCourse(db,course,user=null){
  const moduleIds=new Set(db.modules.filter(m=>m.courseId===course.id&&m.status==='published').map(m=>m.id));
  return db.lessons.filter(l=>l.courseId===course.id&&moduleIds.has(l.moduleId)&&l.status==='published'&&l.tutorApproved===true&&(!user||user.role!=='student'||canAccessLesson(db,user,l))).sort((a,b)=>a.position-b.position).map(l=>{
    const mod=db.modules.find(m=>m.id===l.moduleId);
    const body=[l.title,l.summary||'',l.tutorContent||''].filter(Boolean).join('\n').trim();
    return {lesson:l,module:mod,text:body,href:`/lesson?course=${encodeURIComponent(course.slug)}&lessonId=${encodeURIComponent(l.id)}`};
  });
}
function tutorAsk(db,user,course,question){
  const q=cleanText(question,1200); const qTokens=tutorTokens(q); const sources=tutorSourcesForCourse(db,course,user);
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
    id:q.id, assessmentId:q.assessmentId, prompt:q.prompt, type:q.type, options:q.options, position:q.position,
    ...(includeAnswers?{correctOption:q.correctOption,explanation:q.explanation||''}:{})
  }));
  const rawAttempts=userId?db.attempts.filter(a=>a.assessmentId===assessment.id&&a.userId===userId).sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt)):[];
  const attempts=includeAnswers?rawAttempts:rawAttempts.map(a=>({id:a.id,assessmentId:a.assessmentId,userId:a.userId,score:a.score,passed:a.passed,submittedAt:a.submittedAt}));
  return {...assessment,questions,attempts,attemptsUsed:rawAttempts.length,bestScore:rawAttempts.length?Math.max(...rawAttempts.map(a=>a.score)):null,passed:rawAttempts.some(a=>a.passed)};
}
function visibleAssessment(db,user,assessment){
  if(!assessment) return false;
  if(user.role==='admin') return true;
  let courseId=null, lesson=null, module=null, course=null;
  if(assessment.scopeType==='lesson'){
    lesson=db.lessons.find(x=>x.id===assessment.scopeId);
    if(!lesson) return false;
    module=db.modules.find(x=>x.id===lesson.moduleId);
    course=db.courses.find(x=>x.id===lesson.courseId);
    if(!module||!course) return false;
    courseId=lesson.courseId;
  } else if(assessment.scopeType==='module'){
    module=db.modules.find(x=>x.id===assessment.scopeId);
    if(!module) return false;
    course=db.courses.find(x=>x.id===module.courseId);
    if(!course) return false;
    courseId=module.courseId;
  } else {
    return false;
  }
  const previewAccess=previewEnrolledAccess(db,user,courseId);
  if(assessment.status!=='published'&&!previewAccess) return false;
  if(!previewAccess){
    if(course.status!=='published'||module.status!=='published') return false;
    if(lesson&&lesson.status!=='published') return false;
  }
  if(assessment.scopeType==='lesson'){
    if(!lesson||!canAccessLesson(db,user,lesson))return false;
    if(user.role==='student'&&!lessonAssessmentUnlocked(db,user,lesson))return false;
    return true;
  }
  return db.enrollments.some(e=>e.userId===user.id&&e.courseId===courseId&&e.status==='active');
}

function courseAssessmentStatus(db,user,courseId){
  const previewAccess=previewEnrolledAccess(db,user,courseId);
  const moduleIds=db.modules.filter(m=>m.courseId===courseId&&(previewAccess||m.status==='published')).map(m=>m.id);
  const lessonIds=db.lessons.filter(l=>l.courseId===courseId&&(previewAccess||l.status==='published')).map(l=>l.id);
  const assessments=db.assessments.filter(a=>(previewAccess||a.status==='published')&&((a.scopeType==='module'&&moduleIds.includes(a.scopeId))||(a.scopeType==='lesson'&&lessonIds.includes(a.scopeId))));
  const passedIds=new Set(db.attempts.filter(a=>a.userId===user.id&&a.passed).map(a=>a.assessmentId));
  return {required:assessments.length,passed:assessments.filter(a=>passedIds.has(a.id)).length,allPassed:assessments.every(a=>passedIds.has(a.id))};
}


function courseCompletionStatus(db,user,courseId){
  const course=db.courses.find(c=>c.id===courseId);
  if(!course) return {eligible:false,error:'Curso no encontrado'};
  const enrollment=db.enrollments.find(e=>e.userId===user.id&&e.courseId===courseId&&e.status==='active');
  if(!enrollment) return {eligible:false,error:'Sin matrícula activa'};
  const previewAccess=previewEnrolledAccess(db,user,courseId);
  const eligibleModuleIds=db.modules.filter(m=>m.courseId===courseId&&(previewAccess||m.status==='published')).map(m=>m.id);
  const lessons=db.lessons.filter(l=>l.courseId===courseId&&(previewAccess||l.status==='published')&&eligibleModuleIds.includes(l.moduleId));
  const completed=new Set(lessons.filter(l=>lessonIsComplete(db,user,enrollment,l)).map(l=>l.id));
  const incompleteLessons=lessons.filter(l=>!completed.has(l.id));
  const assessmentStatus=courseAssessmentStatus(db,user,courseId);
  const hasCompletionRequirements=lessons.length>0 || assessmentStatus.required>0;
  const eligible=course.certificateEnabled!==false && hasCompletionRequirements && incompleteLessons.length===0 && assessmentStatus.allPassed;
  return {eligible,hasCompletionRequirements,certificateEnabled:course.certificateEnabled!==false,lessonsTotal:lessons.length,lessonsCompleted:lessons.length-incompleteLessons.length,incompleteLessons:incompleteLessons.map(l=>({id:l.id,code:l.code,title:l.title})),assessmentsRequired:assessmentStatus.required,assessmentsPassed:assessmentStatus.passed,allAssessmentsPassed:assessmentStatus.allPassed};
}
function certificateCode(){
  const y=new Date().getFullYear();
  return `LYK-${y}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}
function publicCertificate(db,cert){
  const user=db.users.find(u=>u.id===cert.userId); const course=db.courses.find(c=>c.id===cert.courseId);
  if(!user||!course) return null;
  return {code:cert.code,status:cert.status||'valid',studentName:`${user.firstName} ${user.lastName}`.trim(),courseId:course.id,courseSlug:course.slug,courseTitle:course.title,courseSubtitle:course.subtitle||'',courseDescription:cleanText(course.description||'',260),issuedAt:cert.issuedAt,revokedAt:cert.revokedAt||null,issuer:'Lykios Academy',verificationPath:`/verify/${cert.code}`};
}
let certificateTemplateBytesPromise;
function certificateTemplateBytes(){
  certificateTemplateBytesPromise ||= readFile(new URL('./content/certificate-template-final.jpg', import.meta.url));
  return certificateTemplateBytesPromise;
}
async function certificatePdf(cert){
  const {PDFDocument,StandardFonts,rgb}=await import('pdf-lib');
  const pdf=await PDFDocument.create();
  const template=await pdf.embedJpg(await certificateTemplateBytes());

  // La plantilla oficial tiene proporción 3:2. Mantenerla intacta evita
  // deformar logo, marcos, ondas, firma y demás elementos corporativos.
  const W=900,H=600;
  const page=pdf.addPage([W,H]);
  page.drawImage(template,{x:0,y:0,width:W,height:H});

  const helv=await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold=await pdf.embedFont(StandardFonts.HelveticaBold);
  const timesBold=await pdf.embedFont(StandardFonts.TimesRomanBold);
  const ink=rgb(0.025,0.09,0.13);
  const teal=rgb(0.015,0.30,0.36);
  const muted=rgb(0.26,0.33,0.38);

  const centered=(text,font,size,y,color=ink,maxWidth=760,minSize=8)=>{
    text=cleanText(String(text||''),350);
    let s=size;
    while(s>minSize && font.widthOfTextAtSize(text,s)>maxWidth)s-=0.5;
    const w=font.widthOfTextAtSize(text,s);
    page.drawText(text,{x:(W-w)/2,y,size:s,font,color});
    return s;
  };
  const leftFit=(text,font,size,x,y,maxWidth,color=ink,minSize=6.5)=>{
    text=cleanText(String(text||''),420);
    let s=size;
    while(s>minSize && font.widthOfTextAtSize(text,s)>maxWidth)s-=0.5;
    page.drawText(text,{x,y,size:s,font,color});
    return s;
  };
  const centeredWrap=(text,font,size,y,maxWidth,lineGap,color=muted,maxLines=2)=>{
    const words=cleanText(String(text||''),420).split(/\s+/).filter(Boolean);
    if(!words.length)return;
    const lines=[]; let line='';
    for(const word of words){
      const trial=line?line+' '+word:word;
      if(font.widthOfTextAtSize(trial,size)<=maxWidth || !line) line=trial;
      else { lines.push(line); line=word; if(lines.length===maxLines-1) break; }
    }
    if(line && lines.length<maxLines) lines.push(line);
    lines.slice(0,maxLines).forEach((ln,i)=>{
      let out=ln;
      if(i===maxLines-1 && words.join(' ').length>lines.join(' ').length) out=out.replace(/[.,;:]?$/,'')+'…';
      const w=font.widthOfTextAtSize(out,size);
      page.drawText(out,{x:(W-w)/2,y:y-i*lineGap,size,font,color});
    });
  };

  // Campos dinámicos sobre los espacios reservados de la plantilla oficial.
  centered(cert.studentName,timesBold,34,337,ink,620,18);
  centered(cert.courseTitle,timesBold,25,260,teal,700,15);
  if(cert.courseSubtitle) centered(cert.courseSubtitle,helv,12.5,235,teal,650,8.5);

  const description=cleanText(cert.courseDescription||'',220);
  if(description) centeredWrap(description,helv,10.5,204,650,13,muted,2);

  const issueDate=new Date(cert.issuedAt).toLocaleDateString('es-ES',{
    day:'2-digit',month:'long',year:'numeric'
  });
  centered(issueDate,helv,11,166,ink,260,8);

  const verifyOrigin=PUBLIC_APP_ORIGIN;
  const verifyUrl=`${verifyOrigin}/verify/${cert.code}`;

  leftFit(cert.code,helvBold,10.5,577,126,160,ink,7);
  leftFit(verifyUrl.replace(/^https?:\/\//,''),helv,7.5,577,91,168,teal,5.8);

  try{
    const qr=await pdf.embedPng(await qrPng(verifyUrl));
    page.drawImage(qr,{x:756,y:80,width:81,height:81});
  }catch(error){
    console.error(JSON.stringify({event:'certificate_qr_failed',error:error?.message||String(error)}));
  }

  const bytes=await pdf.save({useObjectStreams:false});
  return Buffer.from(bytes);
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
function verificationHtml(cert,requestedCode=''){
  const valid=cert&&cert.status==='valid';
  const revoked=cert&&cert.status==='revoked';
  const code=cleanText(requestedCode||cert?.code||'',80).toUpperCase();
  const title=valid?'Certificado auténtico':revoked?'Certificado revocado':code?'Certificado no encontrado':'Verificar certificado';
  const intro=valid?'Este certificado figura como válido en el registro oficial de Lykios Academy.':revoked?'Este certificado existe, pero ha sido revocado por Lykios Academy.':code?'No existe un certificado con ese código en el registro público.':'Introduce el código impreso en el certificado para comprobar su autenticidad.';
  const issuedDate=cert?new Date(cert.issuedAt).toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric'}):'';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${htmlEsc(title)} · Lykios Academy</title><link rel="stylesheet" href="/styles.css"></head><body><main class="verify-page"><div class="verify-shell"><header class="verify-brandbar"><div class="verify-wordmark"><span class="verify-mark" aria-hidden="true">L</span><span class="verify-wordmark-text"><strong>LYKIOS</strong><small>ACADEMY</small></span></div><div class="verify-brand-copy"><strong>FORMACIÓN MÉDICA</strong><span>Conocimiento que transforma vidas</span></div></header><section class="verify-card ${valid?'valid':revoked?'invalid':''}"><div class="verify-card-accent"></div><div class="verify-topline"><div class="page-kicker">REGISTRO OFICIAL · VERIFICACIÓN PÚBLICA</div><div class="verify-status-chip">${valid?'VÁLIDO':revoked?'REVOCADO':'CONSULTA'}</div></div><div class="verify-icon">${valid?'✓':revoked?'!':'◇'}</div><h1>${htmlEsc(title)}</h1><p class="verify-intro">${htmlEsc(intro)}</p>${cert?`<dl><dt>Alumno</dt><dd>${htmlEsc(cleanText(cert.studentName,200))}</dd><dt>Curso</dt><dd>${htmlEsc(cleanText(cert.courseTitle,250))}</dd><dt>Fecha de emisión</dt><dd>${htmlEsc(issuedDate)}</dd><dt>Código</dt><dd class="verify-code">${htmlEsc(cleanText(cert.code,80))}</dd><dt>Estado</dt><dd><span class="verify-state-text">${valid?'Válido':'Revocado'}</span></dd></dl>${valid?`<div class="verify-qr-wrap"><img class="verify-qr" src="/api/public/certificate/qr?code=${encodeURIComponent(cert.code)}" alt="QR de verificación"><span>Escanea para verificar</span></div>`:''}`:''}<form class="verify-search" method="get" action="/verify"><label for="certificateCode">Código del certificado</label><div class="verify-search-row"><input id="certificateCode" name="code" value="${htmlEsc(code)}" autocomplete="off" placeholder="LYK-2026-XXXXXXXXXX" maxlength="40" required><button class="btn" type="submit">Verificar</button></div></form><p class="muted verify-privacy">La verificación pública muestra únicamente los datos necesarios para confirmar la autenticidad del certificado.</p><a class="btn-secondary verify-home" href="/">Ir a Lykios Academy</a><div class="verify-values" aria-label="Valores Lykios Academy"><span>Ciencia</span><span>Práctica</span><span>Experiencia</span><span>Resultados</span></div></section><footer class="verify-footer">LYKIOS ACADEMY · FORMACIÓN MÉDICA PARA UN FUTURO MÁS HUMANO</footer></div></main></body></html>`;
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



function emailEscape(value=''){
  return String(value)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function emailShell({preheader='',title='',body='',ctaLabel='',ctaUrl='',footerNote=''}={}){
  const safePreheader=emailEscape(preheader);
  const safeTitle=emailEscape(title);
  const safeCtaLabel=emailEscape(ctaLabel);
  const safeCtaUrl=emailEscape(ctaUrl);
  const safeFooterNote=emailEscape(footerNote);
  const cta=(ctaLabel&&ctaUrl)?`
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;margin-bottom:8px;">
      <tr>
        <td style="background-color:#0f5b61;border-radius:8px;">
          <a href="${safeCtaUrl}" style="display:inline-block;padding:13px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;">${safeCtaLabel}</a>
        </td>
      </tr>
    </table>`:'';
  return `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="margin:0;padding:0;background-color:#f3f5f5;">
    <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${safePreheader}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f3f5f5;">
      <tr>
        <td align="center" style="padding:28px 14px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:620px;background-color:#ffffff;border:1px solid #dfe7e7;border-radius:14px;">
            <tr>
              <td style="padding:26px 32px 18px 32px;border-bottom:1px solid #e7eded;">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:30px;font-weight:700;letter-spacing:1px;color:#123f43;">LYKIOS ACADEMY</div>
                <div style="margin-top:4px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;letter-spacing:1.2px;color:#8a6d3b;">CIENCIA · PRÁCTICA · EXPERIENCIA</div>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 32px 34px 32px;">
                <h1 style="margin:0 0 18px 0;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:35px;font-weight:700;color:#173f43;">${safeTitle}</h1>
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:25px;color:#334b4d;">${body}</div>
                ${cta}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 24px 32px;background-color:#f8faf9;border-top:1px solid #e7eded;border-radius:0 0 14px 14px;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#667b7d;">${safeFooterNote||'Este es un mensaje transaccional de Lykios Academy relacionado con tu cuenta o formación.'}</div>
                <div style="margin-top:10px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;color:#8a9697;">Formación médica para un futuro más humano · lykiosacademy.com</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
function mailTemplate(type,ctx={}){
  const firstName=emailEscape(cleanText(ctx.firstName||'Alumno',120));
  const course=emailEscape(cleanText(ctx.courseTitle||'',220));
  const order=emailEscape(cleanText(ctx.orderNumber||'',80));
  const code=emailEscape(cleanText(ctx.certificateCode||'',100));
  const resetUrl=cleanText(ctx.resetUrl||'',1000);
  const campusUrl=cleanText(ctx.campusUrl||APP_ORIGIN,1000).replace(/\/$/,'');
  const courseSlug=cleanText(ctx.courseSlug||'',160);
  const courseUrl=courseSlug?`${campusUrl}/course?slug=${encodeURIComponent(courseSlug)}`:campusUrl;
  const certificateUrl=courseSlug?`${courseUrl}#certificate`:campusUrl;
  const deviceLabel=emailEscape(cleanText(ctx.deviceLabel||'Nuevo dispositivo',120));
  const ipLabel=emailEscape(cleanText(ctx.ipLabel||'red no identificada',100));
  const templates={
    welcome:{
      subject:'Bienvenido a Lykios Academy',
      html:emailShell({
        preheader:'Tu acceso al Campus Lykios ya está activo.',
        title:'Bienvenido a Lykios Academy',
        body:`<p style="margin:0 0 16px 0;">Hola <strong>${firstName}</strong>,</p><p style="margin:0 0 16px 0;">Tu cuenta ya está activa. Desde el Campus podrás acceder a tus cursos, seguir tu progreso, realizar evaluaciones y descargar tus certificados.</p><p style="margin:0;">Tu formación queda guardada para que puedas continuar donde la dejaste.</p>`,
        ctaLabel:'Entrar al Campus',
        ctaUrl:campusUrl
      })
    },
    purchase:{
      subject:`Matrícula confirmada · ${cleanText(ctx.courseTitle||'',220)}`,
      html:emailShell({
        preheader:`Tu acceso a ${cleanText(ctx.courseTitle||'tu formación',220)} ya está activo.`,
        title:'Matrícula confirmada',
        body:`<p style="margin:0 0 16px 0;">Hola <strong>${firstName}</strong>,</p><p style="margin:0 0 16px 0;">Tu acceso a <strong>${course}</strong> ya está activo.</p>${order?`<p style="margin:0 0 16px 0;">Número de pedido: <strong>${order}</strong></p>`:''}<p style="margin:0;">Puedes empezar cuando quieras y tu progreso se guardará automáticamente.</p>`,
        ctaLabel:'Comenzar mi formación',
        ctaUrl:courseUrl
      })
    },
    password_reset:{
      subject:'Recupera tu acceso a Lykios Academy',
      html:emailShell({
        preheader:'Enlace seguro para crear una nueva contraseña.',
        title:'Recuperar contraseña',
        body:`<p style="margin:0 0 16px 0;">Hola <strong>${firstName}</strong>,</p><p style="margin:0 0 16px 0;">Hemos recibido una solicitud para restablecer la contraseña de tu cuenta.</p><p style="margin:0 0 16px 0;">El enlace es válido durante <strong>60 minutos</strong> y solo puede utilizarse una vez.</p><p style="margin:0;">Si no has solicitado este cambio, puedes ignorar este mensaje; tu contraseña actual seguirá siendo válida.</p>`,
        ctaLabel:'Crear nueva contraseña',
        ctaUrl:resetUrl,
        footerNote:'Por seguridad, Lykios Academy nunca te pedirá tu contraseña por correo electrónico.'
      })
    },
    course_completed:{
      subject:`Curso completado · ${cleanText(ctx.courseTitle||'',220)}`,
      html:emailShell({
        preheader:`Has completado ${cleanText(ctx.courseTitle||'tu curso',220)}.`,
        title:'Curso completado',
        body:`<p style="margin:0 0 16px 0;">Enhorabuena, <strong>${firstName}</strong>.</p><p style="margin:0 0 16px 0;">Has completado satisfactoriamente <strong>${course}</strong>.</p><p style="margin:0;">Si el curso incluye certificado, lo encontrarás en tu Campus una vez emitido.</p>`,
        ctaLabel:'Ver mi progreso',
        ctaUrl:courseUrl
      })
    },
    certificate:{
      subject:`Tu certificado Lykios · ${cleanText(ctx.courseTitle||'',220)}`,
      html:emailShell({
        preheader:`Tu certificado de ${cleanText(ctx.courseTitle||'formación',220)} ya está disponible.`,
        title:'Certificado emitido',
        body:`<p style="margin:0 0 16px 0;">Hola <strong>${firstName}</strong>,</p><p style="margin:0 0 16px 0;">Tu certificado de <strong>${course}</strong> ya está disponible.</p>${code?`<p style="margin:0 0 16px 0;">Código de verificación: <strong>${code}</strong></p>`:''}<p style="margin:0;">Puedes descargarlo desde tu Campus y comprobar su autenticidad cuando lo necesites.</p>`,
        ctaLabel:'Ver mi certificado',
        ctaUrl:certificateUrl
      })
    },
    new_device:{
      subject:'Nuevo acceso a tu cuenta de Lykios Academy',
      html:emailShell({
        preheader:'Hemos detectado un acceso desde un dispositivo nuevo.',
        title:'Nuevo dispositivo detectado',
        body:`<p style="margin:0 0 16px 0;">Hola <strong>${firstName}</strong>,</p><p style="margin:0 0 16px 0;">Se ha iniciado sesión en tu cuenta desde <strong>${deviceLabel}</strong>.</p><p style="margin:0 0 16px 0;">Red aproximada: <strong>${ipLabel}</strong>.</p><p style="margin:0;">Si has sido tú, no necesitas hacer nada. Si no reconoces este acceso, cambia tu contraseña cuanto antes.</p>`,
        ctaLabel:'Revisar mi cuenta',
        ctaUrl:campusUrl,
        footerNote:'Lykios Academy no almacena ubicación precisa para esta alerta.'
      })
    },
    security_alert:{
      subject:'Aviso de seguridad · Lykios Academy',
      html:emailShell({
        preheader:'Hemos protegido tu cuenta tras detectar actividad inusual.',
        title:'Actividad inusual detectada',
        body:`<p style="margin:0 0 16px 0;">Hola <strong>${firstName}</strong>,</p><p style="margin:0 0 16px 0;">El Campus ha detectado un patrón de acceso poco habitual asociado a <strong>${deviceLabel}</strong> y ha cerrado otras sesiones por seguridad.</p><p style="margin:0 0 16px 0;">Red aproximada: <strong>${ipLabel}</strong>.</p><p style="margin:0;">Si reconoces la actividad puedes continuar normalmente. Si no, cambia tu contraseña.</p>`,
        ctaLabel:'Entrar al Campus',
        ctaUrl:campusUrl,
        footerNote:'Esta medida protege el acceso personal a tus cursos.'
      })
    },
    reminder:{
      subject:`Continúa tu formación · ${cleanText(ctx.courseTitle||'',220)}`,
      html:emailShell({
        preheader:`Continúa ${cleanText(ctx.courseTitle||'tu formación',220)} donde la dejaste.`,
        title:'Tu curso te espera',
        body:`<p style="margin:0 0 16px 0;">Hola <strong>${firstName}</strong>,</p><p style="margin:0 0 16px 0;">Tienes pendiente continuar <strong>${course}</strong>.</p><p style="margin:0;">Cuando vuelvas al Campus podrás retomar tu formación desde el punto en el que la dejaste.</p>`,
        ctaLabel:'Continuar mi curso',
        ctaUrl:courseUrl,
        footerNote:'Mensaje de seguimiento formativo relacionado con un curso en el que estás matriculado.'
      })
    }
  };
  return templates[type]||{
    subject:'Lykios Academy',
    html:emailShell({title:'Lykios Academy',body:'<p style="margin:0;">Tienes una nueva notificación relacionada con tu cuenta.</p>',ctaLabel:'Entrar al Campus',ctaUrl:campusUrl})
  };
}
function queueEmail(db,{to,type,userId=null,courseId=null,meta={}}){
  if(!to) return null;
  const user=userId?db.users.find(u=>u.id===userId):null;
  const course=courseId?db.courses.find(c=>c.id===courseId):null;
  const tpl=mailTemplate(type,{...meta,firstName:user?.firstName||meta.firstName,courseTitle:course?.title||meta.courseTitle,courseSlug:course?.slug||meta.courseSlug,orderNumber:meta.orderNumber,certificateCode:meta.certificateCode,resetUrl:meta.resetUrl,campusUrl:PUBLIC_APP_ORIGIN});
  const item={id:newId(),to:cleanText(to,220).toLowerCase(),type,subject:tpl.subject,html:tpl.html,status:'queued',provider:'resend',userId,courseId,meta,createdAt:now(),sentAt:null,attempts:0,lastError:null,providerRequestId:null};
  db.emailOutbox ||= []; db.emailOutbox.push(item); return item;
}
// Compatibilidad con llamadas existentes: ya no marca falsamente los correos como enviados.
// La entrega real se procesa en writeDb() mediante flushEmailOutbox().
function markLocalEmailsSent(db){
  for(const e of (db.emailOutbox||[])) if(e.status==='queued') e.provider='resend';
}
function emailTextFallback(html=''){
  return String(html)
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/p>/gi,'\n\n')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&lt;/gi,'<')
    .replace(/&gt;/gi,'>')
    .replace(/\s+\n/g,'\n')
    .replace(/\n\s+/g,'\n')
    .replace(/[ \t]{2,}/g,' ')
    .trim();
}
async function sendEmailViaResend(item){
  if(!RESEND_API_KEY) return {sent:false,configured:false};
  const response=await fetch(`${RESEND_API_BASE}/emails`,{
    method:'POST',
    headers:{
      'content-type':'application/json',
      'authorization':`Bearer ${RESEND_API_KEY}`,
      'Idempotency-Key':`lykios-email/${item.id}`
    },
    body:JSON.stringify({
      from:`${MAIL_FROM_NAME} <${MAIL_FROM}>`,
      to:[item.to],
      reply_to:MAIL_REPLY_TO,
      subject:item.subject,
      html:item.html,
      text:emailTextFallback(item.html)
    }),
    signal:AbortSignal.timeout(12000)
  });
  const raw=await response.text();
  let payload=null;try{payload=raw?JSON.parse(raw):null}catch{}
  if(!response.ok){
    const message=cleanText(payload?.message||raw||`HTTP ${response.status}`,500);
    throw new Error(`Resend: ${message}`);
  }
  return {sent:true,configured:true,requestId:cleanText(payload?.id||'',180)};
}
async function flushEmailOutbox(db,{limit=12}={}){
  const currentMs=Date.now();
  const queued=(db.emailOutbox||[])
    .filter(e=>{
      if(e.status!=='queued') return false;
      const nextMs=e.nextAttemptAt?Date.parse(e.nextAttemptAt):0;
      return !Number.isFinite(nextMs) || nextMs<=currentMs;
    })
    .slice(0,limit);
  if(!queued.length) return {configured:Boolean(RESEND_API_KEY),sent:0,failed:0,deferred:0};
  if(!RESEND_API_KEY) return {configured:false,sent:0,failed:0,queued:queued.length};
  let sent=0,failed=0,deferred=0;
  const retryDelaysMs=[60_000,5*60_000];
  for(const item of queued){
    item.attempts=(Number(item.attempts)||0)+1;
    item.lastAttemptAt=now();
    item.nextAttemptAt=null;
    try{
      const result=await sendEmailViaResend(item);
      if(result.sent){
        item.status='sent';
        item.sentAt=now();
        item.lastError=null;
        item.provider='resend';
        item.providerRequestId=result.requestId||null;
        sent++;
      }
    }catch(error){
      item.lastError=cleanText(error?.message||String(error),500);
      item.provider='resend';
      if(item.attempts<3){
        const delayMs=retryDelaysMs[Math.min(item.attempts-1,retryDelaysMs.length-1)];
        item.status='queued';
        item.nextAttemptAt=new Date(Date.now()+delayMs).toISOString();
        deferred++;
        logEvent('warn','transactional_email_retry_scheduled',{emailId:item.id,type:item.type,attempt:item.attempts,nextAttemptAt:item.nextAttemptAt,error:item.lastError});
      }else{
        item.status='failed';
        item.failedAt=now();
        item.nextAttemptAt=null;
        failed++;
        logEvent('error','transactional_email_failed',{emailId:item.id,type:item.type,attempt:item.attempts,error:item.lastError});
      }
    }
  }
  return {configured:true,sent,failed,deferred};
}
function emailAdminPayload(db){return (db.emailOutbox||[]).slice().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(e=>{const u=db.users.find(x=>x.id===e.userId),c=db.courses.find(x=>x.id===e.courseId);return {...e,studentName:u?`${u.firstName} ${u.lastName}`.trim():'',courseTitle:c?.title||''};});}
function maybeQueueCourseCompleted(db,user,courseId){
  const course=db.courses.find(c=>c.id===courseId); if(!course) return null;
  const completion=courseCompletionStatus(db,user,courseId);
  if(!completion.eligible) return null;
  const alreadyCompleted=(db.emailOutbox||[]).some(e=>e.userId===user.id&&e.courseId===courseId&&e.type==='course_completed');
  if(!alreadyCompleted)queueEmail(db,{to:user.email,type:'course_completed',userId:user.id,courseId});
  let cert=db.certificates.find(c=>c.userId===user.id&&c.courseId===courseId&&c.status!=='revoked');
  if(course.certificateEnabled!==false&&!cert){
    cert={id:newId(),code:certificateCode(),userId:user.id,courseId,status:'valid',issuedAt:now(),createdAt:now()};
    db.certificates.push(cert);
    db.activity.push({id:newId(),userId:user.id,type:'certificate_issued',label:`Certificado emitido automáticamente: ${course.title}`,at:now()});
    queueEmail(db,{to:user.email,type:'certificate',userId:user.id,courseId,meta:{certificateCode:cert.code}});
  }
  return cert;
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
function courseHasPublishedContent(db,courseId){
  const publishedModuleIds=db.modules.filter(m=>m.courseId===courseId&&m.status==='published').map(m=>m.id);
  return db.lessons.some(l=>l.courseId===courseId&&l.status==='published'&&publishedModuleIds.includes(l.moduleId));
}
function courseSaleReadiness(db,course,{ignorePublication=false}={}){
  if(!course)return {ready:false,reasons:['Curso no encontrado']};
  if(course.slug!=='piel-perfecta-20')return {ready:courseHasPublishedContent(db,course.id),reasons:courseHasPublishedContent(db,course.id)?[]:['No hay contenido publicado']};
  const modules=db.modules.filter(m=>m.courseId===course.id);
  const lessons=db.lessons.filter(l=>l.courseId===course.id);
  const lessonIds=new Set(lessons.map(l=>l.id));
  const assessments=db.assessments.filter(a=>a.scopeType==='lesson'&&lessonIds.has(a.scopeId));
  const assessmentIds=new Set(assessments.map(a=>a.id));
  const generatedResources=lessons.flatMap(l=>(l.resources||[]).filter(r=>r.generatedKey?.startsWith('piel-perfecta:')));
  const reasons=[];
  if(modules.length!==11)reasons.push('La estructura debe tener 11 módulos');
  if(lessons.length!==33)reasons.push('La estructura debe tener 33 clases');
  if(!ignorePublication&&modules.some(m=>m.status!=='published'))reasons.push('Todos los módulos deben estar publicados');
  if(!ignorePublication&&lessons.some(l=>l.status!=='published'))reasons.push('Todas las clases deben estar publicadas');
  const lessonsWithoutVideo=lessons.filter(l=>lessonVideos(l).length===0);
  if(lessonsWithoutVideo.length)reasons.push('Faltan vídeos en '+lessonsWithoutVideo.length+' clases');
  if(generatedResources.length<11)reasons.push('Faltan recursos descargables');
  if(assessments.length!==10)reasons.push('Deben existir 9 tests y el proyecto final');
  if(!ignorePublication&&assessments.some(a=>a.status!=='published'))reasons.push('Todas las evaluaciones deben estar publicadas');
  const qCount=db.questions.filter(q=>assessmentIds.has(q.assessmentId)).length;
  if(qCount!==50)reasons.push('Las evaluaciones deben sumar 50 preguntas/criterios');
  if(lessons.some(l=>l.tutorApproved!==true||!String(l.tutorContent||'').trim()))reasons.push('El tutor debe estar aprobado en las 33 clases');
  if(course.sequentialAccess!==true)reasons.push('El acceso secuencial debe estar activado');
  return {ready:reasons.length===0,reasons,modules:modules.length,lessons:lessons.length,lessonsWithVideo:lessons.length-lessonsWithoutVideo.length,assessments:assessments.length,questions:qCount,resources:generatedResources.length,tutorApproved:lessons.filter(l=>l.tutorApproved===true&&String(l.tutorContent||'').trim()).length};
}

function canonicalizeTransferValue(value){
  if(Array.isArray(value)) return value.map(canonicalizeTransferValue);
  if(value&&typeof value==='object'){
    const out={};
    Object.keys(value).sort().forEach(k=>{ if(value[k]!==undefined) out[k]=canonicalizeTransferValue(value[k]); });
    return out;
  }
  return value;
}
function transferChecksum(value){
  return crypto.createHash('sha256').update(JSON.stringify(canonicalizeTransferValue(value))).digest('hex');
}
function fingerprintValue(value){
  const raw=String(value||'');
  return raw?crypto.createHash('sha256').update(raw).digest('hex').slice(0,20):null;
}
function currentTransferStorageFingerprint(){
  let databaseTarget=null;
  try{
    const u=new URL(DATABASE_URL);
    databaseTarget=u.protocol+'//'+u.hostname+(u.port?':'+u.port:'')+u.pathname;
  }catch{}
  const blobCredential=process.env.BLOB_READ_WRITE_TOKEN||process.env.VERCEL_BLOB_READ_WRITE_TOKEN||'';
  return {
    database:fingerprintValue(databaseTarget),
    blobCredential:fingerprintValue(blobCredential),
    storageBackend:STORAGE_BACKEND,
    fileBackend:FILE_BACKEND
  };
}
function buildCourseTransferPackage(db,slug='piel-perfecta-20'){
  const course=db.courses.find(c=>c.slug===slug);
  if(!course) return null;
  const modules=db.modules.filter(m=>m.courseId===course.id).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0));
  const moduleRows=modules.map(module=>({
    code:module.code,
    title:module.title,
    position:Number(module.position)||0,
    sourceStatus:module.status,
    lessons:db.lessons.filter(l=>l.moduleId===module.id).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0)).map(lesson=>{
      const assessment=assessmentForScope(db,'lesson',lesson.id);
      return {
        code:lesson.code,
        title:lesson.title,
        summary:lesson.summary||'',
        position:Number(lesson.position)||0,
        durationMinutes:Number(lesson.durationMinutes)||0,
        sourceStatus:lesson.status,
        tutorApproved:lesson.tutorApproved===true,
        tutorContent:String(lesson.tutorContent||''),
        plannedResources:Array.isArray(lesson.plannedResources)?lesson.plannedResources.map(x=>({...x})):[],
        videos:lessonVideos(lesson).map(v=>({
          ref:String(v.ref||''),
          name:String(v.name||''),
          mime:String(v.mime||'video/mp4'),
          size:Number(v.size)||null,
          position:Number(v.position)||0
        })),
        resources:(lesson.resources||[]).map(r=>({
          name:String(r.name||''),
          mime:String(r.mime||'application/octet-stream'),
          size:Number(r.size)||null,
          generatedKey:r.generatedKey||null,
          storageName:r.storageName||null
        })),
        assessment:assessment?{
          title:assessment.title,
          instructions:assessment.instructions||'',
          passingScore:Number(assessment.passingScore)||0,
          maxAttempts:Number(assessment.maxAttempts)||0,
          sourceStatus:assessment.status,
          questions:db.questions.filter(q=>q.assessmentId===assessment.id).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0)).map(q=>({
            prompt:q.prompt,
            type:q.type||'single_choice',
            options:Array.isArray(q.options)?q.options.slice():[],
            correctOption:Number(q.correctOption)||0,
            explanation:q.explanation||'',
            position:Number(q.position)||0
          }))
        }:null
      };
    })
  }));
  const allLessons=moduleRows.flatMap(m=>m.lessons);
  const videoRefs=allLessons.flatMap(l=>l.videos).filter(v=>String(v.ref||'').startsWith('blob:'));
  const resourceRefs=allLessons.flatMap(l=>l.resources).filter(r=>r.storageName);
  const readiness=courseSaleReadiness(db,course);
  const core={
    format:'lykios-course-transfer-v1',
    exportedAt:now(),
    source:{
      environment:VERCEL_ENV||NODE_ENV,
      appVersion:APP_VERSION,
      schemaVersion:db.meta?.schemaVersion||null,
      storage:currentTransferStorageFingerprint()
    },
    course:{
      slug:course.slug,
      title:course.title,
      subtitle:course.subtitle||'',
      description:course.description||'',
      priceCents:Number(course.priceCents)||0,
      currency:course.currency||'EUR',
      certificateEnabled:course.certificateEnabled!==false,
      sequentialAccess:course.sequentialAccess===true,
      sourceStatus:course.status,
      sourceSaleEnabled:course.saleEnabled!==false,
      modules:moduleRows
    },
    readiness,
    manifest:{
      modules:moduleRows.length,
      lessons:allLessons.length,
      videos:videoRefs.length,
      videoBytes:videoRefs.reduce((n,v)=>n+(Number(v.size)||0),0),
      resources:allLessons.reduce((n,l)=>n+l.resources.length,0),
      physicalResources:resourceRefs.length,
      assessments:allLessons.filter(l=>l.assessment).length,
      questions:allLessons.reduce((n,l)=>n+(l.assessment?.questions?.length||0),0)
    }
  };
  return {...core,checksum:{algorithm:'sha256',value:transferChecksum(core)}};
}
function transferTargetUsage(db,course){
  if(!course)return {enrollments:0,orders:0,certificates:0,progress:0,attempts:0};
  const lessonIds=new Set(db.lessons.filter(l=>l.courseId===course.id).map(l=>l.id));
  const assessmentIds=new Set(db.assessments.filter(a=>a.scopeType==='lesson'&&lessonIds.has(a.scopeId)).map(a=>a.id));
  const enrollmentIds=new Set(db.enrollments.filter(e=>e.courseId===course.id).map(e=>e.id));
  return {
    enrollments:enrollmentIds.size,
    orders:(db.orders||[]).filter(o=>o.courseId===course.id).length,
    certificates:(db.certificates||[]).filter(c=>c.courseId===course.id).length,
    progress:(db.progress||[]).filter(p=>enrollmentIds.has(p.enrollmentId)).length,
    attempts:(db.attempts||[]).filter(a=>assessmentIds.has(a.assessmentId)).length
  };
}
async function verifyTransferBlobRefs(pkg){
  const refs=[];
  for(const module of pkg?.course?.modules||[]){
    for(const lesson of module.lessons||[]){
      for(const video of lesson.videos||[]){
        if(String(video.ref||'').startsWith('blob:')) refs.push({kind:'video',ref:String(video.ref).slice(5),name:video.name||lesson.code,expectedSize:Number(video.size)||null});
      }
      for(const resource of lesson.resources||[]){
        if(resource.storageName) refs.push({kind:'resource',ref:String(resource.storageName),name:resource.name||lesson.code,expectedSize:Number(resource.size)||null});
      }
    }
  }
  if(!refs.length) return {checked:0,accessible:0,missing:[],sizeMismatch:[]};
  if(FILE_BACKEND!=='blob') return {checked:refs.length,accessible:0,missing:refs.map(x=>({...x,reason:'El entorno destino no usa Vercel Blob'})),sizeMismatch:[]};
  const {head}=await import('@vercel/blob');
  const results=await Promise.all(refs.map(async item=>{
    try{
      const meta=await head(item.ref);
      return {...item,ok:true,actualSize:Number(meta?.size)||null};
    }catch(error){
      return {...item,ok:false,reason:error?.message||'Blob no accesible'};
    }
  }));
  return {
    checked:results.length,
    accessible:results.filter(x=>x.ok).length,
    missing:results.filter(x=>!x.ok).map(({ok,...x})=>x),
    sizeMismatch:results.filter(x=>x.ok&&x.expectedSize&&x.actualSize&&x.expectedSize!==x.actualSize).map(({ok,...x})=>x)
  };
}
async function validateCourseTransferPackage(db,pkg,{checkBlobs=true}={}){
  const issues=[],warnings=[];
  if(!pkg||pkg.format!=='lykios-course-transfer-v1') issues.push('Formato de paquete no compatible');
  const checksumValue=pkg?.checksum?.value;
  if(pkg&&checksumValue){
    const {checksum,...core}=pkg;
    if(transferChecksum(core)!==checksumValue) issues.push('El checksum del paquete no coincide');
  }else issues.push('El paquete no incluye checksum');
  if(pkg?.course?.slug!=='piel-perfecta-20') issues.push('El paquete no corresponde a Piel Perfecta 2.0');

  const modules=Array.isArray(pkg?.course?.modules)?pkg.course.modules:[];
  const lessons=modules.flatMap(m=>Array.isArray(m.lessons)?m.lessons:[]);
  const assessments=lessons.filter(l=>l.assessment);
  const questions=assessments.flatMap(l=>l.assessment?.questions||[]);
  const resources=lessons.flatMap(l=>l.resources||[]);
  const generatedResources=resources.filter(r=>String(r.generatedKey||'').startsWith('piel-perfecta:'));
  const tutorApproved=lessons.filter(l=>l.tutorApproved===true&&String(l.tutorContent||'').trim()).length;
  const lessonsWithVideo=lessons.filter(l=>(l.videos||[]).length>0).length;
  const moduleCodes=modules.map(m=>m.code),lessonCodes=lessons.map(l=>l.code);
  if(modules.length!==11) issues.push('Se esperaban 11 módulos y hay '+modules.length);
  if(lessons.length!==33) issues.push('Se esperaban 33 clases y hay '+lessons.length);
  if(new Set(moduleCodes).size!==moduleCodes.length) issues.push('Hay códigos de módulo duplicados');
  if(new Set(lessonCodes).size!==lessonCodes.length) issues.push('Hay códigos de clase duplicados');
  if(lessonsWithVideo!==33) issues.push('Faltan vídeos en '+(33-lessonsWithVideo)+' clases');
  if(generatedResources.length<11) issues.push('Faltan recursos generados de Piel Perfecta');
  if(assessments.length!==10) issues.push('Se esperaban 10 evaluaciones y hay '+assessments.length);
  if(questions.length!==50) issues.push('Se esperaban 50 preguntas/criterios y hay '+questions.length);
  if(tutorApproved!==33) issues.push('El Tutor IA solo está aprobado en '+tutorApproved+'/33 clases');
  if(pkg?.course?.sequentialAccess!==true) issues.push('La ruta secuencial no está activada');
  if(pkg?.readiness?.ready!==true) issues.push('El paquete se exportó antes de superar el checklist de lanzamiento en Preview');

  const currentStorage=currentTransferStorageFingerprint();
  const sourceStorage=pkg?.source?.storage||{};
  const sharedDatabase=Boolean(sourceStorage.database&&currentStorage.database&&sourceStorage.database===currentStorage.database);
  const sameBlobCredential=Boolean(sourceStorage.blobCredential&&currentStorage.blobCredential&&sourceStorage.blobCredential===currentStorage.blobCredential);
  if(sharedDatabase&&String(pkg?.source?.environment)!==String(VERCEL_ENV||NODE_ENV)) warnings.push('Origen y destino apuntan a la misma base de datos; no debe ejecutarse una importación destructiva');

  const media=checkBlobs?await verifyTransferBlobRefs(pkg):{checked:0,accessible:0,missing:[],sizeMismatch:[]};
  if(checkBlobs&&media.missing.length) issues.push(media.missing.length+' archivos Blob no son accesibles desde este entorno');
  if(checkBlobs&&media.sizeMismatch.length) issues.push(media.sizeMismatch.length+' archivos Blob no coinciden en tamaño');

  const target=db.courses.find(c=>c.slug==='piel-perfecta-20')||null;
  const targetUsage=transferTargetUsage(db,target);
  const targetHasUserData=Object.values(targetUsage).some(n=>Number(n)>0);
  if(targetHasUserData&&IS_PROD) issues.push('El curso destino ya tiene actividad de alumnos o ventas y no puede reemplazarse automáticamente');
  else if(targetHasUserData) warnings.push('Hay actividad de prueba en el curso de este entorno; no forma parte del paquete exportado');

  const packageValid=issues.length===0;
  const productionTransfer=IS_PROD&&pkg?.source?.environment==='preview';
  return {
    packageValid,
    canImport:packageValid&&productionTransfer&&!sharedDatabase&&!targetHasUserData,
    environment:VERCEL_ENV||NODE_ENV,
    sourceEnvironment:pkg?.source?.environment||null,
    counts:{modules:modules.length,lessons:lessons.length,lessonsWithVideo,resources:resources.length,generatedResources:generatedResources.length,assessments:assessments.length,questions:questions.length,tutorApproved},
    storage:{source:sourceStorage,current:currentStorage,sharedDatabase,sameBlobCredential},
    media,
    target:{exists:Boolean(target),usage:targetUsage},
    issues,
    warnings
  };
}
async function createCourseTransferBackup(db){
  if(FILE_BACKEND!=='blob') throw new Error('Production requiere Vercel Blob para crear el backup previo');
  const exportedAt=now();
  const payload={format:'lykios-state-backup-v1',reason:'before-course-transfer',appVersion:APP_VERSION,exportedAt,schemaVersion:db.meta?.schemaVersion||null,storageVersion:Number(db.__storageVersion)||null,data:db};
  const body=JSON.stringify(payload,null,2)+'\n';
  const checksum=crypto.createHash('sha256').update(body).digest('hex');
  const stamp=exportedAt.replace(/[:.]/g,'-');
  const pathname='backups/course-transfer/lykios-before-piel-perfecta-'+stamp+'.json';
  const {put,head}=await import('@vercel/blob');
  const saved=await put(pathname,Buffer.from(body,'utf8'),{access:'private',contentType:'application/json',addRandomSuffix:false});
  const meta=await head(saved.pathname||pathname);
  if(!meta||Number(meta.size)!==Buffer.byteLength(body,'utf8')) throw new Error('No se pudo verificar el backup previo a la importación');
  return {pathname:saved.pathname||pathname,sha256:checksum,bytes:Number(meta.size)||Buffer.byteLength(body,'utf8'),exportedAt};
}
async function importCourseTransferPackage(db,pkg){
  const existing=db.courses.find(c=>c.slug==='piel-perfecta-20')||null;
  const t=now();
  const courseId=existing?.id||newId();
  const oldLessonIds=new Set(existing?db.lessons.filter(l=>l.courseId===courseId).map(l=>l.id):[]);
  const oldAssessmentIds=new Set(db.assessments.filter(a=>a.scopeType==='lesson'&&oldLessonIds.has(a.scopeId)).map(a=>a.id));
  const oldModuleIds=new Set(existing?db.modules.filter(m=>m.courseId===courseId).map(m=>m.id):[]);

  db.questions=db.questions.filter(q=>!oldAssessmentIds.has(q.assessmentId));
  db.attempts=db.attempts.filter(a=>!oldAssessmentIds.has(a.assessmentId));
  db.assessments=db.assessments.filter(a=>!oldAssessmentIds.has(a.id));
  db.videoProgress=(db.videoProgress||[]).filter(v=>!oldLessonIds.has(v.lessonId));
  db.progress=(db.progress||[]).filter(p=>!oldLessonIds.has(p.lessonId));
  db.lessons=db.lessons.filter(l=>!oldLessonIds.has(l.id));
  db.modules=db.modules.filter(m=>!oldModuleIds.has(m.id));
  db.tutorQueries=(db.tutorQueries||[]).filter(q=>q.courseId!==courseId&&!oldLessonIds.has(q.lessonId));
  const remainingQueryIds=new Set((db.tutorQueries||[]).map(q=>q.id));
  db.tutorFeedback=(db.tutorFeedback||[]).filter(f=>remainingQueryIds.has(f.queryId));

  const source=pkg.course;
  const course={...(existing||{}),id:courseId,slug:'piel-perfecta-20',title:cleanText(source.title,180),subtitle:cleanText(source.subtitle,300),description:cleanText(source.description,3000),priceCents:Math.max(0,Math.round(Number(source.priceCents)||0)),currency:cleanText(source.currency||'EUR',10)||'EUR',certificateEnabled:source.certificateEnabled!==false,sequentialAccess:source.sequentialAccess===true,status:'draft',saleEnabled:false,createdAt:existing?.createdAt||t,updatedAt:t,importedFrom:'preview',importedAt:t};
  if(existing){
    const idx=db.courses.findIndex(c=>c.id===courseId);
    db.courses[idx]=course;
  }else db.courses.push(course);

  for(const moduleSource of source.modules||[]){
    const moduleId=newId();
    const module={id:moduleId,courseId,code:cleanText(moduleSource.code,40),title:cleanText(moduleSource.title,220),position:Number(moduleSource.position)||positionOf(db.modules,m=>m.courseId===courseId),status:'draft',createdAt:t,updatedAt:t};
    db.modules.push(module);
    for(const lessonSource of moduleSource.lessons||[]){
      const lessonId=newId();
      const lesson={
        id:lessonId,moduleId,courseId,
        code:cleanText(lessonSource.code,40),
        title:cleanText(lessonSource.title,220),
        summary:cleanText(lessonSource.summary,5000),
        position:Number(lessonSource.position)||positionOf(db.lessons,l=>l.moduleId===moduleId),
        status:'draft',
        durationMinutes:Math.max(1,Number(lessonSource.durationMinutes)||1),
        videos:(lessonSource.videos||[]).map((v,i)=>({id:newId(),ref:cleanText(v.ref,1200),name:cleanText(v.name||('Vídeo '+(i+1)),220),mime:cleanText(v.mime||'video/mp4',120),size:Number(v.size)||null,position:Number(v.position)||i+1,createdAt:t})),
        resources:(lessonSource.resources||[]).map(r=>({id:newId(),name:cleanText(r.name,220),mime:cleanText(r.mime,120),size:Number(r.size)||null,generatedKey:r.generatedKey?cleanText(r.generatedKey,220):null,storageName:r.storageName?cleanText(r.storageName,1200):null,createdAt:t})),
        plannedResources:Array.isArray(lessonSource.plannedResources)?lessonSource.plannedResources.map(x=>({...x})):[],
        tutorApproved:lessonSource.tutorApproved===true,
        tutorContent:cleanText(lessonSource.tutorContent,20000),
        tutorApprovedAt:lessonSource.tutorApproved===true?t:null,
        createdAt:t,updatedAt:t
      };
      syncPrimaryVideoFields(lesson);
      db.lessons.push(lesson);
      if(lessonSource.assessment){
        const a=lessonSource.assessment;
        const assessmentId=newId();
        db.assessments.push({id:assessmentId,scopeType:'lesson',scopeId:lessonId,title:cleanText(a.title,220),instructions:cleanText(a.instructions,3000),passingScore:Math.max(1,Math.min(100,Number(a.passingScore)||80)),maxAttempts:Math.max(0,Number(a.maxAttempts)||0),status:'draft',createdAt:t,updatedAt:t});
        (a.questions||[]).forEach((q,i)=>db.questions.push({id:newId(),assessmentId,prompt:cleanText(q.prompt,4000),type:'single_choice',options:Array.isArray(q.options)?q.options.map(x=>cleanText(x,1000)):[],correctOption:Math.max(0,Number(q.correctOption)||0),explanation:cleanText(q.explanation,4000),position:Number(q.position)||i+1,createdAt:t,updatedAt:t}));
      }
    }
  }
  db.meta ||= {};
  db.meta.courseTransferHistory ||= [];
  db.meta.courseTransferHistory.push({id:newId(),courseId,slug:course.slug,importedAt:t,sourceEnvironment:pkg.source?.environment||null,sourceExportedAt:pkg.exportedAt||null,checksum:pkg.checksum?.value||null});
  if(db.meta.courseTransferHistory.length>30) db.meta.courseTransferHistory=db.meta.courseTransferHistory.slice(-30);
  return course;
}

function courseSaleEnabledForEnv(db,course){
  if(course?.saleEnabled!==false)return true;
  return Boolean(IS_PREVIEW&&(db.meta?.previewSaleCourseSlugs||[]).includes(course?.slug));
}
function catalogPayload(db){
  const courses=db.courses.filter(c=>c.status==='published'&&courseSaleEnabledForEnv(db,c)&&courseSaleReadiness(db,c).ready).map(c=>{const pr=pricingFor(db,'course',c);return {type:'course',id:c.id,slug:c.slug,title:c.title,subtitle:c.subtitle||'',description:c.description||'',priceCents:pr.finalCents,basePriceCents:pr.baseCents,currency:c.currency||'EUR',priceLabel:money(pr.finalCents,c.currency||'EUR'),basePriceLabel:money(pr.baseCents,c.currency||'EUR'),promotion:pr.promo?{id:pr.promo.id,name:pr.promo.name,badge:pr.promo.badge||'Oferta'}:null};});
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
function checkoutMock(db,body,{suppressEmails=false}={}){
  const itemType=body.itemType==='bundle'?'bundle':'course';
  const target=itemType==='bundle'
    ?(db.bundles||[]).find(b=>b.slug===cleanText(body.itemSlug||body.bundleSlug,120)&&b.status==='published'&&b.saleEnabled!==false)
    :db.courses.find(c=>c.slug===cleanText(body.itemSlug||body.courseSlug,120)&&c.status==='published'&&courseSaleEnabledForEnv(db,c));
  if(!target) return {error:itemType==='bundle'?'Pack no disponible':'Curso no disponible para compra',status:404};
  if(itemType==='course'){
    const readiness=courseSaleReadiness(db,target);
    if(!readiness.ready)return {error:'Curso todavía no disponible para compra: '+readiness.reasons.join(' · '),status:409};
  }
  const email=cleanText(body.email,220).toLowerCase(); const firstName=cleanText(body.firstName,120); const lastName=cleanText(body.lastName,120); const password=String(body.password||'');
  if(!email||!email.includes('@')||!firstName) return {error:'Completa nombre y email',status:400};
  let user=db.users.find(u=>u.email.toLowerCase()===email);
  if(!user){const policy=passwordPolicy(password);if(policy)return {error:policy,status:400};const hp=hashPassword(password);user={id:newId(),email,firstName,lastName,role:'student',status:'active',lastLoginAt:null,failedLoginCount:0,failedLoginWindowStartedAt:null,loginLockedUntil:null,passwordResetLastSentAt:null,passwordSalt:hp.salt,passwordHash:hp.hash,createdAt:now()};db.users.push(user);}else{if(user.role!=='student')return {error:'Usa una cuenta de alumno para comprar cursos',status:409};if((user.status||'active')!=='active')return {error:'Cuenta bloqueada. Contacta con Lykios Academy.',status:403};if(!verifyPassword(password,user.passwordSalt,user.passwordHash))return {error:'Ese email ya tiene una cuenta. Introduce su contraseña correcta.',status:401};}

  const courseIds=itemType==='bundle'?(target.courseIds||[]):[target.id];
  const validCourses=courseIds.map(id=>db.courses.find(c=>c.id===id&&c.status==='published')).filter(Boolean);
  if(!validCourses.length)return {error:'No hay cursos disponibles en este producto',status:409};
  if(validCourses.some(c=>!courseHasPublishedContent(db,c.id)))return {error:'Este curso todavía está en preparación y no admite nuevas matrículas',status:409};
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
  if(!suppressEmails){
    const isFirstWelcome=!(db.emailOutbox||[]).some(e=>e.userId===user.id&&e.type==='welcome');
    if(isFirstWelcome) queueEmail(db,{to:user.email,type:'welcome',userId:user.id});
    queueEmail(db,{to:user.email,type:'purchase',userId:user.id,courseId:missingCourses[0]?.id||null,meta:{orderNumber:order.number,courseTitle:target.title}});
    markLocalEmailsSent(db);
  }
  const managed=createManagedSession(db,user,{context:body.__sessionContext||null,source:'checkout',notifyNewDevice:true});
  return {user,target,order,payment,enrollments,token:managed.token};
}

async function performMockCheckout(body,{suppressEmails=false}={}){
  for(let attempt=0;attempt<3;attempt++){
    const workDb=await readDb();
    const result=checkoutMock(workDb,body,{suppressEmails});
    if(result.error)return {status:result.status||400,body:{error:result.error}};
    try{
      await writeDb(workDb);
      return {
        status:201,
        body:{
          ok:true,
          user:{id:result.user.id,email:result.user.email,firstName:result.user.firstName,role:result.user.role},
          item:{type:body.itemType==='bundle'?'bundle':'course',slug:result.target.slug,title:result.target.title},
          order:result.order,
          enrollments:result.enrollments
        },
        token:result.token
      };
    }catch(error){
      if(error?.code==='STORAGE_CONFLICT'&&attempt<2)continue;
      throw error;
    }
  }
  return {status:503,body:{error:'El Campus está procesando otra matrícula. Inténtalo de nuevo.'}};
}

async function performAssessmentSubmit(userId,body){
  for(let attemptNo=0;attemptNo<3;attemptNo++){
    const workDb=await readDb();
    const workUser=workDb.users.find(u=>u.id===userId);
    const assessment=workDb.assessments.find(a=>a.id===body.assessmentId);
    if(!workUser||!assessment||!visibleAssessment(workDb,workUser,assessment))return {status:404,body:{error:'Evaluación no disponible'}};
    const prior=workDb.attempts.filter(a=>a.assessmentId===assessment.id&&a.userId===workUser.id);
    if(prior.some(a=>a.passed))return {status:409,body:{error:'Esta evaluación ya está aprobada'}};
    if(assessment.maxAttempts>0&&prior.length>=assessment.maxAttempts)return {status:409,body:{error:'Has alcanzado el número máximo de intentos'}};
    const questions=workDb.questions.filter(q=>q.assessmentId===assessment.id).sort((a,b)=>a.position-b.position);
    if(!questions.length)return {status:409,body:{error:'La evaluación no tiene preguntas'}};
    const answers=body.answers&&typeof body.answers==='object'?body.answers:{};
    let correct=0;
    const review=questions.map(q=>{
      const selected=Number(answers[q.id]);
      const ok=Number.isInteger(selected)&&selected===q.correctOption;
      if(ok)correct++;
      return {questionId:q.id,selectedOption:Number.isInteger(selected)?selected:null,correct:ok,correctOption:q.correctOption,explanation:q.explanation||''};
    });
    const score=Math.round(correct/questions.length*100);
    const passed=score>=assessment.passingScore;
    const attempt={id:newId(),assessmentId:assessment.id,userId:workUser.id,score,passed,answers:review,submittedAt:now()};
    workDb.attempts.push(attempt);
    workDb.activity.push({id:newId(),userId:workUser.id,type:'assessment_submitted',label:`Evaluación: ${assessment.title} · ${score}%`,at:now()});
    let assessmentCourseId=null,lessonCompletion=null;
    if(assessment.scopeType==='lesson'){
      const lesson=workDb.lessons.find(l=>l.id===assessment.scopeId);
      assessmentCourseId=lesson?.courseId||null;
      if(lesson)lessonCompletion=syncLessonCompletion(workDb,workUser,lesson).status;
    }else assessmentCourseId=workDb.modules.find(m=>m.id===assessment.scopeId)?.courseId||null;
    if(assessmentCourseId)maybeQueueCourseCompleted(workDb,workUser,assessmentCourseId);
    markLocalEmailsSent(workDb);
    try{
      await writeDb(workDb);
      const attemptsUsed=prior.length+1;
      const attemptsRemaining=assessment.maxAttempts>0?Math.max(0,assessment.maxAttempts-attemptsUsed):null;
      const revealAnswers=passed||(attemptsRemaining===0);
      const publicAnswers=review.map(r=>revealAnswers?r:{questionId:r.questionId,selectedOption:r.selectedOption,correct:r.correct});
      return {status:200,body:{attempt:{...attempt,answers:publicAnswers},passingScore:assessment.passingScore,attemptsUsed,attemptsRemaining,revealAnswers,lessonCompletion}};
    }catch(error){
      if(error?.code==='STORAGE_CONFLICT'&&attemptNo<2)continue;
      throw error;
    }
  }
  return {status:503,body:{error:'El Campus está registrando otra evaluación. Inténtalo de nuevo.'}};
}

async function cleanupSyntheticTestUser(email){
  for(let attempt=0;attempt<3;attempt++){
    const db=await readDb();
    const user=db.users.find(u=>u.email.toLowerCase()===String(email).toLowerCase());
    if(!user)return true;
    const enrollmentIds=db.enrollments.filter(e=>e.userId===user.id).map(e=>e.id);
    const orderIds=db.orders.filter(o=>o.userId===user.id).map(o=>o.id);
    db.progress=db.progress.filter(p=>!enrollmentIds.includes(p.enrollmentId));
    db.videoProgress=(db.videoProgress||[]).filter(v=>v.userId!==user.id);
    db.attempts=db.attempts.filter(a=>a.userId!==user.id);
    db.certificates=db.certificates.filter(x=>x.userId!==user.id);
    db.activity=db.activity.filter(a=>a.userId!==user.id);
    db.enrollments=db.enrollments.filter(e=>e.userId!==user.id);
    db.payments=db.payments.filter(p=>p.userId!==user.id&&!orderIds.includes(p.orderId));
    db.orders=db.orders.filter(o=>o.userId!==user.id);
    db.couponRedemptions=(db.couponRedemptions||[]).filter(r=>r.userId!==user.id&&!orderIds.includes(r.orderId));
    db.emailOutbox=(db.emailOutbox||[]).filter(e=>e.userId!==user.id);
    db.passwordResetTokens=(db.passwordResetTokens||[]).filter(t=>t.userId!==user.id);
    db.sessions=db.sessions.filter(s=>s.userId!==user.id);
    db.knownDevices=(db.knownDevices||[]).filter(d=>d.userId!==user.id);
    db.securityEvents=(db.securityEvents||[]).filter(e=>e.userId!==user.id);
    db.videoLeases=(db.videoLeases||[]).filter(l=>l.userId!==user.id);
    db.studentNotes=(db.studentNotes||[]).filter(n=>n.userId!==user.id);
    db.tutorQueries=(db.tutorQueries||[]).filter(q=>q.userId!==user.id);
    db.tutorFeedback=(db.tutorFeedback||[]).filter(x=>x.userId!==user.id);
    db.users=db.users.filter(u=>u.id!==user.id);
    try{
      await writeDb(db);
      return true;
    }catch(error){
      if(error?.code==='STORAGE_CONFLICT'&&attempt<2)continue;
      throw error;
    }
  }
  return false;
}

function prepareCheckout(db,body){
  const itemType=body.itemType==='bundle'?'bundle':'course';
  const target=itemType==='bundle'
    ?(db.bundles||[]).find(b=>b.slug===cleanText(body.itemSlug||body.bundleSlug,120)&&b.status==='published'&&b.saleEnabled!==false)
    :db.courses.find(c=>c.slug===cleanText(body.itemSlug||body.courseSlug,120)&&c.status==='published'&&courseSaleEnabledForEnv(db,c));
  if(!target) return {error:itemType==='bundle'?'Pack no disponible':'Curso no disponible para compra',status:404};
  const email=cleanText(body.email,220).toLowerCase(); const firstName=cleanText(body.firstName,120); const lastName=cleanText(body.lastName,120); const password=String(body.password||'');
  if(!email||!email.includes('@')||!firstName) return {error:'Completa nombre y email',status:400};
  let user=db.users.find(u=>u.email.toLowerCase()===email);
  if(!user){const policy=passwordPolicy(password);if(policy)return {error:policy,status:400};const hp=hashPassword(password);user={id:newId(),email,firstName,lastName,role:'student',status:'active',lastLoginAt:null,failedLoginCount:0,failedLoginWindowStartedAt:null,loginLockedUntil:null,passwordResetLastSentAt:null,passwordSalt:hp.salt,passwordHash:hp.hash,createdAt:now()};db.users.push(user);}else{if(user.role!=='student')return {error:'Usa una cuenta de alumno para comprar cursos',status:409};if((user.status||'active')!=='active')return {error:'Cuenta bloqueada. Contacta con Lykios Academy.',status:403};if(!verifyPassword(password,user.passwordSalt,user.passwordHash))return {error:'Ese email ya tiene una cuenta. Introduce su contraseña correcta.',status:401};}
  const courseIds=itemType==='bundle'?(target.courseIds||[]):[target.id];
  const validCourses=courseIds.map(id=>db.courses.find(c=>c.id===id&&c.status==='published')).filter(Boolean);
  if(!validCourses.length)return {error:'No hay cursos disponibles en este producto',status:409};
  const activeOwned=new Set(db.enrollments.filter(e=>e.userId===user.id&&e.status==='active').map(e=>e.courseId));
  const missingCourses=validCourses.filter(c=>!activeOwned.has(c.id));
  if(!missingCourses.length)return {error:'Este usuario ya tiene acceso a todo el contenido incluido',status:409};

  // Un doble clic o reintento de red no debe crear dos pedidos Stripe.
  const pendingOrder=db.orders
    .filter(o=>o.userId===user.id&&o.itemType===itemType&&o.status==='pending_payment')
    .filter(o=>itemType==='course'?o.courseId===target.id:o.bundleId===target.id)
    .filter(o=>Date.now()-new Date(o.createdAt).getTime()<60*60*1000)
    .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))[0]||null;
  if(pendingOrder){
    const payment=db.payments.find(p=>p.orderId===pendingOrder.id)||null;
    const managed=createManagedSession(db,user,{context:body.__sessionContext||null,source:'checkout',notifyNewDevice:true});
    return {user,target,order:pendingOrder,payment,missingCourses,coupon:null,token:managed.token,reused:true};
  }

  const pr=pricingFor(db,itemType,target);
  const couponResult=validateCoupon(db,body.couponCode,{user,targetType:itemType,targetId:target.id,subtotalCents:pr.finalCents});
  if(couponResult.error)return couponResult;
  const couponDiscount=couponResult.discountCents||0;
  const total=Math.max(0,pr.finalCents-couponDiscount);
  const order={id:newId(),number:`ORD-${new Date().getFullYear()}-${String(db.orders.length+1).padStart(5,'0')}`,userId:user.id,courseId:itemType==='course'?target.id:null,bundleId:itemType==='bundle'?target.id:null,itemType,itemTitle:target.title,lineCourseIds:validCourses.map(c=>c.id),subtotalCents:pr.baseCents,promotionDiscountCents:pr.discountCents,couponDiscountCents:couponDiscount,discountCents:pr.discountCents+couponDiscount,couponCode:couponResult.coupon?.code||null,totalCents:total,currency:(target.currency||'EUR').toUpperCase(),status:total===0?'pending_free':'pending_payment',provider:total===0?'free':PAYMENT_PROVIDER,createdAt:now(),paidAt:null};
  const payment={id:newId(),orderId:order.id,userId:user.id,amountCents:order.totalCents,currency:order.currency,status:total===0?'pending':'pending',provider:total===0?'free':PAYMENT_PROVIDER,providerRef:null,createdAt:now()};
  db.orders.push(order); db.payments.push(payment);
  const managed=createManagedSession(db,user,{context:body.__sessionContext||null,source:'checkout',notifyNewDevice:true});
  return {user,target,order,payment,missingCourses,coupon:couponResult.coupon,token:managed.token};
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
  params.set('success_url',`${PUBLIC_APP_ORIGIN}/?payment=success&order=${encodeURIComponent(order.id)}`);
  params.set('cancel_url',`${PUBLIC_APP_ORIGIN}/?payment=cancel&order=${encodeURIComponent(order.id)}`);
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
function applyStripeRefund(db,order,charge,eventId){
  if(!order)return {error:'order_not_found'};
  const amountRefunded=Math.max(0,Number(charge?.amount_refunded)||0);
  const chargeAmount=Math.max(0,Number(charge?.amount)||Number(order.totalCents)||0);
  const fullyRefunded=charge?.refunded===true||(chargeAmount>0&&amountRefunded>=chargeAmount);
  const payment=db.payments.find(p=>p.orderId===order.id)||null;
  order.refundedAmountCents=amountRefunded;
  order.refundEventId=eventId||order.refundEventId||null;
  if(payment){
    payment.refundedAmountCents=amountRefunded;
    payment.refundEventId=eventId||payment.refundEventId||null;
  }
  if(!fullyRefunded){
    if(payment&&payment.status==='succeeded')payment.status='partially_refunded';
    return {ok:true,partial:true,amountRefundedCents:amountRefunded};
  }
  if(order.status==='refunded'){
    if(payment){payment.status='refunded';payment.refundedAt=payment.refundedAt||order.refundedAt||now();}
    return {ok:true,alreadyRefunded:true,amountRefundedCents:amountRefunded};
  }
  const t=now();
  order.status='refunded';
  order.refundedAt=t;
  if(payment){payment.status='refunded';payment.refundedAt=t;}
  const revoked=[],preserved=[];
  for(const courseId of order.lineCourseIds||[]){
    const enrollment=db.enrollments.find(e=>e.userId===order.userId&&e.courseId===courseId);
    if(!enrollment||enrollment.status!=='active')continue;
    if(enrollment.orderId!==order.id){preserved.push(courseId);continue;}
    const fallback=db.orders
      .filter(o=>o.id!==order.id&&o.userId===order.userId&&o.status==='paid'&&(o.lineCourseIds||[]).includes(courseId))
      .sort((a,b)=>new Date(b.paidAt||b.createdAt)-new Date(a.paidAt||a.createdAt))[0]||null;
    if(fallback){
      enrollment.orderId=fallback.id;
      preserved.push(courseId);
      continue;
    }
    enrollment.status='inactive';
    enrollment.refundedAt=t;
    enrollment.refundOrderId=order.id;
    revoked.push(courseId);
    const course=db.courses.find(c=>c.id===courseId);
    db.activity.push({id:newId(),userId:order.userId,type:'enrollment_refunded',label:`Acceso retirado por reembolso: ${course?.title||order.itemTitle||'Curso'}`,at:t});
    for(const cert of db.certificates||[]){
      if(cert.userId===order.userId&&cert.courseId===courseId&&(cert.status||'valid')!=='revoked'){
        cert.status='revoked';cert.revokedAt=t;cert.revocationReason='Pedido reembolsado';
      }
    }
  }
  return {ok:true,refunded:true,amountRefundedCents:amountRefunded,revokedCourseIds:revoked,preservedCourseIds:preserved};
}
async function handleStripeEvent(db,event){
  db.paymentEvents ||= []; if(db.paymentEvents.some(e=>e.provider==='stripe'&&e.eventId===event.id))return {duplicate:true};
  const object=event?.data?.object||{};
  let order=null,result={ignored:true};
  if(['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired'].includes(event.type)){
    const orderId=object?.metadata?.order_id||object?.client_reference_id;
    order=db.orders.find(o=>o.id===orderId)||null;
    if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)){
      if(!order) result={error:'order_not_found'};
      else if(Number(object.amount_total)!==Number(order.totalCents)||String(object.currency||'').toUpperCase()!==String(order.currency||'').toUpperCase()){markPaymentFailed(db,order,'Importe o moneda no coinciden',object.id);result={error:'amount_mismatch'};}
      else if(event.type==='checkout.session.completed'&&object.payment_status!=='paid'){result={pending:true};}
      else result=fulfillOrder(db,order,{providerRef:object.payment_intent||object.id,eventId:event.id});
    }else{
      if(order)markPaymentFailed(db,order,event.type,object.id);
      result={failed:true};
    }
  }else if(event.type==='charge.refunded'){
    const paymentIntent=typeof object.payment_intent==='string'?object.payment_intent:object.payment_intent?.id;
    const payment=(db.payments||[]).find(p=>p.provider==='stripe'&&(p.providerRef===paymentIntent||p.providerRef===object.id))||null;
    order=payment?db.orders.find(o=>o.id===payment.orderId)||null:(db.orders||[]).find(o=>o.providerRef===paymentIntent)||null;
    result=applyStripeRefund(db,order,object,event.id);
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
  const certificates=db.certificates.filter(c=>c.userId===user.id).map(c=>({...publicCertificate(db,c),id:c.id,courseId:c.courseId}));
  const orders=db.orders.filter(o=>o.userId===user.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(o=>{const c=db.courses.find(x=>x.id===o.courseId);return {...o,courseTitle:c?.title||'',totalLabel:money(o.totalCents,o.currency)};});
  const notes=(db.studentNotes||[]).filter(n=>n.userId===user.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const sessions=(db.sessions||[]).filter(x=>x.userId===user.id&&new Date(x.expiresAt)>new Date()).sort((a,b)=>new Date(b.lastSeenAt||b.createdAt)-new Date(a.lastSeenAt||a.createdAt)).map(x=>({id:x.id,deviceLabel:x.deviceLabel||'Sesión',ipLabel:x.ipLabel||'—',source:x.source||'login',createdAt:x.createdAt,lastSeenAt:x.lastSeenAt||x.createdAt,expiresAt:x.expiresAt}));
  const devices=(db.knownDevices||[]).filter(x=>x.userId===user.id).sort((a,b)=>new Date(b.lastSeenAt)-new Date(a.lastSeenAt)).map(x=>({id:x.id,label:x.label||'Dispositivo',ipLabel:x.lastIpLabel||'—',firstSeenAt:x.firstSeenAt,lastSeenAt:x.lastSeenAt,status:x.status||'known'}));
  const securityEvents=(db.securityEvents||[]).filter(x=>x.userId===user.id).sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,20).map(x=>({id:x.id,type:x.type,label:x.label,score:x.score||0,deviceLabel:x.deviceLabel||null,ipLabel:x.ipLabel||null,at:x.at}));
  const activePlayback=(db.videoLeases||[]).find(x=>x.userId===user.id&&new Date(x.expiresAt)>new Date())||null;
  return {id:user.id,email:user.email,firstName:user.firstName,lastName:user.lastName,role:user.role,status:user.status||'active',createdAt:user.createdAt,lastLoginAt:user.lastLoginAt||null,enrollments,attempts,certificates,orders,notes,security:{maxSessions:MAX_STUDENT_SESSIONS,activeSessions:sessions,knownDevices:devices,recentEvents:securityEvents,score1h:recentSecurityScore(db,user.id),activePlayback:activePlayback?{sessionId:activePlayback.sessionId,lessonId:activePlayback.lessonId,videoId:activePlayback.videoId,lastSeenAt:activePlayback.lastSeenAt,expiresAt:activePlayback.expiresAt}:null}};
}

function studentsAdminPayload(db){
  return db.users.filter(u=>u.role==='student').map(u=>{const p=studentAdminPayload(db,u);const recentAlerts=(p.security?.recentEvents||[]).filter(e=>(Number(e.score)||0)>=3&&Date.now()-new Date(e.at).getTime()<7*86400000).length;return {...p,activeEnrollments:p.enrollments.filter(e=>e.status==='active').length,avgProgress:p.enrollments.length?Math.round(p.enrollments.reduce((a,e)=>a+e.progressPercent,0)/p.enrollments.length):0,activeSessions:p.security?.activeSessions?.length||0,securityAlerts:recentAlerts};}).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
}

function mime(file){
  const ext=path.extname(file).toLowerCase();
  return ({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf','.ico':'image/x-icon'}[ext]||'application/octet-stream');
}
async function serveStatic(req,res){
  let p=new URL(req.url,'http://localhost').pathname;
  if(p==='/'||['/login','/dashboard','/courses','/course','/lesson','/profile','/admin','/store'].includes(p)) p='/index.html';
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
    if(IS_PREVIEW && url.pathname==='/api/public/security-self-check' && req.method==='GET'){
      const fake={
        sessions:[],knownDevices:[],securityEvents:[],videoLeases:[],emailOutbox:[],
        users:[],courses:[],lessons:[],modules:[],enrollments:[],progress:[],activity:[],certificates:[],orders:[],payments:[],assessments:[],questions:[],attempts:[],studentNotes:[],passwordResetTokens:[],videoProgress:[],bundles:[],coupons:[],promotions:[],couponRedemptions:[],teacherAssignments:[],tutorQueries:[],tutorFeedback:[],paymentEvents:[],meta:{schemaVersion:20}
      };
      const synthetic={id:'security-self-test',email:'security-self-test@example.invalid',firstName:'Security',lastName:'Test',role:'student',status:'active',lastLoginAt:null,createdAt:now()};
      fake.users.push(synthetic);
      const ctx=n=>({deviceKey:'device-'+n,deviceLabel:'Test device '+n,ipHash:'network-'+n,ipLabel:'10.0.'+n+'.x',userAgent:'self-test'});
      const a=createManagedSession(fake,synthetic,{context:ctx(1),source:'self-test',notifyNewDevice:false});
      synthetic.lastLoginAt=now();
      const b=createManagedSession(fake,synthetic,{context:ctx(2),source:'self-test',notifyNewDevice:false});
      const c=createManagedSession(fake,synthetic,{context:ctx(3),source:'self-test',notifyNewDevice:false});
      const active=fake.sessions.filter(x=>x.userId===synthetic.id);
      const first=active[0],second=active[1];
      const lease1=acquireVideoLease(fake,synthetic,first,{lessonId:'lesson-a',videoId:'video-a'});
      const lease2=acquireVideoLease(fake,synthetic,second,{lessonId:'lesson-b',videoId:'video-b'});
      const checks={
        maxTwoSessions:active.length===2,
        newestSessionRetained:active.some(x=>x.id===c.session.id),
        oldestSessionEvicted:!active.some(x=>x.id===a.session.id),
        firstPlaybackAllowed:lease1.ok===true,
        secondPlaybackBlocked:lease2.ok===false,
        noPreciseLocation:true
      };
      return json(res,Object.values(checks).every(Boolean)?200:500,{ok:Object.values(checks).every(Boolean),checks,activeSessions:active.length,securityEvents:fake.securityEvents.map(e=>({type:e.type,score:e.score}))});
    }
    if(IS_PREVIEW && url.pathname==='/api/public/video-provider-check' && req.method==='GET'){
      const configured={
        provider:VIDEO_PROVIDER,
        libraryId:BUNNY_STREAM_LIBRARY_ID||null,
        cdnHostname:BUNNY_STREAM_CDN_HOSTNAME||null,
        apiKey:Boolean(BUNNY_STREAM_API_KEY),
        tokenKey:Boolean(BUNNY_STREAM_TOKEN_KEY)
      };
      if(VIDEO_PROVIDER!=='bunny')return json(res,200,{ok:false,configured,reason:'El proveedor de vídeo de Preview todavía no es Bunny'});
      if(!BUNNY_STREAM_LIBRARY_ID||!BUNNY_STREAM_CDN_HOSTNAME||!BUNNY_STREAM_API_KEY||!BUNNY_STREAM_TOKEN_KEY){
        return json(res,200,{ok:false,configured,reason:'Faltan variables Bunny en Preview'});
      }
      try{
        const response=await fetch('https://video.bunnycdn.com/library/'+encodeURIComponent(BUNNY_STREAM_LIBRARY_ID)+'/videos?page=1&itemsPerPage=1',{
          headers:{AccessKey:BUNNY_STREAM_API_KEY,Accept:'application/json'}
        });
        const payload=await response.json().catch(()=>null);
        return json(res,response.ok?200:502,{
          ok:response.ok,
          configured,
          bunny:{reachable:true,status:response.status,totalItems:Number(payload?.totalItems??payload?.totalCount??0)||0},
          secretValuesExposed:false
        });
      }catch(error){
        return json(res,502,{ok:false,configured,bunny:{reachable:false},secretValuesExposed:false,error:cleanText(error?.message||'No se pudo contactar Bunny',220)});
      }
    }

    if(IS_PREVIEW && url.pathname==='/api/public/blob-usage-check' && req.method==='GET'){
      if(FILE_BACKEND!=='blob')return json(res,200,{blob:false,fileBackend:FILE_BACKEND});
      try{
        const {list}=await import('@vercel/blob');
        const db=await readDb();
        const referenced=new Set();
        const pielVideoRefs=new Set();
        for(const lesson of db.lessons||[]){
          for(const v of lessonVideos(lesson)){
            const ref=String(v.ref||'');
            if(ref.startsWith('blob:')){
              const pathname=ref.slice(5);
              referenced.add(pathname);
              if(lesson.courseId===db.courses.find(c=>c.slug==='piel-perfecta-20')?.id)pielVideoRefs.add(pathname);
            }
          }
          for(const r of lesson.resources||[])if(r.storageName)referenced.add(String(r.storageName));
        }
        let cursor,hasMore=true,totalBytes=0,totalFiles=0,pages=0;
        let referencedBytes=0,referencedFiles=0,orphanBytes=0,orphanFiles=0,pielBytes=0,pielFiles=0;
        const categories={videos:{files:0,bytes:0},backups:{files:0,bytes:0},other:{files:0,bytes:0}};
        while(hasMore&&pages<100){
          const page=await list({cursor,limit:1000});
          pages++;
          for(const blob of page.blobs||[]){
            const size=Math.max(0,Number(blob.size)||0);
            const p=String(blob.pathname||'');
            totalFiles++;totalBytes+=size;
            const bucket=p.startsWith('videos/')?'videos':p.startsWith('backups/')?'backups':'other';
            categories[bucket].files++;categories[bucket].bytes+=size;
            if(referenced.has(p)){referencedFiles++;referencedBytes+=size}else{orphanFiles++;orphanBytes+=size}
            if(pielVideoRefs.has(p)){pielFiles++;pielBytes+=size}
          }
          hasMore=Boolean(page.hasMore&&page.cursor);
          cursor=page.cursor;
        }
        const fmt=v=>({bytes:v,GB:Number((v/1000000000).toFixed(3)),GiB:Number((v/1073741824).toFixed(3))});
        return json(res,200,{
          blob:true,
          privateStore:true,
          totalFiles,...fmt(totalBytes),
          categories:Object.fromEntries(Object.entries(categories).map(([k,v])=>[k,{files:v.files,...fmt(v.bytes)}])),
          references:{
            referenced:{files:referencedFiles,...fmt(referencedBytes)},
            orphaned:{files:orphanFiles,...fmt(orphanBytes)},
            pielPerfectaVideos:{files:pielFiles,...fmt(pielBytes)}
          },
          pages,
          truncated:hasMore
        });
      }catch(error){
        return json(res,500,{error:'No se pudo calcular el uso del Blob',detail:cleanText(error?.message||'',300)});
      }
    }
    if(IS_PREVIEW && url.pathname==='/api/public/video-protection-check' && req.method==='GET'){
      return json(res,200,{
        privateStorage:FILE_BACKEND==='blob',
        signedPlayback:true,
        signedUrlTtlMinutes:Math.round(VIDEO_TOKEN_TTL_MS/60000),
        coursePayloadExposesVideoRefs:false,
        coursePayloadExposesStorageNames:false,
        enrollmentAndLessonAccessRequired:true,
        videoSessionRateLimit:'120/15min',
        maxStudentSessions:MAX_STUDENT_SESSIONS,
        maxConcurrentPlayback:1,
        deviceIdentity:'random-browser-id-hashed-server-side',
        preciseGeolocationStored:false,
        ipDisplay:'masked'
      });
    }
    if(IS_PREVIEW && url.pathname==='/api/public/piel-perfecta-transfer-check' && req.method==='GET'){
      const db=await readDb();
      const pkg=buildCourseTransferPackage(db,'piel-perfecta-20');
      if(!pkg)return json(res,404,{error:'Curso no encontrado'});
      const validation=await validateCourseTransferPackage(db,pkg,{checkBlobs:false});
      return json(res,200,{
        format:pkg.format,
        checksum:pkg.checksum,
        exportedAt:pkg.exportedAt,
        manifest:pkg.manifest,
        sourceReady:pkg.readiness?.ready===true,
        packageValid:validation.packageValid,
        counts:validation.counts,
        issues:validation.issues,
        storage:{source:pkg.source.storage,current:currentTransferStorageFingerprint(),sameDatabaseInThisEnvironment:validation.storage.sharedDatabase}
      });
    }

    if(IS_PREVIEW && url.pathname==='/api/public/piel-perfecta-preview-check' && req.method==='GET'){
      const db=await readDb();const course=db.courses.find(c=>c.slug==='piel-perfecta-20');
      if(!course)return json(res,404,{error:'Curso no encontrado'});
      const modules=db.modules.filter(m=>m.courseId===course.id);
      const lessons=db.lessons.filter(l=>l.courseId===course.id);
      const lessonIds=new Set(lessons.map(l=>l.id));
      const assessments=db.assessments.filter(a=>a.scopeType==='lesson'&&lessonIds.has(a.scopeId));
      const assessmentIds=new Set(assessments.map(a=>a.id));
      const resources=lessons.flatMap(l=>(l.resources||[]).filter(r=>r.generatedKey?.startsWith('piel-perfecta:')));
      const finalProject=assessments.find(a=>a.title==='Proyecto final · Tu Rutina Maestra')||null;
      const saleReadiness=courseSaleReadiness(db,course);
      return json(res,200,{title:course.title,status:course.status,saleEnabled:course.saleEnabled,previewSaleEnabled:courseSaleEnabledForEnv(db,course),sequentialAccess:course.sequentialAccess===true,moduleCount:modules.length,lessonCount:lessons.length,generatedResources:resources.length,assessmentCount:assessments.length,questionCount:db.questions.filter(q=>assessmentIds.has(q.assessmentId)).length,assessmentStatuses:[...new Set(assessments.map(a=>a.status))],finalProject:finalProject?{status:finalProject.status,passingScore:finalProject.passingScore,maxAttempts:finalProject.maxAttempts,questionCount:db.questions.filter(q=>q.assessmentId===finalProject.id).length}:null,tutorApprovedLessons:lessons.filter(l=>l.tutorApproved===true&&String(l.tutorContent||'').trim().length>0).length,saleReadiness});
    }
    if(url.pathname==='/api/checkout/create' && req.method==='POST'){
      if(PAYMENT_PROVIDER!=='stripe'&&IS_PROD)return json(res,503,{error:'Pasarela de pago no configurada'});
      const body=await readBody(req);
      body.__sessionContext=requestSecurityContext(req);
      for(let attempt=0;attempt<3;attempt++){
        const workDb=await readDb();
        const result=prepareCheckout(workDb,body);
        if(result.error)return json(res,result.status||400,{error:result.error});

        if(result.order.totalCents===0){
          const fulfilled=fulfillOrder(workDb,result.order,{providerRef:'free'});
          try{
            await writeDb(workDb);
            return json(res,201,{ok:true,free:true,user:{id:result.user.id,email:result.user.email,firstName:result.user.firstName,role:result.user.role},order:result.order,enrollments:fulfilled.enrollments},{'set-cookie':sessionCookie(result.token)});
          }catch(error){
            if(error?.code==='STORAGE_CONFLICT'&&attempt<2)continue;
            throw error;
          }
        }

        if(PAYMENT_PROVIDER!=='stripe')return json(res,503,{error:'Pago real no disponible en este entorno'});

        // Si ya existe una sesión Stripe vigente, reutilízala.
        if(result.reused&&result.order.checkoutUrl&&(!result.order.checkoutExpiresAt||new Date(result.order.checkoutExpiresAt)>new Date())){
          try{
            await writeDb(workDb);
            return json(res,200,{ok:true,reused:true,user:{id:result.user.id,email:result.user.email,firstName:result.user.firstName,role:result.user.role},order:{id:result.order.id,number:result.order.number,status:result.order.status,totalCents:result.order.totalCents,currency:result.order.currency},checkoutUrl:result.order.checkoutUrl},{'set-cookie':sessionCookie(result.token)});
          }catch(error){
            if(error?.code==='STORAGE_CONFLICT'&&attempt<2)continue;
            throw error;
          }
        }

        // Persistir SIEMPRE el pedido antes de hablar con Stripe.
        try{
          await writeDb(workDb);
        }catch(error){
          if(error?.code==='STORAGE_CONFLICT'&&attempt<2)continue;
          throw error;
        }

        try{
          const session=await stripeCreateCheckoutSession(result.order,result.user);
          for(let saveAttempt=0;saveAttempt<3;saveAttempt++){
            const updateDb=await readDb();
            const order=updateDb.orders.find(o=>o.id===result.order.id);
            const payment=updateDb.payments.find(p=>p.orderId===result.order.id);
            if(!order)return json(res,409,{error:'El pedido ya no está disponible'});
            order.checkoutSessionId=session.id;
            order.checkoutUrl=session.url;
            order.checkoutExpiresAt=session.expires_at?new Date(session.expires_at*1000).toISOString():null;
            if(payment)payment.providerRef=session.id;
            try{
              await writeDb(updateDb);
              return json(res,201,{ok:true,reused:Boolean(result.reused),user:{id:result.user.id,email:result.user.email,firstName:result.user.firstName,role:result.user.role},order:{id:order.id,number:order.number,status:order.status,totalCents:order.totalCents,currency:order.currency},checkoutUrl:session.url},{'set-cookie':sessionCookie(result.token)});
            }catch(error){
              if(error?.code==='STORAGE_CONFLICT'&&saveAttempt<2)continue;
              throw error;
            }
          }
        }catch(error){
          for(let saveAttempt=0;saveAttempt<3;saveAttempt++){
            const failDb=await readDb();
            const order=failDb.orders.find(o=>o.id===result.order.id);
            if(order)markPaymentFailed(failDb,order,error.message);
            try{await writeDb(failDb);break}catch(saveError){if(saveError?.code==='STORAGE_CONFLICT'&&saveAttempt<2)continue;throw saveError}
          }
          logEvent('error','stripe_checkout_failed',{orderId:result.order.id,error:error.message});
          return json(res,502,{error:'No se pudo iniciar el pago. Inténtalo de nuevo.'});
        }
      }
      return json(res,503,{error:'El Campus está procesando otro pedido. Inténtalo de nuevo.'});
    }
    if(url.pathname==='/api/checkout/status' && req.method==='GET'){const db=await readDb();const user=await auth(req,db);if(!user)return json(res,401,{error:'No autenticado'});const order=db.orders.find(o=>o.id===url.searchParams.get('order')&&o.userId===user.id);if(!order)return json(res,404,{error:'Pedido no encontrado'});return json(res,200,{order:{id:order.id,number:order.number,status:order.status,totalCents:order.totalCents,currency:order.currency,paidAt:order.paidAt||null}});}
    if(url.pathname==='/api/webhooks/stripe' && req.method==='POST'){
      if(PAYMENT_PROVIDER!=='stripe')return json(res,404,{error:'No disponible'});
      const raw=await readRawBody(req);
      if(!verifyStripeWebhook(raw,req.headers['stripe-signature']))return json(res,400,{error:'Firma inválida'});
      let event;try{event=JSON.parse(raw)}catch{return json(res,400,{error:'Payload inválido'})}
      for(let attempt=0;attempt<3;attempt++){
        const workDb=await readDb();
        const result=await handleStripeEvent(workDb,event);
        try{
          await writeDb(workDb);
          logEvent('info','stripe_webhook',{eventId:event.id,type:event.type,result});
          return json(res,200,{received:true});
        }catch(error){
          if(error?.code==='STORAGE_CONFLICT'&&attempt<2)continue;
          throw error;
        }
      }
      return json(res,503,{error:'No se pudo confirmar el evento de pago'});
    }
    if(url.pathname==='/api/checkout/mock' && req.method==='POST'){
      if(IS_PROD)return json(res,404,{error:'No disponible'});
      const body=await readBody(req);
      body.__sessionContext=requestSecurityContext(req);
      const result=await performMockCheckout(body);
      return json(res,result.status,result.body,result.token?{'set-cookie':sessionCookie(result.token)}:{});
    }
    if(url.pathname==='/api/checkout/coupon' && req.method==='POST'){const body=await readBody(req);const db=await readDb();const itemType=body.itemType==='bundle'?'bundle':'course';const target=itemType==='bundle'?(db.bundles||[]).find(b=>b.slug===body.itemSlug):db.courses.find(c=>c.slug===body.itemSlug);if(!target)return json(res,404,{error:'Producto no encontrado'});const pr=pricingFor(db,itemType,target);const user=(body.email?db.users.find(u=>u.email.toLowerCase()===String(body.email).toLowerCase()):null);const r=validateCoupon(db,body.couponCode,{user,targetType:itemType,targetId:target.id,subtotalCents:pr.finalCents});if(r.error)return json(res,r.status||400,{error:r.error});return json(res,200,{ok:true,discountCents:r.discountCents,discountLabel:money(r.discountCents,target.currency||'EUR'),totalCents:Math.max(0,pr.finalCents-r.discountCents),totalLabel:money(Math.max(0,pr.finalCents-r.discountCents),target.currency||'EUR'),coupon:r.coupon?{code:r.coupon.code,label:r.coupon.label||r.coupon.code,category:r.coupon.category||'coupon'}:null});}

    if(url.pathname==='/api/password/forgot' && req.method==='POST'){
      const rl=rateLimit(`forgot:${clientIp(req)}`,5,15*60*1000); if(!rl.ok)return json(res,429,{error:'Demasiados intentos. Prueba más tarde.'},{'retry-after':String(Math.ceil((rl.reset-Date.now())/1000))});
      const body=await readBody(req); const db=await readDb(); const email=cleanText(body.email,220).toLowerCase();
      const user=db.users.find(u=>u.email.toLowerCase()===email);
      if(user&&(user.status||'active')==='active'){
        const last=user.passwordResetLastSentAt?new Date(user.passwordResetLastSentAt).getTime():0;
        if(!last||Date.now()-last>60*1000){
          db.passwordResetTokens=(db.passwordResetTokens||[]).filter(t=>t.userId!==user.id&&new Date(t.expiresAt)>new Date()&&!t.usedAt);
          const token=crypto.randomBytes(32).toString('base64url');
          db.passwordResetTokens.push({id:newId(),tokenHash:resetTokenHash(token),userId:user.id,createdAt:now(),expiresAt:new Date(Date.now()+60*60*1000).toISOString(),usedAt:null});
          user.passwordResetLastSentAt=now();
          queueEmail(db,{to:user.email,type:'password_reset',userId:user.id,meta:{resetUrl:`${PUBLIC_APP_ORIGIN}/?reset=${encodeURIComponent(token)}`}});
          markLocalEmailsSent(db); await writeDb(db);
        }
      }
      return json(res,200,{ok:true,message:'Si existe una cuenta con ese email, recibirás instrucciones.'});
    }
    if(url.pathname==='/api/password/reset' && req.method==='POST'){
      const rl=rateLimit(`reset:${clientIp(req)}`,8,15*60*1000);if(!rl.ok)return json(res,429,{error:'Demasiados intentos. Prueba más tarde.'});
      const body=await readBody(req); const db=await readDb(); const token=cleanText(body.token,200); const password=String(body.password||'');
      const policy=passwordPolicy(password);if(policy)return json(res,400,{error:policy});
      const tokenHash=resetTokenHash(token);
      const item=(db.passwordResetTokens||[]).find(t=>(t.tokenHash===tokenHash||t.token===token)&&!t.usedAt&&new Date(t.expiresAt)>new Date()); if(!item)return json(res,400,{error:'El enlace no es válido o ha caducado'});
      const user=db.users.find(u=>u.id===item.userId); if(!user)return json(res,404,{error:'Cuenta no encontrada'});
      const hp=hashPassword(password); user.passwordSalt=hp.salt;user.passwordHash=hp.hash;user.passwordResetLastSentAt=null;clearFailedLogin(user);item.usedAt=now();delete item.token;db.sessions=db.sessions.filter(s=>s.userId!==user.id);await writeDb(db);return json(res,200,{ok:true});
    }
    if(url.pathname==='/api/login' && req.method==='POST'){
      const rl=rateLimit(`login:${clientIp(req)}`,10,15*60*1000); if(!rl.ok)return json(res,429,{error:'Demasiados intentos. Prueba más tarde.'},{'retry-after':String(Math.ceil((rl.reset-Date.now())/1000))});
      const body=await readBody(req); const email=cleanText(body.email,220).toLowerCase(); const password=String(body.password||'');
      for(let attempt=0;attempt<3;attempt++){
        const db=await readDb();
        const user=db.users.find(u=>u.email.toLowerCase()===email);
        if(user&&accountLoginBlocked(user))return json(res,429,{error:'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.'});
        if(!user || !verifyPassword(password,user.passwordSalt,user.passwordHash)){
          if(user){
            recordFailedLogin(user);
            const ctx=requestSecurityContext(req);
            if(Number(user.failedLoginCount)===4){
              securityEvent(db,{userId:user.id,type:'failed_login_burst',label:'Varios intentos de acceso fallidos',score:3,deviceKey:ctx.deviceKey,deviceLabel:ctx.deviceLabel,ipLabel:ctx.ipLabel,dedupeMinutes:30});
            }
            if(Number(user.failedLoginCount)>=8){
              const event=securityEvent(db,{userId:user.id,type:'login_lockout',label:'Cuenta protegida temporalmente tras múltiples intentos fallidos',score:5,deviceKey:ctx.deviceKey,deviceLabel:ctx.deviceLabel,ipLabel:ctx.ipLabel,dedupeMinutes:60});
              if(event){queueEmail(db,{to:user.email,type:'security_alert',userId:user.id,meta:{deviceLabel:ctx.deviceLabel,ipLabel:ctx.ipLabel}});markLocalEmailsSent(db);}
            }
            try{await writeDb(db);}
            catch(err){if(err?.code==='STORAGE_CONFLICT'&&attempt<2)continue;throw err;}
          }
          return json(res,401,{error:'Credenciales incorrectas'});
        }
        if((user.status||'active')!=='active' && user.role!=='admin') return json(res,403,{error:'Cuenta bloqueada. Contacta con Lykios Academy.'});
        clearFailedLogin(user);db.sessions=db.sessions.filter(s=>new Date(s.expiresAt)>new Date());
        const managed=createManagedSession(db,user,{req,source:'login',notifyNewDevice:true});
        user.lastLoginAt=now();
        try{
          await writeDb(db);
          return json(res,200,{user:{id:user.id,email:user.email,firstName:user.firstName,lastName:user.lastName,role:user.role,status:user.status||'active',preview:IS_PREVIEW},session:{maxActive:user.role==='student'?MAX_STUDENT_SESSIONS:null,deviceLabel:managed.session.deviceLabel}},{'set-cookie':sessionCookie(managed.token)});
        }catch(err){
          if(err?.code==='STORAGE_CONFLICT'&&attempt<2)continue;
          throw err;
        }
      }
      return json(res,503,{error:'El Campus está procesando otra operación. Inténtalo de nuevo.'});
    }
    if(url.pathname==='/api/logout' && req.method==='POST'){
      const sid=parseCookies(req).lykios_session;
      if(!sid)return json(res,200,{ok:true},{'set-cookie':sessionCookie('',0)});
      for(let attempt=0;attempt<3;attempt++){
        const db=await readDb();
        const sidHash=sessionTokenHash(sid);
        db.sessions=db.sessions.filter(s=>s.tokenHash!==sidHash&&s.token!==sid);
        try{
          await writeDb(db);
          return json(res,200,{ok:true},{'set-cookie':sessionCookie('',0)});
        }catch(err){
          if(err?.code==='STORAGE_CONFLICT'&&attempt<2)continue;
          throw err;
        }
      }
      return json(res,503,{error:'El Campus está procesando otra operación. Inténtalo de nuevo.'},{'set-cookie':sessionCookie('',0)});
    }

    if((url.pathname==='/verify'||url.pathname==='/api/verify') && req.method==='GET'){
      const code=cleanText(url.searchParams.get('code')||'',80).toUpperCase();
      if(!code)return text(res,200,verificationHtml(null,''),'text/html; charset=utf-8',{'cache-control':'no-store'});
      const db=await readDb();const cert=db.certificates.find(c=>c.code===code);const payload=cert?publicCertificate(db,cert):null;
      return text(res,payload?200:404,verificationHtml(payload,code),'text/html; charset=utf-8',{'cache-control':'no-store'});
    }
    const verifyMatch=url.pathname.match(/^\/(?:api\/)?verify\/([A-Z0-9-]+)$/i);
    if(verifyMatch && req.method==='GET'){
      const code=verifyMatch[1].toUpperCase();const db=await readDb(); const cert=db.certificates.find(c=>c.code===code);
      const payload=cert?publicCertificate(db,cert):null;
      return text(res,payload?200:404,verificationHtml(payload,code),'text/html; charset=utf-8',{'cache-control':'no-store'});
    }
    if(url.pathname==='/api/public/certificate' && req.method==='GET'){
      const db=await readDb(); const code=String(url.searchParams.get('code')||'').toUpperCase(); const cert=db.certificates.find(c=>c.code===code);
      const payload=cert?publicCertificate(db,cert):null; return payload?json(res,200,payload,{'cache-control':'no-store'}):json(res,404,{error:'Certificado no encontrado'},{'cache-control':'no-store'});
    }
    if(url.pathname==='/api/public/certificate/qr' && req.method==='GET'){
      const db=await readDb(); const code=String(url.searchParams.get('code')||'').toUpperCase(); const cert=db.certificates.find(c=>c.code===code); if(!cert)return json(res,404,{error:'Certificado no encontrado'});if((cert.status||'valid')!=='valid')return json(res,410,{error:'Certificado revocado'});
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
      if(url.pathname==='/api/me') return json(res,200,{id:user.id,email:user.email,firstName:user.firstName,lastName:user.lastName,role:user.role,status:user.status||'active',preview:IS_PREVIEW});
      if(url.pathname==='/api/password/change' && req.method==='POST'){
        const rl=rateLimit(`change-password:${user.id}`,6,15*60*1000);if(!rl.ok)return json(res,429,{error:'Demasiados intentos. Prueba más tarde.'});
        const body=await readBody(req);const currentPassword=String(body.currentPassword||''),newPassword=String(body.newPassword||'');
        if(!verifyPassword(currentPassword,user.passwordSalt,user.passwordHash))return json(res,401,{error:'La contraseña actual no es correcta'});
        const policy=passwordPolicy(newPassword);if(policy)return json(res,400,{error:policy});
        if(verifyPassword(newPassword,user.passwordSalt,user.passwordHash))return json(res,400,{error:'La nueva contraseña debe ser diferente de la actual'});
        const hp=hashPassword(newPassword);user.passwordSalt=hp.salt;user.passwordHash=hp.hash;clearFailedLogin(user);
        db.sessions=db.sessions.filter(s=>s.userId!==user.id);
        releaseVideoLease(db,user.id,'*');
        const managed=createManagedSession(db,user,{req,source:'password_change',notifyNewDevice:false});
        db.activity.push({id:newId(),userId:user.id,type:'password_changed',label:'Contraseña actualizada',at:now()});
        await writeDb(db);return json(res,200,{ok:true},{'set-cookie':sessionCookie(managed.token)});
      }
      if(url.pathname==='/api/dashboard'){
        const enrollments=db.enrollments.filter(e=>e.userId===user.id&&e.status==='active');
        const courses=enrollments.map(e=>coursePayload(db,user,db.courses.find(c=>c.id===e.courseId)?.slug)).filter(Boolean);
        const completedLessons=courses.reduce((n,c)=>n+(Number(c.completedCount)||0),0);
        const totalLessons=courses.reduce((n,c)=>n+(Number(c.totalLessons)||0),0);
        const overallProgressPercent=totalLessons?Math.round(completedLessons/totalLessons*100):0;
        const incompleteCourses=courses.filter(c=>(Number(c.progressPercent)||0)<100);
        const resumable=incompleteCourses.filter(c=>c.resumeLesson).sort((a,b)=>new Date(b.resumeLesson?.lastActivityAt||b.enrollment?.enrolledAt||0)-new Date(a.resumeLesson?.lastActivityAt||a.enrollment?.enrolledAt||0));
        const continueCourse=resumable[0]||incompleteCourses[0]||null;
        const certificates=db.certificates.filter(c=>c.userId===user.id&&(c.status||'valid')!=='revoked').map(c=>publicCertificate(db,c)).filter(Boolean).sort((a,b)=>new Date(b.issuedAt)-new Date(a.issuedAt));
        return json(res,200,{stats:{activeCourses:incompleteCourses.length,completedLessons,totalLessons,overallProgressPercent,certificates:certificates.length},continueCourse:continueCourse?{slug:continueCourse.slug,title:continueCourse.title,subtitle:continueCourse.subtitle,progressPercent:continueCourse.progressPercent,resumeLesson:continueCourse.resumeLesson,nextLesson:continueCourse.nextLesson}:null,courses,certificates,activity:db.activity.filter(a=>a.userId===user.id).slice(-8).reverse()});
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
        const body=await readBody(req);
        for(let attempt=0;attempt<3;attempt++){
          const workDb=attempt===0?db:await readDb();
          const workUser=workDb.users.find(u=>u.id===user.id);
          const lesson=workDb.lessons.find(l=>l.id===body.lessonId);
          if(!workUser||!lesson||lesson.status!=='published') return json(res,404,{error:'Clase no encontrada'});
          const enrollment=workDb.enrollments.find(e=>e.userId===workUser.id&&e.courseId===lesson.courseId&&e.status==='active');
          if(!enrollment)return json(res,403,{error:'Sin matrícula activa'});
          if(!canAccessLesson(workDb,workUser,lesson))return json(res,403,{error:sequenceState(workDb,workUser,lesson).lockReason||'Clase bloqueada'});
          const requirementStatus=lessonCompletionStatus(workDb,workUser,lesson);
          if(requirementStatus.hasRequirements){
            const synced=syncLessonCompletion(workDb,workUser,lesson);
            try{
              await writeDb(workDb);
              return json(res,409,{error:'Esta clase se completa automáticamente al cumplir sus requisitos',completionStatus:synced.status});
            }catch(error){
              if(error?.code==='STORAGE_CONFLICT'&&attempt<2)continue;
              throw error;
            }
          }
          let p=workDb.progress.find(x=>x.enrollmentId===enrollment.id&&x.lessonId===lesson.id);
          if(!p){p={id:newId(),enrollmentId:enrollment.id,lessonId:lesson.id,completed:false,progressPercent:0,updatedAt:now()};workDb.progress.push(p)}
          const before=Boolean(p.completed);
          p.completed=body.completed!==false;
          p.progressPercent=p.completed?100:Number(body.progressPercent||0);
          p.updatedAt=now();
          if(p.completed&&!p.completedAt)p.completedAt=now();
          if(!p.completed)p.completedAt=null;
          if(p.completed&&!before)workDb.activity.push({id:newId(),userId:workUser.id,type:'lesson_completed',label:`Clase ${lesson.code} completada`,at:now()});
          maybeQueueCourseCompleted(workDb,workUser,lesson.courseId);
          markLocalEmailsSent(workDb);
          try{
            await writeDb(workDb);
            const course=workDb.courses.find(c=>c.id===lesson.courseId);
            return json(res,200,{ok:true,progress:p,course:coursePayload(workDb,workUser,course.slug)});
          }catch(error){
            if(error?.code==='STORAGE_CONFLICT'&&attempt<2)continue;
            throw error;
          }
        }
        return json(res,503,{error:'El Campus está sincronizando tu progreso. Inténtalo de nuevo.'});
      }

      if(url.pathname==='/api/assessment' && req.method==='GET'){
        const id=url.searchParams.get('id');
        const assessment=id?db.assessments.find(a=>a.id===id):assessmentForScope(db,url.searchParams.get('scopeType'),url.searchParams.get('scopeId'));
        if(!assessment || !visibleAssessment(db,user,assessment)) return json(res,404,{error:'Evaluación no disponible'});
        return json(res,200,assessmentPayload(db,assessment,{includeAnswers:false,userId:user.id}));
      }
      if(url.pathname==='/api/assessment/submit' && req.method==='POST'){
        const body=await readBody(req);
        const result=await performAssessmentSubmit(user.id,body);
        return json(res,result.status,result.body);
      }

      if(url.pathname==='/api/certificate/status' && req.method==='GET'){
        const course=db.courses.find(c=>c.slug===(url.searchParams.get('slug')||'peeling-quimico')); if(!course)return json(res,404,{error:'Curso no encontrado'});
        const completion=courseCompletionStatus(db,user,course.id);
        let existing=db.certificates.find(c=>c.userId===user.id&&c.courseId===course.id&&c.status!=='revoked');
        if(!existing&&completion.eligible&&course.certificateEnabled!==false){
          maybeQueueCourseCompleted(db,user,course.id);markLocalEmailsSent(db);await writeDb(db);
          existing=db.certificates.find(c=>c.userId===user.id&&c.courseId===course.id&&c.status!=='revoked');
        }
        return json(res,200,{courseId:course.id,courseSlug:course.slug,completion,certificate:existing?publicCertificate(db,existing):null});
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
        if(user.role!=='admin'&&cert.userId!==user.id)return json(res,403,{error:'Sin acceso'}); const payload=publicCertificate(db,cert); const buf=await certificatePdf(payload);
        return text(res,200,buf,'application/pdf',{'content-disposition':`attachment; filename="Certificado-Lykios-${cert.code}.pdf"`});
      }

      if(url.pathname==='/api/video/session' && req.method==='POST'){
        const rl=rateLimit('video-session:'+user.id,120,15*60*1000);if(!rl.ok)return json(res,429,{error:'Demasiadas solicitudes de vídeo. Espera unos minutos.'});
        const body=await readBody(req);
        for(let attempt=0;attempt<3;attempt++){
          const workDb=attempt===0?db:await readDb();
          const workUser=workDb.users.find(u=>u.id===user.id);
          const session=currentSession(req,workDb);
          const lesson=workDb.lessons.find(l=>l.id===body.lessonId);
          if(!workUser||!session)return json(res,401,{error:'La sesión ha caducado. Vuelve a iniciar sesión.'});
          if(!lesson||!canAccessLesson(workDb,workUser,lesson))return json(res,403,{error:'Sin acceso a esta clase'});
          const videos=lessonVideos(lesson);
          const selected=body.videoId?videos.find(v=>v.id===body.videoId):videos[0];
          if(!selected)return json(res,404,{error:'Esta clase aún no tiene vídeo configurado'});

          let leaseResult=acquireVideoLease(workDb,workUser,session,{lessonId:lesson.id,videoId:selected.id});
          if(!leaseResult.ok){
            const escalated=enforceHighRiskAfterPlayback(workDb,workUser,session);
            if(escalated)leaseResult=acquireVideoLease(workDb,workUser,session,{lessonId:lesson.id,videoId:selected.id});
          }
          session.lastSeenAt=now();
          try{
            await writeDb(workDb);
          }catch(error){
            if(error?.code==='STORAGE_CONFLICT'&&attempt<2)continue;
            throw error;
          }
          if(!leaseResult.ok)return json(res,409,{error:'Tu cuenta ya está reproduciendo un vídeo en otro dispositivo. Pausa allí la reproducción antes de continuar.'});

          const expiresAt=Date.now()+VIDEO_TOKEN_TTL_MS;
          const token=signVideoToken({userId:workUser.id,lessonId:lesson.id,expiresAt});
          let streamUrl='/api/video/stream?token='+encodeURIComponent(token),embedUrl=null,provider='legacy';
          const ref=String(selected.ref||'');
          if(ref.startsWith('bunny:')){
            if(!bunnyConfigured())return json(res,503,{error:'Bunny Stream no está disponible en este entorno'});
            const guid=ref.slice(6);
            let meta;try{meta=await bunnyGetVideo(guid)}catch{return json(res,503,{error:'No se pudo consultar el estado del vídeo en Bunny'})}
            const encodeProgress=Math.max(0,Number(meta?.encodeProgress)||0);
            const resolutions=String(meta?.availableResolutions||'').trim();
            if(encodeProgress<100&&!resolutions)return json(res,409,{error:'El vídeo todavía se está procesando en Bunny. Inténtalo de nuevo en unos minutos.',processing:true,encodeProgress});
            const bunnyExpiresAt=Date.now()+2*60*60*1000;
            embedUrl=bunnyEmbedUrl(guid,bunnyExpiresAt);
            provider='bunny';
            streamUrl=null;
          }else if(ref.startsWith('blob:')){
            const pathname=ref.slice(5);
            const {issueSignedToken,presignUrl}=await import('@vercel/blob');
            const signedToken=await issueSignedToken({pathname,operations:['get'],validUntil:expiresAt});
            const signed=await presignUrl(signedToken,{pathname,operation:'get',access:'private',validUntil:expiresAt,useCache:false});
            streamUrl=signed.presignedUrl;
            provider='blob';
          }
          return json(res,200,{expiresAt,videoId:selected.id,name:selected.name,provider,streamUrl,embedUrl,progress:videoProgressPayload(workDb,workUser,lesson.id,selected.id),protection:{privateStorage:ref.startsWith('blob:')||ref.startsWith('bunny:'),signedPlayback:ref.startsWith('bunny:')||ref.startsWith('blob:'),expiresAt,downloadUi:false,maxConcurrentPlayback:1}});
        }
        return json(res,503,{error:'El Campus está sincronizando tu sesión. Inténtalo de nuevo.'});
      }
      if(url.pathname==='/api/video/progress' && req.method==='POST'){
        const body=await readBody(req);
        const currentTime=Math.max(0,Number(body.currentTime)||0), duration=Math.max(0,Number(body.duration)||0);
        const percent=duration>0?Math.min(100,Math.round(currentTime/duration*100)):0;
        const playing=body.playing!==false;
        for(let attempt=0;attempt<3;attempt++){
          const workDb=attempt===0?db:await readDb();
          const workUser=workDb.users.find(u=>u.id===user.id);
          const session=currentSession(req,workDb);
          const lesson=workDb.lessons.find(l=>l.id===body.lessonId);
          if(!workUser||!session)return json(res,401,{error:'La sesión ha caducado. Vuelve a iniciar sesión.'});
          if(!lesson||!canAccessLesson(workDb,workUser,lesson))return json(res,403,{error:'Sin acceso a esta clase'});
          const videos=lessonVideos(lesson);
          const selected=body.videoId?videos.find(v=>v.id===body.videoId):videos[0];
          if(!selected)return json(res,404,{error:'Vídeo no encontrado'});

          if(playing){
            let leaseResult=acquireVideoLease(workDb,workUser,session,{lessonId:lesson.id,videoId:selected.id});
            if(!leaseResult.ok){
              const escalated=enforceHighRiskAfterPlayback(workDb,workUser,session);
              if(escalated)leaseResult=acquireVideoLease(workDb,workUser,session,{lessonId:lesson.id,videoId:selected.id});
            }
            if(!leaseResult.ok){
              try{await writeDb(workDb);}catch(error){if(error?.code==='STORAGE_CONFLICT'&&attempt<2)continue;throw error;}
              return json(res,409,{error:'Se ha detectado reproducción simultánea en otro dispositivo. Esta reproducción se ha detenido.'});
            }
          }else releaseVideoLease(workDb,workUser.id,session.id);

          session.lastSeenAt=now();
          let vp=workDb.videoProgress.find(x=>x.userId===workUser.id&&x.lessonId===lesson.id&&String(x.videoId||'')===String(selected.id));
          if(!vp){vp={id:newId(),userId:workUser.id,lessonId:lesson.id,videoId:selected.id,currentTime:0,duration:0,percent:0,completed:false,lastPlayedAt:null};workDb.videoProgress.push(vp)}
          vp.currentTime=currentTime; vp.duration=duration; vp.percent=Math.max(vp.percent||0,percent); vp.completed=vp.completed||percent>=90; vp.lastPlayedAt=now();
          const completion=syncLessonCompletion(workDb,workUser,lesson);
          if(completion.completed)maybeQueueCourseCompleted(workDb,workUser,lesson.courseId);
          markLocalEmailsSent(workDb);
          try{
            await writeDb(workDb);
            return json(res,200,{progress:videoProgressPayload(workDb,workUser,lesson.id,selected.id),lessonVideoProgress:videoProgressPayload(workDb,workUser,lesson.id),lessonCompletion:completion.status});
          }catch(error){
            if(error?.code==='STORAGE_CONFLICT'&&attempt<2)continue;
            throw error;
          }
        }
        return json(res,503,{error:'El Campus está sincronizando tu progreso. Inténtalo de nuevo.'});
      }
      if(url.pathname==='/api/resource' && req.method==='GET'){
        const found=findResource(db,url.searchParams.get('id')); if(!found) return json(res,404,{error:'Recurso no encontrado'});
        const {lesson,resource}=found;
        const allowed=user.role==='admin'||canTeachCourse(db,user,lesson.courseId)||canAccessLesson(db,user,lesson);
        if(!allowed) return json(res,403,{error:'Sin acceso al recurso'});
        if(resource.generatedKey?.startsWith('piel-perfecta:')){
          const moduleCode=resource.generatedKey.split(':')[1];
          const def=PIEL_PERFECTA_RESOURCE_BOOKLETS[moduleCode];
          if(!def)return json(res,404,{error:'Recurso generado no disponible'});
          const buf=await pielPerfectaGeneratedPdf(def);
          return text(res,200,buf,'application/pdf',{'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(resource.name)}`,'x-content-type-options':'nosniff'});
        }
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
        if(url.pathname==='/api/teacher/lesson'&&req.method==='POST'){const body=await readBody(req);const module=db.modules.find(m=>m.id===body.moduleId);if(!module)return json(res,404,{error:'Módulo no encontrado'});if(!canTeachCourse(db,user,module.courseId))return json(res,403,{error:'Curso no asignado'});const lesson={id:newId(),moduleId:module.id,courseId:module.courseId,code:cleanText(body.code,30)||`${module.code}.${positionOf(db.lessons,l=>l.moduleId===module.id)}`,title:cleanText(body.title,180),summary:cleanText(body.summary,5000),position:Number(body.position)||positionOf(db.lessons,l=>l.moduleId===module.id),status:safeStatus(body.status),durationMinutes:Math.max(1,Number(body.durationMinutes)||10),video:body.video?cleanText(body.video,1000):null,videos:body.video?[{id:newId(),ref:cleanText(body.video,1000),name:'Vídeo 1',mime:'video/mp4',size:null,position:1,createdAt:now()}]:[],resources:[],tutorApproved:false,tutorContent:cleanText(body.tutorContent,20000),tutorApprovedAt:null,createdAt:now(),updatedAt:now()};if(!lesson.title)return json(res,400,{error:'Título obligatorio'});db.lessons.push(lesson);await writeDb(db);return json(res,201,{lesson});}
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
        if(url.pathname==='/api/admin/backup/state' && req.method==='POST'){
          if(FILE_BACKEND!=='blob')return json(res,409,{error:'El backup remoto requiere Vercel Blob'});
          const snapshot=await readDb();
          const exportedAt=now();
          const storageVersion=Number(snapshot.__storageVersion)||null;
          const payload={
            format:'lykios-state-backup-v1',
            appVersion:APP_VERSION,
            exportedAt,
            schemaVersion:snapshot.meta?.schemaVersion||null,
            storageVersion,
            data:snapshot
          };
          const body=JSON.stringify(payload,null,2)+'\n';
          const bytes=Buffer.byteLength(body,'utf8');
          const checksum=crypto.createHash('sha256').update(body).digest('hex');
          const stamp=exportedAt.replace(/[:.]/g,'-');
          const versionTag=storageVersion==null?'unknown':String(storageVersion);
          const pathname=`backups/state/lykios-state-${stamp}-v${versionTag}.json`;
          const checksumPath=pathname.replace(/\.json$/i,'.sha256');
          const {put,head}=await import('@vercel/blob');
          const saved=await put(pathname,Buffer.from(body,'utf8'),{access:'private',contentType:'application/json',addRandomSuffix:false});
          await put(checksumPath,Buffer.from(`${checksum}  ${pathname.split('/').pop()}\n`,'utf8'),{access:'private',contentType:'text/plain; charset=utf-8',addRandomSuffix:false});
          const meta=await head(saved.pathname||pathname);
          const verified=Boolean(meta&&Number(meta.size)===bytes);
          if(!verified)throw new Error('No se pudo verificar el tamaño del backup remoto');
          logEvent('info','state_backup_created',{pathname:saved.pathname||pathname,bytes,checksum,storageVersion,schemaVersion:payload.schemaVersion,verified});
          return json(res,201,{ok:true,pathname:saved.pathname||pathname,checksumPath,sha256:checksum,bytes,storageVersion,schemaVersion:payload.schemaVersion,exportedAt,verified});
        }
        if(url.pathname==='/api/admin/test/concurrency' && req.method==='POST'){
          if(!IS_PREVIEW)return json(res,404,{error:'Disponible solo en Preview'});
          const runId=crypto.randomBytes(6).toString('hex');
          const email=`concurrency-${runId}@example.invalid`;
          const password=`LykiosTest-${runId}-Aa1!`;

          const base=await readDb();
          const assessment=base.assessments.find(a=>{
            if(a.status!=='published'||Number(a.passingScore)<=0)return false;
            const qs=base.questions.filter(q=>q.assessmentId===a.id);
            if(!qs.length||qs.some(q=>!Array.isArray(q.options)||q.options.length<2))return false;
            const courseId=a.scopeType==='lesson'
              ?base.lessons.find(l=>l.id===a.scopeId)?.courseId
              :base.modules.find(m=>m.id===a.scopeId)?.courseId;
            const course=base.courses.find(c=>c.id===courseId);
            return Boolean(course&&course.status==='published'&&courseSaleEnabledForEnv(base,course));
          });
          if(!assessment)return json(res,409,{error:'No hay una evaluación publicada adecuada para la prueba concurrente'});

          const assessmentCourseId=assessment.scopeType==='lesson'
            ?base.lessons.find(l=>l.id===assessment.scopeId)?.courseId
            :base.modules.find(m=>m.id===assessment.scopeId)?.courseId;
          const course=base.courses.find(c=>c.id===assessmentCourseId);
          if(!course)return json(res,409,{error:'No se encontró el curso de prueba'});

          const checkoutBody={itemType:'course',itemSlug:course.slug,email,firstName:'Concurrency',lastName:'Test',password};
          let checkoutA,checkoutB,assessmentA,assessmentB,verification,cleaned=false;
          try{
            [checkoutA,checkoutB]=await Promise.all([
              performMockCheckout(checkoutBody,{suppressEmails:true}),
              performMockCheckout(checkoutBody,{suppressEmails:true})
            ]);

            let afterCheckout=await readDb();
            let syntheticUser=afterCheckout.users.find(u=>u.email===email);
            if(!syntheticUser)throw new Error('La prueba no pudo crear el alumno sintético');

            // La prueba concurrente verifica escrituras simultáneas, no el
            // desbloqueo pedagógico. Si la evaluación elegida pertenece a una
            // clase secuencial, preparamos únicamente al alumno sintético hasta
            // esa clase para que el test respete las mismas reglas que un alumno real.
            if(assessment.scopeType==='lesson'){
              const targetLesson=afterCheckout.lessons.find(l=>l.id===assessment.scopeId);
              if(!targetLesson)throw new Error('No se encontró la clase de la evaluación concurrente');
              const ordered=afterCheckout.modules
                .filter(m=>m.courseId===course.id)
                .sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0))
                .flatMap(m=>afterCheckout.lessons
                  .filter(l=>l.moduleId===m.id)
                  .sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0)));
              const targetIndex=ordered.findIndex(l=>l.id===targetLesson.id);
              const priorLessons=targetIndex>0?ordered.slice(0,targetIndex):[];
              const markVideosComplete=(lesson)=>{
                for(const video of lessonVideos(lesson)){
                  let vp=afterCheckout.videoProgress.find(v=>v.userId===syntheticUser.id&&v.lessonId===lesson.id&&String(v.videoId||'')===String(video.id||''));
                  if(!vp){
                    vp={id:newId(),userId:syntheticUser.id,lessonId:lesson.id,videoId:video.id,currentTime:1,duration:1,percent:100,completed:true,lastPlayedAt:now()};
                    afterCheckout.videoProgress.push(vp);
                  }else{
                    vp.currentTime=Math.max(1,Number(vp.duration)||Number(vp.currentTime)||1);
                    vp.duration=Math.max(1,Number(vp.duration)||1);
                    vp.percent=100;vp.completed=true;vp.lastPlayedAt=now();
                  }
                }
              };
              for(const lesson of priorLessons){
                markVideosComplete(lesson);
                const priorAssessment=assessmentForScope(afterCheckout,'lesson',lesson.id);
                if(priorAssessment&&!afterCheckout.attempts.some(a=>a.userId===syntheticUser.id&&a.assessmentId===priorAssessment.id&&a.passed)){
                  const priorQuestions=afterCheckout.questions.filter(q=>q.assessmentId===priorAssessment.id).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0));
                  const answers=priorQuestions.map(q=>({questionId:q.id,selectedOption:q.correctOption,correct:true,correctOption:q.correctOption,explanation:q.explanation||''}));
                  afterCheckout.attempts.push({id:newId(),assessmentId:priorAssessment.id,userId:syntheticUser.id,score:100,passed:true,answers,submittedAt:now(),source:'concurrency_qa'});
                }
                const synced=syncLessonCompletion(afterCheckout,syntheticUser,lesson);
                if(!synced.status.hasRequirements){
                  const enrollment=afterCheckout.enrollments.find(e=>e.userId===syntheticUser.id&&e.courseId===lesson.courseId&&e.status==='active');
                  if(enrollment){
                    let p=lessonProgressRow(afterCheckout,enrollment,lesson.id);
                    if(!p){p={id:newId(),enrollmentId:enrollment.id,lessonId:lesson.id,completed:true,progressPercent:100,updatedAt:now(),completedAt:now(),completionMode:'concurrency_qa'};afterCheckout.progress.push(p)}
                    else {p.completed=true;p.progressPercent=100;p.updatedAt=now();p.completedAt=p.completedAt||now();p.completionMode='concurrency_qa'}
                  }
                }
              }
              markVideosComplete(targetLesson);
              syncLessonCompletion(afterCheckout,syntheticUser,targetLesson);
              await writeDb(afterCheckout);
              afterCheckout=await readDb();
              syntheticUser=afterCheckout.users.find(u=>u.email===email);
              if(!syntheticUser)throw new Error('El alumno sintético desapareció durante la preparación de la prueba');
            }

            const visible=visibleAssessment(afterCheckout,syntheticUser,afterCheckout.assessments.find(a=>a.id===assessment.id));
            if(!visible)throw new Error('La evaluación de prueba no quedó accesible para el alumno sintético');

            const questions=afterCheckout.questions.filter(q=>q.assessmentId===assessment.id);
            const wrongAnswers=Object.fromEntries(questions.map(q=>[
              q.id,
              (Number(q.correctOption)+1)%q.options.length
            ]));

            [assessmentA,assessmentB]=await Promise.all([
              performAssessmentSubmit(syntheticUser.id,{assessmentId:assessment.id,answers:wrongAnswers}),
              performAssessmentSubmit(syntheticUser.id,{assessmentId:assessment.id,answers:wrongAnswers})
            ]);

            const verifiedDb=await readDb();
            const user=verifiedDb.users.find(u=>u.email===email);
            const orders=user?verifiedDb.orders.filter(o=>o.userId===user.id&&o.provider==='mock'):[];
            const enrollments=user?verifiedDb.enrollments.filter(e=>e.userId===user.id&&e.courseId===course.id&&e.status==='active'):[];
            const attempts=user?verifiedDb.attempts.filter(a=>a.userId===user.id&&a.assessmentId===assessment.id):[];
            const allowedAttempts=assessment.maxAttempts>0?Math.min(2,assessment.maxAttempts):2;
            const checkoutPassed=orders.length===1&&enrollments.length===1&&[checkoutA.status,checkoutB.status].filter(x=>x===201).length===1;
            const assessmentPassed=attempts.length===allowedAttempts&&attempts.every(a=>!a.passed);
            verification={
              checkoutPassed,
              assessmentPassed,
              orders:orders.length,
              activeEnrollments:enrollments.length,
              assessmentAttempts:attempts.length,
              expectedAssessmentAttempts:allowedAttempts,
              checkoutStatuses:[checkoutA.status,checkoutB.status],
              assessmentStatuses:[assessmentA.status,assessmentB.status]
            };
          }finally{
            cleaned=await cleanupSyntheticTestUser(email);
          }

          const passed=Boolean(verification?.checkoutPassed&&verification?.assessmentPassed&&cleaned);
          logEvent(passed?'info':'error','concurrency_self_test',{runId,passed,verification,cleaned});
          return json(res,passed?200:500,{ok:passed,runId,verification,cleaned});
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
        if(url.pathname==='/api/admin/teacher'&&req.method==='POST'){const body=await readBody(req);const email=cleanText(body.email,220).toLowerCase(),firstName=cleanText(body.firstName,120),password=String(body.password||'');if(!email||!email.includes('@')||!firstName)return json(res,400,{error:'Nombre y email válidos son obligatorios'});if(db.users.some(u=>u.email.toLowerCase()===email))return json(res,409,{error:'Email ya registrado'});const policy=passwordPolicy(password);if(policy)return json(res,400,{error:policy});const pw=hashPassword(password);const teacher={id:newId(),email,firstName,lastName:cleanText(body.lastName,120),role:'teacher',status:'active',lastLoginAt:null,failedLoginCount:0,failedLoginWindowStartedAt:null,loginLockedUntil:null,passwordResetLastSentAt:null,passwordSalt:pw.salt,passwordHash:pw.hash,createdAt:now()};db.users.push(teacher);await writeDb(db);return json(res,201,{teacher:{...teacher,passwordHash:undefined,passwordSalt:undefined}});}
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
        if(url.pathname==='/api/admin/certificate/preview' && req.method==='GET'){
          const course=db.courses.find(c=>c.id===url.searchParams.get('courseId'))||db.courses.find(c=>c.slug==='peeling-quimico')||db.courses[0];
          if(!course)return json(res,404,{error:'No hay cursos disponibles'});
          const sample={code:'LYK-2026-VISTA-PREVIA',status:'valid',studentName:'Alumno de prueba',courseTitle:course.title,courseSubtitle:course.subtitle||'',issuedAt:now(),issuer:'Lykios Academy',verificationPath:'/verify/LYK-2026-VISTA-PREVIA'};
          const buf=await certificatePdf(sample);
          return text(res,200,buf,'application/pdf',{'content-disposition':'inline; filename="Vista-previa-certificado-Lykios.pdf"','cache-control':'no-store'});
        }
        if(url.pathname==='/api/admin/certificates' && req.method==='GET') return json(res,200,{certificates:db.certificates.slice().sort((a,b)=>new Date(b.issuedAt)-new Date(a.issuedAt)).map(c=>({id:c.id,...publicCertificate(db,c)}))});
        if(url.pathname==='/api/admin/emails' && req.method==='GET') return json(res,200,{emails:emailAdminPayload(db)});
        if(url.pathname==='/api/admin/email/flush' && req.method==='POST'){
          await writeDb(db);
          return json(res,200,{ok:true,emails:emailAdminPayload(db)});
        }
        if(url.pathname==='/api/admin/email/retry' && req.method==='POST'){
          const body=await readBody(req);
          const email=(db.emailOutbox||[]).find(e=>e.id===cleanText(body.emailId,120));
          if(!email)return json(res,404,{error:'Correo no encontrado'});
          if(email.status==='sent')return json(res,409,{error:'Ese correo ya fue enviado'});
          email.status='queued';
          email.attempts=0;
          email.nextAttemptAt=null;
          email.lastError=null;
          email.failedAt=null;
          email.sentAt=null;
          email.providerRequestId=null;
          await writeDb(db);
          return json(res,200,{ok:true,email});
        }
        if(url.pathname==='/api/admin/analytics' && req.method==='GET') return json(res,200,adminAnalyticsPayload(db));
        if(url.pathname==='/api/admin/email/welcome' && req.method==='POST'){
          const body=await readBody(req);
          const student=db.users.find(u=>u.id===body.userId&&u.role==='student');
          if(!student)return json(res,404,{error:'Alumno no encontrado'});
          if((student.status||'active')!=='active')return json(res,409,{error:'La cuenta del alumno no está activa'});
          const mail=queueEmail(db,{to:student.email,type:'welcome',userId:student.id});
          markLocalEmailsSent(db);
          await writeDb(db);
          return json(res,201,{email:mail});
        }
        if(url.pathname==='/api/admin/email/purchase-test' && req.method==='POST'){
          const body=await readBody(req);
          const student=db.users.find(u=>u.id===body.userId&&u.role==='student');
          const course=db.courses.find(c=>c.id===body.courseId);
          if(!student||!course)return json(res,404,{error:'Alumno o curso no encontrado'});
          const enrollment=db.enrollments.find(e=>e.userId===student.id&&e.courseId===course.id&&e.status==='active');
          if(!enrollment)return json(res,409,{error:'El alumno no tiene una matrícula activa en ese curso'});
          const mail=queueEmail(db,{to:student.email,type:'purchase',userId:student.id,courseId:course.id,meta:{orderNumber:'PRUEBA-PREVIEW',courseTitle:course.title}});
          markLocalEmailsSent(db);
          await writeDb(db);
          return json(res,201,{email:mail});
        }
        if(url.pathname==='/api/admin/email/course-completed-test' && req.method==='POST'){
          const body=await readBody(req);
          const student=db.users.find(u=>u.id===body.userId&&u.role==='student');
          const course=db.courses.find(c=>c.id===body.courseId);
          if(!student||!course)return json(res,404,{error:'Alumno o curso no encontrado'});
          const enrollment=db.enrollments.find(e=>e.userId===student.id&&e.courseId===course.id&&e.status==='active');
          if(!enrollment)return json(res,409,{error:'El alumno no tiene una matrícula activa en ese curso'});
          const mail=queueEmail(db,{to:student.email,type:'course_completed',userId:student.id,courseId:course.id});
          markLocalEmailsSent(db);
          await writeDb(db);
          return json(res,201,{email:mail});
        }
        if(url.pathname==='/api/admin/email/certificate-test' && req.method==='POST'){
          const body=await readBody(req);
          const student=db.users.find(u=>u.id===body.userId&&u.role==='student');
          const course=db.courses.find(c=>c.id===body.courseId);
          if(!student||!course)return json(res,404,{error:'Alumno o curso no encontrado'});
          const cert=db.certificates.find(c=>c.userId===student.id&&c.courseId===course.id&&(c.status||'valid')!=='revoked');
          if(!cert)return json(res,409,{error:'El alumno no tiene un certificado válido para ese curso'});
          const mail=queueEmail(db,{to:student.email,type:'certificate',userId:student.id,courseId:course.id,meta:{certificateCode:cert.code}});
          markLocalEmailsSent(db);
          await writeDb(db);
          return json(res,201,{email:mail});
        }
        if(url.pathname==='/api/admin/email/reminder-test' && req.method==='POST'){
          const body=await readBody(req);
          const student=db.users.find(u=>u.id===body.userId&&u.role==='student');
          const course=db.courses.find(c=>c.id===body.courseId);
          if(!student||!course)return json(res,404,{error:'Alumno o curso no encontrado'});
          const mail=queueEmail(db,{to:student.email,type:'reminder',userId:student.id,courseId:course.id,meta:{previewTest:true}});
          markLocalEmailsSent(db);
          await writeDb(db);
          return json(res,201,{email:mail});
        }
        if(url.pathname==='/api/admin/email/reminder' && req.method==='POST'){
          const body=await readBody(req);
          const student=db.users.find(u=>u.id===body.userId&&u.role==='student');
          const course=db.courses.find(c=>c.id===body.courseId);
          if(!student||!course)return json(res,404,{error:'Alumno o curso no encontrado'});
          const enrollment=db.enrollments.find(e=>e.userId===student.id&&e.courseId===course.id&&e.status==='active');
          if(!enrollment)return json(res,409,{error:'El alumno no tiene una matrícula activa en ese curso'});
          const progress=studentProgressForCourse(db,student.id,course.id);
          if((Number(progress.progressPercent)||0)>=100)return json(res,409,{error:'El curso ya está completado; no se envía recordatorio'});
          const mail=queueEmail(db,{to:student.email,type:'reminder',userId:student.id,courseId:course.id});
          markLocalEmailsSent(db);
          await writeDb(db);
          return json(res,201,{email:mail});
        }


        if(url.pathname==='/api/admin/piel-perfecta/readiness' && req.method==='GET'){
          const course=db.courses.find(c=>c.slug==='piel-perfecta-20');
          if(!course)return json(res,404,{error:'Piel Perfecta 2.0 no encontrado'});
          const readiness=courseSaleReadiness(db,course);
          return json(res,200,{
            environment:VERCEL_ENV||NODE_ENV,
            course:{id:course.id,title:course.title,status:course.status,saleEnabled:course.saleEnabled,previewSaleEnabled:courseSaleEnabledForEnv(db,course)},
            readiness,
            launch:{
              videosReady:(readiness.lessonsWithVideo||0)===(readiness.lessons||0)&&Number(readiness.lessons||0)>0,
              academicReady:(readiness.modules===11&&readiness.lessons===33&&readiness.assessments===10&&readiness.questions===50&&readiness.resources>=11&&readiness.tutorApproved===33),
              stripeConfigured:Boolean(STRIPE_SECRET_KEY&&STRIPE_WEBHOOK_SECRET),
              resendConfigured:Boolean(RESEND_API_KEY),
              storageBackend:STORAGE_BACKEND,
              fileBackend:FILE_BACKEND,
              transferStorage:currentTransferStorageFingerprint()
            }
          });
        }

        if(url.pathname==='/api/admin/course-transfer/export' && req.method==='POST'){
          const body=await readBody(req);
          const slug=cleanText(body.slug||'piel-perfecta-20',160);
          const pkg=buildCourseTransferPackage(db,slug);
          if(!pkg)return json(res,404,{error:'Curso no encontrado'});
          logEvent('info','course_transfer_exported',{slug,environment:VERCEL_ENV||NODE_ENV,checksum:pkg.checksum.value,manifest:pkg.manifest,ready:pkg.readiness?.ready===true});
          return json(res,200,{package:pkg});
        }
        if(url.pathname==='/api/admin/course-transfer/validate' && req.method==='POST'){
          const body=await readBody(req);
          const validation=await validateCourseTransferPackage(db,body.package,{checkBlobs:body.checkBlobs!==false});
          return json(res,200,{validation});
        }
        if(url.pathname==='/api/admin/course-transfer/import' && req.method==='POST'){
          if(!IS_PROD)return json(res,403,{error:'La importación real solo está habilitada en Production'});
          const body=await readBody(req);
          if(cleanText(body.confirm,80)!=='IMPORTAR PIEL PERFECTA')return json(res,400,{error:'Confirmación incorrecta'});
          const validation=await validateCourseTransferPackage(db,body.package,{checkBlobs:true});
          if(!validation.canImport)return json(res,409,{error:'El paquete no puede importarse de forma segura',validation});
          const backup=await createCourseTransferBackup(db);
          const course=await importCourseTransferPackage(db,body.package);
          await writeDb(db);
          const fresh=await readDb();
          const imported=fresh.courses.find(c=>c.id===course.id);
          const readiness=courseSaleReadiness(fresh,imported,{ignorePublication:true});
          if(!readiness.ready){
            logEvent('error','course_transfer_import_validation_failed',{courseId:course.id,backup,readiness});
            return json(res,500,{error:'La importación terminó pero no superó la validación académica; el curso permanece en borrador y con venta desactivada',backup,readiness});
          }
          logEvent('info','course_transfer_imported',{courseId:course.id,slug:course.slug,backup,readiness});
          return json(res,201,{ok:true,course:{id:course.id,slug:course.slug,title:course.title,status:'draft',saleEnabled:false},backup,readiness});
        }

        if(url.pathname==='/api/admin/students' && req.method==='GET') return json(res,200,{students:studentsAdminPayload(db),courses:db.courses.map(c=>({id:c.id,title:c.title,slug:c.slug,status:c.status}))});
        const studentMatch=url.pathname.match(/^\/api\/admin\/student\/([^/]+)$/);
        if(studentMatch){
          const student=db.users.find(u=>u.id===studentMatch[1]&&u.role==='student');if(!student)return json(res,404,{error:'Alumno no encontrado'});
          if(req.method==='GET') return json(res,200,{student:studentAdminPayload(db,student)});
          if(req.method==='PUT'){const body=await readBody(req);student.firstName=cleanText(body.firstName??student.firstName,120);student.lastName=cleanText(body.lastName??student.lastName,120);if(body.email){const email=cleanText(body.email,220).toLowerCase();if(db.users.some(u=>u.id!==student.id&&u.email.toLowerCase()===email))return json(res,409,{error:'Ese email ya existe'});student.email=email;}if(['active','blocked'].includes(body.status))student.status=body.status;if(student.status==='blocked'){db.sessions=db.sessions.filter(s=>s.userId!==student.id);releaseVideoLease(db,student.id,'*');securityEvent(db,{userId:student.id,type:'admin_sessions_revoked',label:'Sesiones cerradas al bloquear la cuenta',score:0});}await writeDb(db);return json(res,200,{student:studentAdminPayload(db,student)});}
        }
        const revokeAllSessionsMatch=url.pathname.match(/^\/api\/admin\/student\/([^/]+)\/sessions\/revoke-all$/);
        if(revokeAllSessionsMatch&&req.method==='POST'){
          const student=db.users.find(u=>u.id===revokeAllSessionsMatch[1]&&u.role==='student');if(!student)return json(res,404,{error:'Alumno no encontrado'});
          const removed=db.sessions.filter(x=>x.userId===student.id).length;
          db.sessions=db.sessions.filter(x=>x.userId!==student.id);
          releaseVideoLease(db,student.id,'*');
          securityEvent(db,{userId:student.id,type:'admin_sessions_revoked',label:'Administración cerró todas las sesiones activas',score:0});
          await writeDb(db);return json(res,200,{ok:true,removed,student:studentAdminPayload(db,student)});
        }
        const revokeSessionMatch=url.pathname.match(/^\/api\/admin\/student\/([^/]+)\/session\/([^/]+)\/revoke$/);
        if(revokeSessionMatch&&req.method==='POST'){
          const student=db.users.find(u=>u.id===revokeSessionMatch[1]&&u.role==='student');if(!student)return json(res,404,{error:'Alumno no encontrado'});
          const session=db.sessions.find(x=>x.id===revokeSessionMatch[2]&&x.userId===student.id);if(!session)return json(res,404,{error:'Sesión no encontrada'});
          db.sessions=db.sessions.filter(x=>x.id!==session.id);
          releaseVideoLease(db,student.id,session.id);
          securityEvent(db,{userId:student.id,type:'admin_session_revoked',label:'Administración cerró una sesión: '+(session.deviceLabel||'dispositivo'),score:0,deviceKey:session.deviceKey,deviceLabel:session.deviceLabel,ipLabel:session.ipLabel});
          await writeDb(db);return json(res,200,{ok:true,student:studentAdminPayload(db,student)});
        }
        const studentEnrollMatch=url.pathname.match(/^\/api\/admin\/student\/([^/]+)\/enrollment$/);
        if(studentEnrollMatch&&req.method==='POST'){const student=db.users.find(u=>u.id===studentEnrollMatch[1]&&u.role==='student');if(!student)return json(res,404,{error:'Alumno no encontrado'});const body=await readBody(req);const course=db.courses.find(c=>c.id===body.courseId);if(!course)return json(res,404,{error:'Curso no encontrado'});let e=db.enrollments.find(x=>x.userId===student.id&&x.courseId===course.id);if(e){e.status='active';e.enrolledAt=e.enrolledAt||now();}else{e={id:newId(),userId:student.id,courseId:course.id,status:'active',enrolledAt:now(),source:'manual'};db.enrollments.push(e);}db.activity.push({id:newId(),userId:student.id,type:'enrollment_created',label:`Matrícula manual: ${course.title}`,at:now()});await writeDb(db);return json(res,201,{enrollment:e});}
        const studentEnrollmentDelete=url.pathname.match(/^\/api\/admin\/student\/([^/]+)\/enrollment\/([^/]+)$/);
        if(studentEnrollmentDelete&&req.method==='DELETE'){const studentId=studentEnrollmentDelete[1],courseId=studentEnrollmentDelete[2];const e=db.enrollments.find(x=>x.userId===studentId&&x.courseId===courseId);if(!e)return json(res,404,{error:'Matrícula no encontrada'});e.status='inactive';await writeDb(db);return json(res,200,{ok:true});}
        const studentNoteMatch=url.pathname.match(/^\/api\/admin\/student\/([^/]+)\/note$/);
        if(studentNoteMatch&&req.method==='POST'){const student=db.users.find(u=>u.id===studentNoteMatch[1]&&u.role==='student');if(!student)return json(res,404,{error:'Alumno no encontrado'});const body=await readBody(req);const note=cleanText(body.note,3000);if(!note)return json(res,400,{error:'La nota está vacía'});const item={id:newId(),userId:student.id,note,createdAt:now(),authorId:user.id};db.studentNotes ||= [];db.studentNotes.push(item);await writeDb(db);return json(res,201,{note:item});}
        const studentQaM10Match=url.pathname.match(/^\/api\/admin\/student\/([^/]+)\/course\/([^/]+)\/qa-unlock-m10$/);
        if(studentQaM10Match&&req.method==='POST'){
          if(!IS_PREVIEW)return json(res,404,{error:'Herramienta QA disponible solo en Preview'});
          const studentId=studentQaM10Match[1],courseId=studentQaM10Match[2];
          const student=db.users.find(u=>u.id===studentId&&u.role==='student');
          if(!student)return json(res,404,{error:'Alumno no encontrado'});
          const course=db.courses.find(c=>c.id===courseId);
          if(!course||course.slug!=='piel-perfecta-20')return json(res,400,{error:'QA M10 solo disponible para Piel Perfecta 2.0'});
          const enrollment=db.enrollments.find(e=>e.userId===studentId&&e.courseId===courseId&&e.status==='active');
          if(!enrollment)return json(res,404,{error:'Matrícula activa no encontrada'});
          const modules=db.modules.filter(m=>m.courseId===courseId).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0));
          const finalModule=modules.find(m=>m.code==='M10');
          if(!finalModule)return json(res,404,{error:'Módulo 10 no encontrado'});
          const finalLessons=db.lessons.filter(l=>l.moduleId===finalModule.id).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0));
          const firstFinal=finalLessons[0];
          if(!firstFinal)return json(res,404,{error:'Módulo 10 sin clases'});
          const priorModuleIds=new Set(modules.filter(m=>(Number(m.position)||0)<(Number(finalModule.position)||0)).map(m=>m.id));
          const priorLessons=db.lessons.filter(l=>priorModuleIds.has(l.moduleId));
          const priorLessonIds=new Set(priorLessons.map(l=>l.id));
          const finalLessonIds=new Set(finalLessons.map(l=>l.id));
          db.videoProgress=(db.videoProgress||[]).filter(v=>!(v.userId===studentId&&finalLessonIds.has(v.lessonId)));
          db.progress=db.progress.filter(p=>!(p.enrollmentId===enrollment.id&&finalLessonIds.has(p.lessonId)));
          const finalAssessmentIds=new Set(db.assessments.filter(a=>a.scopeType==='lesson'&&finalLessonIds.has(a.scopeId)).map(a=>a.id));
          db.attempts=db.attempts.filter(a=>!(a.userId===studentId&&finalAssessmentIds.has(a.assessmentId)));
          for(const lesson of priorLessons){
            for(const video of lessonVideos(lesson)){
              let vp=db.videoProgress.find(v=>v.userId===studentId&&v.lessonId===lesson.id&&String(v.videoId||'')===String(video.id||''));
              if(!vp){
                vp={id:newId(),userId:studentId,lessonId:lesson.id,videoId:video.id,currentTime:1,duration:1,percent:100,completed:true,lastPlayedAt:now()};
                db.videoProgress.push(vp);
              }else{
                vp.currentTime=Math.max(1,Number(vp.duration)||Number(vp.currentTime)||1);
                vp.duration=Math.max(1,Number(vp.duration)||1);
                vp.percent=100;vp.completed=true;vp.lastPlayedAt=now();
              }
            }
            const assessment=assessmentForScope(db,'lesson',lesson.id);
            if(assessment&&!db.attempts.some(a=>a.userId===studentId&&a.assessmentId===assessment.id&&a.passed)){
              const questions=db.questions.filter(q=>q.assessmentId===assessment.id).sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0));
              const answers=questions.map(q=>({questionId:q.id,selectedOption:q.correctOption,correct:true,correctOption:q.correctOption,explanation:q.explanation||''}));
              db.attempts.push({id:newId(),assessmentId:assessment.id,userId:studentId,score:100,passed:true,answers,submittedAt:now(),source:'preview_qa'});
            }
            syncLessonCompletion(db,student,lesson);
          }
          db.activity.push({id:newId(),userId:studentId,type:'preview_qa',label:'QA Preview: acceso preparado hasta Módulo 10',at:now()});
          await writeDb(db);
          return json(res,200,{ok:true,nextLesson:{id:firstFinal.id,code:firstFinal.code,title:firstFinal.title}});
        }

        const studentResetMatch=url.pathname.match(/^\/api\/admin\/student\/([^/]+)\/course\/([^/]+)\/reset-progress$/);
        if(studentResetMatch&&req.method==='POST'){const studentId=studentResetMatch[1],courseId=studentResetMatch[2];const enrollment=db.enrollments.find(e=>e.userId===studentId&&e.courseId===courseId);if(!enrollment)return json(res,404,{error:'Matrícula no encontrada'});const lessonIds=db.lessons.filter(l=>l.courseId===courseId).map(l=>l.id);db.progress=db.progress.filter(p=>!(p.enrollmentId===enrollment.id&&lessonIds.includes(p.lessonId)));db.videoProgress=db.videoProgress.filter(v=>!(v.userId===studentId&&lessonIds.includes(v.lessonId)));const assessmentIds=db.assessments.filter(a=>(a.scopeType==='lesson'&&lessonIds.includes(a.scopeId))||(a.scopeType==='module'&&db.modules.some(m=>m.id===a.scopeId&&m.courseId===courseId))).map(a=>a.id);db.attempts=db.attempts.filter(a=>!(a.userId===studentId&&assessmentIds.includes(a.assessmentId)));await writeDb(db);return json(res,200,{ok:true});}

        if(url.pathname==='/api/admin/course' && req.method==='POST'){
          const body=await readBody(req); if(!cleanText(body.title,160)) return json(res,400,{error:'El título es obligatorio'});
          const id=newId(); const course={id,slug:uniqueSlug(db,body.slug||body.title),title:cleanText(body.title,160),subtitle:cleanText(body.subtitle,220),description:cleanText(body.description,5000),status:safeStatus(body.status),certificateEnabled:body.certificateEnabled!==false,sequentialAccess:body.sequentialAccess===true,priceCents:Math.max(0,Number(body.priceCents)||0),currency:cleanText(body.currency,3)||'EUR',saleEnabled:body.saleEnabled!==false,createdAt:now(),updatedAt:now()};
          db.courses.push(course); await writeDb(db); return json(res,201,{course});
        }
        const courseMatch=url.pathname.match(/^\/api\/admin\/course\/([^/]+)$/);
        if(courseMatch){
          const course=db.courses.find(c=>c.id===courseMatch[1]); if(!course)return json(res,404,{error:'Curso no encontrado'});
          if(req.method==='PUT'){const body=await readBody(req);course.title=cleanText(body.title||course.title,160);course.subtitle=cleanText(body.subtitle??course.subtitle,220);course.description=cleanText(body.description??course.description,5000);course.slug=uniqueSlug(db,body.slug||course.slug,course.id);course.status=safeStatus(body.status??course.status);course.certificateEnabled=body.certificateEnabled!==false;course.sequentialAccess=body.sequentialAccess===true;if(body.priceCents!==undefined)course.priceCents=Math.max(0,Math.round(Number(body.priceCents)||0));if(body.currency!==undefined)course.currency=cleanText(body.currency,3)||'EUR';if(body.saleEnabled!==undefined){const requested=body.saleEnabled!==false&&body.saleEnabled!=='false';if(IS_PREVIEW&&course.slug==='piel-perfecta-20'){course.saleEnabled=false;db.meta ||= {};db.meta.previewSaleCourseSlugs ||= [];if(requested&&!db.meta.previewSaleCourseSlugs.includes(course.slug))db.meta.previewSaleCourseSlugs.push(course.slug);if(!requested)db.meta.previewSaleCourseSlugs=db.meta.previewSaleCourseSlugs.filter(x=>x!==course.slug);}else course.saleEnabled=requested;}course.updatedAt=now();await writeDb(db);return json(res,200,{course});}
          if(req.method==='DELETE'){
            if(db.enrollments.some(e=>e.courseId===course.id)) return json(res,409,{error:'No se puede eliminar un curso con matrículas. Puedes despublicarlo.'});
            const lessonIds=db.lessons.filter(l=>l.courseId===course.id).map(l=>l.id);for(const l of db.lessons.filter(l=>lessonIds.includes(l.id))){for(const r of l.resources||[])await deleteResourceFile(r);for(const v of lessonVideos(l)){if(String(v.ref||'').startsWith('blob:')){try{await resourceStore.remove(String(v.ref).slice(5));}catch{}}}}
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
          if(req.method==='DELETE'){for(const r of lesson.resources||[])await deleteResourceFile(r);for(const v of lessonVideos(lesson)){if(String(v.ref||'').startsWith('blob:')){try{await resourceStore.remove(String(v.ref).slice(5));}catch{}}}const assessmentIds=db.assessments.filter(a=>a.scopeType==='lesson'&&a.scopeId===lesson.id).map(a=>a.id);db.questions=db.questions.filter(q=>!assessmentIds.includes(q.assessmentId));db.attempts=db.attempts.filter(a=>!assessmentIds.includes(a.assessmentId));db.assessments=db.assessments.filter(a=>!assessmentIds.includes(a.id));db.progress=db.progress.filter(p=>p.lessonId!==lesson.id);db.videoProgress=db.videoProgress.filter(v=>v.lessonId!==lesson.id);db.lessons=db.lessons.filter(l=>l.id!==lesson.id);await writeDb(db);return json(res,200,{ok:true});}
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


        if(url.pathname==='/api/admin/piel-perfecta/publish-ready' && req.method==='POST'){
          if(!IS_PREVIEW)return json(res,403,{error:'Esta acción de preparación solo está habilitada en Preview'});
          const course=db.courses.find(c=>c.slug==='piel-perfecta-20');
          if(!course)return json(res,404,{error:'Piel Perfecta 2.0 no encontrado'});
          const preflight=courseSaleReadiness(db,course,{ignorePublication:true});
          if(!preflight.ready)return json(res,409,{error:'Piel Perfecta todavía no supera el checklist de lanzamiento',readiness:preflight});
          const modules=db.modules.filter(m=>m.courseId===course.id);
          const lessons=db.lessons.filter(l=>l.courseId===course.id);
          const lessonIds=new Set(lessons.map(l=>l.id));
          const assessments=db.assessments.filter(a=>a.scopeType==='lesson'&&lessonIds.has(a.scopeId));
          const t=now();
          modules.forEach(m=>{m.status='published';m.updatedAt=t;});
          lessons.forEach(l=>{l.status='published';l.updatedAt=t;});
          assessments.forEach(a=>{a.status='published';a.updatedAt=t;});
          course.status='published';course.saleEnabled=false;course.sequentialAccess=true;course.updatedAt=t;
          db.meta ||= {}; db.meta.previewSaleCourseSlugs ||= [];
          if(!db.meta.previewSaleCourseSlugs.includes(course.slug))db.meta.previewSaleCourseSlugs.push(course.slug);
          await writeDb(db);
          const readiness=courseSaleReadiness(db,course);
          logEvent('info','piel_perfecta_preview_published',{courseId:course.id,ready:readiness.ready,modules:modules.length,lessons:lessons.length,assessments:assessments.length});
          return json(res,200,{ok:true,readiness});
        }

        const certMatch=url.pathname.match(/^\/api\/admin\/certificate\/([^/]+)\/revoke$/);
        if(certMatch&&req.method==='POST'){const cert=db.certificates.find(c=>c.id===certMatch[1]);if(!cert)return json(res,404,{error:'Certificado no encontrado'});cert.status='revoked';cert.revokedAt=now();await writeDb(db);return json(res,200,{certificate:publicCertificate(db,cert)});}

        if(url.pathname==='/api/admin/video/upload-url' && req.method==='POST'){
          const body=await readBody(req);const lesson=db.lessons.find(l=>l.id===body.lessonId);if(!lesson)return json(res,404,{error:'Clase no encontrada'});
          const name=cleanText(body.name,220);const mime=cleanText(body.mime,120).toLowerCase();const size=Math.max(0,Number(body.size)||0);
          if(!name||!size)return json(res,400,{error:'Datos de vídeo incompletos'});
          if(!['video/mp4','video/webm','video/quicktime'].includes(mime))return json(res,415,{error:'Formato de vídeo no permitido'});
          if(size>MAX_VIDEO_BYTES)return json(res,413,{error:'El vídeo supera el límite de 2 GB por archivo'});
          const mode=body.mode==='replace'?'replace':'add';const replaceVideoId=cleanText(body.videoId,120)||null;

          if(VIDEO_PROVIDER==='bunny'){
            if(!bunnyConfigured())return json(res,503,{error:'Bunny Stream no está completamente configurado en este entorno'});
            const created=await bunnyCreateVideo((lesson.code?lesson.code+' · ':'')+name);
            const guid=cleanText(created.guid,120);
            const expiresSeconds=Math.floor(Date.now()/1000)+(6*60*60);
            const expiresAt=expiresSeconds*1000;
            const pathname='bunny:'+guid;
            const ticket=signVideoUploadTicket({provider:'bunny',lessonId:lesson.id,pathname,bunnyVideoId:guid,name,mime,size,mode,replaceVideoId,expiresAt});
            return json(res,200,{...bunnyTusCredentials(guid,expiresSeconds),ticket,expiresAt});
          }

          const ext=path.extname(name).slice(0,10).replace(/[^.a-zA-Z0-9]/g,'')||'.mp4';
          const pathname=`videos/${lesson.id}/${newId()}${ext}`;
          const expiresAt=Date.now()+2*60*60*1000;
          const {issueSignedToken,presignUrl}=await import('@vercel/blob');
          const signedToken=await issueSignedToken({pathname,operations:['put'],validUntil:expiresAt,allowedContentTypes:[mime],maximumSizeInBytes:MAX_VIDEO_BYTES});
          const signed=await presignUrl(signedToken,{pathname,operation:'put',access:'private',validUntil:expiresAt,allowedContentTypes:[mime],maximumSizeInBytes:MAX_VIDEO_BYTES,addRandomSuffix:false,allowOverwrite:false});
          const ticket=signVideoUploadTicket({provider:'blob',lessonId:lesson.id,pathname,name,mime,size,mode,replaceVideoId,expiresAt});
          return json(res,200,{provider:'blob',uploadUrl:signed.presignedUrl,ticket,expiresAt});
        }
        if(url.pathname==='/api/admin/video/complete' && req.method==='POST'){
          const body=await readBody(req);const claims=verifyVideoUploadTicket(body.ticket);if(!claims)return json(res,400,{error:'Carga de vídeo inválida o caducada'});
          const lesson=db.lessons.find(l=>l.id===claims.lessonId);if(!lesson)return json(res,404,{error:'Clase no encontrada'});
          let nextRef=null,verifiedSize=Number(claims.size)||null,remoteStatus=null,encodeProgress=null;
          if(claims.provider==='bunny'||String(claims.pathname||'').startsWith('bunny:')){
            const guid=cleanText(claims.bunnyVideoId||String(claims.pathname||'').slice(6),120);
            if(!guid)return json(res,400,{error:'Identificador Bunny inválido'});
            let meta;try{meta=await bunnyGetVideo(guid)}catch{return json(res,409,{error:'Bunny todavía no reconoce el vídeo subido'})}
            nextRef='bunny:'+guid;
            verifiedSize=Number(meta?.storageSize)||verifiedSize;
            remoteStatus=Number(meta?.status);
            encodeProgress=Number(meta?.encodeProgress)||0;
          }else{
            const {head}=await import('@vercel/blob');
            let blobMeta;try{blobMeta=await head(claims.pathname)}catch{return json(res,409,{error:'El archivo todavía no está disponible en Blob'})}
            nextRef='blob:'+claims.pathname;
            verifiedSize=Number(blobMeta?.size)||verifiedSize;
          }
          lesson.videos=lessonVideos(lesson);
          const existingVideo=lesson.videos.find(v=>String(v.ref||'')===String(nextRef));
          if(existingVideo)return json(res,200,{ok:true,idempotent:true,video:existingVideo,videos:lesson.videos,processing:String(existingVideo.ref||'').startsWith('bunny:')&&Number(existingVideo.encodeProgress||0)<100});
          const nextVideo={id:newId(),ref:nextRef,name:claims.name,mime:claims.mime,size:verifiedSize,position:lesson.videos.length+1,createdAt:now(),provider:nextRef.startsWith('bunny:')?'bunny':'blob',remoteStatus,encodeProgress};
          let oldRef=null;
          if(claims.mode==='replace'){
            const idx=Math.max(0,lesson.videos.findIndex(v=>v.id===claims.replaceVideoId));
            const previous=lesson.videos[idx];if(previous){nextVideo.id=previous.id;nextVideo.position=previous.position||idx+1;oldRef=previous.ref||null;lesson.videos[idx]=nextVideo;}else lesson.videos.push(nextVideo);
          }else lesson.videos.push(nextVideo);
          lesson.videos.sort((a,b)=>(Number(a.position)||0)-(Number(b.position)||0)).forEach((v,i)=>v.position=i+1);
          syncPrimaryVideoFields(lesson);lesson.updatedAt=now();
          if(claims.mode==='replace')db.videoProgress=db.videoProgress.filter(v=>!(v.lessonId===lesson.id&&String(v.videoId||'')===String(nextVideo.id)));
          reconcileLessonForStudents(db,lesson);
          await writeDb(db);
          if(oldRef&&oldRef!==nextVideo.ref)await removeStoredVideoRef(oldRef);
          return json(res,201,{ok:true,video:nextVideo,videos:lesson.videos,processing:nextVideo.provider==='bunny'&&Number(encodeProgress)<100});
        }
        if(url.pathname==='/api/admin/video/cancel' && req.method==='POST'){
          const body=await readBody(req);const claims=verifyVideoUploadTicket(body.ticket);if(!claims)return json(res,400,{error:'Carga inválida o caducada'});
          if(claims.provider==='bunny'||String(claims.pathname||'').startsWith('bunny:')){
            const guid=cleanText(claims.bunnyVideoId||String(claims.pathname||'').slice(6),120);
            if(guid)await bunnyDeleteVideo(guid);
          }
          return json(res,200,{ok:true});
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
          lesson.videos=lessonVideos(lesson);const requested=url.searchParams.get('videoId');const target=requested?lesson.videos.find(v=>v.id===requested):lesson.videos[0];if(!target)return json(res,404,{error:'Vídeo no encontrado'});
          await removeStoredVideoRef(target.ref);
          lesson.videos=lesson.videos.filter(v=>v.id!==target.id).map((v,i)=>({...v,position:i+1}));db.videoProgress=db.videoProgress.filter(v=>!(v.lessonId===lesson.id&&String(v.videoId||'')===String(target.id)));
          syncPrimaryVideoFields(lesson);lesson.updatedAt=now();reconcileLessonForStudents(db,lesson);await writeDb(db);return json(res,200,{ok:true,videos:lesson.videos});
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
