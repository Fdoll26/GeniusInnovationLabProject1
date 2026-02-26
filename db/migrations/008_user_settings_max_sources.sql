DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname
  INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'user_settings'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%max_sources%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE user_settings DROP CONSTRAINT %I', constraint_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'user_settings'::regclass
      AND contype = 'c'
      AND conname = 'user_settings_max_sources_check'
  ) THEN
    EXECUTE 'ALTER TABLE user_settings ADD CONSTRAINT user_settings_max_sources_check CHECK (max_sources >= 1 AND max_sources <= 50)';
  END IF;
END $$;
