// Generated bindings — orchestrator will run `wrangler types` to refresh.
/// <reference types="@cloudflare/workers-types" />

interface Env {
	DB: D1Database
	CACHE: KVNamespace
	SITES_DATA_KV: KVNamespace
	CHAT_ORG: DurableObjectNamespace
	ASSETS?: Fetcher

	NODE_ENV: string
	ALLOW_INDEXING: string
	LAUNCH_STATUS: string
	CREDIT_CARD_REQUIRED_FOR_TRIAL: string
	TRIAL_DAYS: string
	SSO_ENABLED: string
	AWS_REGION: string
	AWS_ENDPOINT_URL_S3: string
	BUCKET_NAME: string
	BASE_URL: string
	ROOT_APP: string
	PUBLIC_SITE_HOST_SUFFIXES?: string
	TENANT_API_URL: string
	TENANT_API_URL_KSA: string
	POSTHOG_HOST?: string

	// Secrets (set via `wrangler secret put <NAME>`)
	SESSION_SECRET?: string
	HONEYPOT_SECRET?: string
	RESEND_API_KEY?: string
	STRIPE_SECRET_KEY?: string
	STRIPE_WEBHOOK_SECRET?: string
	POLAR_ACCESS_TOKEN?: string
	POLAR_ORGANIZATION_ID?: string
	POLAR_SERVER?: string
	POLAR_WEBHOOK_SECRET?: string
	CHECKOUT_SECRET_KEY?: string
	CHECKOUT_PUBLIC_KEY?: string
	CHECKOUT_SUBDOMAIN?: string
	CHECKOUT_PROCESSING_CHANNEL_ID?: string
	CHECKOUT_ENVIRONMENT?: string
	CHECKOUT_WEBHOOK_SECRET?: string
	INTERNAL_COMMAND_TOKEN?: string
	TENANT_OPERATOR_TOKEN?: string
	AWS_ACCESS_KEY_ID?: string
	AWS_SECRET_ACCESS_KEY?: string
	JWT_SECRET?: string
	INTEGRATION_ENCRYPTION_KEY?: string
	INTEGRATIONS_OAUTH_STATE_SECRET?: string
	SSO_ENCRYPTION_KEY?: string
	POSTHOG_PROJECT_TOKEN?: string
}
