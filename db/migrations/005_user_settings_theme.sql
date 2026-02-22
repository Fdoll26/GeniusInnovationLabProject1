ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'light';

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_theme_check;

ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_theme_check CHECK (theme IN ('light', 'dark'));

