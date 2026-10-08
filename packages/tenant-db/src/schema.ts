import {
	sqliteTable,
	text,
	integer,
	index,
	uniqueIndex,
	primaryKey,
} from 'drizzle-orm/sqlite-core'
import { sql, relations } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

// ==========================================
// 1. CUSTOMERS TABLE
// ==========================================
export const customers = sqliteTable('customers', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	name: text('name').notNull(),
	email: text('email'),
	phone: text('phone').unique(),
	phoneVerified: integer('phone_verified', { mode: 'boolean' }).default(false),
	phoneVerificationCode: text('phone_verification_code'),
	phoneVerificationExpiresAt: integer('phone_verification_expires_at', {
		mode: 'timestamp',
	}),
	refreshTokenHash: text('refresh_token_hash'),
	refreshTokenExpiresAt: integer('refresh_token_expires_at', {
		mode: 'timestamp',
	}),
	stripeCustomerId: text('stripe_customer_id').unique(),
	createdAt: integer('created_at', { mode: 'timestamp' }).default(
		sql`(strftime('%s', 'now'))`,
	),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
		sql`(strftime('%s', 'now'))`,
	),
})

// Refresh tokens are retained after rotation so reuse of an older token can
// invalidate the session instead of being indistinguishable from a typo.
export const customerRefreshTokens = sqliteTable(
	'customer_refresh_tokens',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		customerId: text('customer_id')
			.notNull()
			.references(() => customers.id, { onDelete: 'cascade' }),
		tokenHash: text('token_hash').notNull(),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		rotatedAt: integer('rotated_at', { mode: 'timestamp' }),
		revokedAt: integer('revoked_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		uniqueIndex('customer_refresh_tokens_token_hash_unique').on(
			table.tokenHash,
		),
		index('idx_customer_refresh_tokens_customer').on(table.customerId),
	],
)

// ==========================================
// 2. MARKETING JOURNEYS (Workflow Definitions)
// ==========================================
export const marketingJourneys = sqliteTable(
	'marketing_journeys',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		name: text('name').notNull(),
		description: text('description'),
		status: text('status', {
			enum: ['draft', 'active', 'paused', 'archived'],
		})
			.notNull()
			.default('draft'),
		triggerType: text('trigger_type', {
			enum: ['phone_verified', 'profile_completed', 'custom_event', 'manual'],
		})
			.notNull()
			.default('phone_verified'),
		triggerConfig: text('trigger_config', { mode: 'json' })
			.notNull()
			.default('{}'),
		graphJson: text('graph_json', { mode: 'json' })
			.notNull()
			.default('{"nodes":[],"edges":[]}'),
		nodes: text('nodes', { mode: 'json' }).notNull().default('[]'),
		edges: text('edges', { mode: 'json' }).notNull().default('[]'),
		version: integer('version').notNull().default(1),
		publishedAt: integer('published_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		index('idx_marketing_journeys_status').on(table.status),
		index('idx_marketing_journeys_trigger_type').on(table.triggerType),
	],
)

// ==========================================
// 3. JOURNEY RUNS (Instance per Customer per Trigger)
// ==========================================
export const journeyRuns = sqliteTable(
	'journey_runs',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		journeyId: text('journey_id')
			.notNull()
			.references(() => marketingJourneys.id, { onDelete: 'cascade' }),
		customerId: text('customer_id')
			.notNull()
			.references(() => customers.id, { onDelete: 'cascade' }),
		workflowInstanceId: text('workflow_instance_id'),
		status: text('status', {
			enum: ['running', 'completed', 'failed', 'cancelled'],
		})
			.notNull()
			.default('running'),
		currentNodeId: text('current_node_id'),
		currentStepNodeId: text('current_step_node_id'),
		triggerEvent: text('trigger_event').notNull().default('phone_verified'),
		contextData: text('context_data', { mode: 'json' }).default('{}'),
		errorMessage: text('error_message'),
		startedAt: integer('started_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
		completedAt: integer('completed_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		index('idx_journey_runs_journey_status').on(table.journeyId, table.status),
		index('idx_journey_runs_customer').on(table.customerId),
		index('idx_journey_runs_status').on(table.status),
	],
)

// ==========================================
// 4. JOURNEY STEP EXECUTIONS (Audit Trail & Outbox)
// ==========================================
export const journeyStepExecutions = sqliteTable(
	'journey_step_executions',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		runId: text('run_id')
			.notNull()
			.references(() => journeyRuns.id, { onDelete: 'cascade' }),
		journeyId: text('journey_id').references(() => marketingJourneys.id, {
			onDelete: 'cascade',
		}),
		customerId: text('customer_id').references(() => customers.id, {
			onDelete: 'cascade',
		}),
		nodeId: text('node_id').notNull(),
		nodeType: text('node_type', {
			enum: [
				'trigger',
				'delay',
				'action_email',
				'action_sms',
				'email',
				'sms',
				'condition',
			],
		})
			.notNull()
			.default('trigger'),
		stepType: text('step_type', {
			enum: [
				'trigger',
				'delay',
				'action_email',
				'action_sms',
				'email',
				'sms',
				'condition',
			],
		}),
		status: text('status', {
			enum: [
				'pending',
				'processing',
				'completed',
				'delivered',
				'failed',
				'skipped',
			],
		})
			.notNull()
			.default('pending'),
		retryCount: integer('retry_count').notNull().default(0),
		metadata: text('metadata', { mode: 'json' }).default('{}'),
		executionDetails: text('execution_details', { mode: 'json' }).default('{}'),
		errorMessage: text('error_message'),
		executedAt: integer('executed_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
		completedAt: integer('completed_at', { mode: 'timestamp' }),
	},
	(table) => [
		uniqueIndex('uniq_journey_step_executions_run_node').on(
			table.runId,
			table.nodeId,
		),
		index('idx_journey_step_executions_customer').on(table.customerId),
		index('idx_journey_step_executions_journey').on(table.journeyId),
		index('idx_journey_step_executions_status').on(table.status),
	],
)

// ==========================================
// 5. EXISTING CAMPAIGN TABLES (Preserved & Enhanced)
// ==========================================
export const marketingCampaigns = sqliteTable('marketing_campaigns', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => randomUUID()),
	name: text('name').notNull(),
	status: text('status', {
		enum: ['Draft', 'Scheduled', 'Processing', 'Completed', 'Failed'],
	})
		.notNull()
		.default('Draft'),
	channel: text('channel', { enum: ['email', 'sms'] })
		.notNull()
		.default('email'),
	subject: text('subject'),
	content: text('content').notNull().default(''),
	/** JSON array of email blocks (source of truth for the email designer). */
	contentBlocks: text('content_blocks'),
	/** Design-time rendered HTML for email broadcasts. */
	contentHtml: text('content_html'),
	targetAudienceCount: integer('target_audience_count').default(0),
	segmentationRules: text('segmentation_rules', { mode: 'json' }).default(
		'{"audience": "all"}',
	),
	scheduledAt: integer('scheduled_at', { mode: 'timestamp' }),
	createdAt: integer('created_at', { mode: 'timestamp' }).default(
		sql`(strftime('%s', 'now'))`,
	),
	updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
		sql`(strftime('%s', 'now'))`,
	),
})

export const marketingMessages = sqliteTable(
	'marketing_messages',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		campaignId: text('campaign_id').references(() => marketingCampaigns.id, {
			onDelete: 'cascade',
		}),
		journeyStepExecutionId: text('journey_step_execution_id').references(
			() => journeyStepExecutions.id,
			{ onDelete: 'set null' },
		),
		customerId: text('customer_id')
			.notNull()
			.references(() => customers.id, { onDelete: 'cascade' }),
		channel: text('channel', { enum: ['email', 'sms'] })
			.notNull()
			.default('email'),
		status: text('status').notNull().default('Sent'),
		sentAt: integer('sent_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
		openedAt: integer('opened_at', { mode: 'timestamp' }),
		clickedAt: integer('clicked_at', { mode: 'timestamp' }),
	},
	(table) => [
		index('idx_marketing_messages_campaign').on(table.campaignId),
		index('idx_marketing_messages_customer').on(table.customerId),
		index('idx_marketing_messages_status').on(table.status),
		index('idx_marketing_messages_sent_at').on(table.sentAt),
		index('idx_marketing_messages_journey_step').on(
			table.journeyStepExecutionId,
		),
	],
)

// ==========================================
// 6. RELATIONS
// ==========================================
export const customersRelations = relations(customers, ({ many }) => ({
	marketingMessages: many(marketingMessages),
	journeyRuns: many(journeyRuns),
	journeyStepExecutions: many(journeyStepExecutions),
}))

export const marketingJourneysRelations = relations(
	marketingJourneys,
	({ many }) => ({
		runs: many(journeyRuns),
		stepExecutions: many(journeyStepExecutions),
	}),
)

export const journeyRunsRelations = relations(journeyRuns, ({ one, many }) => ({
	journey: one(marketingJourneys, {
		fields: [journeyRuns.journeyId],
		references: [marketingJourneys.id],
	}),
	customer: one(customers, {
		fields: [journeyRuns.customerId],
		references: [customers.id],
	}),
	stepExecutions: many(journeyStepExecutions),
}))

export const journeyStepExecutionsRelations = relations(
	journeyStepExecutions,
	({ one, many }) => ({
		run: one(journeyRuns, {
			fields: [journeyStepExecutions.runId],
			references: [journeyRuns.id],
		}),
		journey: one(marketingJourneys, {
			fields: [journeyStepExecutions.journeyId],
			references: [marketingJourneys.id],
		}),
		customer: one(customers, {
			fields: [journeyStepExecutions.customerId],
			references: [customers.id],
		}),
		messages: many(marketingMessages),
	}),
)

export const marketingCampaignsRelations = relations(
	marketingCampaigns,
	({ many }) => ({
		messages: many(marketingMessages),
	}),
)

export const marketingMessagesRelations = relations(
	marketingMessages,
	({ one }) => ({
		campaign: one(marketingCampaigns, {
			fields: [marketingMessages.campaignId],
			references: [marketingCampaigns.id],
		}),
		customer: one(customers, {
			fields: [marketingMessages.customerId],
			references: [customers.id],
		}),
		stepExecution: one(journeyStepExecutions, {
			fields: [marketingMessages.journeyStepExecutionId],
			references: [journeyStepExecutions.id],
		}),
	}),
)

// ==========================================
// 7. SHOP ORDERS (customer purchases on tenant sites)
// ==========================================
export const shopOrders = sqliteTable(
	'shop_orders',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		customerId: text('customer_id').references(() => customers.id, {
			onDelete: 'set null',
		}),
		productName: text('product_name').notNull(),
		amountCents: integer('amount_cents').notNull(),
		platformFeeCents: integer('platform_fee_cents').notNull(),
		orgPayoutCents: integer('org_payout_cents').notNull(),
		currency: text('currency').notNull().default('usd'),
		paymentProvider: text('payment_provider', {
			enum: ['stripe', 'polar', 'checkout'],
		})
			.notNull()
			.default('stripe'),
		stripeCheckoutSessionId: text('stripe_checkout_session_id'),
		stripePaymentIntentId: text('stripe_payment_intent_id'),
		polarCheckoutId: text('polar_checkout_id'),
		polarOrderId: text('polar_order_id'),
		checkoutSessionId: text('checkout_session_id'),
		checkoutPaymentId: text('checkout_payment_id'),
		status: text('status', {
			enum: ['pending', 'paid', 'failed', 'refunded'],
		})
			.notNull()
			.default('pending'),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		index('idx_shop_orders_customer').on(table.customerId),
		index('idx_shop_orders_status').on(table.status),
		uniqueIndex('shop_orders_stripe_checkout_session_id_unique').on(
			table.stripeCheckoutSessionId,
		),
		uniqueIndex('shop_orders_stripe_payment_intent_id_unique').on(
			table.stripePaymentIntentId,
		),
		uniqueIndex('shop_orders_polar_checkout_id_unique').on(
			table.polarCheckoutId,
		),
		uniqueIndex('shop_orders_polar_order_id_unique').on(table.polarOrderId),
		uniqueIndex('shop_orders_checkout_session_id_unique').on(
			table.checkoutSessionId,
		),
		uniqueIndex('shop_orders_checkout_payment_id_unique').on(
			table.checkoutPaymentId,
		),
	],
)

export const shopOrdersRelations = relations(shopOrders, ({ one }) => ({
	customer: one(customers, {
		fields: [shopOrders.customerId],
		references: [customers.id],
	}),
}))

// ==========================================
// 8. CUSTOMER PAYMENT METHODS (shop card snapshots)
// ==========================================
export const customerPaymentMethods = sqliteTable(
	'customer_payment_methods',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		customerId: text('customer_id')
			.notNull()
			.references(() => customers.id, { onDelete: 'cascade' }),
		stripePaymentMethodId: text('stripe_payment_method_id').notNull().unique(),
		brand: text('brand').notNull(),
		last4: text('last4').notNull(),
		expMonth: integer('exp_month').notNull(),
		expYear: integer('exp_year').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		index('idx_customer_payment_methods_customer').on(table.customerId),
	],
)

export const customerPaymentMethodsRelations = relations(
	customerPaymentMethods,
	({ one }) => ({
		customer: one(customers, {
			fields: [customerPaymentMethods.customerId],
			references: [customers.id],
		}),
	}),
)

// ==========================================
// 9. WEBSITE FORMS (regional definitions + submissions)
// ==========================================
export const websiteForms = sqliteTable(
	'website_forms',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		name: text('name').notNull(),
		description: text('description'),
		fields: text('fields', { mode: 'json' }).notNull().default('[]'),
		submitLabel: text('submit_label').notNull().default('Submit'),
		successMessage: text('success_message')
			.notNull()
			.default('Thank you. Your response has been received.'),
		status: text('status', { enum: ['draft', 'published'] })
			.notNull()
			.default('published'),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [index('idx_website_forms_status').on(table.status)],
)

export const websiteFormSubmissions = sqliteTable(
	'website_form_submissions',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		formId: text('form_id')
			.notNull()
			.references(() => websiteForms.id, { onDelete: 'cascade' }),
		values: text('values', { mode: 'json' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		index('idx_website_form_submissions_form_created').on(
			table.formId,
			table.createdAt,
		),
	],
)

export const websiteFormSubmissionsRelations = relations(
	websiteFormSubmissions,
	({ one }) => ({
		form: one(websiteForms, {
			fields: [websiteFormSubmissions.formId],
			references: [websiteForms.id],
		}),
	}),
)

// Read receipts are scoped to the authenticated operator, never a shared inbox flag.
export const mailboxReadReceipts = sqliteTable(
	'mailbox_read_receipts',
	{
		submissionId: text('submission_id')
			.notNull()
			.references(() => websiteFormSubmissions.id, { onDelete: 'cascade' }),
		operatorId: text('operator_id').notNull(),
		readAt: integer('read_at', { mode: 'timestamp' }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.submissionId, table.operatorId] }),
		index('idx_mailbox_read_receipts_operator').on(table.operatorId),
	],
)

// ==========================================
// 10. AI PHONE CALLS (caller numbers and transcripts stay regional)
// ==========================================
export type VoiceTranscriptTurn = {
	role: 'agent' | 'caller'
	text: string
	at: number
}

export const voiceCalls = sqliteTable(
	'voice_calls',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		channel: text('channel', { enum: ['phone', 'web_test'] }).notNull(),
		// Opaque part of the business the call was for (defined by the vertical).
		scopeId: text('scope_id'),
		flowVersionId: text('flow_version_id'),
		roomName: text('room_name').notNull(),
		callerPhone: text('caller_phone'),
		customerId: text('customer_id').references(() => customers.id, {
			onDelete: 'set null',
		}),
		// A definition slug (`callPurposeIds(vertical)`), checked in code.
		purpose: text('purpose'),
		outcome: text('outcome', {
			enum: [
				'resolved',
				'link_sent',
				'escalated',
				'message_taken',
				'abandoned',
				'failed',
			],
		}),
		summary: text('summary'),
		transcript: text('transcript', { mode: 'json' })
			.$type<VoiceTranscriptTurn[]>()
			.notNull()
			.default(sql`'[]'`),
		recordingKey: text('recording_key'),
		recordingExpiresAt: integer('recording_expires_at', { mode: 'timestamp' }),
		// Set once retention has queued the call's expected recording key for
		// deletion. A recording that starts after the call finishes never
		// reaches recording_key, so without this sweep the object is orphaned.
		recordingSweptAt: integer('recording_swept_at', { mode: 'timestamp' }),
		transcriptExpiresAt: integer('transcript_expires_at', {
			mode: 'timestamp',
		}),
		startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
		endedAt: integer('ended_at', { mode: 'timestamp' }),
		durationSeconds: integer('duration_seconds'),
		// Calls logged before follow-up tracking existed count as resolved.
		followUpStatus: text('follow_up_status', { enum: ['open', 'resolved'] })
			.notNull()
			.default('resolved'),
		followUpResolvedAt: integer('follow_up_resolved_at', {
			mode: 'timestamp',
		}),
		autoResolveAt: integer('auto_resolve_at', { mode: 'timestamp' }),
		tags: text('tags', { mode: 'json' })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		rating: integer('rating'),
		sentiment: text('sentiment', {
			enum: ['positive', 'neutral', 'negative'],
		}),
		transferResult: text('transfer_result', {
			enum: ['none', 'answered', 'no_answer', 'referred'],
		})
			.notNull()
			.default('none'),
		transferContactId: text('transfer_contact_id'),
		voicemail: integer('voicemail', { mode: 'boolean' })
			.notNull()
			.default(false),
		calledWhileOpen: integer('called_while_open', { mode: 'boolean' }),
		linkSent: integer('link_sent', { mode: 'boolean' })
			.notNull()
			.default(false),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		index('idx_voice_calls_started').on(table.startedAt),
		index('idx_voice_calls_purpose').on(table.purpose),
		index('idx_voice_calls_follow_up').on(
			table.followUpStatus,
			table.startedAt,
		),
		index('idx_voice_calls_auto_resolve').on(table.autoResolveAt),
		index('idx_voice_calls_caller_phone').on(table.callerPhone),
		index('idx_voice_calls_customer').on(table.customerId),
		index('idx_voice_calls_recording_expires').on(table.recordingExpiresAt),
		index('idx_voice_calls_transcript_expires').on(table.transcriptExpiresAt),
		uniqueIndex('voice_calls_room_name_unique').on(table.roomName),
	],
)

// Data from a call that a texted link carries to a site page. The link token
// is only stored hashed; the raw token exists in the SMS.
export const voiceLinkHandoffs = sqliteTable(
	'voice_link_handoffs',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		callId: text('call_id')
			.notNull()
			.references(() => voiceCalls.id, { onDelete: 'cascade' }),
		tokenHash: text('token_hash').notNull(),
		scopeId: text('scope_id'),
		// Site path the link opens, without the token fragment.
		path: text('path').notNull(),
		payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
		sentToPhone: text('sent_to_phone'),
		smsSentAt: integer('sms_sent_at', { mode: 'timestamp' }),
		expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
		openedAt: integer('opened_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		uniqueIndex('voice_link_handoffs_token_hash_unique').on(table.tokenHash),
		index('idx_voice_link_handoffs_call').on(table.callId),
	],
)

export const voiceCallRequests = sqliteTable(
	'voice_call_requests',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		callId: text('call_id')
			.notNull()
			.references(() => voiceCalls.id, { onDelete: 'cascade' }),
		// A definition slug (`callRequestTypeIds(vertical)`), checked in code.
		type: text('type').notNull(),
		status: text('status', { enum: ['open', 'done'] })
			.notNull()
			.default('open'),
		callerName: text('caller_name'),
		callerPhone: text('caller_phone'),
		details: text('details', { mode: 'json' })
			.$type<Record<string, string>>()
			.notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		index('idx_voice_call_requests_status').on(table.status, table.createdAt),
		index('idx_voice_call_requests_call').on(table.callId),
		index('idx_voice_call_requests_caller_phone').on(table.callerPhone),
	],
)

// Every SMS attempt from a call, including blocked ones, so per-call and
// per-org caps can be enforced and abuse can be audited.
export const voiceSmsSends = sqliteTable(
	'voice_sms_sends',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		callId: text('call_id')
			.notNull()
			.references(() => voiceCalls.id, { onDelete: 'cascade' }),
		// staff_alert rows go to the org's own team and have a separate cap.
		kind: text('kind', {
			enum: ['handoff_link', 'website_link', 'staff_alert'],
		}).notNull(),
		toPhone: text('to_phone').notNull(),
		status: text('status', {
			enum: ['sent', 'failed', 'blocked', 'skipped'],
		}).notNull(),
		reason: text('reason'),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
	},
	(table) => [
		index('idx_voice_sms_sends_created').on(table.createdAt),
		index('idx_voice_sms_sends_call').on(table.callId),
		index('idx_voice_sms_sends_to_phone').on(table.toPhone),
	],
)

// Recording objects whose call row is already gone but which could not be
// deleted from storage yet (for example, storage credentials are missing).
// The retention purge retries them so erasure never orphans a recording.
export const voiceRecordingDeletions = sqliteTable(
	'voice_recording_deletions',
	{
		recordingKey: text('recording_key').primaryKey(),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
	},
)

// Phone-line ownership codes sent for this org, so the daily cap survives
// restarts and holds across processes.
export const voiceLineVerifications = sqliteTable(
	'voice_line_verifications',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		toPhone: text('to_phone').notNull(),
		method: text('method', { enum: ['sms', 'call'] }).notNull(),
		status: text('status', { enum: ['sent', 'failed'] }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
	},
	(table) => [
		index('idx_voice_line_verifications_created').on(table.createdAt),
	],
)

export const voiceCallsRelations = relations(voiceCalls, ({ one, many }) => ({
	customer: one(customers, {
		fields: [voiceCalls.customerId],
		references: [customers.id],
	}),
	handoffs: many(voiceLinkHandoffs),
	requests: many(voiceCallRequests),
	smsSends: many(voiceSmsSends),
}))

export const voiceSmsSendsRelations = relations(voiceSmsSends, ({ one }) => ({
	call: one(voiceCalls, {
		fields: [voiceSmsSends.callId],
		references: [voiceCalls.id],
	}),
}))

export const voiceLinkHandoffsRelations = relations(
	voiceLinkHandoffs,
	({ one }) => ({
		call: one(voiceCalls, {
			fields: [voiceLinkHandoffs.callId],
			references: [voiceCalls.id],
		}),
	}),
)

export const voiceCallRequestsRelations = relations(
	voiceCallRequests,
	({ one }) => ({
		call: one(voiceCalls, {
			fields: [voiceCallRequests.callId],
			references: [voiceCalls.id],
		}),
	}),
)

// ==========================================
// 11. INFERRED TYPES
// ==========================================
export type Customer = typeof customers.$inferSelect
export type NewCustomer = typeof customers.$inferInsert

export type MarketingJourney = typeof marketingJourneys.$inferSelect
export type NewMarketingJourney = typeof marketingJourneys.$inferInsert

export type JourneyRun = typeof journeyRuns.$inferSelect
export type NewJourneyRun = typeof journeyRuns.$inferInsert

export type JourneyStepExecution = typeof journeyStepExecutions.$inferSelect
export type NewJourneyStepExecution = typeof journeyStepExecutions.$inferInsert

export type MarketingCampaign = typeof marketingCampaigns.$inferSelect
export type NewMarketingCampaign = typeof marketingCampaigns.$inferInsert

export type MarketingMessage = typeof marketingMessages.$inferSelect
export type NewMarketingMessage = typeof marketingMessages.$inferInsert

export type ShopOrder = typeof shopOrders.$inferSelect
export type NewShopOrder = typeof shopOrders.$inferInsert

export type CustomerPaymentMethod = typeof customerPaymentMethods.$inferSelect
export type NewCustomerPaymentMethod =
	typeof customerPaymentMethods.$inferInsert
export type WebsiteForm = typeof websiteForms.$inferSelect
export type WebsiteFormSubmission = typeof websiteFormSubmissions.$inferSelect
export type VoiceCall = typeof voiceCalls.$inferSelect
export type VoiceLinkHandoff = typeof voiceLinkHandoffs.$inferSelect
export type VoiceCallRequest = typeof voiceCallRequests.$inferSelect
export type VoiceSmsSend = typeof voiceSmsSends.$inferSelect
export type VoiceRecordingDeletion = typeof voiceRecordingDeletions.$inferSelect
export type VoiceLineVerification = typeof voiceLineVerifications.$inferSelect
