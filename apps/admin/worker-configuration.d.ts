/// <reference types="@cloudflare/workers-types" />

interface Env {
	DB: D1Database
	CACHE: KVNamespace
	ASSETS: Fetcher
	/** Service binding to the App Worker (see `app/utils/app-service.server.ts`). */
	APP?: Fetcher
	NODE_ENV: string
	ALLOW_INDEXING: string
	BASE_URL: string
	ROOT_APP: string
	LAUNCH_STATUS: string
	TRIAL_DAYS: string
	CREDIT_CARD_REQUIRED_FOR_TRIAL: string
	AWS_REGION: string
	AWS_ENDPOINT_URL_S3: string
	BUCKET_NAME: string
	AWS_ACCESS_KEY_ID: string
	GITHUB_CLIENT_ID: string
	STRIPE_PORTAL_URL: string
	SESSION_SECRET: string
	HONEYPOT_SECRET: string
	INTERNAL_COMMAND_TOKEN: string
	SSO_ENCRYPTION_KEY: string
	AUDIT_LOG_SECRET_KEY: string
	RESEND_API_KEY: string
	STRIPE_SECRET_KEY: string
	AWS_SECRET_ACCESS_KEY: string
	GITHUB_CLIENT_SECRET: string
	GITHUB_TOKEN: string
	BETTERSTACK_API_KEY: string
}
