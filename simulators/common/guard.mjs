/**
 * Guard that keeps the simulators test-only.
 *
 * SPEC §15.3 defines these services as test doubles. They have no production
 * credentials, no real provider connectivity, and deliberately permissive
 * fault controls, so they refuse to start in a production environment.
 */
export function assertTestOnly() {
  const environment = String(process.env.SIM_ENV ?? process.env.NODE_ENV ?? '').toLowerCase();
  if (environment === 'production' || environment === 'prod') {
    throw new Error(
      'REFUSED TO START: eia-quality simulators are test doubles (SPEC §15.3) and must never run as production adapters. ' +
        'Unset NODE_ENV/SIM_ENV=production or run them only in a local or test environment.',
    );
  }
}

export const TEST_DOUBLE_NOTICE =
  'TEST DOUBLE: synthetic responses only; no real FS-RI, SAP S/4HANA, bank, email, OCR, or sanctions connectivity.';
