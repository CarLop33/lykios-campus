const requiredCommon = ['DATABASE_URL','SESSION_SECRET','VIDEO_SIGNING_SECRET'];
const requiredPreview = [...requiredCommon];
const requiredProduction = [...requiredCommon,'STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'];
const env = process.env.VERCEL_ENV || 'development';
const req = env === 'production' ? requiredProduction : (env === 'preview' ? requiredPreview : []);
const missing = req.filter(k => !process.env[k]);
console.log(JSON.stringify({
  app: 'lykios-campus',
  vercelEnv: env,
  required: req,
  missing,
  status: missing.length ? 'NO_GO' : 'GO'
}, null, 2));
if (missing.length) process.exit(1);
