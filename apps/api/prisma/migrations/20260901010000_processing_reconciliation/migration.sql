-- Reconciliation inspects published outbox events whose generation is still
-- nonterminal. These columns bound how often one generation is inspected
-- (lastRecoveredAt) and how many times lost work is re-published
-- (recoveryAttempts), safely across multiple API instances.
ALTER TABLE "ProcessingOutbox"
ADD COLUMN "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastRecoveredAt" TIMESTAMP(3);
