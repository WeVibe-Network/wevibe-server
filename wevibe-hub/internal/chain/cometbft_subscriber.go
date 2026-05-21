package chain

import (
	"context"
	"fmt"

	rpchttp "github.com/cometbft/cometbft/rpc/client/http"
	"github.com/cometbft/cometbft/rpc/client"
	coretypes "github.com/cometbft/cometbft/rpc/core/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"log/slog"
)

type CometBFTSubscriber struct {
	client  client.Client
	logger  *slog.Logger
	nodeURL string
}

func NewCometBFTSubscriber(nodeURL string, logger *slog.Logger) (*CometBFTSubscriber, error) {
	httpClient, err := rpchttp.New(nodeURL, "/websocket")
	if err != nil {
		return nil, fmt.Errorf("create rpc client: %w", err)
	}
	return &CometBFTSubscriber{
		client:  httpClient,
		logger:  logger,
		nodeURL: nodeURL,
	}, nil
}

func (s *CometBFTSubscriber) Start(ctx context.Context) error {
	if err := s.client.Start(); err != nil {
		return fmt.Errorf("start rpc client: %w", err)
	}
	s.logger.Info("CometBFT subscriber started", "node", s.nodeURL)
	return nil
}

func (s *CometBFTSubscriber) Stop() error {
	return s.client.Stop()
}

func (s *CometBFTSubscriber) Subscribe(ctx context.Context) (<-chan coretypes.ResultEvent, error) {
	query := "tm.event = 'NewBlock'"
	return s.client.Subscribe(ctx, "wevibe-hub-chain-watcher", query)
}

func (s *CometBFTSubscriber) Block(ctx context.Context, height *int64) (*cmttypes.Block, error) {
	result, err := s.client.Block(ctx, height)
	if err != nil {
		return nil, err
	}
	return result.Block, nil
}

func (s *CometBFTSubscriber) Status(ctx context.Context) (*coretypes.ResultStatus, error) {
	return s.client.Status(ctx)
}