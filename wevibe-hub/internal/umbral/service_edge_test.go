package umbral

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/umbral/umbralpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type sidecarStub struct {
	storeKFragFn      func(context.Context, *umbralpb.StoreKFragRequest, ...grpc.CallOption) (*umbralpb.StoreKFragResponse, error)
	reEncryptFn       func(context.Context, *umbralpb.ReEncryptRequest, ...grpc.CallOption) (*umbralpb.ReEncryptResponse, error)
	deleteKFragsFn    func(context.Context, *umbralpb.DeleteKFragsRequest, ...grpc.CallOption) (*umbralpb.DeleteKFragsResponse, error)
	deleteOrgKFragsFn func(context.Context, *umbralpb.DeleteOrgKFragsRequest, ...grpc.CallOption) (*umbralpb.DeleteOrgKFragsResponse, error)
	healthFn          func(context.Context, *umbralpb.HealthRequest, ...grpc.CallOption) (*umbralpb.HealthResponse, error)
}

func (s *sidecarStub) StoreKFrag(ctx context.Context, req *umbralpb.StoreKFragRequest, opts ...grpc.CallOption) (*umbralpb.StoreKFragResponse, error) {
	if s.storeKFragFn == nil {
		panic("unexpected StoreKFrag call")
	}
	return s.storeKFragFn(ctx, req, opts...)
}

func (s *sidecarStub) ReEncrypt(ctx context.Context, req *umbralpb.ReEncryptRequest, opts ...grpc.CallOption) (*umbralpb.ReEncryptResponse, error) {
	if s.reEncryptFn == nil {
		panic("unexpected ReEncrypt call")
	}
	return s.reEncryptFn(ctx, req, opts...)
}

func (s *sidecarStub) DeleteKFrags(ctx context.Context, req *umbralpb.DeleteKFragsRequest, opts ...grpc.CallOption) (*umbralpb.DeleteKFragsResponse, error) {
	if s.deleteKFragsFn == nil {
		panic("unexpected DeleteKFrags call")
	}
	return s.deleteKFragsFn(ctx, req, opts...)
}

func (s *sidecarStub) DeleteOrgKFrags(ctx context.Context, req *umbralpb.DeleteOrgKFragsRequest, opts ...grpc.CallOption) (*umbralpb.DeleteOrgKFragsResponse, error) {
	if s.deleteOrgKFragsFn == nil {
		panic("unexpected DeleteOrgKFrags call")
	}
	return s.deleteOrgKFragsFn(ctx, req, opts...)
}

func (s *sidecarStub) Health(ctx context.Context, req *umbralpb.HealthRequest, opts ...grpc.CallOption) (*umbralpb.HealthResponse, error) {
	if s.healthFn == nil {
		panic("unexpected Health call")
	}
	return s.healthFn(ctx, req, opts...)
}

func newServiceForTest(sidecar umbralpb.UmbralSidecarClient) *Service {
	return NewService(&client{sidecar: sidecar})
}

func TestServiceReEncryptForMember_EdgeCases(t *testing.T) {
	type testCase struct {
		name        string
		sidecarResp *umbralpb.ReEncryptResponse
		sidecarErr  error
		wantCfrag   []byte
		checkErr    func(*testing.T, error)
	}

	testCases := []testCase{
		{
			name:        "success returns cfrag and forwards request",
			sidecarResp: &umbralpb.ReEncryptResponse{Cfrag: []byte{0xca, 0xfe}},
			wantCfrag:   []byte{0xca, 0xfe},
			checkErr: func(t *testing.T, err error) {
				t.Helper()
				if err != nil {
					t.Fatalf("expected nil error, got %v", err)
				}
			},
		},
		{
			name:       "not found maps to ErrKFragNotFound",
			sidecarErr: status.Error(codes.NotFound, "missing kfrag"),
			checkErr: func(t *testing.T, err error) {
				t.Helper()
				if err != ErrKFragNotFound {
					t.Fatalf("expected ErrKFragNotFound, got %v", err)
				}
			},
		},
		{
			name:       "unavailable wraps ErrSidecarUnavailable",
			sidecarErr: status.Error(codes.Unavailable, "sidecar offline"),
			checkErr: func(t *testing.T, err error) {
				t.Helper()
				if err == nil {
					t.Fatal("expected non-nil error")
				}
				if !errors.Is(err, ErrSidecarUnavailable) {
					t.Fatalf("expected error wrapping ErrSidecarUnavailable, got %v", err)
				}
				if !strings.Contains(err.Error(), "umbral sidecar unavailable") {
					t.Fatalf("expected unavailable error message, got %q", err.Error())
				}
				if !strings.Contains(err.Error(), "sidecar offline") {
					t.Fatalf("expected wrapped sidecar detail, got %q", err.Error())
				}
			},
		},
		{
			name:       "unexpected sidecar error is wrapped with method prefix",
			sidecarErr: errors.New("boom"),
			checkErr: func(t *testing.T, err error) {
				t.Helper()
				if err == nil {
					t.Fatal("expected non-nil error")
				}
				if got, want := err.Error(), "re-encrypt: boom"; got != want {
					t.Fatalf("unexpected error text: got %q want %q", got, want)
				}
			},
		},
	}

	const orgID = "org-edge"
	const epochID = uint64(42)
	memberPK := []byte{0x01, 0x02, 0x03}
	capsule := []byte{0xa0, 0xa1}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			var gotReq *umbralpb.ReEncryptRequest

			svc := newServiceForTest(&sidecarStub{
				reEncryptFn: func(_ context.Context, req *umbralpb.ReEncryptRequest, _ ...grpc.CallOption) (*umbralpb.ReEncryptResponse, error) {
					gotReq = req
					return tc.sidecarResp, tc.sidecarErr
				},
			})

			gotCfrag, err := svc.ReEncryptForMember(context.Background(), orgID, epochID, memberPK, capsule)

			if gotReq == nil {
				t.Fatal("expected ReEncrypt request to be forwarded")
			}
			if gotReq.OrgId != orgID {
				t.Fatalf("OrgId mismatch: got %q want %q", gotReq.OrgId, orgID)
			}
			if gotReq.EpochId != epochID {
				t.Fatalf("EpochId mismatch: got %d want %d", gotReq.EpochId, epochID)
			}
			if !reflect.DeepEqual(gotReq.MemberPk, memberPK) {
				t.Fatalf("MemberPk mismatch: got %v want %v", gotReq.MemberPk, memberPK)
			}
			if !reflect.DeepEqual(gotReq.Capsule, capsule) {
				t.Fatalf("Capsule mismatch: got %v want %v", gotReq.Capsule, capsule)
			}

			tc.checkErr(t, err)
			if !bytes.Equal(gotCfrag, tc.wantCfrag) {
				t.Fatalf("cfrag mismatch: got %v want %v", gotCfrag, tc.wantCfrag)
			}
		})
	}
}

func TestServiceStoreKFrag_ForwardsInputsAndPropagatesErrors(t *testing.T) {
	sidecarFailure := errors.New("store failed")

	testCases := []struct {
		name       string
		orgID      string
		epochID    uint64
		memberPK   []byte
		kfrag      []byte
		sidecarErr error
	}{
		{
			name:     "nil payloads are forwarded without panic",
			orgID:    "",
			epochID:  0,
			memberPK: nil,
			kfrag:    nil,
		},
		{
			name:       "empty payloads and sidecar error are returned unchanged",
			orgID:      "org",
			epochID:    9,
			memberPK:   []byte{},
			kfrag:      []byte{},
			sidecarErr: sidecarFailure,
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			var gotReq *umbralpb.StoreKFragRequest

			svc := newServiceForTest(&sidecarStub{
				storeKFragFn: func(_ context.Context, req *umbralpb.StoreKFragRequest, _ ...grpc.CallOption) (*umbralpb.StoreKFragResponse, error) {
					gotReq = req
					return &umbralpb.StoreKFragResponse{}, tc.sidecarErr
				},
			})

			err := svc.StoreKFrag(context.Background(), tc.orgID, tc.epochID, tc.memberPK, tc.kfrag)
			if tc.sidecarErr == nil {
				if err != nil {
					t.Fatalf("expected nil error, got %v", err)
				}
			} else if err != tc.sidecarErr {
				t.Fatalf("expected original sidecar error %v, got %v", tc.sidecarErr, err)
			}

			if gotReq == nil {
				t.Fatal("expected StoreKFrag request to be forwarded")
			}
			if gotReq.OrgId != tc.orgID {
				t.Fatalf("OrgId mismatch: got %q want %q", gotReq.OrgId, tc.orgID)
			}
			if gotReq.EpochId != tc.epochID {
				t.Fatalf("EpochId mismatch: got %d want %d", gotReq.EpochId, tc.epochID)
			}
			if !reflect.DeepEqual(gotReq.MemberPk, tc.memberPK) {
				t.Fatalf("MemberPk mismatch: got %v want %v", gotReq.MemberPk, tc.memberPK)
			}
			if !reflect.DeepEqual(gotReq.Kfrag, tc.kfrag) {
				t.Fatalf("Kfrag mismatch: got %v want %v", gotReq.Kfrag, tc.kfrag)
			}
		})
	}
}

func TestServiceOnMemberRemoved_EdgeCases(t *testing.T) {
	testCases := []struct {
		name              string
		memberPK          []byte
		sidecarResp       *umbralpb.DeleteKFragsResponse
		sidecarErr        error
		wantDeletedCount  uint32
		wantErrorContains string
		wantErrorIs       error
	}{
		{
			name:             "success returns deleted count",
			memberPK:         []byte{0, 1, 2, 3, 4, 5, 6, 7},
			sidecarResp:      &umbralpb.DeleteKFragsResponse{DeletedCount: 5},
			wantDeletedCount: 5,
		},
		{
			name:              "unavailable wraps ErrSidecarUnavailable",
			memberPK:          nil,
			sidecarErr:        status.Error(codes.Unavailable, "network down"),
			wantErrorContains: "network down",
			wantErrorIs:       ErrSidecarUnavailable,
		},
		{
			name:              "unexpected error is wrapped with delete kfrags prefix",
			memberPK:          []byte{1, 2},
			sidecarErr:        errors.New("boom"),
			wantErrorContains: "delete kfrags: boom",
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			var gotReq *umbralpb.DeleteKFragsRequest

			svc := newServiceForTest(&sidecarStub{
				deleteKFragsFn: func(_ context.Context, req *umbralpb.DeleteKFragsRequest, _ ...grpc.CallOption) (*umbralpb.DeleteKFragsResponse, error) {
					gotReq = req
					if tc.sidecarResp == nil {
						tc.sidecarResp = &umbralpb.DeleteKFragsResponse{}
					}
					return tc.sidecarResp, tc.sidecarErr
				},
			})

			deletedCount, err := svc.OnMemberRemoved(context.Background(), "org-1", tc.memberPK)

			if gotReq == nil {
				t.Fatal("expected DeleteKFrags request to be forwarded")
			}
			if gotReq.OrgId != "org-1" {
				t.Fatalf("OrgId mismatch: got %q want %q", gotReq.OrgId, "org-1")
			}
			if !reflect.DeepEqual(gotReq.MemberPk, tc.memberPK) {
				t.Fatalf("MemberPk mismatch: got %v want %v", gotReq.MemberPk, tc.memberPK)
			}

			if tc.sidecarErr == nil {
				if err != nil {
					t.Fatalf("expected nil error, got %v", err)
				}
				if deletedCount != tc.wantDeletedCount {
					t.Fatalf("DeletedCount mismatch: got %d want %d", deletedCount, tc.wantDeletedCount)
				}
				return
			}

			if err == nil {
				t.Fatal("expected non-nil error")
			}
			if deletedCount != 0 {
				t.Fatalf("expected zero deleted count on error, got %d", deletedCount)
			}
			if tc.wantErrorIs != nil && !errors.Is(err, tc.wantErrorIs) {
				t.Fatalf("expected wrapped error %v, got %v", tc.wantErrorIs, err)
			}
			if tc.wantErrorContains != "" && !strings.Contains(err.Error(), tc.wantErrorContains) {
				t.Fatalf("expected error to contain %q, got %q", tc.wantErrorContains, err.Error())
			}
		})
	}
}

func TestServiceRemoveOrgKFrags_EdgeCases(t *testing.T) {
	testCases := []struct {
		name              string
		orgID             string
		sidecarResp       *umbralpb.DeleteOrgKFragsResponse
		sidecarErr        error
		wantDeletedCount  uint32
		wantErrorContains string
		wantErrorIs       error
	}{
		{
			name:             "success returns deleted count",
			orgID:            "org-2",
			sidecarResp:      &umbralpb.DeleteOrgKFragsResponse{DeletedCount: 3},
			wantDeletedCount: 3,
		},
		{
			name:              "unavailable wraps ErrSidecarUnavailable",
			orgID:             "org-2",
			sidecarErr:        status.Error(codes.Unavailable, "socket closed"),
			wantErrorContains: "socket closed",
			wantErrorIs:       ErrSidecarUnavailable,
		},
		{
			name:              "unexpected error is wrapped with delete org kfrags prefix",
			orgID:             "",
			sidecarErr:        errors.New("bad delete"),
			wantErrorContains: "delete org kfrags: bad delete",
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			var gotReq *umbralpb.DeleteOrgKFragsRequest

			svc := newServiceForTest(&sidecarStub{
				deleteOrgKFragsFn: func(_ context.Context, req *umbralpb.DeleteOrgKFragsRequest, _ ...grpc.CallOption) (*umbralpb.DeleteOrgKFragsResponse, error) {
					gotReq = req
					if tc.sidecarResp == nil {
						tc.sidecarResp = &umbralpb.DeleteOrgKFragsResponse{}
					}
					return tc.sidecarResp, tc.sidecarErr
				},
			})

			deletedCount, err := svc.RemoveOrgKFrags(context.Background(), tc.orgID)

			if gotReq == nil {
				t.Fatal("expected DeleteOrgKFrags request to be forwarded")
			}
			if gotReq.OrgId != tc.orgID {
				t.Fatalf("OrgId mismatch: got %q want %q", gotReq.OrgId, tc.orgID)
			}

			if tc.sidecarErr == nil {
				if err != nil {
					t.Fatalf("expected nil error, got %v", err)
				}
				if deletedCount != tc.wantDeletedCount {
					t.Fatalf("DeletedCount mismatch: got %d want %d", deletedCount, tc.wantDeletedCount)
				}
				return
			}

			if err == nil {
				t.Fatal("expected non-nil error")
			}
			if deletedCount != 0 {
				t.Fatalf("expected zero deleted count on error, got %d", deletedCount)
			}
			if tc.wantErrorIs != nil && !errors.Is(err, tc.wantErrorIs) {
				t.Fatalf("expected wrapped error %v, got %v", tc.wantErrorIs, err)
			}
			if tc.wantErrorContains != "" && !strings.Contains(err.Error(), tc.wantErrorContains) {
				t.Fatalf("expected error to contain %q, got %q", tc.wantErrorContains, err.Error())
			}
		})
	}
}

func TestServiceHealth_EdgeCases(t *testing.T) {
	testCases := []struct {
		name              string
		sidecarErr        error
		wantErrorContains string
		wantErrorIs       error
	}{
		{
			name: "success",
		},
		{
			name:              "unavailable wraps ErrSidecarUnavailable",
			sidecarErr:        status.Error(codes.Unavailable, "dial timeout"),
			wantErrorContains: "dial timeout",
			wantErrorIs:       ErrSidecarUnavailable,
		},
		{
			name:              "unexpected error is wrapped with health prefix",
			sidecarErr:        errors.New("boom"),
			wantErrorContains: "sidecar health: boom",
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			var gotReq *umbralpb.HealthRequest

			svc := newServiceForTest(&sidecarStub{
				healthFn: func(_ context.Context, req *umbralpb.HealthRequest, _ ...grpc.CallOption) (*umbralpb.HealthResponse, error) {
					gotReq = req
					return &umbralpb.HealthResponse{Healthy: true}, tc.sidecarErr
				},
			})

			err := svc.Health(context.Background())

			if gotReq == nil {
				t.Fatal("expected Health request to be forwarded")
			}

			if tc.sidecarErr == nil {
				if err != nil {
					t.Fatalf("expected nil error, got %v", err)
				}
				return
			}

			if err == nil {
				t.Fatal("expected non-nil error")
			}
			if tc.wantErrorIs != nil && !errors.Is(err, tc.wantErrorIs) {
				t.Fatalf("expected wrapped error %v, got %v", tc.wantErrorIs, err)
			}
			if tc.wantErrorContains != "" && !strings.Contains(err.Error(), tc.wantErrorContains) {
				t.Fatalf("expected error to contain %q, got %q", tc.wantErrorContains, err.Error())
			}
		})
	}
}

func TestClientClose_NilConnectionIsNoop(t *testing.T) {
	c := &client{}
	if err := c.Close(); err != nil {
		t.Fatalf("expected nil close error for nil connection, got %v", err)
	}
}
