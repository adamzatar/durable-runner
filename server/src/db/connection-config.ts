// Where a production process (API, worker, coordinator, migrations) finds
// PostgreSQL. Two mutually exclusive shapes:
//
//   local  DATABASE_URL, passed to pg unchanged. Local development, tests,
//          demos and benchmarks keep using exactly this.
//
//   cloud  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSL_CA_FILE.
//          On ECS the password is injected from the RDS-managed secret and
//          the rest are plain task-definition values. Handing pg separate
//          fields instead of assembling a URL means the generated password
//          (which may contain URL-reserved characters) is never encoded into
//          or parsed back out of a connection string.
//
// Setting both is an error rather than a precedence rule: a cloud task that
// somehow also received a DATABASE_URL must not silently connect to it.

import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import tls from "node:tls";
import type { PoolConfig } from "pg";

export type DbConnectionConfig = Pick<
  PoolConfig,
  "connectionString" | "host" | "port" | "database" | "user" | "password" | "ssl"
>;

const CLOUD_VARS = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DB_SSL_CA_FILE"] as const;

export function resolveDbConnectionConfig(env: NodeJS.ProcessEnv = process.env): DbConnectionConfig {
  const cloudVarsSet = CLOUD_VARS.filter((name) => env[name] !== undefined && env[name] !== "");

  if (env.DATABASE_URL) {
    if (cloudVarsSet.length > 0) {
      throw new Error(
        `DATABASE_URL and ${cloudVarsSet.join(", ")} are both set: use DATABASE_URL (local) or the DB_* variables (cloud), not both`,
      );
    }
    return { connectionString: env.DATABASE_URL };
  }

  if (cloudVarsSet.length === 0) {
    throw new Error(`No database configured: set DATABASE_URL (local) or ${CLOUD_VARS.join(", ")} (cloud)`);
  }
  const missing = CLOUD_VARS.filter((name) => !cloudVarsSet.includes(name));
  if (missing.length > 0) {
    throw new Error(`Incomplete cloud database configuration: missing ${missing.join(", ")}`);
  }

  // Non-null: every name in CLOUD_VARS was just checked to be set.
  const rawPort = env.DB_PORT!;
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error(`DB_PORT must be a TCP port number, got ${JSON.stringify(rawPort)}`);
  }

  const host = env.DB_HOST!;
  return {
    host,
    port: Number(rawPort),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    // Full verification, the equivalent of libpq's sslmode=verify-full, with
    // no opt-out on this path:
    // - `ca` replaces Node's default trust store for this connection, so the
    //   server must chain to the supplied bundle (the RDS CAs), and those
    //   CAs are trusted for nothing else in the process, unlike
    //   NODE_EXTRA_CA_CERTS.
    // - The certificate must also name DB_HOST, so a valid RDS certificate
    //   for a different endpoint is rejected. This is bound explicitly
    //   rather than left to pg: pg 8.23 passes the host to TLS only when it
    //   is a hostname, and for an IP address Node then checks the
    //   certificate against "localhost" instead (see the tests).
    // - If the server declines TLS, pg fails the connection rather than
    //   continuing in plaintext.
    ssl: {
      ca: loadCaBundle(env.DB_SSL_CA_FILE!),
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) => tls.checkServerIdentity(host, certificate),
    },
  };
}

// Read and sanity-check the CA bundle at startup. A missing, empty or
// corrupt file would otherwise surface only at the first query, as an
// opaque TLS verification failure (and on the API, as readiness failing),
// rather than as a configuration error naming the file.
export function loadCaBundle(path: string): string[] {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`DB_SSL_CA_FILE ${JSON.stringify(path)} could not be read: ${(error as Error).message}`);
  }
  const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (certificates.length === 0) {
    throw new Error(`DB_SSL_CA_FILE ${JSON.stringify(path)} contains no PEM certificates`);
  }
  for (const [index, certificate] of certificates.entries()) {
    let parsed: X509Certificate;
    try {
      parsed = new X509Certificate(certificate);
    } catch (error) {
      throw new Error(
        `DB_SSL_CA_FILE ${JSON.stringify(path)}: certificate ${index + 1} is not valid: ${(error as Error).message}`,
      );
    }
    if (!parsed.ca) {
      throw new Error(`DB_SSL_CA_FILE ${JSON.stringify(path)}: certificate ${index + 1} is not a CA certificate`);
    }
  }
  return certificates;
}
