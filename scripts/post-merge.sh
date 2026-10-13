#!/bin/bash
set -e
pnpm install --frozen-lockfile
# schema is migrated by the API server at boot (artifacts/api-server/src/lib/migrate.ts)
