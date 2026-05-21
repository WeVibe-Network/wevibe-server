package umbral

import (
	"context"
	"fmt"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/umbral/umbralpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

const SidecarAddr = "127.0.0.1:4460"

type UmbralSidecarClient interface {
	GenerateKeyPair(ctx context.Context) (*umbralpb.GenerateKeyPairResponse, error)
	GenerateKFrags(ctx context.Context, req *umbralpb.GenerateKFragsRequest) (*umbralpb.GenerateKFragsResponse, error)
	ReEncrypt(ctx context.Context, req *umbralpb.ReEncryptRequest) (*umbralpb.ReEncryptResponse, error)
	DeleteKFrags(ctx context.Context, req *umbralpb.DeleteKFragsRequest) (*umbralpb.DeleteKFragsResponse, error)
	DeleteOrgKFrags(ctx context.Context, req *umbralpb.DeleteOrgKFragsRequest) (*umbralpb.DeleteOrgKFragsResponse, error)
	Health(ctx context.Context) (*umbralpb.HealthResponse, error)
	Close() error
}

type client struct {
	conn   *grpc.ClientConn
	sidecar umbralpb.UmbralSidecarClient
}

func NewClient(addr string) (*client, error) {
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("create grpc connection to umbral sidecar: %w", err)
	}
	return &client{
		conn:   conn,
		sidecar: umbralpb.NewUmbralSidecarClient(conn),
	}, nil
}

func (c *client) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

func (c *client) GenerateKeyPair(ctx context.Context) (*umbralpb.GenerateKeyPairResponse, error) {
	return c.sidecar.GenerateKeyPair(ctx, &umbralpb.GenerateKeyPairRequest{})
}

func (c *client) GenerateKFrags(ctx context.Context, req *umbralpb.GenerateKFragsRequest) (*umbralpb.GenerateKFragsResponse, error) {
	return c.sidecar.GenerateKFrags(ctx, req)
}

func (c *client) ReEncrypt(ctx context.Context, req *umbralpb.ReEncryptRequest) (*umbralpb.ReEncryptResponse, error) {
	return c.sidecar.ReEncrypt(ctx, req)
}

func (c *client) DeleteKFrags(ctx context.Context, req *umbralpb.DeleteKFragsRequest) (*umbralpb.DeleteKFragsResponse, error) {
	return c.sidecar.DeleteKFrags(ctx, req)
}

func (c *client) DeleteOrgKFrags(ctx context.Context, req *umbralpb.DeleteOrgKFragsRequest) (*umbralpb.DeleteOrgKFragsResponse, error) {
	return c.sidecar.DeleteOrgKFrags(ctx, req)
}

func (c *client) Health(ctx context.Context) (*umbralpb.HealthResponse, error) {
	return c.sidecar.Health(ctx, &umbralpb.HealthRequest{})
}

func GenerateKeyPair(ctx context.Context, addr string) (secretKey, publicKey []byte, err error) {
	c, err := NewClient(addr)
	if err != nil {
		return nil, nil, fmt.Errorf("create umbral sidecar client: %w", err)
	}
	defer c.Close()

	resp, err := c.GenerateKeyPair(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("generate key pair: %w", err)
	}
	return resp.SecretKey, resp.PublicKey, nil
}