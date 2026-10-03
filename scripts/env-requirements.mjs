export function inspectEnvironment(target=(process.env.VERCEL_ENV||'preview')){
  const normalized=String(target||'preview').toLowerCase();
  const isProduction=normalized==='production';

  const required=[
    'DATABASE_URL',
    'LYKIOS_VIDEO_SECRET',
    'LYKIOS_ADMIN_EMAIL',
    'LYKIOS_ADMIN_PASSWORD',
    'RESEND_API_KEY',
    'BLOB_READ_WRITE_TOKEN'
  ];
  if(isProduction) required.push('LYKIOS_APP_ORIGIN','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET');

  const missing=required.filter(k=>!String(process.env[k]||'').trim());
  const invalid=[];

  const db=String(process.env.DATABASE_URL||'').trim();
  if(db&&!/^postgres(?:ql)?:\/\//i.test(db)) invalid.push('DATABASE_URL no parece una URL PostgreSQL');

  const video=String(process.env.LYKIOS_VIDEO_SECRET||'');
  if(video&&video.length<32) invalid.push('LYKIOS_VIDEO_SECRET debe tener al menos 32 caracteres');

  const adminPassword=String(process.env.LYKIOS_ADMIN_PASSWORD||'');
  const minAdmin=isProduction?14:12;
  if(adminPassword&&adminPassword.length<minAdmin) invalid.push(`LYKIOS_ADMIN_PASSWORD debe tener al menos ${minAdmin} caracteres`);

  if(isProduction){
    const origin=String(process.env.LYKIOS_APP_ORIGIN||'').trim();
    if(origin&&!/^https:\/\//i.test(origin)) invalid.push('LYKIOS_APP_ORIGIN debe usar HTTPS');
    const provider=String(process.env.LYKIOS_PAYMENT_PROVIDER||'stripe').toLowerCase();
    if(provider!=='stripe') invalid.push('LYKIOS_PAYMENT_PROVIDER debe ser stripe en producción');
  }

  const fileBackend=String(process.env.LYKIOS_FILE_BACKEND||'blob').toLowerCase();
  if(['preview','production'].includes(normalized)&&fileBackend!=='blob') invalid.push('LYKIOS_FILE_BACKEND debe ser blob en Vercel');

  const storageBackend=String(process.env.LYKIOS_STORAGE_BACKEND||'postgres').toLowerCase();
  if(['preview','production'].includes(normalized)&&storageBackend!=='postgres') invalid.push('LYKIOS_STORAGE_BACKEND debe ser postgres en Vercel');

  return {target:normalized,required,missing,invalid,status:(!missing.length&&!invalid.length)?'GO':'NO_GO'};
}
