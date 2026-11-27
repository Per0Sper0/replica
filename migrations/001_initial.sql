CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects ((data->>'ownerId'));
CREATE INDEX IF NOT EXISTS projects_source_idx ON projects ((data->>'sourceSceneId'));
CREATE TABLE IF NOT EXISTS sessions (
  token text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires);
CREATE TABLE IF NOT EXISTS metadata (
  key text PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO metadata (key,value) VALUES ('schema-version','1') ON CONFLICT(key) DO NOTHING;
