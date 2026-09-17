// Imported first (and only for its side effect) by every entrypoint that
// needs DATABASE_URL. Node's --env-file flag can't be passed through
// NODE_OPTIONS (Node rejects it there) and isn't forwarded by every CLI we
// run (vitest's argument parser rejects unknown flags outright), so we load
// the file directly instead. Safe to fail: on Replit the environment
// variables are expected to be supplied by the platform, not a checked-in
// .env file.
try {
  process.loadEnvFile();
} catch {
  // no .env file present — fine if the environment already provides the vars
}
