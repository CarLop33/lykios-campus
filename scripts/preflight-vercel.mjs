import { inspectEnvironment } from './env-requirements.mjs';

const target=process.env.VERCEL_ENV||'development';
const result=inspectEnvironment(target);
console.log(JSON.stringify({
  app:'lykios-campus',
  vercelEnv:target,
  ...result
},null,2));
if(result.status!=='GO') process.exit(1);
