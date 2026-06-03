package handlers

import (
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/social"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/umbral"
)

var pool *pgxpool.Pool
var qdrantClient *retrieval.QdrantClient
var nodePrivkeyHex string
var chainClient *chain.GrpcClient
var faucetURL string
var umbralService *umbral.Service
var socialClient *social.Client

func SetPool(p *pgxpool.Pool) {
	pool = p
}

func GetPool() *pgxpool.Pool {
	return pool
}

func SetQdrantClient(c *retrieval.QdrantClient) {
	qdrantClient = c
}

func SetNodePrivkey(key string) {
	nodePrivkeyHex = key
}

func SetChainClient(c *chain.GrpcClient) {
	chainClient = c
}

func SetFaucetURL(url string) {
	faucetURL = url
}

func SetUmbralService(s *umbral.Service) {
	umbralService = s
}

func SetSocialClient(c *social.Client) {
	socialClient = c
}

func GetSocialClient() *social.Client {
	return socialClient
}
