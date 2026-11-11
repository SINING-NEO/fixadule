CREATE TABLE events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  days TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  host_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  slots TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  joined_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (event_id, name_key)
);

CREATE INDEX people_by_event ON people(event_id);
