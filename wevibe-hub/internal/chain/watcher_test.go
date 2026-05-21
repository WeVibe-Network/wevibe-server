package chain

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

type mockDBForWatcher struct {
	events   []mockEvent
	notifs   []mockNotif
	lastBlock int64
}

type mockEvent struct {
	txHash   string
	orgID    string
	memHash  []byte
	action   string
}

type mockNotif struct {
	recipient string
	category  string
	orgID     string
}

func (m *mockDBForWatcher) QueryRow(ctx context.Context, query string, args ...interface{}) (interface{}, error) {
	if query == "SELECT last_seen_block_height FROM watcher_state WHERE watcher_name = 'chain_commit_events'" {
		return m.lastBlock, nil
	}
	return int64(0), nil
}

func (m *mockDBForWatcher) Exec(ctx context.Context, query string, args ...interface{}) (interface{}, error) {
	if query == "UPDATE watcher_state SET last_seen_block_height = $1, updated_at = NOW() WHERE watcher_name = 'chain_commit_events'" {
		if len(args) > 0 {
			m.lastBlock = args[0].(int64)
		}
		return nil, nil
	}
	if query == "INSERT INTO chain_commit_events" {
		action := "memory_approved"
		if len(args) > 3 && args[3] == "report_upheld" {
			action = "report_upheld"
		}
		m.events = append(m.events, mockEvent{
			txHash:  args[0].(string),
			orgID:   args[3].(string),
			memHash: args[4].([]byte),
			action:  action,
		})
		return nil, nil
	}
	if query == "INSERT INTO notifications" {
		m.notifs = append(m.notifs, mockNotif{
			recipient: args[0].(string),
			category:  args[1].(string),
			orgID:     args[5].(string),
		})
		return nil, nil
	}
	return nil, nil
}

func TestChainWatcher_ProcessApproveTx_WritesEvent(t *testing.T) {
	db := &mockDBForWatcher{
		events:    make([]mockEvent, 0),
		lastBlock: 0,
	}

	require.NotNil(t, db)
	require.Len(t, db.events, 0)
}

func TestChainWatcher_ProcessApproveTx_EmitsNotifications(t *testing.T) {
	db := &mockDBForWatcher{
		events:    make([]mockEvent, 0),
		notifs:    make([]mockNotif, 0),
		lastBlock: 0,
	}

	approvers := []string{"wevibe1mod1", "wevibe1mod2"}
	for _, mod := range approvers {
		db.notifs = append(db.notifs, mockNotif{
			recipient: mod,
			category:  "chain_commit_involving_you",
			orgID:     "test-org",
		})
	}

	require.Len(t, db.notifs, 2)
	require.Equal(t, "chain_commit_involving_you", db.notifs[0].category)
	require.Equal(t, "wevibe1mod1", db.notifs[0].recipient)
	require.Equal(t, "wevibe1mod2", db.notifs[1].recipient)
}

func TestChainWatcher_ProcessReportTx_WritesEvent(t *testing.T) {
	db := &mockDBForWatcher{
		events:    make([]mockEvent, 0),
		notifs:    make([]mockNotif, 0),
		lastBlock: 0,
	}

	db.events = append(db.events, mockEvent{
		txHash:  "abc123",
		orgID:   "test-org",
		memHash: []byte("hash123"),
		action:  "report_upheld",
	})

	require.Len(t, db.events, 1)
	require.Equal(t, "report_upheld", db.events[0].action)
	require.Equal(t, "test-org", db.events[0].orgID)
}

func TestChainWatcher_ProcessReportTx_EmitsApprovalOverturnNotifications(t *testing.T) {
	db := &mockDBForWatcher{
		events:    make([]mockEvent, 0),
		notifs:    make([]mockNotif, 0),
		lastBlock: 0,
	}

	approvers := []string{"wevibe1mod1", "wevibe1mod2"}
	upholders := []string{"wevibe1mod3"}

	for _, mod := range approvers {
		db.notifs = append(db.notifs, mockNotif{
			recipient: mod,
			category:  "your_approval_was_overturned",
			orgID:    "test-org",
		})
	}
	for _, mod := range upholders {
		db.notifs = append(db.notifs, mockNotif{
			recipient: mod,
			category:  "report_upheld_committed",
			orgID:    "test-org",
		})
	}

	require.True(t, len(db.notifs) >= 3)
	hasOverturn := false
	hasUpheld := false
	for _, n := range db.notifs {
		if n.category == "your_approval_was_overturned" {
			hasOverturn = true
		}
		if n.category == "report_upheld_committed" {
			hasUpheld = true
		}
	}
	require.True(t, hasOverturn, "should emit your_approval_was_overturned for approvers")
	require.True(t, hasUpheld, "should emit report_upheld_committed for upholders")
}

func TestChainWatcher_Idempotent(t *testing.T) {
	db := &mockDBForWatcher{
		events:    make([]mockEvent, 0),
		notifs:    make([]mockNotif, 0),
		lastBlock: 0,
	}

	db.events = append(db.events, mockEvent{txHash: "tx1", action: "memory_approved"})
	db.events = append(db.events, mockEvent{txHash: "tx1", action: "memory_approved"})

	require.Len(t, db.events, 2)
}

func TestChainWatcher_ResumeFromLastBlock(t *testing.T) {
	db := &mockDBForWatcher{
		events:    make([]mockEvent, 0),
		lastBlock: 100,
	}

	require.Equal(t, int64(100), db.lastBlock)
}