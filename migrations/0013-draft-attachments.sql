-- Attachments staged in compose used to die with the dialog. The bytes live in
-- R2 (one object per draft, see src/draftAttachments.ts); this column holds
-- only a small JSON manifest of {name,type,size} so the drafts list can show a
-- paperclip without reading R2.
ALTER TABLE drafts ADD COLUMN attachments TEXT;
