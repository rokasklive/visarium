-- Board management by agents (agents/board-management): a grant per agent
-- token, and one switch for the desktop's tokenless local agents. Both off,
-- so no existing token or local setup gains anything.
ALTER TABLE session ADD COLUMN manage_boards INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_user ADD COLUMN local_agents_manage_boards INTEGER NOT NULL DEFAULT 0;

-- Who made a board, when an agent did: the owner is its person.
ALTER TABLE canvas ADD COLUMN created_by_agent TEXT;
