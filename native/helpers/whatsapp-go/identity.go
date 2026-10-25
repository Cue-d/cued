package main

import (
	"context"
	"fmt"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"sort"
)

// Aliases come only from the authenticated provider's durable LID store.
type identityAlias struct {
	LID string `json:"lid"`
	PN  string `json:"pn"`
}

func (r *helperRuntime) identityAliases(data interface{}) []identityAlias {
	if r.client == nil || r.client.Store == nil || r.client.Store.LIDs == nil {
		return nil
	}
	jids := make(map[string]bool)
	var add func(interface{})
	add = func(value interface{}) {
		str := func(s string) {
			if s != "" {
				jids[s] = true
			}
		}
		ptr := func(s *string) {
			if s != nil {
				str(*s)
			}
		}
		switch v := value.(type) {
		case contactSnapshot:
			str(v.JID)
		case chatSnapshot:
			str(v.JID)
			for _, p := range v.Participants {
				str(p)
			}
		case messageSnapshot:
			str(v.ChatJID)
			ptr(v.SenderJID)
			ptr(v.ParticipantJID)
			ptr(v.ReplyToSender)
		case receiptSnapshot:
			str(v.ChatJID)
		case callSnapshot:
			str(v.ChatJID)
			ptr(v.InitiatorJID)
			ptr(v.RemoteJID)
		case callDeleteSnapshot:
			str(v.ChatJID)
		case stateSnapshot:
			add(v.Contacts)
			add(v.Chats)
			add(v.Messages)
			add(v.Calls)
		case resyncPage:
			add(v.Contacts)
			add(v.Chats)
			add(v.Messages)
			add(v.Calls)
		case []contactSnapshot:
			for _, x := range v {
				add(x)
			}
		case []chatSnapshot:
			for _, x := range v {
				add(x)
			}
		case []messageSnapshot:
			for _, x := range v {
				add(x)
			}
		case []callSnapshot:
			for _, x := range v {
				add(x)
			}
		case map[string]interface{}:
			for _, key := range []string{"contacts", "chats", "messages", "calls"} {
				add(v[key])
			}
		}
	}
	add(data)
	aliases := make(map[string]identityAlias)
	for raw := range jids {
		jid, err := types.ParseJID(raw)
		if err != nil {
			continue
		}
		jid = jid.ToNonAD()
		var lid, pn types.JID
		switch jid.Server {
		case types.HiddenUserServer:
			lid = jid
			pn, err = r.client.Store.LIDs.GetPNForLID(context.Background(), lid)
		case types.DefaultUserServer:
			pn = jid
			lid, err = r.client.Store.LIDs.GetLIDForPN(context.Background(), pn)
		default:
			continue
		}
		if err != nil || lid.IsEmpty() || pn.IsEmpty() || lid.Server != types.HiddenUserServer || pn.Server != types.DefaultUserServer {
			continue
		}
		aliases[lid.String()] = identityAlias{LID: lid.String(), PN: pn.String()}
	}
	result := make([]identityAlias, 0, len(aliases))
	for _, alias := range aliases {
		result = append(result, alias)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].LID < result[j].LID })
	return result
}

func waitForPairPreKeys(ctx context.Context, runtime *helperRuntime) error {
	if runtime == nil || runtime.client == nil {
		return nil
	}
	if runtime.client.Store != nil && runtime.client.Store.PreKeys != nil {
		count, err := runtime.client.Store.PreKeys.UploadedPreKeyCount(ctx)
		if err != nil {
			return fmt.Errorf("read uploaded WhatsApp prekeys: %w", err)
		}
		if count > 0 {
			return nil
		}
	}
	if err := runtime.client.PreKeysUploaded.WaitTimeoutCtx(ctx, pairConnectGracePeriod); err != nil {
		return fmt.Errorf("WhatsApp connected but initial encryption keys were not uploaded: %w", err)
	}
	return nil
}

// Include older identities even during incremental resync: learning an alias can
// require migrating previously projected rows that have no new message activity.
func (r *helperRuntime) cachedIdentityAliases() ([]identityAlias, error) {
	rows, err := r.state.cache.db.Query(`SELECT jid FROM contacts UNION SELECT jid FROM chats`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var contacts []contactSnapshot
	for rows.Next() {
		var jid string
		if err := rows.Scan(&jid); err != nil {
			return nil, err
		}
		contacts = append(contacts, contactSnapshot{JID: jid})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return r.identityAliases(contacts), nil
}

// Manually downloaded history bypasses whatsmeow's automatic history handler.
// Persist its explicit mapping records before emitting observations.
func (r *helperRuntime) storeHistoryIdentityAliases(data *waHistorySync.HistorySync) error {
	if r.client == nil || r.client.Store == nil || r.client.Store.LIDs == nil {
		return nil
	}
	pairs := make([]store.LIDMapping, 0)
	add := func(lidRaw, pnRaw string) {
		lid, lidErr := types.ParseJID(lidRaw)
		pn, pnErr := types.ParseJID(pnRaw)
		if pn.Server == types.LegacyUserServer {
			pn.Server = types.DefaultUserServer
		}
		if lidErr != nil || pnErr != nil || lid.User == "" || pn.User == "" || lid.Server != types.HiddenUserServer || pn.Server != types.DefaultUserServer {
			return
		}
		pairs = append(pairs, store.LIDMapping{LID: lid.ToNonAD(), PN: pn.ToNonAD()})
	}
	for _, mapping := range data.GetPhoneNumberToLidMappings() {
		add(mapping.GetLidJID(), mapping.GetPnJID())
	}
	for _, chat := range data.GetConversations() {
		lid, pn := chat.GetLidJID(), chat.GetPnJID()
		jid, err := types.ParseJID(chat.GetID())
		if err == nil {
			if lid == "" && jid.Server == types.HiddenUserServer {
				lid = jid.String()
			}
			if pn == "" && (jid.Server == types.DefaultUserServer || jid.Server == types.LegacyUserServer) {
				pn = jid.String()
			}
		}
		add(lid, pn)
	}
	if len(pairs) == 0 {
		return nil
	}
	return r.client.Store.LIDs.PutManyLIDMappings(context.Background(), pairs)
}
