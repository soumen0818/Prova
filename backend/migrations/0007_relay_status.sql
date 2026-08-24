-- The last spend relay failure, visible without a shell.
--
-- Same reasoning as the folder's status: the reason a transfer failed existed only in `docker logs`
-- on a box behind a security group, and the app's own copy was one release behind. A relay failure
-- is rarer than a fold failure but far more urgent — somebody is standing there with money that did
-- not move.
--
-- Reuses the folder's status row: this is one status light for pool operations, not a log.
ALTER TABLE pool_folder_status ADD COLUMN IF NOT EXISTS last_relay_error TEXT NOT NULL DEFAULT '';
ALTER TABLE pool_folder_status ADD COLUMN IF NOT EXISTS last_relay_at TIMESTAMPTZ;
