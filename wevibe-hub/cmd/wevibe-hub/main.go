package main

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/api/handlers"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/config"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/db"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/hubsign"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/notifications"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/social"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/umbral"
)

func corsOrigins() []string {
	env := os.Getenv("CORS_ALLOWED_ORIGINS")
	if env == "" {
		return []string{"http://*", "https://*"}
	}
	origins := strings.Split(env, ",")
	for i := range origins {
		origins[i] = strings.TrimSpace(origins[i])
	}
	return origins
}

func main() {
	cfg := config.Load()
	retrievalRanker := &retrieval.ProbabilisticRanker{
		Temperature:       cfg.RetrievalTemperature,
		NewMemBoostMult:   cfg.RetrievalNewMemBoostMult,
		NewMemBoostWindow: cfg.RetrievalNewMemBoostWindow,
		GraceEpochs:       20,
		RNG:               rand.New(rand.NewSource(time.Now().UnixNano())),
	}
	retrieval.SetRetrievalRanker(retrievalRanker)
	log.Printf("retrieval ranker configured: T=%.2f boost=%.2f window=%d",
		retrievalRanker.Temperature, retrievalRanker.NewMemBoostMult, retrievalRanker.NewMemBoostWindow)
	log.Printf("retrieval vector knobs configured: sigma=%.4f recall_depth=%d",
		cfg.RetrievalVectorNoiseSigma, cfg.RetrievalRecallDepth)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	responseSigner, err := hubsign.NewFromEnv()
	if err != nil {
		log.Fatalf("FATAL: hub response signer init: %v", err)
	}
	handlers.SetResponsePubkeyHex(responseSigner.PublicKeyHex())

	if err := db.ApplySchema(cfg.DatabaseURL); err != nil {
		log.Fatalf("FATAL: schema apply failed: %v", err)
	}

	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("FATAL: database connection failed: %v", err)
	}
	defer pool.Close()
	handlers.SetPool(pool)

	var chainClient *chain.GrpcClient
	if !cfg.ChainEnabled {
		log.Fatalf("FATAL: WEVIBE_CHAIN_ENABLED must be true — chain is the sole content store")
	}
	if cfg.ChainGRPCURL == "" || cfg.ChainID == "" || cfg.ChainSubmitterMnemonic == "" {
		log.Fatalf("FATAL: chain config incomplete — WEVIBE_CHAIN_GRPC_URL, WEVIBE_CHAIN_ID, and WEVIBE_CHAIN_SUBMITTER_MNEMONIC are all required")
	}
	chainClient, err = chain.NewGrpcClient(cfg.ChainGRPCURL, cfg.ChainID, cfg.ChainSubmitterMnemonic)
	if err != nil {
		log.Fatalf("FATAL: chain client: %v", err)
	}
	defer chainClient.Close()
	log.Printf("chain client initialized for chain %s, submitter %s", cfg.ChainID, chainClient.SubmitterAddress())

	handlers.SetChainClient(chainClient)
	handlers.SetFaucetURL(cfg.FaucetURL)
	handlers.SetSocialClient(social.NewClient(cfg.SocialGraphURL))

	umbralClient, err := umbral.NewClient(cfg.UmbralSidecarAddr)
	if err != nil {
		log.Fatalf("FATAL: umbral sidecar client: %v", err)
	}
	umbralService := umbral.NewService(umbralClient)
	handlers.SetUmbralService(umbralService)
	log.Printf("umbral service initialized (sidecar at %s)", cfg.UmbralSidecarAddr)

	qdrantClient, err := retrieval.NewQdrantClient(cfg.QdrantAddr, cfg.QdrantAPIKey)
	if err != nil {
		log.Printf("WARNING: qdrant unavailable: %v", err)
	} else {
		qdrantClient.SetRetrievalConfig(cfg.RetrievalVectorNoiseSigma, cfg.RetrievalRecallDepth)
		qdrantClient.SetPendingDenialDB(pool)
		defer qdrantClient.Close()
		handlers.SetQdrantClient(qdrantClient)
	}

	if qdrantClient != nil {
		if err := chain.SyncEpochData(ctx, chainClient, qdrantClient, pool); err != nil {
			log.Printf("WARNING: startup SyncEpochData failed: %v — hub will retry on the next epoch tick", err)
		}
		if err := chain.SyncKeywordWeightsFromChain(ctx, chainClient, qdrantClient, pool); err != nil {
			log.Printf("WARNING: SyncKeywordWeightsFromChain failed: %v — hub will operate with potentially stale keyword weights; the next serve/denial TX will update individual memories", err)
		}
	} else {
		log.Printf("WARNING: skipping startup chain syncs — qdrant client unavailable")
	}

	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := chain.SyncEpochData(ctx, chainClient, qdrantClient, pool); err != nil {
					log.Printf("ERROR: epoch sync failed: %v", err)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	handlers.SetNodePrivkey(cfg.NodePrivkey)

	notifHub := notifications.NewHub()
	handlers.SetNotificationHub(notifHub)
	prefStore := notifications.NewPreferenceStore(pool)
	notificationDispatcher := notifications.NewDispatcher(prefStore, slog.Default())
	if smtpChannel, enabled, smtpErr := notifications.NewSMTPChannelFromEnv(); smtpErr != nil {
		log.Printf("WARNING: smtp channel disabled: %v", smtpErr)
	} else if enabled {
		notificationDispatcher.Register(smtpChannel)
	}
	notificationDispatcher.Register(notifications.NewWebhookChannel())
	handlers.SetNotificationDispatcher(notificationDispatcher)

	txDecoder := chain.BuildTxDecoder(chainClient.GetCodec())
	watcher := chain.NewChainWatcher(chainClient, pool, slog.Default(), txDecoder, notifHub, qdrantClient, cfg.OllamaURL)
	watcher.SetDispatcher(notificationDispatcher)
	go func() {
		if err := watcher.Start(ctx); err != nil {
			log.Printf("ERROR: chain watcher exited: %v", err)
		}
	}()

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	allowedOrigins := corsOrigins()
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		ExposedHeaders:   []string{hubsign.SignatureHeader},
		AllowCredentials: false,
		MaxAge:           300,
	}))
	r.Use(hubsign.SigningMiddleware(responseSigner))

	r.Get("/health", handlers.Health)

	r.Get("/v1/members/{pubkey}/orgs", handlers.GetMemberOrgs)
	r.Get("/v1/profile/notifications", handlers.GetNotificationPreferences)
	r.Patch("/v1/profile/notifications", handlers.UpdateNotificationPreferences)
	r.Get("/v1/profile/{wallet}", handlers.GetProfile)

	r.Get("/v1/notifications", handlers.ListNotifications)
	r.Get("/v1/notifications/unread-count", handlers.GetUnreadCount)
	r.Post("/v1/notifications/mark-read", handlers.MarkRead)
	r.Get("/v1/notifications/ws", handlers.NotificationWebSocket)

	r.Post("/v1/orgs", handlers.CreateOrg)
	r.Post("/v1/identity/blob", handlers.StoreIdentityBlob)
	r.Get("/v1/identity/blob/{credentialId}", handlers.GetIdentityBlob)
	r.Post("/v1/pair", handlers.StorePairingBlob)
	r.Get("/v1/pair/{pairingId}", handlers.GetPairingBlob)
	r.Get("/v1/hub/serving-address", handlers.GetServingAddress)
	r.Get("/v1/extraction-presets", handlers.GetExtractionPresets)
	r.Get("/v1/balance/{address}", handlers.GetBalance)
	r.Post("/v1/faucet/fund", handlers.FundFromFaucet)
	r.Get("/v1/orgs/discover", handlers.DiscoverOrgs)

	r.Route("/v1/orgs/{orgID}", func(r chi.Router) {
		// Public org-scoped reads (no membership required)
		r.Get("/", handlers.GetOrg)
		r.Get("/extraction-profile", handlers.GetExtractionProfile)
		r.Post("/join", handlers.SubmitJoinRequest)
		r.Get("/epoch/{epochID}/manifest", handlers.GetEpochManifest)
		r.Put("/extraction-profile", handlers.SetExtractionProfile)

		// Membership-required routes
		r.Group(func(r chi.Router) {
			r.Use(auth.RequireOrgMembership(handlers.GetPool()))

			r.Patch("/config", handlers.UpdateOrgConfig)
			r.Post("/epoch/rotate", handlers.RotateEpoch)

			r.Post("/members", handlers.InviteMember)
			r.Get("/members", handlers.ListMembers)
			r.Get("/members/{pubkey}", handlers.GetMember)
			r.Post("/members/{pubkey}/enable-recall", handlers.EnableMemberRecall)
			r.Post("/members/{pubkey}/pre-key", handlers.RegisterPreKey)
			r.Get("/members/{pubkey}/pre-key", handlers.GetPreKey)
			r.Delete("/members/{pubkey}", handlers.RemoveMember)
			r.Patch("/members/{pubkey}/role", handlers.UpdateMemberRole)
			r.Post("/members/wallet", handlers.LinkWallet)
			r.Get("/keys/envelope", handlers.GetKeyEnvelope)

			r.Post("/dashboard/keys", handlers.RegisterDashboardKey)
			r.Delete("/dashboard/keys/{pubkey}", handlers.RevokeDashboardKey)

			r.Post("/recovery/shares", handlers.StoreRecoveryShares)
			r.Get("/recovery/shares", handlers.GetRecoveryShare)

			r.Post("/submit", handlers.SubmitMemory)
			r.Post("/submit/batch", handlers.SubmitMemoryBatch)
			r.Route("/reports", func(r chi.Router) {
				r.Post("/", handlers.CreateReport)
				r.Get("/", handlers.ListReports)
				r.Get("/{reportID}", handlers.GetReport)
				r.Patch("/{reportID}", handlers.UpdateReport)
				r.Post("/{reportID}/vote", handlers.VoteOnReport)
				r.Post("/{reportID}/commit", handlers.CommitReport)
			})

			r.Get("/moderation/queue", handlers.GetPendingQueue)
			r.Get("/moderation/history", handlers.GetModerationHistory)
			r.Post("/moderation/{submissionHash}/vote", handlers.VoteOnSubmission)
			r.Post("/moderation/{submissionHash}/approve", handlers.ApproveSubmission)
			r.Post("/moderation/{submissionHash}/deny", handlers.DenySubmission)
			r.Post("/moderation/{submissionHash}/undo-approve", handlers.UndoApproveSubmission)
			r.Post("/moderation/batch-submit", handlers.BatchSubmitToChain)

			r.Post("/serves", handlers.RecordServeEvent)
			r.Post("/denials", handlers.RecordDenialEvent)
			r.Get("/denials/pending-count", handlers.GetPendingDenialCount)
			r.Get("/denials/pending", handlers.GetPendingDenials)

			r.Post("/query", handlers.QueryMemories)
			r.Get("/memories", handlers.ListMemories)
			r.Get("/memories/{cid}", handlers.GetMemory)

			r.Get("/keywords", handlers.ListKeywords)
			r.Post("/keywords", handlers.AddKeyword)
			r.Put("/keywords/merge", handlers.MergeKeywords)
			r.Put("/keywords/{keyword}/rename", handlers.RenameKeyword)
			r.Delete("/keywords/{keyword}", handlers.DeprecateKeyword)

			r.Post("/submit-keyword-results", handlers.SubmitKeywordResults)
			r.Post("/verify-keywords", handlers.VerifyKeywords)
			r.Post("/submissions/{hash}/rerun-keywords", handlers.RerunKeywords)
			r.Put("/submissions/{hash}/update-keywords", handlers.UpdateKeywords)
			r.Delete("/submissions/{hash}", handlers.RemoveSubmission)
			r.Get("/submissions", handlers.ListSubmissions)
			r.Get("/my-submissions", handlers.ListMySubmissions)

			r.Get("/health", handlers.OrgHealth)

			r.Get("/credits", handlers.GetOrgCredits)
			r.Get("/finances", handlers.GetOrgFinances)
			r.Get("/chain-config", handlers.GetOrgChainConfig)
			r.Post("/transfer-leadership", handlers.TransferLeadership)
			r.Post("/close", handlers.CloseOrg)

			r.Get("/join-requests", handlers.ListJoinRequests)
			r.Post("/join-requests/{requestID}/approve", handlers.ApproveJoinRequest)
			r.Post("/join-requests/{requestID}/deny", handlers.DenyJoinRequest)
		})
	})

	r.Post("/v1/billing/topup", handlers.TopUpCredits)

	if os.Getenv("WEVIBE_TEST_MODE") == "true" {
		log.Printf("TEST MODE ENABLED — test endpoints registered at /v1/test/*")
		r.Get("/v1/test/health", handlers.TestHealth)

		r.Post("/v1/test/embed", handlers.TestEmbed)
		r.Get("/v1/test/orgs/{orgID}/queue", handlers.TestGetQueue)
		r.Get("/v1/test/orgs/{orgID}/serve-queue", handlers.TestServeQueueDepth)
	}

	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("wevibe-hub starting on %s", addr)
	if err := http.ListenAndServe(addr, r); err != nil {
		log.Fatalf("wevibe-hub: %v", err)
	}
}
