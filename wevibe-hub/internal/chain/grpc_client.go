package chain

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	cryptocodec "github.com/cosmos/cosmos-sdk/crypto/codec"
	"github.com/cosmos/cosmos-sdk/crypto/hd"
	"github.com/cosmos/cosmos-sdk/crypto/keyring"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtx "github.com/cosmos/cosmos-sdk/x/auth/tx"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	attesttypes "github.com/wevibe-network/wevibe-chain/x/attestation/types"
	bwtypes "github.com/wevibe-network/wevibe-chain/x/bandwidth/types"
	emissionstypes "github.com/wevibe-network/wevibe-chain/x/emissions/types"
	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	orgtypes "github.com/wevibe-network/wevibe-chain/x/org/types"
	reptypes "github.com/wevibe-network/wevibe-chain/x/reputation/types"
	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type GrpcClient struct {
	conn      *grpc.ClientConn
	codec     codec.Codec
	registry  codectypes.InterfaceRegistry
	submitter sdk.AccAddress
	kr        keyring.Keyring
	chainID   string
	rpcURL    string
	txConfig  client.TxConfig
	authQuery authtypes.QueryClient

	fallbackMu            sync.Mutex
	fallbackStateLoaded   bool
	fallbackAccountNumber uint64
	fallbackSequence      uint64

	memoryQuery    memorytypes.QueryClient
	orgQuery       orgtypes.QueryClient
	serveQuery     servetypes.QueryClient
	attestQuery    attesttypes.QueryClient
	bandwidthQuery bwtypes.QueryClient
	emissionsQuery emissionstypes.QueryClient
	repQuery       reptypes.QueryClient
}

func NewGrpcClient(grpcURL, chainID, mnemonic string) (*GrpcClient, error) {
	sdk.GetConfig().SetBech32PrefixForAccount("wevibe", "wevibepub")

	normalizedGRPCURL := strings.TrimSpace(grpcURL)
	if parsed, err := url.Parse(normalizedGRPCURL); err == nil && parsed.Host != "" {
		normalizedGRPCURL = parsed.Host
	}

	rpcURL := strings.TrimSpace(os.Getenv("WEVIBE_CHAIN_RPC_URL"))
	if parsed, err := url.Parse(rpcURL); err == nil && parsed.Host != "" {
		rpcURL = "http://" + parsed.Host
	}

	conn, err := grpc.NewClient(normalizedGRPCURL,
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("create grpc connection: %w", err)
	}

	registry := codectypes.NewInterfaceRegistry()
	cryptocodec.RegisterInterfaces(registry)
	authtypes.RegisterInterfaces(registry)
	orgtypes.RegisterInterfaces(registry)
	memorytypes.RegisterInterfaces(registry)
	servetypes.RegisterInterfaces(registry)
	attesttypes.RegisterInterfaces(registry)
	bwtypes.RegisterInterfaces(registry)
	emissionstypes.RegisterInterfaces(registry)
	reptypes.RegisterInterfaces(registry)
	cdc := codec.NewProtoCodec(registry)

	kb, err := keyring.New("wevibe-hub", keyring.BackendMemory, "", bytes.NewReader([]byte{}), cdc)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("create keyring: %w", err)
	}

	hdPath := "m/44'/118'/0'/0/0"
	info, err := kb.NewAccount("submitter", mnemonic, "", hdPath, hd.Secp256k1)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("derive submitter key: %w", err)
	}

	addr, err := info.GetAddress()
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("get submitter address: %w", err)
	}

	txConfig := authtx.NewTxConfig(cdc, authtx.DefaultSignModes)
	authQuery := authtypes.NewQueryClient(conn)

	return &GrpcClient{
		conn:           conn,
		codec:          cdc,
		registry:       registry,
		submitter:      addr,
		kr:             kb,
		chainID:        chainID,
		rpcURL:         rpcURL,
		txConfig:       txConfig,
		authQuery:      authQuery,
		memoryQuery:    memorytypes.NewQueryClient(conn),
		orgQuery:       orgtypes.NewQueryClient(conn),
		serveQuery:     servetypes.NewQueryClient(conn),
		attestQuery:    attesttypes.NewQueryClient(conn),
		bandwidthQuery: bwtypes.NewQueryClient(conn),
		emissionsQuery: emissionstypes.NewQueryClient(conn),
		repQuery:       reptypes.NewQueryClient(conn),
	}, nil
}

func (c *GrpcClient) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

func (c *GrpcClient) SubmitterAddress() string {
	if c.submitter == nil {
		return ""
	}
	return c.submitter.String()
}

func (c *GrpcClient) GetOrgQueryClient() orgtypes.QueryClient {
	return c.orgQuery
}

func (c *GrpcClient) GetMemoryQueryClient() memorytypes.QueryClient {
	return c.memoryQuery
}

func (c *GrpcClient) GetServeQueryClient() servetypes.QueryClient {
	return c.serveQuery
}

func (c *GrpcClient) GetAttestationQueryClient() attesttypes.QueryClient {
	return c.attestQuery
}

func (c *GrpcClient) GetBandwidthQueryClient() bwtypes.QueryClient {
	return c.bandwidthQuery
}

func (c *GrpcClient) GetEmissionsQueryClient() emissionstypes.QueryClient {
	return c.emissionsQuery
}

func (c *GrpcClient) GetReputationQueryClient() reptypes.QueryClient {
	return c.repQuery
}

func (c *GrpcClient) GetCodec() codec.Codec {
	return c.codec
}

func (c *GrpcClient) GetRegistry() codectypes.InterfaceRegistry {
	return c.registry
}

func (c *GrpcClient) GetKeyring() keyring.Keyring {
	return c.kr
}

func (c *GrpcClient) GetSubmitterAddress() sdk.AccAddress {
	return c.submitter
}

func (c *GrpcClient) GetTxConfig() client.TxConfig {
	return c.txConfig
}

func (c *GrpcClient) GetChainID() string {
	return c.chainID
}

func (c *GrpcClient) BroadcastTxSync(ctx context.Context, txBytes []byte) (string, error) {
	return c.broadcastTxSync(ctx, txBytes)
}
