package notifications

import "context"

type PushChannel struct{}

func NewPushChannel() *PushChannel {
	return &PushChannel{}
}

func (p *PushChannel) Name() string {
	return "push"
}

func (p *PushChannel) Dispatch(ctx context.Context, prefs UserPreferences, event DispatchEvent) error {
	// Push dispatch is a no-op until device token persistence exists.
	return nil
}
