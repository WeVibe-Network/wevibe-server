package handlers

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

func TestResolveRecallGovernor(t *testing.T) {
	withRecallMode := func(mode string, fn func(t *testing.T)) {
		t.Helper()
		prev := recallMode
		SetRecallMode(mode)
		t.Cleanup(func() { SetRecallMode(prev) })
		fn(t)
	}

	t.Run("prod mode defaults both nil", func(t *testing.T) {
		withRecallMode("prod", func(t *testing.T) {
			floor, budget, defaulted := resolveRecallGovernor(nil, nil)
			if floor != 0.55 || budget != 3 {
				t.Fatalf("unexpected defaults: floor=%v budget=%d", floor, budget)
			}
			want := []string{"relevance_floor", "surface_budget"}
			if !reflect.DeepEqual(defaulted, want) {
				t.Fatalf("unexpected defaulted fields: got=%v want=%v", defaulted, want)
			}
		})
	})

	t.Run("test mode defaults both nil", func(t *testing.T) {
		withRecallMode("test", func(t *testing.T) {
			floor, budget, defaulted := resolveRecallGovernor(nil, nil)
			if floor != 0 || budget != 1000 {
				t.Fatalf("unexpected test defaults: floor=%v budget=%d", floor, budget)
			}
			want := []string{"relevance_floor", "surface_budget"}
			if !reflect.DeepEqual(defaulted, want) {
				t.Fatalf("unexpected defaulted fields: got=%v want=%v", defaulted, want)
			}
		})
	})

	t.Run("explicit zeroes honored", func(t *testing.T) {
		withRecallMode("test", func(t *testing.T) {
			zeroF := 0.0
			zeroB := 0
			floor, budget, defaulted := resolveRecallGovernor(&zeroF, &zeroB)
			if floor != 0 || budget != 0 {
				t.Fatalf("explicit zeroes not honored: floor=%v budget=%d", floor, budget)
			}
			if len(defaulted) != 0 {
				t.Fatalf("expected no defaulted fields, got=%v", defaulted)
			}
		})
	})

	t.Run("explicit non-zero honored", func(t *testing.T) {
		withRecallMode("prod", func(t *testing.T) {
			f := 0.7
			b := 5
			floor, budget, defaulted := resolveRecallGovernor(&f, &b)
			if floor != 0.7 || budget != 5 {
				t.Fatalf("explicit values not honored: floor=%v budget=%d", floor, budget)
			}
			if len(defaulted) != 0 {
				t.Fatalf("expected no defaulted fields, got=%v", defaulted)
			}
		})
	})

	t.Run("per-field independence", func(t *testing.T) {
		withRecallMode("prod", func(t *testing.T) {
			f := 0.7
			floor, budget, defaulted := resolveRecallGovernor(&f, nil)
			if floor != 0.7 || budget != 3 {
				t.Fatalf("unexpected effective values: floor=%v budget=%d", floor, budget)
			}
			want := []string{"surface_budget"}
			if !reflect.DeepEqual(defaulted, want) {
				t.Fatalf("unexpected defaulted fields: got=%v want=%v", defaulted, want)
			}
		})
	})
}

func TestQueryRequestJSONPresenceForGovernorFields(t *testing.T) {
	t.Run("empty object leaves pointers nil", func(t *testing.T) {
		var req protocol.QueryRequest
		if err := json.Unmarshal([]byte(`{}`), &req); err != nil {
			t.Fatalf("unmarshal failed: %v", err)
		}
		if req.RelevanceFloor != nil || req.SurfaceBudget != nil {
			t.Fatalf("expected nil pointers, got floor=%v budget=%v", req.RelevanceFloor, req.SurfaceBudget)
		}
	})

	t.Run("explicit zeroes produce non-nil pointers", func(t *testing.T) {
		var req protocol.QueryRequest
		if err := json.Unmarshal([]byte(`{"relevance_floor":0,"surface_budget":0}`), &req); err != nil {
			t.Fatalf("unmarshal failed: %v", err)
		}
		if req.RelevanceFloor == nil || req.SurfaceBudget == nil {
			t.Fatalf("expected non-nil pointers, got floor=%v budget=%v", req.RelevanceFloor, req.SurfaceBudget)
		}
		if *req.RelevanceFloor != 0 || *req.SurfaceBudget != 0 {
			t.Fatalf("expected zero values, got floor=%v budget=%d", *req.RelevanceFloor, *req.SurfaceBudget)
		}
	})

	t.Run("single field presence stays independent", func(t *testing.T) {
		var req protocol.QueryRequest
		if err := json.Unmarshal([]byte(`{"relevance_floor":0.55}`), &req); err != nil {
			t.Fatalf("unmarshal failed: %v", err)
		}
		if req.RelevanceFloor == nil || req.SurfaceBudget != nil {
			t.Fatalf("expected floor non-nil and budget nil, got floor=%v budget=%v", req.RelevanceFloor, req.SurfaceBudget)
		}
		if *req.RelevanceFloor != 0.55 {
			t.Fatalf("unexpected floor value: %v", *req.RelevanceFloor)
		}
	})
}
