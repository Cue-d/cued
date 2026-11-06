package main

import (
	"database/sql"
	"net/url"
)

// Each process has its own pool. Apply pragmas through the DSN so every pooled
// connection waits for competing writers and enforces foreign keys. IMMEDIATE
// transactions avoid the read-then-write upgrade race (SQLITE_BUSY_SNAPSHOT).
func openHelperDatabase(path string) (*sql.DB, error) {
	query := url.Values{}
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "foreign_keys(ON)")
	query.Set("_txlock", "immediate")
	dsn := url.URL{Scheme: "file", Path: path, RawQuery: query.Encode()}
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, err
	}
	if err = db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}
