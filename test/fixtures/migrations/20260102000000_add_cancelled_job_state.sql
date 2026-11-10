-- AlterEnum
-- A value added here can only be used once this file's transaction commits, so the next
-- migration, not this one, uses it.
ALTER TYPE "job_state" ADD VALUE 'cancelled';
