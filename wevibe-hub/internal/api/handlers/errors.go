package handlers

import (
	"encoding/json"
	"net/http"
)

type ErrorEnvelope struct {
	Error  string `json:"error"`
	Code   string `json:"code"`
	Detail string `json:"detail,omitempty"`
}

// WriteError writes the canonical hub error envelope; handlers should prefer
// this over using http.Error with a raw JSON string body.
func WriteError(w http.ResponseWriter, status int, code, message string, detail ...string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	env := ErrorEnvelope{Error: message, Code: code}
	if len(detail) > 0 && detail[0] != "" {
		env.Detail = detail[0]
	}

	_ = json.NewEncoder(w).Encode(env)
}
