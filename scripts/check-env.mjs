import { inspectEnvironment } from './env-requirements.mjs';

const target=process.argv[2]||process.env.VERCEL_ENV||'preview';
const result=inspectEnvironment(target);
console.log(JSON.stringify(result,null,2));
if(result.status!=='GO') process.exit(1);
