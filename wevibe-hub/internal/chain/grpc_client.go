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
	txtypes "github.com/cosmos/cosmos-sdk/types/tx"
	authtx "github.com/cosmos/cosmos-sdk/x/auth/tx"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	authztypes "github.com/cosmos/cosmos-sdk/x/authz"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	"github.com/jackc/pgx/v5/pgxpool"
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

type orgSigner struct {
	orgID      string
	role       OrgKeyRole
	keyringUID string
	address    sdk.AccAddress
	addressStr string
	mu         sync.Mutex
	seqLoaded  bool
	accountNum uint64
	nextSeq    uint64
}

type GrpcClient struct {
	conn      *grpc.ClientConn
	codec     codec.Codec
	registry  codectypes.InterfaceRegistry
	kr        keyring.Keyring
	mnemonic  string
	chainID   string
	rpcURL    string
	txConfig  client.TxConfig
	authQuery authtypes.QueryClient
	bankQuery banktypes.QueryClient
	txSim     txSimulator
	gasMode   gasStrategy

	orgSigners   map[string]*orgSigner
	orgSignersMu sync.RWMutex

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

	gasMode, err := parseGasStrategy(os.Getenv("GAS_STRATEGY"))
	if err != nil {
		return nil, err
	}

	conn, err := grpc.NewClient(normalizedGRPCURL,
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("create grpc connection: %w", err)
	}

	registry := codectypes.NewInterfaceRegistry()
	cryptocodec.RegisterInterfaces(registry)
	authtypes.RegisterInterfaces(registry)
	banktypes.RegisterInterfaces(registry)
	authztypes.RegisterInterfaces(registry)
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
	_, err = kb.NewAccount("submitter", mnemonic, "", hdPath, hd.Secp256k1)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("derive submitter key: %w", err)
	}

	txConfig := authtx.NewTxConfig(cdc, authtx.DefaultSignModes)
	authQuery := authtypes.NewQueryClient(conn)
	bankQuery := banktypes.NewQueryClient(conn)

	return &GrpcClient{
		conn:           conn,
		codec:          cdc,
		registry:       registry,
		kr:             kb,
		mnemonic:       mnemonic,
		chainID:        chainID,
		rpcURL:         rpcURL,
		txConfig:       txConfig,
		authQuery:      authQuery,
		bankQuery:      bankQuery,
		txSim:          txtypes.NewServiceClient(conn),
		gasMode:        gasMode,
		orgSigners:     make(map[string]*orgSigner),
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
	record, err := c.kr.Key("submitter")
	if err != nil {
		return ""
	}

	address, err := record.GetAddress()
	if err != nil {
		return ""
	}

	return address.String()
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
	record, err := c.kr.Key("submitter")
	if err != nil {
		return nil
	}

	address, err := record.GetAddress()
	if err != nil {
		return nil
	}

	return address
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

func (c *GrpcClient) GetOrgSigner(ctx context.Context, db *pgxpool.Pool, orgID string, role OrgKeyRole) (*orgSigner, error) {
	trimmedOrgID := strings.TrimSpace(orgID)
	if trimmedOrgID == "" {
		return nil, fmt.Errorf("orgID is required")
	}
	if !role.valid() {
		return nil, fmt.Errorf("invalid org key role %q", role)
	}
	if db == nil {
		return nil, fmt.Errorf("db is required")
	}

	cacheKey := trimmedOrgID + ":" + string(role)

	c.orgSignersMu.RLock()
	if signer, ok := c.orgSigners[cacheKey]; ok {
		c.orgSignersMu.RUnlock()
		return signer, nil
	}
	c.orgSignersMu.RUnlock()

	c.orgSignersMu.Lock()
	defer c.orgSignersMu.Unlock()

	if signer, ok := c.orgSigners[cacheKey]; ok {
		return signer, nil
	}

	addressStr, keyringUID, err := c.EnsureOrgAccount(ctx, db, trimmedOrgID, role)
	if err != nil {
		return nil, err
	}

	address, err := sdk.AccAddressFromBech32(addressStr)
	if err != nil {
		return nil, fmt.Errorf("parse org signer address %s: %w", addressStr, err)
	}

	signer := &orgSigner{
		orgID:      trimmedOrgID,
		role:       role,
		keyringUID: keyringUID,
		address:    address,
		addressStr: addressStr,
	}
	c.orgSigners[cacheKey] = signer

	return signer, nil
}
