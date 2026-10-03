import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = readFileSync(new URL('../../client/index.js', import.meta.url));
const version = createHash('sha256').update(source).digest('hex').slice(0, 16);
export const clientPath = `/client/${version}.js`;

export function createClientInterface() {
  return {
    name: 'client',
    register(router) {
      const send = (req, res) => {
        res.setHeader('content-type', 'text/javascript; charset=utf-8');
        res.setHeader('etag', `"${version}"`);
        res.setHeader('cache-control', req.path === clientPath ? 'public, max-age=31536000, immutable' : 'no-cache');
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('link', `<${clientPath}>; rel="canonical"`);
        if (req.headers['if-none-match'] === `"${version}"`) { res.writeHead(304); res.end(); return; }
        res.setHeader('content-length', source.length);
        res.writeHead(200);
        res.end(req.method === 'HEAD' ? undefined : source);
      };
      for (const path of ['/client.js', clientPath]) {
        router.get(path, send);
        router.add('HEAD', path, send);
      }
    },
  };
}
