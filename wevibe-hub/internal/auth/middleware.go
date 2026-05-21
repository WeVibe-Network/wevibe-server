package auth

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type contextKey string

const MemberPubkeyKey contextKey = "memberPubkey"
const MemberOrgIDKey contextKey = "memberOrgID"

func RequireOrgMembership(pool *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			orgID := chi.URLParam(r, "orgID")
			if orgID == "" {
				http.Error(w, `{"error":"missing org ID"}`, http.StatusBadRequest)
				return
			}

			auth, err := ParseWeVibeSigned(r)
			if err != nil {
				http.Error(w, `{"error":"authentication required"}`, http.StatusUnauthorized)
				return
			}

			var exists bool
			err = pool.QueryRow(r.Context(),
				"SELECT EXISTS(SELECT 1 FROM members WHERE org_id = $1 AND pubkey = $2 AND active = true)",
				orgID, auth.Pubkey).Scan(&exists)
			if err != nil {
				http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
				return
			}
			if !exists {
				http.Error(w, `{"error":"not a member of this org"}`, http.StatusForbidden)
				return
			}

			ctx := context.WithValue(r.Context(), MemberPubkeyKey, auth.Pubkey)
			ctx = context.WithValue(ctx, MemberOrgIDKey, orgID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func GetMemberPubkey(ctx context.Context) string {
	v, _ := ctx.Value(MemberPubkeyKey).(string)
	return v
}

func GetMemberOrgID(ctx context.Context) string {
	v, _ := ctx.Value(MemberOrgIDKey).(string)
	return v
}