const target = process.argv[2] || 'preview';
const common = ['DATABASE_URL','LYKIOS_VIDEO_SECRET','LYKIOS_ADMIN_EMAIL','LYKIOS_ADMIN_PASSWORD'];
const prod = ['LYKIOS_APP_ORIGIN','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'];
const required = target === 'production' ? [...common, ...prod] : common;
const missing = required.filter(k => !String(process.env[k] || '').trim());
if (missing.length) {
  console.error(`NO-GO ${target}: faltan ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`GO ${target}: ${required.length} variables requeridas presentes.`);
