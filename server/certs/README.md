# RDS CA bundle

`rds-global-bundle.pem` is the Amazon RDS global CA bundle, used to verify
the RDS PostgreSQL server certificate on the cloud (`DB_*`) connection path
(see `server/src/db/connection-config.ts`). It is checked in, not downloaded
at image build time, so every image build packages the same reviewed bytes.

- Source: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
- Downloaded: 2026-09-25
- SHA-256: `e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3`
- Contents: 108 self-signed root CA certificates, none expired at download,
  including `Amazon RDS us-east-1 Root CA RSA2048 G1` (valid to 2061), the
  root for the instance's `rds-ca-rsa2048-g1` certificate authority.

To refresh, download from the same URL, compare the SHA-256 and diff the
certificate subjects, then update this file.
