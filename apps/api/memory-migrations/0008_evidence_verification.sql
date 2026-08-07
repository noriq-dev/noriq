-- PLNR-265 — additive citation-verification columns on `evidence` (0001).
--
-- Spec correction: the task's execution spec names this file `0007_evidence_verification.sql`,
-- but 0007 was already taken by PLNR-263's follow-up fix (episode sitting identity). This is
-- 0008 — the directory listing is authoritative over the spec's literal filename.
--
-- `evidence.verification_state` (0001) already says WHAT a citation's last check found
-- (valid/moved/changed/missing/unverifiable). What was missing is WHERE/WHEN/BY WHOM that check
-- happened — which is exactly what lets retrieval tell "verified" from "verified for ME":
--
--   last_verified_at        when the check last ran, or NULL if it never has (getMemoryItem must
--                            say so honestly rather than implying a fresh 'unverifiable' means
--                            "checked and inconclusive" — see memory/verification.ts).
--   last_verified_base_id   the opaque baseId the check was actually performed against — a git
--                            SHA, a Perforce changelist, a Diversion commit id, compared ONLY by
--                            string equality (§6 — never parsed, shortened, or assumed to be git).
--                            This is NOT `evidence.base_id` (the citation's own recorded scope,
--                            fixed at write time, part of evidence_hash's identity) — a citation
--                            can be re-verified against a NEWER active index generation than the
--                            base_id it was originally cited against.
--   last_verified_branch    same idea, for branch — a caller retrieving at a DIFFERENT
--                            branch/base than what was last verified must not see 'valid' as
--                            proof for them (PLNR-265's whole point: an unrelated-branch
--                            verification is worse than none, because it reads as settled).
--   verification_source     who/what performed the check: the cheap server-side tier (checked
--                            against the active index generation's graph) or a Runner's thorough
--                            worktree report (§15). Free text, not an enum — the set of possible
--                            sources is a seam (deferred: a future GitHub-content check), not a
--                            fixed vocabulary this schema should hard-code.
--   observed_path            where a 'moved' citation was actually found, when known. Nullable —
--                            the cheap server tier (memory/verification.ts) never produces
--                            'moved' at all (documented there); only a Runner report populates
--                            this, and only for that one state.
--
-- Verification never deletes a row (locked decision — see the task's execution spec and
-- memory/verification.ts's module comment): every write here is an UPDATE of these columns
-- on an EXISTING evidence row, never a DELETE/INSERT. Additive-only, per memory/migrations.ts's
-- own rule — nothing here touches 0001-0007's columns or any other table.
ALTER TABLE evidence ADD COLUMN last_verified_at TEXT;
ALTER TABLE evidence ADD COLUMN last_verified_base_id TEXT;
ALTER TABLE evidence ADD COLUMN last_verified_branch TEXT;
ALTER TABLE evidence ADD COLUMN verification_source TEXT;
ALTER TABLE evidence ADD COLUMN observed_path TEXT;
