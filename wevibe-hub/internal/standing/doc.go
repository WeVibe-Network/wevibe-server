// Package standing derives per-memory standing from recall events and a
// versioned edge policy.
//
// Boundary rule: standing is derived, rebuildable edge state. It is never
// written to chain; chain stores the ordered events that allow standing to be
// recomputed under an explicit policy version.
package standing
