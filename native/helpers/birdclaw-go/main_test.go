package main

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

func TestReadsArchiveDMsAndFollowGraph(t *testing.T) {
	archivePath := filepath.Join(t.TempDir(), "twitter-archive.zip")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	entries := map[string]string{
		"archive/data/account.js":         `window.YTD.account.part0 = [{"account":{"accountId":"10","username":"sam","accountDisplayName":"Sam"}}]`,
		"archive/data/tweets.js":          `window.YTD.tweets.part0 = [{"tweet":{"entities":{"user_mentions":[{"id_str":"20","screen_name":"ava","name":"Ava Chen"}]}}}]`,
		"archive/data/direct-messages.js": `window.YTD.direct_messages.part0 = [{"dmConversation":{"conversationId":"group-1","name":"Builders","messages":[{"participantsLeave":{"initiatingUserId":"30","userIds":["30"]}},{"messageCreate":{"id":"m1","senderId":"20","recipientId":"10","text":"hello","createdAt":"2026-08-03T12:00:00.000Z"}},{"participantsJoin":{"initiatingUserId":"20","userIds":["40"]}},{"joinConversation":{"participantsSnapshot":["10","20","30"]}}]}}]`,
		"archive/data/follower.js":        `window.YTD.follower.part0 = [{"follower":{"accountId":"20"}}]`,
		"archive/data/following.js":       `window.YTD.following.part0 = [{"following":{"accountId":"20"}}]`,
	}
	for name, content := range entries {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	data, err := readArchive(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	if data.account.ID != "10" || data.account.Handle != "sam" {
		t.Fatalf("account = %#v", data.account)
	}
	if len(data.messages) != 1 || data.messages[0].Text != "hello" {
		t.Fatalf("messages = %#v", data.messages)
	}
	conversation := data.conversations["group-1"]
	if len(conversation.ParticipantIDs) != 2 || conversation.ParticipantIDs[0] != "20" || conversation.ParticipantIDs[1] != "40" {
		t.Fatalf("conversation participants = %#v", conversation.ParticipantIDs)
	}
	profile := data.profiles["profile_user_20"]
	if profile.Handle != "ava" || profile.DisplayName != "Ava Chen" {
		t.Fatalf("profile = %#v", profile)
	}
	if data.totalRelationships != 2 {
		t.Fatalf("totalRelationships = %d", data.totalRelationships)
	}
	relationships, err := readArchivePage(archivePath, "relationships", 0, "", data.totalMessages, data.totalRelationships, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(relationships.followEdges) != 2 {
		t.Fatalf("followEdges = %#v", relationships.followEdges)
	}
}

func TestReadsOnlyRequestedMessagePage(t *testing.T) {
	archivePath := filepath.Join(t.TempDir(), "twitter-archive.zip")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	entries := map[string]string{
		"data/account.js":         `window.YTD.account.part0 = [{"account":{"accountId":"10","username":"sam"}}]`,
		"data/direct-messages.js": `window.YTD.direct_messages.part0 = [{"dmConversation":{"conversationId":"10-20","messages":[{"messageCreate":{"id":"m1","senderId":"20","recipientId":"10"}},{"messageCreate":{"id":"m2","senderId":"20","recipientId":"10"}},{"messageCreate":{"id":"m3","senderId":"20","recipientId":"10"}}]}}]`,
	}
	for name, content := range entries {
		entry, createErr := writer.Create(name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, writeErr := entry.Write([]byte(content)); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := readArchivePage(archivePath, "messages", 1, "", -1, -1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if data.totalMessages != 3 || len(data.messages) != 1 || data.messages[0].ID != "m2" {
		t.Fatalf("page = total %d messages %#v", data.totalMessages, data.messages)
	}
}

func TestPagesRelationshipsWithoutParsingDMs(t *testing.T) {
	archivePath := filepath.Join(t.TempDir(), "twitter-archive.zip")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	entries := map[string]string{
		"data/account.js":         `window.YTD.account.part0 = [{"account":{"accountId":"10","username":"sam"}}]`,
		"data/direct-messages.js": `this is intentionally not a valid archive slice`,
		"data/follower.js":        `window.YTD.follower.part0 = [{"follower":{"accountId":"30"}},{"follower":{"accountId":"10"}},{"follower":{"accountId":"20"}},{"follower":{"accountId":"40"}}]`,
		"data/following.js":       `window.YTD.following.part0 = [{"following":{"accountId":"30"}},{"following":{"accountId":"20"}}]`,
	}
	for name, content := range entries {
		entry, createErr := writer.Create(name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, writeErr := entry.Write([]byte(content)); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	first, err := readArchivePage(archivePath, "relationships", 0, "", 7, 6, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !first.relationshipHasMore || len(first.profiles) != 2 || len(first.followEdges) != 3 {
		t.Fatalf("first relationship page = %#v", first)
	}
	second, err := readArchivePage(archivePath, "relationships", 0, "20", 7, 6, 2)
	if err != nil {
		t.Fatal(err)
	}
	if second.relationshipHasMore || len(second.profiles) != 2 || len(second.followEdges) != 3 {
		t.Fatalf("second relationship page = %#v", second)
	}
}

func TestParseTwitterDate(t *testing.T) {
	if got := parseTwitterDate("Mon Feb 19 14:59:19 +0000 2024"); got != "2024-02-19T14:59:19Z" {
		t.Fatalf("parseTwitterDate = %q", got)
	}
}
