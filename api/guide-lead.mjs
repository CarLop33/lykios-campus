import pg from 'pg';
const { Pool } = pg;

const ALLOWED_ORIGINS = new Set([
  'https://lykiosacademy.com',
  'https://www.lykiosacademy.com',
  'https://piel-perfecta.lykiosacademy.com',
  'https://lykios-academy.vercel.app'
]);

const SOURCE = 'instagram-dm-piel';
const CONTACT_EMAIL = process.env.LYKIOS_MAIL_REPLY_TO || 'info@lykiosacademy.com';
const FROM_EMAIL = process.env.LYKIOS_MAIL_FROM || 'campus@lykiosacademy.com';
const FROM_NAME = process.env.LYKIOS_MAIL_FROM_NAME || 'Lykios Academy';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const GUIDE_URL = 'https://campus.lykiosacademy.com/api/public/piel-perfecta-guide.pdf';
const COURSE_URL = 'https://www.lykiosacademy.com/cursos/piel-perfecta-2';
const LOGO_URL = 'https://www.lykiosacademy.com/assets/logo.jpg';
const COURSE_IMAGE_URL = 'https://www.lykiosacademy.com/assets/piel-perfecta.webp';

let pool;

function getPool() {
  if (!pool) {
    if (!DATABASE_URL) throw new Error('DATABASE_URL missing');
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
}

function clean(value, max = 255) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}
function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}
function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body); } catch {}
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('invalid_json'); }
}

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS lykios_leads (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      privacy_consent BOOLEAN NOT NULL DEFAULT FALSE,
      marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      submissions_count INTEGER NOT NULL DEFAULT 1,
      last_email_status TEXT NOT NULL DEFAULT 'pending',
      last_email_id TEXT,
      referrer TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lykios_leads_source ON lykios_leads(source)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lykios_leads_last_seen ON lykios_leads(last_seen_at DESC)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS lykios_lead_events (
      id BIGSERIAL PRIMARY KEY,
      lead_email TEXT NOT NULL,
      event_type TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata JSONB
    )
  `);
}

async function sendEmail(payload) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY missing');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Resend ${response.status}: ${data?.message || 'send failed'}`);
  return data;
}

function emailHtml(name) {
  const safeName = escapeHtml(name);
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Tu Guía Piel Perfecta</title>
</head>
<body style="margin:0;background-color:#f0f4f5;font-family:Arial,Helvetica,sans-serif;color:#0a2a30;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f0f4f5;">
<tr><td align="center" style="padding-top:24px;padding-right:12px;padding-bottom:24px;padding-left:12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#fdfefe;border-radius:22px;overflow:hidden;">
<tr><td align="center" bgcolor="#053d47" style="background-color:#053d47;padding-top:34px;padding-right:28px;padding-bottom:30px;padding-left:28px;">
<img src="${LOGO_URL}" width="76" height="76" border="0" alt="Lykios Academy" style="display:block;width:76px;height:76px;border-radius:16px;margin:0 auto;">
<p style="font-size:11px;line-height:16px;color:#bfe8e5;font-weight:700;letter-spacing:2px;margin-top:18px;margin-right:0;margin-bottom:0;margin-left:0;text-transform:uppercase;">GUÍA GRATUITA · PIEL PERFECTA 2.0</p>
<h1 style="font-size:34px;line-height:38px;color:#ffffff;font-weight:800;margin-top:12px;margin-right:0;margin-bottom:0;margin-left:0;">Gracias por confiar en nosotros, ${safeName}.</h1>
</td></tr>

<tr><td style="padding-top:32px;padding-right:36px;padding-bottom:10px;padding-left:36px;">
<p style="font-size:16px;line-height:27px;color:#4d696e;margin-top:0;margin-right:0;margin-bottom:12px;margin-left:0;">Has dado un primer paso sencillo, pero importante: empezar a cuidar tu piel con más criterio y menos ruido.</p>
<p style="font-size:16px;line-height:27px;color:#4d696e;margin-top:0;margin-right:0;margin-bottom:0;margin-left:0;">Hemos preparado esta guía para ayudarte a observar, simplificar y tomar mejores decisiones desde hoy.</p>
</td></tr>

<tr><td style="padding-top:22px;padding-right:36px;padding-bottom:10px;padding-left:36px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f7fbfb;border:1px solid #dbe8e9;border-radius:18px;">
<tr><td style="padding-top:24px;padding-right:24px;padding-bottom:24px;padding-left:24px;">
<p style="font-size:10px;line-height:15px;color:#319ea5;font-weight:800;letter-spacing:1.7px;margin-top:0;margin-right:0;margin-bottom:7px;margin-left:0;text-transform:uppercase;">TU GUÍA</p>
<h2 style="font-size:24px;line-height:29px;color:#0a2a30;font-weight:800;margin-top:0;margin-right:0;margin-bottom:10px;margin-left:0;">Tu rutina de piel, con criterio</h2>
<p style="font-size:14px;line-height:23px;color:#5d777b;margin-top:0;margin-right:0;margin-bottom:18px;margin-left:0;">Una guía práctica para observar tu piel, simplificar tu rutina y seguir un pequeño plan de 7 días.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#076f72" style="background-color:#076f72;border-radius:12px;">
<a href="${GUIDE_URL}" target="_blank" style="display:inline-block;padding-top:15px;padding-right:22px;padding-bottom:15px;padding-left:22px;font-size:14px;line-height:14px;color:#ffffff;text-decoration:none;font-weight:800;">ABRIR MI GUÍA →</a>
</td></tr></table>
</td></tr></table>
</td></tr>

<tr><td style="padding-top:24px;padding-right:36px;padding-bottom:8px;padding-left:36px;">
<p style="font-size:11px;line-height:16px;color:#076f72;font-weight:800;letter-spacing:1.6px;margin-top:0;margin-right:0;margin-bottom:7px;margin-left:0;text-transform:uppercase;">EMPIEZA POR AQUÍ</p>
<h3 style="font-size:22px;line-height:26px;color:#0a2a30;font-weight:800;margin-top:0;margin-right:0;margin-bottom:10px;margin-left:0;">Observa → Simplifica → Ajusta</h3>
<p style="font-size:14px;line-height:24px;color:#5d777b;margin-top:0;margin-right:0;margin-bottom:0;margin-left:0;">No intentes cambiar toda tu rutina hoy. Empieza observando qué tienes, cómo responde tu piel y qué pasos realmente necesitas.</p>
</td></tr>

<tr><td style="padding-top:30px;padding-right:36px;padding-bottom:12px;padding-left:36px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:1px;background-color:#dfe9ea;font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr>

<tr><td style="padding-top:16px;padding-right:36px;padding-bottom:4px;padding-left:36px;">
<p style="font-size:11px;line-height:16px;color:#c8a96e;font-weight:800;letter-spacing:1.6px;margin-top:0;margin-right:0;margin-bottom:7px;margin-left:0;text-transform:uppercase;">Y SI QUIERES IR UN POCO MÁS ALLÁ…</p>
<h2 style="font-size:27px;line-height:32px;color:#0a2a30;font-weight:800;margin-top:0;margin-right:0;margin-bottom:10px;margin-left:0;">Aprender para decidir mejor.</h2>
<p style="font-size:14px;line-height:24px;color:#5d777b;margin-top:0;margin-right:0;margin-bottom:0;margin-left:0;">Lykios Academy transforma información compleja en conocimiento práctico, comprensible y aplicable. No queremos que memorices recetas: queremos que entiendas el porqué de cada decisión.</p>
</td></tr>

<tr><td style="padding-top:24px;padding-right:36px;padding-bottom:30px;padding-left:36px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#053d47" style="width:100%;background-color:#053d47;border-radius:18px;">
<tr><td style="padding-top:24px;padding-right:24px;padding-bottom:24px;padding-left:24px;">
<img src="${COURSE_IMAGE_URL}" width="180" height="180" border="0" alt="Piel Perfecta 2.0" style="display:block;width:180px;height:180px;border-radius:14px;margin-bottom:18px;">
<p style="font-size:10px;line-height:15px;color:#98ddd6;font-weight:800;letter-spacing:1.7px;margin-top:0;margin-right:0;margin-bottom:7px;margin-left:0;text-transform:uppercase;">SI ESTA GUÍA TE HA RESULTADO ÚTIL</p>
<h2 style="font-size:27px;line-height:30px;color:#ffffff;font-weight:800;margin-top:0;margin-right:0;margin-bottom:7px;margin-left:0;">Piel Perfecta 2.0</h2>
<p style="font-size:14px;line-height:22px;color:#cce4e3;font-weight:600;margin-top:0;margin-right:0;margin-bottom:12px;margin-left:0;">Entiende tu piel. Cuídala con criterio para siempre.</p>
<p style="font-size:13px;line-height:22px;color:#d9ebea;margin-top:0;margin-right:0;margin-bottom:16px;margin-left:0;">La guía es solo el punto de partida. En el curso aprenderás a entender tu piel, elegir cosméticos con criterio y construir tu propia <strong>Rutina Maestra</strong>.</p>
<p style="font-size:11px;line-height:19px;color:#e9f6f5;font-weight:700;margin-top:0;margin-right:0;margin-bottom:16px;margin-left:0;">11 módulos · Acceso de por vida · Recursos + tests · Certificado</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#68c7bf" style="background-color:#68c7bf;border-radius:11px;">
<a href="${COURSE_URL}" target="_blank" style="display:inline-block;padding-top:13px;padding-right:18px;padding-bottom:13px;padding-left:18px;font-size:12px;line-height:12px;color:#053d47;text-decoration:none;font-weight:800;">CONOCER PIEL PERFECTA 2.0 →</a>
</td></tr></table>
</td></tr></table>
</td></tr>

<tr><td style="padding-top:0;padding-right:36px;padding-bottom:32px;padding-left:36px;">
<h3 style="font-size:20px;line-height:24px;color:#0a2a30;font-weight:800;margin-top:0;margin-right:0;margin-bottom:8px;margin-left:0;">Gracias de nuevo por estar aquí.</h3>
<p style="font-size:14px;line-height:24px;color:#5d777b;margin-top:0;margin-right:0;margin-bottom:16px;margin-left:0;">Esperamos que esta guía te ayude a ver el cuidado de tu piel de otra manera: con menos ruido, menos compras impulsivas y mucho más criterio.</p>
<p style="font-size:13px;line-height:21px;color:#0a2a30;font-weight:700;margin-top:0;margin-right:0;margin-bottom:0;margin-left:0;">Equipo Lykios Academy<br><span style="font-weight:500;color:#71878a;">by Dr. Carlos López Scovino</span></p>
</td></tr>

<tr><td align="center" bgcolor="#eef4f5" style="background-color:#eef4f5;border-top:1px solid #dde8e9;padding-top:24px;padding-right:28px;padding-bottom:24px;padding-left:28px;">
<p style="font-size:11px;line-height:18px;color:#73898d;margin-top:0;margin-right:0;margin-bottom:8px;margin-left:0;">Lykios Academy · Formación digital y cursos online</p>
<p style="font-size:10px;line-height:16px;color:#84979a;margin-top:0;margin-right:0;margin-bottom:0;margin-left:0;">Has recibido este correo porque solicitaste la Guía Piel Perfecta desde uno de nuestros canales.</p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return json(res, 405, { ok:false, error:'Método no permitido.' });
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json(res, 403, { ok:false, error:'Origen no autorizado.' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return json(res, 400, { ok:false, error:'Solicitud no válida.' });
  }

  if (body.website) return json(res, 200, { ok:true });

  const name = clean(body.name, 100);
  const email = clean(body.email, 254).toLowerCase();
  const utmSourceRaw = clean(body.utm_source, 120).toLowerCase();
  const source = utmSourceRaw === 'tiktok'
    ? 'tiktok-dm-piel'
    : utmSourceRaw === 'instagram'
      ? 'instagram-dm-piel'
      : SOURCE;
  const privacyConsent = body.privacy === true || body.privacy === 'on';
  const marketingConsent = body.marketing === true || body.marketing === 'on';
  const referrer = clean(body.referrer, 500);
  const utmSource = clean(body.utm_source, 120);
  const utmMedium = clean(body.utm_medium, 120);
  const utmCampaign = clean(body.utm_campaign, 180);

  if (name.length < 2 || !validEmail(email) || !privacyConsent) {
    console.warn('Guide lead validation failed', {
      hasName: name.length >= 2,
      validEmail: validEmail(email),
      privacyConsent,
      source
    });
    return json(res, 400, { ok:false, error:'Revisa tu nombre, correo y aceptación de privacidad.' });
  }

  const db = getPool();

  try {
    await ensureSchema(db);
    await db.query(
      `INSERT INTO lykios_leads
        (email,name,source,privacy_consent,marketing_consent,referrer,utm_source,utm_medium,utm_campaign)
       VALUES ($1,$2,$3,TRUE,$4,$5,$6,$7,$8)
       ON CONFLICT (email) DO UPDATE SET
        name=EXCLUDED.name,
        source=EXCLUDED.source,
        privacy_consent=TRUE,
        marketing_consent=(lykios_leads.marketing_consent OR EXCLUDED.marketing_consent),
        last_seen_at=NOW(),
        submissions_count=lykios_leads.submissions_count+1,
        referrer=COALESCE(NULLIF(EXCLUDED.referrer,''),lykios_leads.referrer),
        utm_source=COALESCE(NULLIF(EXCLUDED.utm_source,''),lykios_leads.utm_source),
        utm_medium=COALESCE(NULLIF(EXCLUDED.utm_medium,''),lykios_leads.utm_medium),
        utm_campaign=COALESCE(NULLIF(EXCLUDED.utm_campaign,''),lykios_leads.utm_campaign)`,
      [email,name,source,marketingConsent,referrer,utmSource,utmMedium,utmCampaign]
    );
    await db.query(
      `INSERT INTO lykios_lead_events (lead_email,event_type,source,metadata)
       VALUES ($1,'guide_requested',$2,$3::jsonb)`,
      [email, source, JSON.stringify({ marketingConsent, referrer, utmSource, utmMedium, utmCampaign })]
    );
  } catch (error) {
    console.error('Guide lead DB error', error?.message);
    return json(res, 500, { ok:false, error:'No hemos podido guardar tus datos. Inténtalo de nuevo.' });
  }

  try {
    const customer = await sendEmail({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [email],
      reply_to: CONTACT_EMAIL,
      subject: `${name}, aquí tienes tu Guía Piel Perfecta ✨`,
      html: emailHtml(name),
      tags: [
        { name:'source', value:source },
        { name:'campaign', value:'guia-piel-perfecta' }
      ]
    });

    await sendEmail({
      from: `Lykios Leads <${FROM_EMAIL}>`,
      to: [CONTACT_EMAIL],
      reply_to: email,
      subject: `${source} — Nuevo lead: ${name}`,
      html: `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#0a2a30;"><h2>Nuevo lead · Piel Perfecta</h2><p><strong>Nombre:</strong> ${escapeHtml(name)}</p><p><strong>Email:</strong> ${escapeHtml(email)}</p><p><strong>Origen:</strong> ${escapeHtml(source)}</p><p><strong>Privacidad:</strong> aceptada</p><p><strong>Marketing:</strong> ${marketingConsent ? 'sí' : 'no'}</p><p><strong>Fecha:</strong> ${new Date().toISOString()}</p></body></html>`,
      tags: [
        { name:'source', value:source },
        { name:'type', value:'internal-lead-alert' }
      ]
    });

    await db.query(
      `UPDATE lykios_leads SET last_email_status='sent', last_email_id=$1 WHERE email=$2`,
      [customer?.id || null, email]
    );
    await db.query(
      `INSERT INTO lykios_lead_events (lead_email,event_type,source,metadata)
       VALUES ($1,'guide_email_sent',$2,$3::jsonb)`,
      [email, source, JSON.stringify({ resendId: customer?.id || null })]
    );

    return json(res, 200, { ok:true });
  } catch (error) {
    console.error('Guide email error', error?.message);
    try {
      await db.query(`UPDATE lykios_leads SET last_email_status='failed' WHERE email=$1`, [email]);
      await db.query(
        `INSERT INTO lykios_lead_events (lead_email,event_type,source,metadata)
         VALUES ($1,'guide_email_failed',$2,$3::jsonb)`,
        [email, source, JSON.stringify({ error:String(error?.message || 'unknown').slice(0,500) })]
      );
    } catch {}
    return json(res, 502, { ok:false, error:'Tus datos se han guardado, pero no hemos podido enviar la guía. Inténtalo de nuevo en unos minutos.' });
  }
}
