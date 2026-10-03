/** Apply CORS before routing, including error responses and preflight requests. */
export function createCorsHandler(config = false) {
  if (config === false || config == null) return () => false;
  const origins = config.origins;
  if (!Array.isArray(origins) || !origins.length || origins.some(origin => typeof origin !== 'string')) {
    throw new TypeError('cors.origins must be a non-empty array of origins');
  }
  const allowed = new Set(origins);
  const methods = 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS';
  const headers = ['authorization', 'content-type', 'prefer', ...(config.headers || []).map(name => name.toLowerCase())];
  return (req, res) => {
    const origin = req.headers.origin;
    if (!origin) return false;
    res.setHeader('vary', 'Origin');
    const accepted = allowed.has('*') || allowed.has(origin);
    if (accepted) {
      res.setHeader('access-control-allow-origin', allowed.has('*') ? '*' : origin);
      res.setHeader('access-control-expose-headers', 'ETag, Link, Retry-After, Content-Disposition');
    }
    if (req.method !== 'OPTIONS') return false;
    const requested = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(name => name.trim()).filter(Boolean);
    const method = req.headers['access-control-request-method'];
    if (!accepted || !methods.split(', ').includes(method) || requested.some(name => !headers.includes(name))) {
      res.writeHead(403); res.end(); return true;
    }
    res.setHeader('access-control-allow-methods', methods);
    res.setHeader('access-control-allow-headers', headers.join(', '));
    res.setHeader('access-control-max-age', '600');
    res.writeHead(204); res.end(); return true;
  };
}
