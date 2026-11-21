-- Which issuer vouched for a linked identity (security-audit-fixes). A
-- provider id can be pointed at a different issuer later; a subject from that
-- other issuer must not reach the account. Null for identities linked before
-- this: each adopts the issuer of its next sign-in.
ALTER TABLE user_identity ADD COLUMN issuer TEXT;
