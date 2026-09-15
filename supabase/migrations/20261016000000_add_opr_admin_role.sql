-- Add the opr_admin role to the app_role enum.
--
-- This lives in its own migration on purpose: a newly added enum value must be
-- committed before any later statement can reference it, so the columns /
-- backfill that use 'opr_admin' go in the following migration.

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'opr_admin';
