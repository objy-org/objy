import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const source = readFileSync(resolveClientModule());
const version = createHash('sha256').update(source).digest('hex').slice(0, 16);
export const clientPath = `/client/${version}.js`;

function resolveClientModule() {
  try {
    return fileURLToPath(import.meta.resolve('@objy/client'));
  } catch (cause) {
    const sibling = new URL('../../../objy-client/index.js', import.meta.url);
    if (existsSync(sibling)) return sibling;
    throw new Error('@objy/client is required by the OBJY DB server', { cause });
  }
}

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
