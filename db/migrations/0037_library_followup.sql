ALTER TABLE library_entries ADD COLUMN due_date date, ADD COLUMN reminder_agent text REFERENCES companions(agent_id) ON DELETE SET NULL, ADD COLUMN reminded_at timestamptz;
--> statement-breakpoint
CREATE INDEX library_pending_reminders_idx ON library_entries(due_date) WHERE due_date IS NOT NULL AND reminder_agent IS NOT NULL AND NOT done AND reminded_at IS NULL;
