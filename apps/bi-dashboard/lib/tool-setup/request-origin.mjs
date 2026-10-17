export function isSameOriginRequest(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const url = new URL(request.url);
  // NextURL normalizes loopback IPs to localhost. The browser's Host header
  // retains the actual destination, including its port.
  const host = request.headers.get('host') || url.host;
  return origin === `${url.protocol}//${host}`;
}
