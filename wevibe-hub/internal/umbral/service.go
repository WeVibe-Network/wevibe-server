package umbral

import (
	"context"
	"errors"
	"fmt"
	"log"
	"log/slog"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/umbral/umbralpb"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

var (
	ErrKFragNotFound      = errors.New("kfrag not found in sidecar")
	ErrSidecarUnavailable = errors.New("umbral sidecar unavailable")
)

type Service struct {
	client *client
}

func NewService(client *client) *Service {
	return &Service{client: client}
}

func (s *Service) StoreKFrag(ctx context.Context, orgID string, memberPK, kfrag []byte) error {
	_, err := s.client.sidecar.StoreKFrag(ctx, &umbralpb.StoreKFragRequest{
		OrgId:    orgID,
		MemberPk: memberPK,
		Kfrag:    kfrag,
	})
	if err != nil {
		wlog.Op(ctx, "hub.store_kfrag", slog.LevelError,
			slog.String("phase", "outcome"),
			slog.String("status", "err"),
			slog.String("org", orgID),
			slog.String("member_pk_fp", wlog.Fingerprint(memberPK)),
			slog.String("err", err.Error()))
		return err
	}
	wlog.Op(ctx, "hub.store_kfrag", slog.LevelInfo,
		slog.String("phase", "outcome"),
		slog.String("status", "ok"),
		slog.String("org", orgID),
		slog.String("member_pk_fp", wlog.Fingerprint(memberPK)),
		slog.Int("kfrag_len", len(kfrag)))
	return nil
}

func (s *Service) ReEncryptForMember(ctx context.Context, orgID string, memberPK, capsule []byte) ([]byte, error) {
	req := &umbralpb.ReEncryptRequest{
		OrgId:    orgID,
		MemberPk: memberPK,
		Capsule:  capsule,
	}
	resp, err := s.client.ReEncrypt(ctx, req)
	if err != nil {
		wlog.Op(ctx, "hub.reencrypt", slog.LevelError,
			slog.String("phase", "outcome"),
			slog.String("status", "err"),
			slog.String("org", orgID),
			slog.String("member_pk_fp", wlog.Fingerprint(memberPK)),
			slog.String("capsule_fp", wlog.Fingerprint(capsule)),
			slog.String("err", err.Error()))
		if st, ok := status.FromError(err); ok && st.Code() == codes.NotFound {
			return nil, ErrKFragNotFound
		}
		if st, ok := status.FromError(err); ok && st.Code() == codes.Unavailable {
			return nil, fmt.Errorf("%w: %v", ErrSidecarUnavailable, err)
		}
		return nil, fmt.Errorf("re-encrypt: %w", err)
	}
	wlog.Op(ctx, "hub.reencrypt", slog.LevelInfo,
		slog.String("phase", "outcome"),
		slog.String("status", "ok"),
		slog.String("org", orgID),
		slog.String("member_pk_fp", wlog.Fingerprint(memberPK)),
		slog.String("capsule_fp", wlog.Fingerprint(capsule)),
		slog.Int("cfrag_len", len(resp.Cfrag)))
	return resp.Cfrag, nil
}

func (s *Service) OnMemberRemoved(ctx context.Context, orgID string, memberPK []byte) (uint32, error) {
	req := &umbralpb.DeleteKFragsRequest{
		OrgId:    orgID,
		MemberPk: memberPK,
	}
	resp, err := s.client.DeleteKFrags(ctx, req)
	if err != nil {
		if st, ok := status.FromError(err); ok && st.Code() == codes.Unavailable {
			return 0, fmt.Errorf("%w: %v", ErrSidecarUnavailable, err)
		}
		return 0, fmt.Errorf("delete kfrags: %w", err)
	}
	log.Printf("umbral: deleted %d kfrags for org=%s member_pk=%x", resp.DeletedCount, orgID, memberPK[:8])
	return resp.DeletedCount, nil
}

func (s *Service) RemoveOrgKFrags(ctx context.Context, orgID string) (uint32, error) {
	req := &umbralpb.DeleteOrgKFragsRequest{
		OrgId: orgID,
	}
	resp, err := s.client.DeleteOrgKFrags(ctx, req)
	if err != nil {
		if st, ok := status.FromError(err); ok && st.Code() == codes.Unavailable {
			return 0, fmt.Errorf("%w: %v", ErrSidecarUnavailable, err)
		}
		return 0, fmt.Errorf("delete org kfrags: %w", err)
	}
	log.Printf("umbral: deleted %d kfrags for org=%s", resp.DeletedCount, orgID)
	return resp.DeletedCount, nil
}

func (s *Service) Health(ctx context.Context) error {
	_, err := s.client.Health(ctx)
	if err != nil {
		if st, ok := status.FromError(err); ok && st.Code() == codes.Unavailable {
			return fmt.Errorf("%w: %v", ErrSidecarUnavailable, err)
		}
		return fmt.Errorf("sidecar health: %w", err)
	}
	return nil
}
