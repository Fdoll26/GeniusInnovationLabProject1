#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <migration_name_without_extension>"
  echo "Example: $0 012_model_run_provider_separation"
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required"
  exit 1
fi

migration_name="$1"
rollback_file="db/migrations/${migration_name}.rollback.sql"

if [[ ! -f "$rollback_file" ]]; then
  echo "Rollback file not found: $rollback_file"
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$rollback_file"
