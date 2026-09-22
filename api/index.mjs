import { handleRequest } from '../server.mjs';

function one(value) {
  if (Array.isArray(value)) return value.join('/');
  return value == null ? null : String(value);
}

export default async function handler(req,res){
  try {
    const base = new URL(req.url || '/', 'https://lykios.internal');
    const apiPath = one(req.query?.lykios_path) ?? base.searchParams.get('lykios_path');
    const verifyPath = one(req.query?.lykios_verify) ?? base.searchParams.get('lykios_verify');

    if (apiPath !== null) {
      base.searchParams.delete('lykios_path');
      const qs = base.searchParams.toString();
      req.url = '/api/' + apiPath.replace(/^\/+/, '') + (qs ? '?' + qs : '');
    } else if (verifyPath !== null) {
      base.searchParams.delete('lykios_verify');
      const qs = base.searchParams.toString();
      req.url = '/verify/' + verifyPath.replace(/^\/+/, '') + (qs ? '?' + qs : '');
    }

    return handleRequest(req,res);
  } catch (error) {
    console.error(JSON.stringify({event:'vercel_route_reconstruction_failed',error:error?.message || String(error)}));
    res.statusCode = 500;
    res.setHeader('content-type','application/json; charset=utf-8');
    res.end(JSON.stringify({error:'Error interno'}));
  }
}
