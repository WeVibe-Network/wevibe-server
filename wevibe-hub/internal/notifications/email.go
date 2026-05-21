package notifications

import (
	"context"
	"fmt"
	"net"
	"net/smtp"
	"os"
	"strings"
	"sync"
	"time"
)

const emailRateLimitPerHour = 10

type SMTPChannel struct {
	host string
	port string
	user string
	pass string
	from string

	mu          sync.Mutex
	recentSends map[string][]time.Time
}

func NewSMTPChannelFromEnv() (*SMTPChannel, bool, error) {
	host := strings.TrimSpace(os.Getenv("WEVIBE_SMTP_HOST"))
	port := strings.TrimSpace(os.Getenv("WEVIBE_SMTP_PORT"))
	user := strings.TrimSpace(os.Getenv("WEVIBE_SMTP_USER"))
	pass := strings.TrimSpace(os.Getenv("WEVIBE_SMTP_PASS"))
	from := strings.TrimSpace(os.Getenv("WEVIBE_SMTP_FROM"))

	if host == "" || port == "" || user == "" || pass == "" || from == "" {
		return nil, false, nil
	}

	return &SMTPChannel{
		host:        host,
		port:        port,
		user:        user,
		pass:        pass,
		from:        from,
		recentSends: make(map[string][]time.Time),
	}, true, nil
}

func (s *SMTPChannel) Name() string {
	return "email"
}

func (s *SMTPChannel) Dispatch(ctx context.Context, prefs UserPreferences, event DispatchEvent) error {
	if !s.allowSend(prefs.RecipientPubkey) {
		return nil
	}

	subject, body := renderEmailTemplate(event)
	msg := strings.Join([]string{
		"From: " + s.from,
		"To: " + prefs.EmailAddress,
		"Subject: " + subject,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"",
		body,
	}, "\r\n")

	addr := net.JoinHostPort(s.host, s.port)
	auth := smtp.PlainAuth("", s.user, s.pass, s.host)

	errCh := make(chan error, 1)
	go func() {
		errCh <- smtp.SendMail(addr, auth, s.from, []string{prefs.EmailAddress}, []byte(msg))
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errCh:
		return err
	}
}

func (s *SMTPChannel) allowSend(pubkey string) bool {
	now := time.Now()
	cutoff := now.Add(-1 * time.Hour)

	s.mu.Lock()
	defer s.mu.Unlock()

	history := s.recentSends[pubkey]
	filtered := history[:0]
	for _, sentAt := range history {
		if sentAt.After(cutoff) {
			filtered = append(filtered, sentAt)
		}
	}

	if len(filtered) >= emailRateLimitPerHour {
		s.recentSends[pubkey] = filtered
		return false
	}

	filtered = append(filtered, now)
	s.recentSends[pubkey] = filtered
	return true
}

func renderEmailTemplate(event DispatchEvent) (string, string) {
	orgLabel := event.OrgName
	if orgLabel == "" {
		orgLabel = event.OrgID
	}
	if orgLabel == "" {
		orgLabel = "your organization"
	}

	subject := "WeVibe notification"
	body := fmt.Sprintf("%s\n\n%s", event.Title, event.Body)

	switch event.Category {
	case "chain_commit_involving_you":
		subject = "WeVibe: chain commit involving you"
	case "report_upheld_committed":
		subject = "WeVibe: report upheld on chain"
	case "your_approval_was_overturned":
		subject = "WeVibe: approved memory overturned"
	case "join_request_received":
		subject = "WeVibe: new join request"
	case "join_approved":
		subject = "WeVibe: join request approved"
	case "join_denied":
		subject = "WeVibe: join request denied"
	case "test_notification":
		subject = "WeVibe: test notification"
	}

	body = fmt.Sprintf("%s\n\nOrg: %s\nCategory: %s\nEvent: %s\n", event.Body, orgLabel, event.Category, event.EventRef)
	return subject, body
}
