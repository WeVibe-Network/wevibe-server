package auth

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

type contextKey string

const MemberPubkeyKey contextKey = "memberPubkey"
const MemberOrgIDKey contextKey = "memberOrgID"

const signedTimestampWindow = 5 * time.Minute

var errTimestampOutOfWindow = errors.New("timestamp expired or too far in future")

func RequireVerifiedIdentity() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			signed, err := verifySignedIdentity(r)
			if err != nil {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), MemberPubkeyKey, signed.Pubkey)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func RequireVerifiedMembership(pool *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			signed, err := verifySignedIdentity(r)
			if err != nil {
				http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
				return
			}

			orgID := chi.URLParam(r, "orgID")
			if orgID == "" {
				http.Error(w, `{"error":"missing org ID"}`, http.StatusBadRequest)
				return
			}

			var exists bool
			err = pool.QueryRow(r.Context(),
				"SELECT EXISTS(SELECT 1 FROM members WHERE org_id = $1 AND pubkey = $2 AND active = true)",
				orgID, signed.Pubkey).Scan(&exists)
			if err != nil {
				http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
				return
			}
			if !exists {
				http.Error(w, `{"error":"not a member of this org"}`, http.StatusForbidden)
				return
			}

			ctx := context.WithValue(r.Context(), MemberPubkeyKey, signed.Pubkey)
			ctx = context.WithValue(ctx, MemberOrgIDKey, orgID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func verifySignedIdentity(r *http.Request) (*SignedTimestampAuth, error) {
	signed, err := ParseWeVibeSigned(r)
	if err != nil {
		return nil, err
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	if now.Sub(ts) > signedTimestampWindow || ts.Sub(now) > signedTimestampWindow {
		return nil, errTimestampOutOfWindow
	}

	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		return nil, err
	}

	return signed, nil
}

func GetMemberPubkey(ctx context.Context) string {
	v, _ := ctx.Value(MemberPubkeyKey).(string)
	return v
}

func GetMemberOrgID(ctx context.Context) string {
	v, _ := ctx.Value(MemberOrgIDKey).(string)
	return v
}
