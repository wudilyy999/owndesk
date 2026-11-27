CREATE TABLE library_upload_text (id text PRIMARY KEY REFERENCES task_uploads(id) ON DELETE CASCADE, body text NOT NULL);
--> statement-breakpoint
CREATE TABLE library_artifact_text (id text PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE, body text NOT NULL);
--> statement-breakpoint
CREATE TABLE library_project_events (
 entry_id text NOT NULL REFERENCES library_entries(id) ON DELETE CASCADE,
 origin text NOT NULL, title text NOT NULL, body text NOT NULL, at timestamptz NOT NULL,
 PRIMARY KEY(entry_id,origin)
);
--> statement-breakpoint
CREATE TABLE library_mail_watches (
 entry_id text PRIMARY KEY REFERENCES library_entries(id) ON DELETE CASCADE,
 connection_id text NOT NULL REFERENCES app_connections(id) ON DELETE CASCADE,
 revision integer NOT NULL, thread_id text NOT NULL, since timestamptz NOT NULL,
 next_check timestamptz NOT NULL DEFAULT now(), last_error text, last_checked timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX library_mail_thread_idx ON library_mail_watches(connection_id,thread_id);
