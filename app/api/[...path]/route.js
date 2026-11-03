import path from 'node:path';
import serverModule from '../../../server.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const { createGameServer } = serverModule;
let gameServerPromise;

function getGameServer() {
  if (!gameServerPromise) {
    gameServerPromise = new Promise((resolve, reject) => {
      const dataFile = process.env.DATA_FILE || path.join(process.cwd(), 'data', 'game-state.json');
      const server = createGameServer({ dataFile });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }
  return gameServerPromise;
}

async function forwardToGameServer(request) {
  const incomingUrl = new URL(request.url);
  const gameServer = await getGameServer();
  const headers = new Headers();
  for (const name of ['cookie', 'content-type', 'origin']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('host', request.headers.get('host') || incomingUrl.host);
  headers.set('x-forwarded-host', request.headers.get('host') || incomingUrl.host);
  headers.set('x-forwarded-proto', incomingUrl.protocol.slice(0, -1));

  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();
  const upstream = await fetch(`http://127.0.0.1:${gameServer.address().port}${incomingUrl.pathname}${incomingUrl.search}`, {
    method,
    headers,
    body,
    redirect: 'manual',
  });
  const responseHeaders = new Headers();
  for (const name of ['cache-control', 'content-type', 'x-content-type-options']) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append('set-cookie', cookie);
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: responseHeaders });
}

export const GET = forwardToGameServer;
export const POST = forwardToGameServer;
export const PATCH = forwardToGameServer;
export const DELETE = forwardToGameServer;