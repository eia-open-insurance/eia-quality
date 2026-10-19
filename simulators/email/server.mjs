import { createApp } from './app.mjs';
import { createSimulatorServer, runIfMain, startServer } from '../common/server.mjs';

export const EMAIL_PORT = 8184;

export function createServer(options = {}) {
  const app = createApp(options);
  return createSimulatorServer({
    apps: [{ app, openapiFile: new URL('./openapi.yaml', import.meta.url) }],
    title: 'EIA email relay simulator',
    defaultPort: EMAIL_PORT,
    host: '127.0.0.1',
  });
}

runIfMain(import.meta.url, async () => {
  const server = createServer();
  await startServer(server, { defaultPort: EMAIL_PORT, system: 'email', paths: ['/sim/email/v1'] });
});
