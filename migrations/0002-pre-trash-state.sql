-- Spec 1 polish: remember a message's state before it was trashed, so restore
-- returns it to inbox OR archived (wherever it was) instead of always inbox.
-- Apply exactly once.
ALTER TABLE messages ADD COLUMN pre_trash_state TEXT;
