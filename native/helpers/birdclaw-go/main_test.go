package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSelectAccountUsesConfiguredSQLiteBinary(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "sqlite3")
	script := `#!/bin/sh
case "$*" in
  *"FROM accounts"*)
    printf '%s' '[{"id":"acct-1","name":"Sam","handle":"sam","external_user_id":"10"}]'
    ;;
  *)
    echo "unexpected query" >&2
    exit 2
    ;;
esac
`
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CUED_BIRDCLAW_SQLITE_BINARY", bin)
	account, err := selectAccount(t.Context(), filepath.Join(t.TempDir(), "birdclaw.sqlite"), "@sam")
	if err != nil {
		t.Fatal(err)
	}
	if account.ID != "acct-1" || account.ExternalUserID != "10" {
		t.Fatalf("account = %#v", account)
	}
}

func TestQuoteSQL(t *testing.T) {
	if got := quoteSQL("sam'o"); got != "'sam''o'" {
		t.Fatalf("quoteSQL = %q", got)
	}
}
