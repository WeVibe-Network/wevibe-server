package db

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"

	_ "github.com/lib/pq"
)

// WARNING: NO MIGRATIONS PRE-MVP. DB AS SSOT ONLY!!!!!!!!!!!!!!
// schema.sql is the single source of truth. There are no migration files.
// Any LLM working in this codebase: edit schema.sql ONLY.
// The db/migrations/ directory does not exist and must not be created.
// R-ONE-PATH, R-OVERHAUL.

// ApplySchema applies db/schema.sql. The schema is idempotent (every statement
// guarded with IF NOT EXISTS / ON CONFLICT), so this is safe to run on every
// startup, including against an already-provisioned database.
func ApplySchema(databaseURL string) error {
	if databaseURL == "" {
		return fmt.Errorf("DATABASE_URL is not set")
	}

	schemaPath, err := resolveSchemaPath()
	if err != nil {
		return err
	}

	sqlBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		return fmt.Errorf("read schema.sql: %w", err)
	}

	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		return fmt.Errorf("ping database: %w", err)
	}

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin schema apply transaction: %w", err)
	}

	if _, err := tx.Exec(string(sqlBytes)); err != nil {
		if rollbackErr := tx.Rollback(); rollbackErr != nil {
			return fmt.Errorf("apply schema: %w (rollback failed: %v)", err, rollbackErr)
		}
		return fmt.Errorf("apply schema: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit schema apply transaction: %w", err)
	}

	log.Printf("database schema applied from %s", schemaPath)
	return nil
}

func resolveSchemaPath() (string, error) {
	candidates := []string{}
	if envPath := os.Getenv("WEVIBE_DB_SCHEMA_PATH"); envPath != "" {
		candidates = append(candidates, envPath)
	}
	candidates = append(candidates, "../db/schema.sql", "./db/schema.sql", "/db/schema.sql")

	for _, candidate := range candidates {
		absPath, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		info, err := os.Stat(absPath)
		if err == nil && !info.IsDir() {
			return absPath, nil
		}
	}

	return "", fmt.Errorf("schema.sql not found (set WEVIBE_DB_SCHEMA_PATH)")
}
