import { createApp as createFsri } from '../fsri/app.mjs';
import { createApp as createS4 } from '../s4/app.mjs';
import { createApp as createBank } from '../bank/app.mjs';
import { createApp as createEmail } from '../email/app.mjs';
import { createApp as createOcr } from '../ocr/app.mjs';
import { createApp as createSanctions } from '../sanctions/app.mjs';
import { createSimulatorServer, runIfMain, startServer } from '../common/server.mjs';

/** Host port for the aggregate service; the container listens on 8080. */
export const ALL_PORT = 8180;

function factory(createApp, openapiFile) {
  return { app: createApp(), openapiFile };
}

/** Build (but do not start) the aggregate simulator hosting all six systems. */
export function createServer() {
  return createSimulatorServer({
    apps: [
      factory(createFsri, new URL('../fsri/openapi.yaml', import.meta.url)),
      factory(createS4, new URL('../s4/openapi.yaml', import.meta.url)),
      factory(createBank, new URL('../bank/openapi.yaml', import.meta.url)),
      factory(createEmail, new URL('../email/openapi.yaml', import.meta.url)),
      factory(createOcr, new URL('../ocr/openapi.yaml', import.meta.url)),
      factory(createSanctions, new URL('../sanctions/openapi.yaml', import.meta.url)),
    ],
    title: 'EIA external-system simulators (aggregate)',
    defaultPort: ALL_PORT,
    host: '127.0.0.1',
  });
}

runIfMain(import.meta.url, async () => {
  const server = createServer();
  await startServer(server, {
    defaultPort: ALL_PORT,
    system: 'simulators',
    paths: ['/sim/fsri/v1', '/sim/s4/v1', '/sim/bank/v1', '/sim/email/v1', '/sim/ocr/v1', '/sim/sanctions/v1'],
  });
});
