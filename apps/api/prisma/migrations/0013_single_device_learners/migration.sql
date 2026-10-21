-- One device at a time for learners (docs/design/single-device-learners.md). A new sign-in by a learner
-- replaces their other sessions in the school. A replaced session is kept (not deleted) until it would
-- have expired, so the device it belonged to can be told why it was signed out.
ALTER TABLE "session" ADD COLUMN "replaced_at" TIMESTAMPTZ(3);
GRANT UPDATE ("replaced_at") ON "session" TO studyhub_app;
