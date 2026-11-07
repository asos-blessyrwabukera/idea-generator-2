// The server listens on loopback with no login, so any web page open in the same browser could
// otherwise talk to it (cross-site requests, or DNS rebinding that points a hostname at 127.0.0.1).
// These checks make sure a request really comes from the app's own page.

export type Refusal = { status: number; code: string; message: string };
type Incoming = { method?: string; headers: Record<string, string | string[] | undefined> };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';

const hostnameOf = (host: string): string | null => {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
};

const hasBody = ({ headers }: Incoming) => Number(first(headers['content-length'])) > 0 || first(headers['transfer-encoding']) !== '';

/** Returns null when the request may proceed, otherwise the refusal to send. */
export function checkRequest(req: Incoming): Refusal | null {
  const host = first(req.headers.host).toLowerCase();
  const hostname = hostnameOf(host);
  if (!hostname || !LOOPBACK_HOSTS.has(hostname)) {
    return { status: 403, code: 'bad_host', message: 'This server only answers on localhost' };
  }
  const origin = first(req.headers.origin).toLowerCase();
  if (origin && origin !== `http://${host}`) {
    return { status: 403, code: 'bad_origin', message: 'Requests from other sites are refused' };
  }
  const isReadOnly = req.method === 'GET' || req.method === 'HEAD';
  if (!isReadOnly && hasBody(req) && !first(req.headers['content-type']).toLowerCase().startsWith('application/json')) {
    return { status: 415, code: 'json_only', message: 'Send the body as application/json' };
  }
  return null;
}
