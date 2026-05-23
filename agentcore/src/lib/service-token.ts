/**
 * Resolve the Airlock service token at cold start.
 *
 * Priority:
 *   1. `AIRLOCK_SERVICE_TOKEN` env var (useful for local `agentcore dev` runs).
 *   2. `AIRLOCK_TOKEN_SECRET_ARN` → Secrets Manager GetSecretValue.
 *
 * We resolve once per process and cache the promise — every invocation reuses
 * the same token until the runtime cycles the worker.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

let cached: Promise<string> | undefined;

export function getServiceToken(): Promise<string> {
  cached ??= resolveServiceToken();
  return cached;
}

/** Test-only: drop the cache so each test starts cold. */
export function _resetServiceTokenCache(): void {
  cached = undefined;
}

async function resolveServiceToken(): Promise<string> {
  const direct = process.env['AIRLOCK_SERVICE_TOKEN'];
  if (direct) return direct;

  const secretArn = process.env['AIRLOCK_TOKEN_SECRET_ARN'];
  if (!secretArn) {
    throw new Error(
      'Neither AIRLOCK_SERVICE_TOKEN nor AIRLOCK_TOKEN_SECRET_ARN is set. ' +
        'See README → "Wire the Airlock service token".',
    );
  }

  const client = new SecretsManagerClient({});
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) {
    throw new Error(`Secret ${secretArn} has no SecretString — store the token as plain text.`);
  }
  return result.SecretString;
}
