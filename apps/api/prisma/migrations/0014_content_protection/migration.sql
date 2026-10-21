-- Content protection and downloads (docs/design/content-protection.md). A tutor may protect a course
-- (watermark, no copying or printing) or not, while the school lets tutors choose; null follows the
-- default (protected).
ALTER TABLE "course" ADD COLUMN "protect_content" BOOLEAN;
