import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadCaBundle, resolveDbConnectionConfig } from "../src/db/connection-config.js";

// Configuration resolution (local DATABASE_URL vs cloud DB_*) and the TLS
// behavior of the cloud path. None of this touches the test database or
// AWS: the TLS tests run the real pg client against a local stand-in server
// that speaks just enough of the PostgreSQL protocol to negotiate TLS, with
// throwaway certificates generated per run by the openssl CLI. They show
// what this configuration makes pg verify; they are not a connection to RDS.

const rdsBundlePath = fileURLToPath(new URL("../certs/rds-global-bundle.pem", import.meta.url));

let dir: string;
let caFile: string;
let otherCaFile: string;
let serverKey: string;
let serverCert: string;
let otherNameKey: string;
let otherNameCert: string;

function openssl(...args: string[]) {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "durable-runner-tls-"));
  writeFileSync(
    path.join(dir, "req.cnf"),
    [
      "[req]",
      "distinguished_name = dn",
      "[dn]",
      "[v3_ca]",
      "basicConstraints = critical,CA:TRUE",
      "keyUsage = critical,keyCertSign,cRLSign",
      "subjectKeyIdentifier = hash",
    ].join("\n"),
  );
  // Server certificates from the trusted CA: one valid for the name
  // "localhost" only (no IP SANs), one valid only for another host name.
  const leafExtensions: Array<[file: string, san: string]> = [
    ["leaf.ext", "DNS:localhost"],
    ["other-name.ext", "DNS:db.other-endpoint.test"],
  ];
  for (const [file, san] of leafExtensions) {
    writeFileSync(
      path.join(dir, file),
      [
        "basicConstraints = CA:FALSE",
        "keyUsage = digitalSignature,keyEncipherment",
        "extendedKeyUsage = serverAuth",
        `subjectAltName = ${san}`,
      ].join("\n"),
    );
  }
  for (const name of ["ca", "other-ca"]) {
    openssl(
      "req", "-x509", "-new", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", `${name}.key`, "-out", `${name}.pem`, "-subj", `/CN=durable-runner test ${name}`,
      "-config", "req.cnf", "-extensions", "v3_ca",
    );
  }
  openssl(
    "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr",
    "-subj", "/CN=localhost", "-config", "req.cnf",
  );
  openssl(
    "x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "1",
    "-days", "2", "-out", "server.pem", "-extfile", "leaf.ext",
  );
  openssl(
    "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "other-name.key", "-out", "other-name.csr",
    "-subj", "/CN=db.other-endpoint.test", "-config", "req.cnf",
  );
  openssl(
    "x509", "-req", "-in", "other-name.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "2",
    "-days", "2", "-out", "other-name.pem", "-extfile", "other-name.ext",
  );
  caFile = path.join(dir, "ca.pem");
  otherCaFile = path.join(dir, "other-ca.pem");
  serverKey = readFileSync(path.join(dir, "server.key"), "utf8");
  serverCert = readFileSync(path.join(dir, "server.pem"), "utf8");
  otherNameKey = readFileSync(path.join(dir, "other-name.key"), "utf8");
  otherNameCert = readFileSync(path.join(dir, "other-name.pem"), "utf8");
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function cloudEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DB_HOST: "durable-runner-dev.example.us-east-1.rds.amazonaws.com",
    DB_PORT: "5432",
    DB_NAME: "durable_runner",
    DB_USER: "durable_runner_admin",
    DB_PASSWORD: "p@ss:w/rd?#%",
    DB_SSL_CA_FILE: rdsBundlePath,
    ...overrides,
  };
}

describe("resolveDbConnectionConfig", () => {
  it("passes DATABASE_URL through unchanged on the local path, with no TLS settings added", () => {
    const url = "postgres://someone@127.0.0.1:5433/durable_runner";
    expect(resolveDbConnectionConfig({ DATABASE_URL: url, DB_POOL_MAX: "4" })).toEqual({ connectionString: url });
  });

  it("refuses DATABASE_URL together with DB_* variables instead of picking one", () => {
    expect(() =>
      resolveDbConnectionConfig({ DATABASE_URL: "postgres://x@127.0.0.1/db", DB_HOST: "rds.example" }),
    ).toThrow(/DATABASE_URL and DB_HOST are both set/);
  });

  it("refuses to start with no database configuration", () => {
    expect(() => resolveDbConnectionConfig({})).toThrow(/No database configured/);
  });

  it("names every missing cloud variable, and never echoes the password", () => {
    const attempt = () => resolveDbConnectionConfig({ DB_HOST: "rds.example", DB_PASSWORD: "hunter2-secret" });
    expect(attempt).toThrow(/missing DB_PORT, DB_NAME, DB_USER, DB_SSL_CA_FILE/);
    expect(attempt).not.toThrow(/hunter2-secret/);
  });

  it("treats empty DB_* values as missing", () => {
    expect(() => resolveDbConnectionConfig(cloudEnv({ DB_PASSWORD: "" }))).toThrow(/missing DB_PASSWORD/);
  });

  it.each(["0", "65536", "54x", "-1", " 5432"])("rejects DB_PORT %j", (port) => {
    expect(() => resolveDbConnectionConfig(cloudEnv({ DB_PORT: port }))).toThrow(/DB_PORT must be a TCP port number/);
  });

  it("builds separate connection fields with verified TLS on the cloud path", () => {
    const config = resolveDbConnectionConfig(cloudEnv());
    expect(config.connectionString).toBeUndefined();
    expect(config).toMatchObject({
      host: "durable-runner-dev.example.us-east-1.rds.amazonaws.com",
      port: 5432,
      database: "durable_runner",
      user: "durable_runner_admin",
      // Reserved URL characters survive untouched: nothing is URL-encoded.
      password: "p@ss:w/rd?#%",
    });
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
  });
});

describe("loadCaBundle", () => {
  it("loads the packaged RDS bundle, which includes the root for the instance's rds-ca-rsa2048-g1 CA", () => {
    const certificates = loadCaBundle(rdsBundlePath);
    expect(certificates.length).toBeGreaterThan(0);
    const subjects = certificates.map((pem) => new X509Certificate(pem).subject);
    expect(subjects.some((subject) => subject.includes("CN=Amazon RDS us-east-1 Root CA RSA2048 G1"))).toBe(true);
  });

  it("fails with the variable name when the file is missing", () => {
    expect(() => loadCaBundle(path.join(dir, "absent.pem"))).toThrow(/DB_SSL_CA_FILE .*could not be read/);
  });

  it("fails when the file holds no certificates", () => {
    const empty = path.join(dir, "empty.pem");
    writeFileSync(empty, "");
    expect(() => loadCaBundle(empty)).toThrow(/contains no PEM certificates/);
  });

  it("fails on a corrupt certificate block", () => {
    const corrupt = path.join(dir, "corrupt.pem");
    writeFileSync(corrupt, "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----\n");
    expect(() => loadCaBundle(corrupt)).toThrow(/certificate 1 is not valid/);
  });

  it("fails on a non-CA certificate (a leaf cert supplied by mistake)", () => {
    expect(() => loadCaBundle(path.join(dir, "server.pem"))).toThrow(/certificate 1 is not a CA certificate/);
  });
});

// --- TLS behavior against a stand-in server ----------------------------------

const SSL_REQUEST_CODE = 80877103;
const FAKE_SERVER_MESSAGE = "stand-in server: TLS established";

// A PostgreSQL ErrorResponse, so that a client which got through TLS fails
// with a recognizable message instead of hanging on the startup exchange.
function errorResponse(message: string): Buffer {
  const fields = Buffer.concat([
    Buffer.from("SFATAL\0VFATAL\0C08000\0", "utf8"),
    Buffer.from(`M${message}\0`, "utf8"),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(5);
  header.write("E", 0);
  header.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([header, fields]);
}

// Answers the client's SSLRequest with `sslReply`. On 'S' it runs the TLS
// handshake as the server; after a completed handshake it answers the
// client's startup message with an ErrorResponse and closes.
async function startStandInServer(sslReply: "S" | "N", identity = { key: () => serverKey, cert: () => serverCert }) {
  let tlsEstablished = false;
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      if (chunk.length < 8 || chunk.readInt32BE(4) !== SSL_REQUEST_CODE) {
        socket.destroy();
        return;
      }
      socket.write(sslReply);
      if (sslReply === "N") return;
      const secure = new tls.TLSSocket(socket, { isServer: true, key: identity.key(), cert: identity.cert() });
      secure.on("error", () => {});
      secure.on("secure", () => {
        tlsEstablished = true;
        secure.once("data", () => secure.end(errorResponse(FAKE_SERVER_MESSAGE)));
      });
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    tlsEstablished: () => tlsEstablished,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function connectError(env: NodeJS.ProcessEnv): Promise<Error & { code?: string }> {
  const client = new pg.Client(resolveDbConnectionConfig(env));
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    return error as Error & { code?: string };
  } finally {
    await client.end().catch(() => {});
  }
  throw new Error("connect() unexpectedly succeeded against the stand-in server");
}

describe("cloud-path TLS verification (stand-in server)", () => {
  it("completes the handshake when the certificate chains to DB_SSL_CA_FILE and matches DB_HOST", async () => {
    const server = await startStandInServer("S");
    try {
      // "localhost" is the certificate's only name. The stand-in listens on
      // 127.0.0.1; Node's connect falls back across address families.
      const error = await connectError(cloudEnv({ DB_HOST: "localhost", DB_PORT: String(server.port), DB_SSL_CA_FILE: caFile }));
      expect(error.message).toBe(FAKE_SERVER_MESSAGE);
      expect(server.tlsEstablished()).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("rejects a certificate that does not chain to DB_SSL_CA_FILE", async () => {
    const server = await startStandInServer("S");
    try {
      const error = await connectError(
        cloudEnv({ DB_HOST: "localhost", DB_PORT: String(server.port), DB_SSL_CA_FILE: otherCaFile }),
      );
      expect(error.code).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN/);
      expect(server.tlsEstablished()).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("rejects the packaged RDS bundle for a certificate no RDS CA issued", async () => {
    const server = await startStandInServer("S");
    try {
      const error = await connectError(cloudEnv({ DB_HOST: "localhost", DB_PORT: String(server.port) }));
      expect(error.code).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN/);
      expect(server.tlsEstablished()).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("rejects a trusted certificate issued for a different host name", async () => {
    // The RDS-shaped case: a genuine certificate from a trusted CA, but for
    // some other endpoint.
    const server = await startStandInServer("S", { key: () => otherNameKey, cert: () => otherNameCert });
    try {
      const error = await connectError(cloudEnv({ DB_HOST: "localhost", DB_PORT: String(server.port), DB_SSL_CA_FILE: caFile }));
      expect(error.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
      expect(server.tlsEstablished()).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("checks the certificate against DB_HOST even when DB_HOST is an IP address", async () => {
    const server = await startStandInServer("S");
    try {
      // Same trusted CA, but the certificate names "localhost", not
      // 127.0.0.1. Without the explicit identity check this connection
      // succeeds: pg gives TLS no name for an IP host, and Node falls back
      // to checking against "localhost".
      const error = await connectError(
        cloudEnv({ DB_HOST: "127.0.0.1", DB_PORT: String(server.port), DB_SSL_CA_FILE: caFile }),
      );
      expect(error.code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    } finally {
      await server.close();
    }
  });

  it("refuses to continue in plaintext when the server declines TLS", async () => {
    const server = await startStandInServer("N");
    try {
      const error = await connectError(cloudEnv({ DB_HOST: "localhost", DB_PORT: String(server.port), DB_SSL_CA_FILE: caFile }));
      expect(error.message).toMatch(/does not support SSL/);
    } finally {
      await server.close();
    }
  });
});
