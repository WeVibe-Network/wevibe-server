package umbral

import (
	"context"
	"fmt"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/umbral/umbralpb"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

const SidecarAddr = "127.0.0.1:4460"

type UmbralSidecarClient interface {
	ReEncrypt(ctx context.Context, req *umbralpb.ReEncryptRequest) (*umbralpb.ReEncryptResponse, error)
	DeleteKFrags(ctx context.Context, req *umbralpb.DeleteKFragsRequest) (*umbralpb.DeleteKFragsResponse, error)
	DeleteOrgKFrags(ctx context.Context, req *umbralpb.DeleteOrgKFragsRequest) (*umbralpb.DeleteOrgKFragsResponse, error)
	Health(ctx context.Context) (*umbralpb.HealthResponse, error)
	Close() error
}

type client struct {
	conn    *grpc.ClientConn
	sidecar umbralpb.UmbralSidecarClient
}

func NewClient(addr string) (*client, error) {
	conn, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithChainUnaryInterceptor(wlog.UnaryClientInterceptor()))
	if err != nil {
		return nil, fmt.Errorf("create grpc connection to umbral sidecar: %w", err)
	}
	return &client{
		conn:    conn,
		sidecar: umbralpb.NewUmbralSidecarClient(conn),
	}, nil
}

func (c *client) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
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
