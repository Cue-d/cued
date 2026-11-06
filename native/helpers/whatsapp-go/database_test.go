package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestHelperDatabaseConcurrentWriterAndReader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history ?#.db")
	first, err := openHelperDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := openHelperDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if _, err = first.Exec("CREATE TABLE items (id INTEGER PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	tx, err := first.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.Exec("INSERT INTO items VALUES (1)"); err != nil {
		t.Fatal(err)
	}
	// WAL readers can proceed while the other process holds a write transaction.
	var count int
	if err = second.QueryRow("SELECT count(*) FROM items").Scan(&count); err != nil || count != 0 {
		t.Fatalf("reader failed during write: count=%d err=%v", count, err)
	}
	done := make(chan error, 1)
	go func() {
		tx2, err := second.Begin()
		if err == nil {
			defer tx2.Rollback()
			_, err = tx2.Exec("INSERT INTO items VALUES (2)")
			if err == nil {
				err = tx2.Commit()
			}
		}
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("competing writer should wait: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("writer did not resume")
	}
	if err = second.QueryRow("SELECT count(*) FROM items").Scan(&count); err != nil || count != 2 {
		t.Fatalf("writes lost: count=%d err=%v", count, err)
	}
	// A fresh pooled connection must inherit the same connection-local settings.
	conn1, err := second.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn1.Close()
	conn2, err := second.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn2.Close()
	for pragma, expected := range map[string]int{"busy_timeout": 5000, "foreign_keys": 1} {
		var actual int
		if err := conn2.QueryRowContext(context.Background(), "PRAGMA "+pragma).Scan(&actual); err != nil || actual != expected {
			t.Fatalf("%s=%d: %v", pragma, actual, err)
		}
	}
}
