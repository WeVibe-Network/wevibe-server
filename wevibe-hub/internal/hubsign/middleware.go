package hubsign

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"strconv"
)

func SigningMiddleware(signer *Signer) func(http.Handler) http.Handler {
	if signer == nil {
		panic("hubsign: signer is required")
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			recorder := newBufferingResponseWriter(w)
			next.ServeHTTP(recorder, r)

			if recorder.hijacked {
				return
			}

			status := recorder.statusCode()
			body := recorder.body.Bytes()
			bodyForClient := body
			if !responseAllowsBody(r.Method, status) {
				if r.Method == http.MethodHead && recorder.header.Get("Content-Length") == "" {
					recorder.header.Set("Content-Length", strconv.Itoa(len(body)))
				}
				bodyForClient = nil
			}

			signature := signer.SignBody(bodyForClient)

			copyHeaders(w.Header(), recorder.header)
			w.Header().Set(SignatureHeader, hex.EncodeToString(signature))

			w.WriteHeader(status)
			if len(bodyForClient) == 0 {
				return
			}
			_, _ = w.Write(bodyForClient)
		})
	}
}

func responseAllowsBody(method string, status int) bool {
	if method == http.MethodHead {
		return false
	}
	if status >= 100 && status <= 199 {
		return false
	}
	return status != http.StatusNoContent && status != http.StatusNotModified
}

type bufferingResponseWriter struct {
	real        http.ResponseWriter
	header      http.Header
	body        bytes.Buffer
	status      int
	wroteHeader bool
	hijacked    bool
}

func newBufferingResponseWriter(real http.ResponseWriter) *bufferingResponseWriter {
	return &bufferingResponseWriter{
		real:   real,
		header: make(http.Header),
		status: http.StatusOK,
	}
}

func (w *bufferingResponseWriter) Header() http.Header {
	return w.header
}

func (w *bufferingResponseWriter) WriteHeader(statusCode int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	w.status = statusCode
}

func (w *bufferingResponseWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if len(p) > 0 && w.header.Get("Content-Type") == "" && w.header.Get("Transfer-Encoding") == "" {
		w.header.Set("Content-Type", http.DetectContentType(p))
	}
	return w.body.Write(p)
}

func (w *bufferingResponseWriter) statusCode() int {
	return w.status
}

func (w *bufferingResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.real.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("underlying response writer does not support hijacking")
	}
	w.hijacked = true
	return hijacker.Hijack()
}

func (w *bufferingResponseWriter) Flush() {
	// Buffered middleware writes once after handler completion.
}

func (w *bufferingResponseWriter) Push(target string, opts *http.PushOptions) error {
	pusher, ok := w.real.(http.Pusher)
	if !ok {
		return http.ErrNotSupported
	}
	return pusher.Push(target, opts)
}

func copyHeaders(dst, src http.Header) {
	for key, values := range src {
		dst.Del(key)
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}
