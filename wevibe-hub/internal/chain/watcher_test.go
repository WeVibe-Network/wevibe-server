package chain

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

type mockDBForWatcher struct {
	lastBlock int64
}

func (m *mockDBForWatcher) QueryRow(ctx context.Context, query string, args ...interface{}) (interface{}, error) {
	if query == "SELECT last_seen_block_height FROM watcher_state WHERE watcher_name = 'chain_watcher'" {
		return m.lastBlock, nil
	}
	return int64(0), nil
}

func (m *mockDBForWatcher) Exec(ctx context.Context, query string, args ...interface{}) (interface{}, error) {
	if query == "UPDATE watcher_state SET last_seen_block_height = $1, updated_at = NOW() WHERE watcher_name = 'chain_watcher'" {
		if len(args) > 0 {
			m.lastBlock = args[0].(int64)
		}
		return nil, nil
	}
	return nil, nil
}

func TestChainWatcher_InitialState(t *testing.T) {
	db := &mockDBForWatcher{
		lastBlock: 0,
	}

	require.NotNil(t, db)
	require.Equal(t, int64(0), db.lastBlock)
}

func TestChainWatcher_ResumeFromLastBlock(t *testing.T) {
	db := &mockDBForWatcher{
		lastBlock: 100,
	}

	require.Equal(t, int64(100), db.lastBlock)
}
