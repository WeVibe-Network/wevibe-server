package auth

import (
	"errors"
	"net/http"
	"strings"
)

type SignedTimestampAuth struct {
	Pubkey    string
	Timestamp string
	Signature string
}

var (
	ErrMissingHeader = errors.New("missing Authorization header")
	ErrInvalidScheme = errors.New("authorization scheme must be WeVibe-Signed")
	ErrMalformedAuth = errors.New("malformed WeVibe-Signed authorization header")
)

func ParseWeVibeSigned(r *http.Request) (*SignedTimestampAuth, error) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return nil, ErrMissingHeader
	}

	const prefix = "WeVibe-Signed "
	if !strings.HasPrefix(header, prefix) {
		return nil, ErrInvalidScheme
	}

	credentials := header[len(prefix):]
	if credentials == "" {
		return nil, ErrMalformedAuth
	}

	parts := strings.Split(credentials, ",")
	if len(parts) != 3 {
		return nil, ErrMalformedAuth
	}

	pubkey, err := extractField(parts[0], "pubkey")
	if err != nil {
		return nil, ErrMalformedAuth
	}
	timestamp, err := extractField(parts[1], "timestamp")
	if err != nil {
		return nil, ErrMalformedAuth
	}
	signature, err := extractField(parts[2], "signature")
	if err != nil {
		return nil, ErrMalformedAuth
	}

	return &SignedTimestampAuth{
		Pubkey:    pubkey,
		Timestamp: timestamp,
		Signature: signature,
	}, nil
}

func extractField(field, expectedKey string) (string, error) {
	idx := strings.Index(field, "=")
	if idx < 0 {
		return "", errors.New("missing =")
	}
	key := field[:idx]
	value := field[idx+1:]
	if key != expectedKey || value == "" {
		return "", errors.New("invalid field")
	}
	return value, nil
}
