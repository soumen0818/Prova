// Package migrations embeds the SQL schema files so the backend can apply them on boot, and so the
// same files are the single source of truth you can also run against a managed database (Supabase).
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
