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
	// TODO: implement mobile push dispatch via FCM/APNs when device token storage is available.
	return nil
}
