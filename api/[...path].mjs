import { handleRequest } from '../server.mjs';

function normalizePath(value) {
  if (Array.isArray(value)) return value.join('/');
  if (value == null) return '';
  return String(value);
}

export default async function handler(req, res) {
  const current = new URL(req.url || '/', 'https://lykios.internal');
  let rawPath = normalizePath(req.query?.path);

  if (!rawPath) {
    const pathname = current.pathname || '';
    if (pathname.startsWith('/api/')) rawPath = pathname.slice('/api/'.length);
  }

  current.searchParams.delete('path');
  const qs = current.searchParams.toString();
  req.url = '/api/' + rawPath.replace(/^\/+/, '') + (qs ? '?' + qs : '');

  return handleRequest(req, res);
}
