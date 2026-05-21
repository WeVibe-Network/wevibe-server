package db

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

func RunMigrations(databaseURL string) error {
	if databaseURL == "" {
		return fmt.Errorf("DATABASE_URL is not set")
	}

	migrationsDir, err := resolveMigrationsDir()
	if err != nil {
		return err
	}

	migrationNames, err := loadMigrationNames(migrationsDir)
	if err != nil {
		return err
	}

	m, err := migrate.New("file://"+filepath.ToSlash(migrationsDir), databaseURL)
	if err != nil {
		return fmt.Errorf("initialize migrations: %w", err)
	}
	defer func() {
		srcErr, dbErr := m.Close()
		if srcErr != nil || dbErr != nil {
			log.Printf("WARNING: migration close source_err=%v db_err=%v", srcErr, dbErr)
		}
	}()

	startVersion := uint(0)
	if currentVersion, _, versionErr := m.Version(); versionErr == nil {
		startVersion = currentVersion
	} else if !errors.Is(versionErr, migrate.ErrNilVersion) {
		return fmt.Errorf("read migration version before apply: %w", versionErr)
	}

	err = m.Up()
	if err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("apply migrations: %w", err)
	}

	finalVersion := uint(0)
	finalDirty := false
	if currentVersion, dirty, versionErr := m.Version(); versionErr == nil {
		finalVersion = currentVersion
		finalDirty = dirty
	} else if !errors.Is(versionErr, migrate.ErrNilVersion) {
		return fmt.Errorf("read final migration version: %w", versionErr)
	}

	if finalDirty {
		return fmt.Errorf("database migration left dirty version=%d", finalVersion)
	}

	if errors.Is(err, migrate.ErrNoChange) {
		log.Printf("database migrations: no change")
	} else {
		for version := startVersion + 1; version <= finalVersion; version++ {
			name, ok := migrationNames[version]
			if !ok {
				name = fmt.Sprintf("%06d", version)
			}
			log.Printf("Applied migration %s", name)
		}
	}

	log.Printf("database migration version=%d dirty=%t", finalVersion, finalDirty)

	return nil
}

func resolveMigrationsDir() (string, error) {
	candidates := []string{}
	if envPath := os.Getenv("WEVIBE_DB_MIGRATIONS_PATH"); envPath != "" {
		candidates = append(candidates, envPath)
	}
	candidates = append(candidates, "../db/migrations", "./db/migrations", "/db/migrations")

	for _, candidate := range candidates {
		absPath, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		info, err := os.Stat(absPath)
		if err == nil && info.IsDir() {
			return absPath, nil
		}
	}

	return "", fmt.Errorf("migration directory not found (set WEVIBE_DB_MIGRATIONS_PATH)")
}

func loadMigrationNames(migrationsDir string) (map[uint]string, error) {
	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		return nil, fmt.Errorf("read migration directory: %w", err)
	}

	names := make(map[uint]string)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		fileName := entry.Name()
		if !strings.HasSuffix(fileName, ".up.sql") {
			continue
		}

		migrationName := strings.TrimSuffix(fileName, ".up.sql")
		parts := strings.SplitN(migrationName, "_", 2)
		if len(parts) != 2 {
			continue
		}

		version, parseErr := strconv.ParseUint(parts[0], 10, 64)
		if parseErr != nil {
			continue
		}

		names[uint(version)] = migrationName
	}

	return names, nil
}
