# Database Seeds

Run the seed script against your local PostgreSQL database:

```bash
psql "$DATABASE_URL" -f db/seed/seed.sql
```

Notes:
- Requires the schema from `db/migrations/001_init.sql`.
- Uses deterministic UUIDs for repeatable inserts.
