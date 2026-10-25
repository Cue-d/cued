package main

import "database/sql"

// History stores seconds. Reject absent, millisecond and overflowing values so
// malformed history cannot poison ordering and incremental cursors.
func validHistoryTimestamp(seconds uint64) bool {
	return seconds > 0 && seconds < 253402300800 // start of year 10000
}

// A delayed original delivery cannot undo a revoke already persisted locally.
func (c *syncCache) isRevoked(chatJID, messageID string) (bool, error) {
	var revoked bool
	err := c.db.QueryRow(`SELECT revoked FROM messages WHERE chat_jid = ? AND message_id = ?`, normalizeJID(chatJID), messageID).Scan(&revoked)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return revoked, err
}

func (r *helperRuntime) isMessageRevoked(message messageSnapshot) (bool, error) {
	keys := []string{message.ChatJID}
	for _, alias := range r.identityAliases(message) {
		if message.ChatJID == alias.LID {
			keys = append(keys, alias.PN)
		}
		if message.ChatJID == alias.PN {
			keys = append(keys, alias.LID)
		}
	}
	for _, key := range keys {
		revoked, err := r.state.cache.isRevoked(key, message.MessageID)
		if err != nil || revoked {
			return revoked, err
		}
	}
	return false, nil
}

func (r *helperRuntime) filterRevokedResends(snapshot *stateSnapshot) error {
	kept := snapshot.Messages[:0]
	for _, message := range snapshot.Messages {
		if !message.Revoked {
			revoked, err := r.isMessageRevoked(message)
			if err != nil {
				return err
			}
			if revoked {
				continue
			}
		}
		kept = append(kept, message)
	}
	snapshot.Messages = kept
	return nil
}
