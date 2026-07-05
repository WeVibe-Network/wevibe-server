// Package wlog is the wevibe-hub structured-logging helper (pre-alpha observability, R-37).
// One slog-based path: every operation logs op + trace + attrs. Fingerprints only — never raw keys.
package wlog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net/http"
	"os"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

// TraceHeader is the HTTP header carrying the correlation id across services.
// It is a HEADER only — NEVER part of any signed body.
const TraceHeader = "X-WeVibe-Trace-Id"

// metadataTraceKey is the lowercase gRPC-metadata form of the trace header.
const metadataTraceKey = "x-wevibe-trace-id"

type ctxKey struct{}

var traceCtxKey = ctxKey{}

// Init installs the default JSON slog handler to stdout. Call once from main().
func Init() {
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	slog.SetDefault(slog.New(h))
}

// Op emits one structured operation log line: op + trace (from ctx) + the given attrs.
func Op(ctx context.Context, op string, level slog.Level, attrs ...slog.Attr) {
	base := []slog.Attr{slog.String("op", op), slog.String("trace", TraceFromContext(ctx))}
	slog.Default().LogAttrs(ctx, level, op, append(base, attrs...)...)
}

// Fingerprint returns the first 8 hex chars of sha256(b) as a safe key/identity fingerprint.
// Returns "" for nil/empty input. NEVER pass plaintext/ciphertext bodies — keys/identities only.
func Fingerprint(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])[:8]
}

// WithTrace stores a trace id on the context.
func WithTrace(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, traceCtxKey, id)
}

// TraceFromContext reads the trace id from the context ("" if absent).
func TraceFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if v, ok := ctx.Value(traceCtxKey).(string); ok {
		return v
	}
	return ""
}

// TraceID is chi/net-http middleware: reads X-WeVibe-Trace-Id (generates one if absent)
// and stores it on the request context for every downstream handler and log line.
func TraceID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(TraceHeader)
		if id == "" {
			id = uuid.NewString()
		}
		ctx := WithTrace(r.Context(), id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// UnaryClientInterceptor propagates the ctx trace id onto outbound gRPC metadata
// (x-wevibe-trace-id) so downstream services (umbral sidecar) can correlate.
func UnaryClientInterceptor() grpc.UnaryClientInterceptor {
	return func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		if id := TraceFromContext(ctx); id != "" {
			ctx = metadata.AppendToOutgoingContext(ctx, metadataTraceKey, id)
		}
		return invoker(ctx, method, req, reply, cc, opts...)
	}
}
