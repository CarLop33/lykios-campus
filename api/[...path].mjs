import { handleRequest } from '../server.mjs';

function normalizePath(value) {
  if (Array.isArray(value)) return value.join('/');
  if (value == null) return '';
  return String(value);
}

export default async function handler(req, res) {
  const rawPath = normalizePath(req.query?.path);
  const current = new URL(req.url || '/', 'https://lykios.internal');

  current.searchParams.delete('path');
  const qs = current.searchParams.toString();
  req.url = '/api/' + rawPath.replace(/^\/+/, '') + (qs ? '?' + qs : '');

  return handleRequest(req, res);
}
