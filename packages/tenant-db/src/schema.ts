import {
	type AnySQLiteColumn,
	sqliteTable,
	text,
	integer,
	index,
	uniqueIndex,
	primaryKey,
	real,
	check,
} from 'drizzle-orm/sqlite-core'
import { sql, relations } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

import {
	RESTAURANT_ACTIVE_ORDER_STATUSES,
	RESTAURANT_ORDER_STATUS_VALUES,
	RESTAURANT_PAYMENT_STATUS_VALUES,
} from '@repo/common/restaurant-orders'
import { SITE_CONTENT_LOCALES } from '@repo/common/site-locales'

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

// Explicit marketing consent, one row per customer + topic + channel. Opting
// out keeps the row (unsubscribedAt set) as the record of the opt-out; a later
// opt-in clears it and restamps subscribedAt/source. A customer with no active
// row has not consented: broadcasts never reach them.
export const CUSTOMER_SUBSCRIPTION_TOPICS = [
	'marketing',
	'product_updates',
	// Fork: SMS drop alerts (menu / drops pages).
	'drops',
	// Reservation journeys: a guest who ticked the marketing box on a booking
	// form agreed to hear from the restaurant about their visits.
	'reservations',
] as const
export const CUSTOMER_SUBSCRIPTION_CHANNELS = ['sms', 'email'] as const
export const CUSTOMER_SUBSCRIPTION_SOURCES = [
	'signup',
	'profile',
	'checkout',
	'form',
	'operator',
	'import',
	// Fork: drop-alert entry points.
	'menu',
	'drops_page',
	'drop_page',
	'order_success',
	// Reservations: the marketing box on a booking form.
	'reservation_booking',
] as const

export type CustomerSubscriptionTopic =
	(typeof CUSTOMER_SUBSCRIPTION_TOPICS)[number]
export type CustomerSubscriptionChannel =
	(typeof CUSTOMER_SUBSCRIPTION_CHANNELS)[number]
export type CustomerSubscriptionSource =
	(typeof CUSTOMER_SUBSCRIPTION_SOURCES)[number]

export const customerSubscriptions = sqliteTable(
	'customer_subscriptions',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		customerId: text('customer_id')
			.notNull()
			.references(() => customers.id, { onDelete: 'cascade' }),
		topic: text('topic', { enum: CUSTOMER_SUBSCRIPTION_TOPICS }).notNull(),
		channel: text('channel', {
			enum: CUSTOMER_SUBSCRIPTION_CHANNELS,
		}).notNull(),
		source: text('source', { enum: CUSTOMER_SUBSCRIPTION_SOURCES }).notNull(),
		subscribedAt: integer('subscribed_at', { mode: 'timestamp' }).notNull(),
		unsubscribedAt: integer('unsubscribed_at', { mode: 'timestamp' }),
		/**
		 * HMAC of the (lower-cased) email address the owner confirmed. An address
		 * a customer typed is not proof they own it, so an email subscription is
		 * deliverable only while this matches the customer's current address: it
		 * is set when the owner follows the emailed confirmation link (or an
		 * operator or import vouches for it) and stops matching if the address
		 * changes. Always null for texts (the OTP proved the phone).
		 */
		confirmedEmailHash: text('confirmed_email_hash'),
		/**
		 * The last confirmation email that was actually sent: when, and an HMAC
		 * of the address it went to. Only a repeat request for the same address
		 * within the resend interval is throttled; a new address is not.
		 */
		confirmationSentAt: integer('confirmation_sent_at', { mode: 'timestamp' }),
		confirmationSentHash: text('confirmation_sent_hash'),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		uniqueIndex('uniq_customer_subscriptions_customer_topic_channel').on(
			table.customerId,
			table.topic,
			table.channel,
		),
		index('idx_customer_subscriptions_topic_channel').on(
			table.topic,
			table.channel,
			table.unsubscribedAt,
		),
	],
)

// Record that a person's data was erased (see the person erasure service in
// tenant-api). Holds no personal data: the customer row is gone, so its id
// points at nothing, and the counts say how much was removed. Never purged.
export const personErasureLog = sqliteTable(
	'person_erasure_log',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		at: integer('at', { mode: 'timestamp_ms' }).notNull(),
		// The operator (control-plane user id) who ran the erasure.
		actorId: text('actor_id').notNull(),
		// Opaque id of the erased customer. Not a foreign key on purpose.
		subjectId: text('subject_id').notNull(),
		counts: text('counts', { mode: 'json' })
			.$type<Record<string, number>>()
			.notNull(),
	},
	(table) => [index('idx_person_erasure_log_at').on(table.at)],
)

export type PersonErasureLogEntry = typeof personErasureLog.$inferSelect

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
			enum: [
				'phone_verified',
				'profile_completed',
				'custom_event',
				'manual',
				'reservation_booked',
				'reservation_completed',
				'reservation_no_show',
				'reservation_cancelled',
			],
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
// 10. RESTAURANT ORDERS (regional durable ordering)
// ==========================================

// Server-repriced restaurant orders. All money is integer cents. Contact and
// delivery fields are customer PII and must never leave this regional DB.
// `status` states that consume capacity: accepted | preparing | ready |
// completed. cancelled / expired / payment_review release capacity.
// Canonical status values live in @repo/common/restaurant-orders.
export const RESTAURANT_ORDER_STATUSES = RESTAURANT_ORDER_STATUS_VALUES

export const RESTAURANT_ORDER_ACTIVE_STATUSES = RESTAURANT_ACTIVE_ORDER_STATUSES

export const RESTAURANT_PAYMENT_STATUSES = RESTAURANT_PAYMENT_STATUS_VALUES

export const restaurantOrders = sqliteTable(
	'restaurant_orders',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		orgId: text('org_id').notNull(),
		customerId: text('customer_id').references(() => customers.id, {
			onDelete: 'set null',
		}),
		number: text('number').notNull(),
		locale: text('locale').notNull().default('en'),
		status: text('status', {
			enum: [...RESTAURANT_ORDER_STATUSES],
		})
			.notNull()
			.default('accepted'),
		paymentMethod: text('payment_method', {
			enum: ['handoff', 'online'],
		}).notNull(),
		paymentStatus: text('payment_status', {
			enum: [...RESTAURANT_PAYMENT_STATUSES],
		}).notNull(),
		paymentProcessor: text('payment_processor', {
			enum: ['connect', 'checkout'],
		}),
		paymentSessionId: text('payment_session_id'),
		paymentEventAt: integer('payment_event_at', { mode: 'timestamp' }),
		fulfillment: text('fulfillment', {
			enum: ['pickup', 'delivery'],
		}).notNull(),
		locationId: text('location_id').notNull(),
		locationName: text('location_name').notNull(),
		dropId: text('drop_id'),
		dropSlug: text('drop_slug'),
		pickupWindowId: text('pickup_window_id'),
		pickupDate: text('pickup_date'),
		pickupTime: text('pickup_time'),
		pickupTimezone: text('pickup_timezone'),
		contactName: text('contact_name').notNull(),
		contactPhone: text('contact_phone').notNull(),
		contactEmail: text('contact_email'),
		deliveryAddress: text('delivery_address'),
		deliveryCity: text('delivery_city'),
		deliveryUnit: text('delivery_unit'),
		deliveryNotes: text('delivery_notes'),
		deliveryZoneId: text('delivery_zone_id'),
		// Geocoded delivery point from a signed delivery quote (null for
		// zip-verified orders).
		deliveryPostalCode: text('delivery_postal_code'),
		deliveryLat: real('delivery_lat'),
		deliveryLng: real('delivery_lng'),
		// Customer-chosen fulfilment time; null = ASAP.
		scheduledFor: integer('scheduled_for', { mode: 'timestamp' }),
		currency: text('currency').notNull(),
		subtotalCents: integer('subtotal_cents').notNull(),
		taxCents: integer('tax_cents').notNull(),
		deliveryFeeCents: integer('delivery_fee_cents').notNull().default(0),
		tipCents: integer('tip_cents').notNull().default(0),
		tipPercent: integer('tip_percent').notNull().default(0),
		totalCents: integer('total_cents').notNull(),
		lines: text('lines', { mode: 'json' }).notNull(),
		idempotencyKey: text('idempotency_key').notNull(),
		requestHash: text('request_hash').notNull(),
		receiptTokenHash: text('receipt_token_hash').notNull(),
		paymentTokenHash: text('payment_token_hash'),
		holdExpiresAt: integer('hold_expires_at', { mode: 'timestamp' }),
		paidAt: integer('paid_at', { mode: 'timestamp' }),
		completedAt: integer('completed_at', { mode: 'timestamp' }),
		cancelledAt: integer('cancelled_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		uniqueIndex('restaurant_orders_number_unique').on(table.number),
		uniqueIndex('restaurant_orders_idempotency_key_unique').on(
			table.idempotencyKey,
		),
		uniqueIndex('restaurant_orders_payment_session_id_unique').on(
			table.paymentSessionId,
		),
		index('idx_restaurant_orders_status_created').on(
			table.status,
			table.createdAt,
		),
		index('idx_restaurant_orders_slot').on(
			table.pickupWindowId,
			table.pickupTime,
			table.status,
		),
		index('idx_restaurant_orders_customer').on(table.customerId),
		index('idx_restaurant_orders_location_created').on(
			table.locationId,
			table.createdAt,
		),
	],
)

// One row per capacity-governed entity per order (drop inventory caps).
// Live capacity is counted by joining these rows against their order's status,
// so cancelled / expired orders stop consuming capacity automatically.
export const restaurantOrderReservations = sqliteTable(
	'restaurant_order_reservations',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		orderId: text('order_id')
			.notNull()
			.references(() => restaurantOrders.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: ['item', 'category'] }).notNull(),
		entityId: text('entity_id').notNull(),
		windowId: text('window_id'),
		slotTime: text('slot_time'),
		quantity: integer('quantity').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		index('idx_restaurant_reservations_entity').on(table.kind, table.entityId),
		index('idx_restaurant_reservations_slot_entity').on(
			table.entityId,
			table.windowId,
			table.slotTime,
		),
		index('idx_restaurant_reservations_order').on(table.orderId),
	],
)

export const restaurantOrdersRelations = relations(
	restaurantOrders,
	({ one, many }) => ({
		customer: one(customers, {
			fields: [restaurantOrders.customerId],
			references: [customers.id],
		}),
		reservations: many(restaurantOrderReservations),
	}),
)

export const restaurantOrderReservationsRelations = relations(
	restaurantOrderReservations,
	({ one }) => ({
		order: one(restaurantOrders, {
			fields: [restaurantOrderReservations.orderId],
			references: [restaurantOrders.id],
		}),
	}),
)

// ==========================================
// 11. AI PHONE CALLS (caller numbers and transcripts stay regional)
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

export const VOICE_CALL_ACTION_OUTCOME_VALUES = [
	'pending',
	'ok',
	'refused',
	'failed',
] as const

// One row per action the voice agent asked tenant-api to run during a call.
// The rows are the per-call cap: an action is reserved here (counted against
// its cap) before it runs. Holds no caller data: ids and outcomes only.
export const voiceCallActions = sqliteTable(
	'voice_call_actions',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		callId: text('call_id')
			.notNull()
			.references(() => voiceCalls.id, { onDelete: 'cascade' }),
		action: text('action').notNull(),
		outcome: text('outcome', { enum: VOICE_CALL_ACTION_OUTCOME_VALUES })
			.notNull()
			.default('pending'),
		dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
	},
	(table) => [
		index('idx_voice_call_actions_call_action').on(table.callId, table.action),
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
// 11b. STAFF (people who work here; regional data plane)
// ==========================================
// Conventions: `*_at` is epoch milliseconds (UTC), `*_date` is `YYYY-MM-DD` in
// the scope timezone, money is integer minor units with an explicit
// currency, multipliers are basis points. This is the HR data plane, so none of
// it ever leaves the regional node except through `/operator/staff`.
const nowMs = sql`(cast(strftime('%s', 'now') as integer) * 1000)`

export const STAFF_STATUS_VALUES = [
	'invited',
	'active',
	'on_leave',
	'terminated',
] as const
export const STAFF_WORKER_TYPE_VALUES = ['employee', 'contractor'] as const
export const STAFF_PAY_TYPE_VALUES = ['hourly', 'salary'] as const
export const STAFF_AUDIT_SENSITIVITY_VALUES = [
	'standard',
	'pay',
	'private',
] as const

export const staffMembers = sqliteTable(
	'staff_members',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		status: text('status', { enum: [...STAFF_STATUS_VALUES] })
			.notNull()
			.default('active'),
		workerType: text('worker_type', { enum: [...STAFF_WORKER_TYPE_VALUES] })
			.notNull()
			.default('employee'),
		firstName: text('first_name').notNull(),
		lastName: text('last_name').notNull(),
		firstNameAr: text('first_name_ar'),
		lastNameAr: text('last_name_ar'),
		email: text('email'),
		// E.164.
		phone: text('phone'),
		// Opaque control-plane user id for staff who also have an App login. No
		// foreign key: the user lives in the US control plane.
		userId: text('user_id'),
		// Payroll id.
		employeeNumber: text('employee_number'),
		locale: text('locale').notNull().default('en'),
		hiredDate: text('hired_date'),
		terminatedAt: integer('terminated_at'),
		terminationReason: text('termination_reason'),
		eligibleForRehire: integer('eligible_for_rehire', {
			mode: 'boolean',
		}),
		primaryScopeId: text('primary_scope_id'),
		createdBy: text('created_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_staff_members_user_id')
			.on(table.userId)
			.where(sql`${table.userId} is not null`),
		uniqueIndex('uniq_staff_members_employee_number')
			.on(table.employeeNumber)
			.where(sql`${table.employeeNumber} is not null`),
		index('idx_staff_members_status').on(table.status),
		index('idx_staff_members_name').on(table.lastName, table.firstName),
	],
)

// Date of birth, home address and emergency contact. Separate table so a
// query for the roster can never select it by accident, and gated by its own
// permission (`staff_private`).
export const staffPrivate = sqliteTable('staff_private', {
	staffId: text('staff_id')
		.primaryKey()
		.references(() => staffMembers.id, { onDelete: 'cascade' }),
	dateOfBirth: text('date_of_birth'),
	addressLine1: text('address_line1'),
	addressLine2: text('address_line2'),
	city: text('city'),
	region: text('region'),
	postalCode: text('postal_code'),
	country: text('country'),
	emergencyContactName: text('emergency_contact_name'),
	emergencyContactPhone: text('emergency_contact_phone'),
	emergencyContactRelation: text('emergency_contact_relation'),
	updatedBy: text('updated_by'),
	updatedAt: integer('updated_at').notNull().default(nowMs),
})

export const staffPositions = sqliteTable(
	'staff_positions',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		name: text('name').notNull(),
		nameAr: text('name_ar'),
		area: text('area'),
		// Theme-token key (never a hex color) so it follows light and dark themes.
		colorKey: text('color_key').notNull().default('neutral'),
		defaultRateMinor: integer('default_rate_minor'),
		currency: text('currency'),
		tipEligible: integer('tip_eligible', { mode: 'boolean' })
			.notNull()
			.default(false),
		archivedAt: integer('archived_at'),
		createdBy: text('created_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_staff_positions_active_name')
			.on(sql`lower(${table.name})`)
			.where(sql`${table.archivedAt} is null`),
	],
)

export const staffScopeAssignments = sqliteTable(
	'staff_scope_assignments',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		staffId: text('staff_id')
			.notNull()
			.references(() => staffMembers.id, { onDelete: 'cascade' }),
		// Opaque control-plane scope id.
		scopeId: text('scope_id').notNull(),
		// HMAC-SHA256 (AUTH_HMAC_SECRET) of org, scope and PIN. The PIN itself
		// is never stored and never returned after it is first shown.
		pinLookup: text('pin_lookup'),
		pinSetAt: integer('pin_set_at'),
		pinFailedCount: integer('pin_failed_count').notNull().default(0),
		pinLockedUntil: integer('pin_locked_until'),
		isPrimary: integer('is_primary', { mode: 'boolean' })
			.notNull()
			.default(false),
		showInSchedule: integer('show_in_schedule', { mode: 'boolean' })
			.notNull()
			.default(true),
		eligibleOpenShifts: integer('eligible_open_shifts', { mode: 'boolean' })
			.notNull()
			.default(true),
		includeInClockErrors: integer('include_in_clock_errors', {
			mode: 'boolean',
		})
			.notNull()
			.default(true),
		canWaiveBreaks: integer('can_waive_breaks', { mode: 'boolean' })
			.notNull()
			.default(false),
		active: integer('active', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_staff_assignments_staff_scope').on(
			table.staffId,
			table.scopeId,
		),
		uniqueIndex('uniq_staff_assignments_scope_pin')
			.on(table.scopeId, table.pinLookup)
			.where(sql`${table.pinLookup} is not null`),
		uniqueIndex('uniq_staff_assignments_primary')
			.on(table.staffId)
			.where(sql`${table.isPrimary} = 1`),
		index('idx_staff_assignments_scope').on(table.scopeId, table.active),
	],
)

// Effective-dated and append-only: a rate change closes the open row (sets
// `effective_to`) and inserts a new one. Triggers in the migration reject any
// other update and every delete, so wage history cannot be rewritten.
export const staffJobs = sqliteTable(
	'staff_jobs',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		staffId: text('staff_id')
			.notNull()
			.references(() => staffMembers.id, { onDelete: 'cascade' }),
		scopeId: text('scope_id').notNull(),
		positionId: text('position_id')
			.notNull()
			.references(() => staffPositions.id),
		payType: text('pay_type', { enum: [...STAFF_PAY_TYPE_VALUES] })
			.notNull()
			.default('hourly'),
		// Null means "use the position default".
		rateMinor: integer('rate_minor'),
		annualSalaryMinor: integer('annual_salary_minor'),
		currency: text('currency').notNull(),
		overtimeExempt: integer('overtime_exempt', { mode: 'boolean' })
			.notNull()
			.default(false),
		tipEligible: integer('tip_eligible', { mode: 'boolean' })
			.notNull()
			.default(false),
		isPrimary: integer('is_primary', { mode: 'boolean' })
			.notNull()
			.default(false),
		effectiveFrom: text('effective_from').notNull(),
		effectiveTo: text('effective_to'),
		changeReason: text('change_reason'),
		createdBy: text('created_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_staff_jobs_open_position')
			.on(table.staffId, table.scopeId, table.positionId)
			.where(sql`${table.effectiveTo} is null`),
		uniqueIndex('uniq_staff_jobs_open_primary')
			.on(table.staffId, table.scopeId)
			.where(sql`${table.isPrimary} = 1 and ${table.effectiveTo} is null`),
		index('idx_staff_jobs_staff').on(table.staffId, table.effectiveFrom),
		index('idx_staff_jobs_scope').on(table.scopeId),
	],
)

export const staffNotes = sqliteTable(
	'staff_notes',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		staffId: text('staff_id')
			.notNull()
			.references(() => staffMembers.id, { onDelete: 'cascade' }),
		// Opaque operator user id.
		authorId: text('author_id').notNull(),
		body: text('body').notNull(),
		deletedAt: integer('deleted_at'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_staff_notes_staff').on(table.staffId, table.createdAt),
	],
)

// One row per org (`id = 'org'`).
export const staffingSettings = sqliteTable('staffing_settings', {
	id: text('id').primaryKey().default('org'),
	pinLength: integer('pin_length').notNull().default(4),
	payPeriod: text('pay_period').notNull().default('weekly'),
	// A date that fixes where periods start: the first day of a weekly or
	// biweekly period, or the day of the month a monthly or semimonthly period
	// starts on. Null means the built-in anchor.
	payPeriodAnchor: text('pay_period_anchor'),
	// 'full' (US default) or 'minimal' (KSA default): how much staff-facing
	// messages say.
	contactLevel: text('contact_level').notNull().default('full'),
	retentionDaysPunchCoordinates: integer('retention_days_punch_coordinates'),
	retentionDaysDeclinedApplicants: integer(
		'retention_days_declined_applicants',
	),
	updatedBy: text('updated_by'),
	updatedAt: integer('updated_at').notNull().default(nowMs),
})

// Append-only (triggers reject update and delete). Authoritative audit trail
// for staff data; the US control plane only ever receives generic events.
export const staffAuditLog = sqliteTable(
	'staff_audit_log',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		at: integer('at').notNull().default(nowMs),
		actorKind: text('actor_kind').notNull().default('operator'),
		actorId: text('actor_id').notNull(),
		impersonated: integer('impersonated', { mode: 'boolean' })
			.notNull()
			.default(false),
		action: text('action').notNull(),
		entityType: text('entity_type').notNull(),
		entityId: text('entity_id'),
		staffId: text('staff_id'),
		scopeId: text('scope_id'),
		sensitivity: text('sensitivity', {
			enum: [...STAFF_AUDIT_SENSITIVITY_VALUES],
		})
			.notNull()
			.default('standard'),
		// Field-level before/after. Pay and private values live only in rows whose
		// sensitivity matches, so reading them needs the matching grant.
		changes: text('changes', { mode: 'json' }),
		ipHash: text('ip_hash'),
	},
	(table) => [
		index('idx_staff_audit_log_at').on(table.at),
		index('idx_staff_audit_log_staff').on(table.staffId, table.at),
	],
)

export const staffMembersRelations = relations(
	staffMembers,
	({ one, many }) => ({
		private: one(staffPrivate, {
			fields: [staffMembers.id],
			references: [staffPrivate.staffId],
		}),
		assignments: many(staffScopeAssignments),
		jobs: many(staffJobs),
		notes: many(staffNotes),
	}),
)

export const staffScopeAssignmentsRelations = relations(
	staffScopeAssignments,
	({ one }) => ({
		staff: one(staffMembers, {
			fields: [staffScopeAssignments.staffId],
			references: [staffMembers.id],
		}),
	}),
)

export const staffJobsRelations = relations(staffJobs, ({ one }) => ({
	staff: one(staffMembers, {
		fields: [staffJobs.staffId],
		references: [staffMembers.id],
	}),
	position: one(staffPositions, {
		fields: [staffJobs.positionId],
		references: [staffPositions.id],
	}),
}))

// ==========================================
// 11c. TIME CLOCK (labor policy, punches, entries, kiosk devices)
// ==========================================
// Same conventions as the staff tables above. Punches and edits are
// append-only and entries can only be voided, never deleted (triggers in the
// migration); a locked entry is immutable until it is unlocked.

export const KIOSK_IDENTIFY_MODE_VALUES = ['pin', 'pick_name'] as const
export const PUNCH_KIND_VALUES = [
	'clock_in',
	'break_start',
	'break_end',
	'clock_out',
] as const
export const PUNCH_SOURCE_VALUES = [
	'kiosk',
	'web',
	'mobile',
	'manager',
	// A paired Station tablet's time clock.
	'pos',
] as const
export const PUNCH_OUTCOME_VALUES = [
	'accepted',
	'rejected_state',
	'rejected_policy',
] as const
export const TIME_ENTRY_STATUS_VALUES = [
	'open',
	'closed',
	'needs_review',
	'approved',
	'locked',
] as const
export const TIME_BREAK_KIND_VALUES = ['meal', 'rest'] as const

// One row per scope plus one organization default (scope_id is null). A
// scope row overrides the default; with neither the code uses built-in
// neutral values. Tenant-api cannot read the control plane, so the policy is
// the node's own source of truth for overtime, break and clock rules.
export const laborPolicies = sqliteTable(
	'labor_policies',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// Opaque control-plane scope id; null is the organization default.
		scopeId: text('scope_id'),
		// The scope id, or '*' for the organization default: one policy each.
		scopeKey: text('scope_key').notNull(),
		timeTrackingEnabled: integer('time_tracking_enabled', { mode: 'boolean' })
			.notNull()
			.default(true),
		// Snapshot used when the control plane cannot be reached.
		timeZone: text('time_zone'),
		weekStartsOn: integer('week_starts_on').notNull().default(1),
		workdayStartMinute: integer('workday_start_minute').notNull().default(0),
		lateGraceMinutes: integer('late_grace_minutes').notNull().default(5),
		preventEarlyMinutes: integer('prevent_early_minutes'),
		allowUnscheduled: integer('allow_unscheduled', { mode: 'boolean' })
			.notNull()
			.default(true),
		missedClockOutReminderMinutes: integer('missed_clock_out_reminder_minutes'),
		autoClockOutMinutes: integer('auto_clock_out_minutes'),
		// Alerts the regional tick sends. Null is off. Nothing fires without a
		// schedule (scheduling is a later slice) except the overtime warning.
		noClockInAlertMinutes: integer('no_clock_in_alert_minutes').default(15),
		preShiftReminderMinutes: integer('pre_shift_reminder_minutes').default(240),
		overtimeAlertMinutes: integer('overtime_alert_minutes').default(60),
		roundingMode: text('rounding_mode').notNull().default('none'),
		roundingIncrementMinutes: integer('rounding_increment_minutes')
			.notNull()
			.default(1),
		dailyOvertimeMinutes: integer('daily_overtime_minutes'),
		dailyOvertimeBp: integer('daily_overtime_bp').notNull().default(15000),
		dailyDoubleTimeMinutes: integer('daily_double_time_minutes'),
		dailyDoubleTimeBp: integer('daily_double_time_bp').notNull().default(20000),
		weeklyOvertimeMinutes: integer('weekly_overtime_minutes'),
		weeklyOvertimeBp: integer('weekly_overtime_bp').notNull().default(15000),
		holidayMultiplierBp: integer('holiday_multiplier_bp')
			.notNull()
			.default(10000),
		holidayDates: text('holiday_dates', { mode: 'json' })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		breakRules: text('break_rules', { mode: 'json' })
			.$type<{
				rules: Array<{
					kind: 'meal' | 'rest'
					afterMinutes: number
					minutes: number
					paid: boolean
					mandatory: boolean
				}>
				autoDeduction: { afterMinutes: number; deductMinutes: number } | null
			}>()
			.notNull()
			.default(sql`'{"rules":[],"autoDeduction":null}'`),
		longShiftMinutes: integer('long_shift_minutes').notNull().default(960),
		geofenceMode: text('geofence_mode').notNull().default('off'),
		geofenceRadiusMeters: integer('geofence_radius_meters'),
		requirePhoto: integer('require_photo', { mode: 'boolean' })
			.notNull()
			.default(false),
		timesheetApprovalMode: text('timesheet_approval_mode')
			.notNull()
			.default('none'),
		scheduleVisibility: text('schedule_visibility').notNull().default('own'),
		publishLeadHours: integer('publish_lead_hours').notNull().default(0),
		timeOffMaxPerDay: integer('time_off_max_per_day'),
		laborTargetBp: integer('labor_target_bp'),
		// No default on purpose: null means "not chosen yet" and must be chosen
		// wherever staff work at more than one scope.
		aggregateOvertimeAcrossScopes: integer('aggregate_overtime_across_scopes', {
			mode: 'boolean',
		}),
		rulePack: text('rule_pack').notNull().default('generic'),
		rulePackVersion: integer('rule_pack_version').notNull().default(1),
		version: integer('version').notNull().default(1),
		updatedBy: text('updated_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [uniqueIndex('uniq_labor_policies_scope').on(table.scopeKey)],
)

export const kioskDevices = sqliteTable(
	'kiosk_devices',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// Bound to one scope for life (a trigger rejects any change).
		scopeId: text('scope_id').notNull(),
		name: text('name').notNull(),
		// Keyed hash of the device secret. The secret itself is never stored.
		secretHash: text('secret_hash').notNull(),
		identifyMode: text('identify_mode', {
			enum: [...KIOSK_IDENTIFY_MODE_VALUES],
		})
			.notNull()
			.default('pin'),
		showNextShifts: integer('show_next_shifts', { mode: 'boolean' })
			.notNull()
			.default(false),
		timeZone: text('time_zone'),
		scopeName: text('scope_name'),
		pairedBy: text('paired_by').notNull(),
		pairedAt: integer('paired_at').notNull().default(nowMs),
		lastSeenAt: integer('last_seen_at'),
		lastSeenIpHash: text('last_seen_ip_hash'),
		revokedAt: integer('revoked_at'),
		revokedBy: text('revoked_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_kiosk_devices_secret_hash').on(table.secretHash),
		index('idx_kiosk_devices_scope').on(table.scopeId),
	],
)

// One-time pairing codes: stored only as a keyed hash, valid for ten minutes.
export const kioskPairingCodes = sqliteTable(
	'kiosk_pairing_codes',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		codeHash: text('code_hash').notNull(),
		scopeId: text('scope_id').notNull(),
		deviceName: text('device_name').notNull(),
		identifyMode: text('identify_mode', {
			enum: [...KIOSK_IDENTIFY_MODE_VALUES],
		})
			.notNull()
			.default('pin'),
		showNextShifts: integer('show_next_shifts', { mode: 'boolean' })
			.notNull()
			.default(false),
		timeZone: text('time_zone'),
		scopeName: text('scope_name'),
		createdBy: text('created_by').notNull(),
		expiresAt: integer('expires_at').notNull(),
		usedAt: integer('used_at'),
		deviceId: text('device_id'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_kiosk_pairing_codes_hash').on(table.codeHash),
		index('idx_kiosk_pairing_codes_scope').on(table.scopeId),
	],
)

// ---------------------------------------------------------------------------
// Point of sale in Station (apps/station). A paired terminal rings up orders in the
// restaurant, possibly offline, and uploads each revision of an order. Holds
// short-lived customer contact data on phone pickups, or a counter guest name
// and table label (cleared after `POS_GUEST_NAME_RETENTION_DAYS`).
//
// Money rows are append-only (triggers in migration 0020): payments and refunds,
// every accepted revision of an order, and the fiscal document chain. The order
// row itself is the current state; its history is `pos_order_revisions`.
// ---------------------------------------------------------------------------

/** Default end of a business day: 04:00, so a late service stays on one day. */
export const POS_DEFAULT_DAY_START_MINUTES = 240

export const posDevices = sqliteTable(
	'pos_devices',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		label: text('label').notNull(),
		// Short prefix for order numbers (`T1-0042`), unique per organization so
		// two terminals can never issue the same number.
		terminalCode: text('terminal_code').notNull(),
		locationId: text('location_id'),
		// The workplace whose staff PINs sign in here (a staff scope; `main` when the
		// organization has only one).
		scopeId: text('scope_id').notNull().default('main'),
		// When true the till locks until a staff member enters their PIN, and every
		// order records who took it. Off by default so a terminal that already
		// exists keeps working; new pairings choose explicitly (on unless a manager
		// turns it off).
		signInRequired: integer('sign_in_required', { mode: 'boolean' })
			.notNull()
			.default(false),
		// When sign-in was last switched on, so orders rung up before that are not
		// flagged for having no staff member.
		signInRequiredSince: integer('sign_in_required_since'),
		// Minutes after local midnight when the business day turns over (0-720).
		dayStartMinutes: integer('day_start_minutes')
			.notNull()
			.default(POS_DEFAULT_DAY_START_MINUTES),
		// When true the till sells only inside a cash drawer shift (opened with a
		// float, closed with a count).
		shiftsRequired: integer('shifts_required', { mode: 'boolean' })
			.notNull()
			.default(false),
		// Station apps beside the till. The time clock punches with each person's
		// PIN; reservations open the host stand for the terminal's location and need
		// sign-in. Each is also gated by the organization's feature flag.
		timeclockEnabled: integer('timeclock_enabled', { mode: 'boolean' })
			.notNull()
			.default(false),
		reservationsEnabled: integer('reservations_enabled', { mode: 'boolean' })
			.notNull()
			.default(false),
		// Keyed hash of the device secret. The secret itself is never stored.
		secretHash: text('secret_hash').notNull(),
		pairedBy: text('paired_by').notNull(),
		pairedAt: integer('paired_at').notNull().default(nowMs),
		lastSeenAt: integer('last_seen_at'),
		revokedAt: integer('revoked_at'),
		revokedBy: text('revoked_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_pos_devices_secret_hash').on(table.secretHash),
		// A revoked terminal frees its code for the replacement tablet.
		uniqueIndex('uniq_pos_devices_terminal_code')
			.on(table.terminalCode)
			.where(sql`${table.revokedAt} is null`),
	],
)

// One-time pairing codes: stored only as a keyed hash, valid for ten minutes.
export const posPairingCodes = sqliteTable(
	'pos_pairing_codes',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		codeHash: text('code_hash').notNull(),
		label: text('label').notNull(),
		terminalCode: text('terminal_code').notNull(),
		locationId: text('location_id'),
		scopeId: text('scope_id').notNull().default('main'),
		signInRequired: integer('sign_in_required', { mode: 'boolean' })
			.notNull()
			.default(false),
		dayStartMinutes: integer('day_start_minutes')
			.notNull()
			.default(POS_DEFAULT_DAY_START_MINUTES),
		shiftsRequired: integer('shifts_required', { mode: 'boolean' })
			.notNull()
			.default(false),
		timeclockEnabled: integer('timeclock_enabled', { mode: 'boolean' })
			.notNull()
			.default(false),
		reservationsEnabled: integer('reservations_enabled', { mode: 'boolean' })
			.notNull()
			.default(false),
		createdBy: text('created_by').notNull(),
		expiresAt: integer('expires_at').notNull(),
		usedAt: integer('used_at'),
		deviceId: text('device_id'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [uniqueIndex('uniq_pos_pairing_codes_hash').on(table.codeHash)],
)

export const POS_ORDER_STATUSES = ['open', 'paid', 'void', 'refunded'] as const

// `id` is the terminal's own UUID, which doubles as the idempotency key.
export const posOrders = sqliteTable(
	'pos_orders',
	{
		id: text('id').primaryKey(),
		// The terminal that owns the order now (a tab can be taken over by another).
		deviceId: text('device_id')
			.notNull()
			.references(() => posDevices.id),
		number: text('number').notNull(),
		// The business day (YYYY-MM-DD), which may run past midnight. Numbers restart daily.
		businessDate: text('business_date').notNull(),
		// Highest revision received. Replays and out-of-order uploads of a lower
		// revision change nothing.
		revision: integer('revision').notNull(),
		status: text('status', { enum: [...POS_ORDER_STATUSES] }).notNull(),
		orderType: text('order_type', { enum: ['dine_in', 'takeaway'] }).notNull(),
		orderSource: text('order_source', { enum: ['counter', 'phone'] })
			.notNull()
			.default('counter'),
		customerPhone: text('customer_phone'),
		pickupAt: integer('pickup_at'),
		pickupTimeZone: text('pickup_time_zone'),
		guestName: text('guest_name'),
		tableLabel: text('table_label'),
		// Who rang the order up, as signed in at the till (id plus the name as it was
		// then, so history survives a rename or a departure). Null when the terminal
		// does not require sign-in. `signIn` says whether the PIN was checked by the
		// server (`online`) or only by the till (`offline`).
		staffId: text('staff_id'),
		staffName: text('staff_name'),
		signIn: text('sign_in', { enum: ['online', 'offline'] }),
		voidedByStaffId: text('voided_by_staff_id'),
		voidedByStaffName: text('voided_by_staff_name'),
		voidReason: text('void_reason'),
		voidApprovedByStaffId: text('void_approved_by_staff_id'),
		voidApprovedByStaffName: text('void_approved_by_staff_name'),
		locationId: text('location_id').notNull(),
		locationName: text('location_name'),
		currency: text('currency').notNull(),
		taxRatePercent: real('tax_rate_percent'),
		taxInclusive: integer('tax_inclusive', { mode: 'boolean' })
			.notNull()
			.default(false),
		// What the terminal rang up and collected: the money that changed hands.
		subtotalCents: integer('subtotal_cents').notNull(),
		adjustmentCents: integer('adjustment_cents').notNull().default(0),
		taxCents: integer('tax_cents').notNull(),
		tipCents: integer('tip_cents').notNull().default(0),
		totalCents: integer('total_cents').notNull(),
		refundedCents: integer('refunded_cents').notNull().default(0),
		// The live menu's total for the same lines, when it could be computed.
		serverTotalCents: integer('server_total_cents'),
		// Why a person should look at this sale. The first reason found sticks; every
		// revision's own verdict is kept on `pos_order_revisions`.
		reviewReason: text('review_reason'),
		lines: text('lines', { mode: 'json' }).notNull(),
		// Items taken off after the order was saved (append-only, see the contract).
		lineVoids: text('line_voids', { mode: 'json' })
			.notNull()
			.default(sql`'[]'`),
		adjustments: text('adjustments', { mode: 'json' }).notNull(),
		catalogFetchedAt: integer('catalog_fetched_at'),
		// The drawer shift it was rung up in, when the terminal tracks shifts.
		shiftId: text('shift_id'),
		rungUpAt: integer('rung_up_at').notNull(),
		receivedAt: integer('received_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
		paidAt: integer('paid_at'),
		voidedAt: integer('voided_at'),
		refundedAt: integer('refunded_at'),
	},
	(table) => [
		uniqueIndex('uniq_pos_orders_device_day_number').on(
			table.deviceId,
			table.businessDate,
			table.number,
		),
		index('idx_pos_orders_status_rung_up').on(table.status, table.rungUpAt),
		index('idx_pos_orders_business_date').on(
			table.businessDate,
			table.locationId,
		),
		index('idx_pos_orders_review').on(table.reviewReason),
		// Guest names are cleared after a retention period; this finds the ones left.
		index('idx_pos_orders_guest_name')
			.on(table.updatedAt)
			.where(sql`${table.guestName} is not null`),
	],
)

// Payments and refunds. A refund is its own row (`kind = 'refund'`) pointing at
// the payment it gives money back from, so a day's takings are one sum.
export const posPayments = sqliteTable(
	'pos_payments',
	{
		// The terminal's payment or refund UUID: a replay can never insert it twice.
		id: text('id').primaryKey(),
		orderId: text('order_id')
			.notNull()
			.references(() => posOrders.id, { onDelete: 'restrict' }),
		deviceId: text('device_id').notNull(),
		kind: text('kind', { enum: ['payment', 'refund'] })
			.notNull()
			.default('payment'),
		refundOf: text('refund_of'),
		staffId: text('staff_id'),
		staffName: text('staff_name'),
		approvedByStaffId: text('approved_by_staff_id'),
		approvedByStaffName: text('approved_by_staff_name'),
		reason: text('reason'),
		method: text('method', { enum: ['cash', 'card', 'other'] }).notNull(),
		amountCents: integer('amount_cents').notNull(),
		tenderedCents: integer('tendered_cents').notNull(),
		// Card terminal approval code or similar, for matching the processor's statement.
		reference: text('reference'),
		// The drawer shift the money moved in (a tab may be paid in a later shift).
		shiftId: text('shift_id'),
		paidAt: integer('paid_at').notNull(),
		receivedAt: integer('received_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_pos_payments_order').on(table.orderId),
		index('idx_pos_payments_paid_at').on(table.paidAt),
		index('idx_pos_payments_shift').on(table.shiftId),
	],
)

// A cash drawer session on one terminal, as the till reported it. The server's
// own expected figure is worked out from the payments it holds when a report is
// asked for, so payments that arrive after the close still count.
export const posShifts = sqliteTable(
	'pos_shifts',
	{
		id: text('id').primaryKey(),
		deviceId: text('device_id').notNull(),
		businessDate: text('business_date').notNull(),
		revision: integer('revision').notNull(),
		status: text('status', { enum: ['open', 'closed'] }).notNull(),
		openedAt: integer('opened_at').notNull(),
		openedByStaffId: text('opened_by_staff_id'),
		openedByStaffName: text('opened_by_staff_name'),
		openingFloatCents: integer('opening_float_cents').notNull(),
		closedAt: integer('closed_at'),
		closedByStaffId: text('closed_by_staff_id'),
		closedByStaffName: text('closed_by_staff_name'),
		countedCashCents: integer('counted_cash_cents'),
		// The till's expected figure at the close.
		expectedCashCents: integer('expected_cash_cents'),
		receivedAt: integer('received_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_pos_shifts_device_opened').on(table.deviceId, table.openedAt),
		index('idx_pos_shifts_business_date').on(table.businessDate),
	],
)

// Cash put into or taken out of a drawer outside a sale. Append-only.
export const posCashMovements = sqliteTable(
	'pos_cash_movements',
	{
		id: text('id').primaryKey(),
		shiftId: text('shift_id')
			.notNull()
			.references(() => posShifts.id, { onDelete: 'restrict' }),
		kind: text('kind', { enum: ['pay_in', 'pay_out'] }).notNull(),
		amountCents: integer('amount_cents').notNull(),
		note: text('note').notNull(),
		staffId: text('staff_id'),
		staffName: text('staff_name'),
		approvedByStaffId: text('approved_by_staff_id'),
		approvedByStaffName: text('approved_by_staff_name'),
		at: integer('at').notNull(),
		receivedAt: integer('received_at').notNull().default(nowMs),
	},
	(table) => [index('idx_pos_cash_movements_shift').on(table.shiftId)],
)

// Every accepted revision of every order, exactly as uploaded but with staff
// names and customer contact removed (ids only for staff).
export const posOrderRevisions = sqliteTable(
	'pos_order_revisions',
	{
		orderId: text('order_id').notNull(),
		revision: integer('revision').notNull(),
		deviceId: text('device_id').notNull(),
		reviewReason: text('review_reason'),
		snapshot: text('snapshot', { mode: 'json' }).notNull(),
		receivedAt: integer('received_at').notNull().default(nowMs),
	},
	(table) => [primaryKey({ columns: [table.orderId, table.revision] })],
)

// The current lines of each order, one row each, for item sales reports.
export const posOrderLines = sqliteTable(
	'pos_order_lines',
	{
		orderId: text('order_id')
			.notNull()
			.references(() => posOrders.id, { onDelete: 'cascade' }),
		lineIndex: integer('line_index').notNull(),
		itemId: text('item_id').notNull(),
		name: text('name').notNull(),
		variantId: text('variant_id'),
		quantity: integer('quantity').notNull(),
		unitCents: integer('unit_cents').notNull(),
		totalCents: integer('total_cents').notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orderId, table.lineIndex] }),
		index('idx_pos_order_lines_item').on(table.itemId),
	],
)

// A tab taken over by another terminal (the guest moved, or the shift ended).
export const posOrderTransfers = sqliteTable(
	'pos_order_transfers',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		orderId: text('order_id').notNull(),
		fromDeviceId: text('from_device_id').notNull(),
		toDeviceId: text('to_device_id').notNull(),
		revision: integer('revision').notNull(),
		staffId: text('staff_id'),
		at: integer('at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_pos_order_transfers_from').on(table.fromDeviceId, table.at),
		index('idx_pos_order_transfers_order').on(table.orderId),
	],
)

// Uploads the server could not apply (an unreadable contract, a change to a closed
// bill, a tab that moved): kept verbatim for a person to settle, never dropped.
export const posHeldUploads = sqliteTable(
	'pos_held_uploads',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		deviceId: text('device_id').notNull(),
		orderId: text('order_id'),
		revision: integer('revision'),
		error: text('error').notNull(),
		message: text('message'),
		contractVersion: integer('contract_version'),
		payload: text('payload').notNull(),
		receivedAt: integer('received_at').notNull().default(nowMs),
		resolvedAt: integer('resolved_at'),
		resolvedBy: text('resolved_by'),
	},
	(table) => [
		index('idx_pos_held_uploads_device').on(table.deviceId, table.receivedAt),
		index('idx_pos_held_uploads_open').on(table.resolvedAt),
	],
)

// The till's fiscal chain (invoices and credit notes), as issued on the device.
// `pos-fiscal.ts` in @repo/common defines the hash.
export const posFiscalDocuments = sqliteTable(
	'pos_fiscal_documents',
	{
		docId: text('doc_id').primaryKey(),
		chainId: text('chain_id').notNull(),
		counter: integer('counter').notNull(),
		kind: text('kind', { enum: ['invoice', 'credit_note'] }).notNull(),
		orderId: text('order_id').notNull(),
		deviceId: text('device_id').notNull(),
		issuedAt: integer('issued_at').notNull(),
		currency: text('currency').notNull(),
		totalCents: integer('total_cents').notNull(),
		taxCents: integer('tax_cents').notNull(),
		previousHash: text('previous_hash').notNull(),
		hash: text('hash').notNull(),
		// Null when the document checks out; otherwise why it does not.
		problem: text('problem'),
		receivedAt: integer('received_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_pos_fiscal_chain_counter').on(table.chainId, table.counter),
		index('idx_pos_fiscal_order').on(table.orderId),
	],
)

// ZATCA e-invoicing (Phase 2) for walk-in sales. One settings row per
// organization (the seller as ZATCA knows it), one EGS unit per terminal (its
// signing key and CSIDs, secrets sealed), and every signed document waiting to
// be, or already, reported to ZATCA.
export const posZatcaSettings = sqliteTable('pos_zatca_settings', {
	id: text('id').primaryKey(),
	environment: text('environment', {
		enum: ['sandbox', 'simulation', 'production'],
	}).notNull(),
	sellerName: text('seller_name').notNull(),
	vatNumber: text('vat_number').notNull(),
	crNumber: text('cr_number').notNull(),
	street: text('street').notNull(),
	buildingNumber: text('building_number').notNull(),
	district: text('district').notNull(),
	city: text('city').notNull(),
	postalCode: text('postal_code').notNull(),
	businessCategory: text('business_category').notNull(),
	branchName: text('branch_name').notNull(),
	updatedBy: text('updated_by').notNull(),
	updatedAt: integer('updated_at').notNull().default(nowMs),
})

export const posZatcaUnits = sqliteTable('pos_zatca_units', {
	deviceId: text('device_id')
		.primaryKey()
		.references(() => posDevices.id, { onDelete: 'restrict' }),
	environment: text('environment', {
		enum: ['sandbox', 'simulation', 'production'],
	}).notNull(),
	// `revoked`: the terminal was removed; the unit never signs or reports again
	// (documents it uploaded before then are still reported).
	status: text('status', {
		enum: ['onboarding', 'active', 'failed', 'revoked'],
	}).notNull(),
	// Sealed (AES-256-GCM); the till receives the key to sign offline.
	privateKeySealed: text('private_key_sealed').notNull(),
	complianceRequestId: text('compliance_request_id'),
	complianceToken: text('compliance_token'),
	complianceSecretSealed: text('compliance_secret_sealed'),
	productionToken: text('production_token'),
	productionSecretSealed: text('production_secret_sealed'),
	lastError: text('last_error'),
	onboardedAt: integer('onboarded_at'),
	// The seller as it was when the unit was onboarded: its certificate was
	// issued for these details, so a later settings change does not alter what
	// the till signs until the unit is onboarded again.
	seller: text('seller', { mode: 'json' }).$type<{
		name: string
		vatNumber: string
		crNumber: string
		street: string
		buildingNumber: string
		district: string
		city: string
		postalCode: string
	}>(),
	// When ZATCA last refused the production CSID (401): revoked or expired. A
	// manager has to onboard the unit again; reporting backs off meanwhile.
	authFailedAt: integer('auth_failed_at'),
	revokedAt: integer('revoked_at'),
	updatedAt: integer('updated_at').notNull().default(nowMs),
})

export const posZatcaSubmissions = sqliteTable(
	'pos_zatca_submissions',
	{
		docId: text('doc_id').primaryKey(),
		deviceId: text('device_id').notNull(),
		orderId: text('order_id').notNull(),
		kind: text('kind', { enum: ['invoice', 'credit_note'] }).notNull(),
		counter: integer('counter').notNull(),
		uuid: text('uuid').notNull(),
		invoiceHash: text('invoice_hash').notNull(),
		xmlBase64: text('xml_base64').notNull(),
		status: text('status', {
			enum: ['pending', 'reported', 'warning', 'rejected'],
		}).notNull(),
		attempts: integer('attempts').notNull().default(0),
		nextAttemptAt: integer('next_attempt_at').notNull().default(0),
		// ZATCA's answer (validation results), kept for the record.
		response: text('response', { mode: 'json' }),
		lastError: text('last_error'),
		issuedAt: integer('issued_at').notNull(),
		reportedAt: integer('reported_at'),
		receivedAt: integer('received_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_pos_zatca_submissions_due').on(
			table.status,
			table.nextAttemptAt,
		),
		// One document per invoice counter value (ICV) of a unit.
		uniqueIndex('idx_pos_zatca_submissions_counter').on(
			table.deviceId,
			table.counter,
		),
	],
)

// PIN sign-in failure counters for a POS terminal (same escalating backoff as
// kiosks: a device is never locked out, only slowed). In the organization's
// database because in-process limiters reset per isolate.
export const posPinAttempts = sqliteTable('pos_pin_attempts', {
	deviceId: text('device_id')
		.primaryKey()
		.references(() => posDevices.id, { onDelete: 'cascade' }),
	failures: integer('failures').notNull().default(0),
	lastFailureAt: integer('last_failure_at'),
	blockedUntil: integer('blocked_until'),
	hourStartedAt: integer('hour_started_at'),
	hourFailures: integer('hour_failures').notNull().default(0),
	hourAlertedAt: integer('hour_alerted_at'),
	updatedAt: integer('updated_at').notNull().default(nowMs),
})

// Staff who may manage a till (change its settings, and later approve voids and
// refunds). Everyone else with a PIN is a cashier.
export const posManagers = sqliteTable('pos_managers', {
	staffId: text('staff_id')
		.primaryKey()
		.references(() => staffMembers.id, { onDelete: 'cascade' }),
	addedBy: text('added_by').notNull(),
	addedAt: integer('added_at').notNull().default(nowMs),
})

// Per-device PIN failure counters (escalating backoff, never a device lock).
// Stored in the org database because the in-process rate limiter resets per
// isolate and is not shared across Durable Objects or processes.
export const kioskAttempts = sqliteTable('kiosk_attempts', {
	deviceId: text('device_id')
		.primaryKey()
		.references(() => kioskDevices.id, { onDelete: 'cascade' }),
	failures: integer('failures').notNull().default(0),
	lastFailureAt: integer('last_failure_at'),
	blockedUntil: integer('blocked_until'),
	hourStartedAt: integer('hour_started_at'),
	hourFailures: integer('hour_failures').notNull().default(0),
	hourAlertedAt: integer('hour_alerted_at'),
	updatedAt: integer('updated_at').notNull().default(nowMs),
})

export const timeEntries = sqliteTable(
	'time_entries',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		staffId: text('staff_id')
			.notNull()
			.references(() => staffMembers.id),
		scopeId: text('scope_id').notNull(),
		// The pay row and position the person clocked in under (null when the
		// person has no job at the scope).
		jobId: text('job_id'),
		positionId: text('position_id'),
		// Nullable: the schedule is independent of the clock.
		shiftId: text('shift_id'),
		clockInAt: integer('clock_in_at').notNull(),
		clockOutAt: integer('clock_out_at'),
		// Scope time zone and business date, fixed when the entry is created.
		timeZone: text('time_zone').notNull(),
		localDate: text('local_date').notNull(),
		status: text('status', { enum: [...TIME_ENTRY_STATUS_VALUES] })
			.notNull()
			.default('open'),
		// JSON array of issue codes (see `@repo/staffing` ENTRY_ISSUE_CODES).
		issues: text('issues', { mode: 'json' })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		// Rate snapshot at clock-in, so a later raise never reprices history.
		rateMinor: integer('rate_minor'),
		currency: text('currency'),
		overtimeExempt: integer('overtime_exempt', { mode: 'boolean' })
			.notNull()
			.default(false),
		breakWaived: integer('break_waived', { mode: 'boolean' })
			.notNull()
			.default(false),
		// Cached from the shared time math whenever the card changes.
		regularMinutes: integer('regular_minutes').notNull().default(0),
		overtimeMinutes: integer('overtime_minutes').notNull().default(0),
		doubleTimeMinutes: integer('double_time_minutes').notNull().default(0),
		holidayMinutes: integer('holiday_minutes').notNull().default(0),
		paidMinutes: integer('paid_minutes').notNull().default(0),
		unpaidBreakMinutes: integer('unpaid_break_minutes').notNull().default(0),
		cashTipsMinor: integer('cash_tips_minor').notNull().default(0),
		creditTipsMinor: integer('credit_tips_minor').notNull().default(0),
		// How the entry was closed: kiosk, manager, auto.
		clockOutKind: text('clock_out_kind'),
		approvedBy: text('approved_by'),
		approvedAt: integer('approved_at'),
		lockedBy: text('locked_by'),
		lockedAt: integer('locked_at'),
		// A manager's "looked at it" for a card whose issues are not errors. It
		// takes the card out of the needs-review queue until the next edit.
		reviewedBy: text('reviewed_by'),
		reviewedAt: integer('reviewed_at'),
		// Free text for the manager; never shown on a kiosk.
		managerNote: text('manager_note'),
		voidedAt: integer('voided_at'),
		voidedBy: text('voided_by'),
		version: integer('version').notNull().default(1),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		// One open entry per person, across every scope.
		uniqueIndex('uniq_time_entries_open_staff')
			.on(table.staffId)
			.where(sql`${table.clockOutAt} is null and ${table.voidedAt} is null`),
		index('idx_time_entries_staff_in').on(table.staffId, table.clockInAt),
		index('idx_time_entries_scope_date').on(table.scopeId, table.localDate),
		index('idx_time_entries_status').on(table.status),
		index('idx_time_entries_local_date').on(table.localDate),
	],
)

export const timeBreaks = sqliteTable(
	'time_breaks',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		entryId: text('entry_id')
			.notNull()
			.references(() => timeEntries.id),
		kind: text('kind', { enum: [...TIME_BREAK_KIND_VALUES] })
			.notNull()
			.default('meal'),
		paid: integer('paid', { mode: 'boolean' }).notNull().default(false),
		startAt: integer('start_at').notNull(),
		endAt: integer('end_at'),
		startPunchId: text('start_punch_id'),
		endPunchId: text('end_punch_id'),
		voidedAt: integer('voided_at'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_time_breaks_entry').on(table.entryId, table.startAt),
		uniqueIndex('uniq_time_breaks_open_entry')
			.on(table.entryId)
			.where(sql`${table.endAt} is null and ${table.voidedAt} is null`),
	],
)

// Append-only (triggers reject update and delete). The client-generated id is
// the idempotency key: replaying the same id returns the stored result.
export const timePunches = sqliteTable(
	'time_punches',
	{
		id: text('id').primaryKey(),
		staffId: text('staff_id')
			.notNull()
			.references(() => staffMembers.id),
		scopeId: text('scope_id').notNull(),
		entryId: text('entry_id'),
		kind: text('kind', { enum: [...PUNCH_KIND_VALUES] }).notNull(),
		// What the device said, what the server saw, and what the punch counts as.
		clientAt: integer('client_at').notNull(),
		serverAt: integer('server_at').notNull(),
		effectiveAt: integer('effective_at'),
		source: text('source', { enum: [...PUNCH_SOURCE_VALUES] }).notNull(),
		deviceId: text('device_id'),
		outcome: text('outcome', { enum: [...PUNCH_OUTCOME_VALUES] }).notNull(),
		rejectCode: text('reject_code'),
		flags: text('flags', { mode: 'json' })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		positionId: text('position_id'),
		timeZone: text('time_zone').notNull(),
		localDate: text('local_date').notNull(),
		// GPS and geofence result are reserved for the personal clock; nullable.
		latitude: real('latitude'),
		longitude: real('longitude'),
		accuracyMeters: real('accuracy_meters'),
		geofenceResult: text('geofence_result'),
		// Keyed hash, never the raw address.
		ipHash: text('ip_hash'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_time_punches_staff').on(table.staffId, table.serverAt),
		index('idx_time_punches_entry').on(table.entryId),
		index('idx_time_punches_scope').on(table.scopeId, table.serverAt),
		index('idx_time_punches_device').on(table.deviceId, table.serverAt),
	],
)

// Append-only edit log for time cards. A reason is required (a trigger rejects
// blank ones). Employee-visible history and the dispute path build on it.
export const timeEntryEdits = sqliteTable(
	'time_entry_edits',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		entryId: text('entry_id')
			.notNull()
			.references(() => timeEntries.id),
		staffId: text('staff_id').notNull(),
		scopeId: text('scope_id').notNull(),
		// Opaque operator user id, or a system actor id.
		editorId: text('editor_id').notNull(),
		// manager, system, auto_clock_out, kiosk.
		via: text('via').notNull(),
		// create, update, void, approve, lock, unlock, auto_clock_out, dispute.
		action: text('action').notNull(),
		reason: text('reason').notNull(),
		before: text('before', { mode: 'json' }),
		after: text('after', { mode: 'json' }),
		// Change in paid minutes this edit made to the card on its own (negative
		// when it reduced the person's hours); null for actions that do not move
		// time, such as an approval.
		hoursDeltaMinutes: integer('hours_delta_minutes'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_time_entry_edits_entry').on(table.entryId, table.createdAt),
		index('idx_time_entry_edits_staff').on(table.staffId, table.createdAt),
	],
)

export const timesheetPeriods = sqliteTable(
	'timesheet_periods',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// Null covers every scope.
		scopeId: text('scope_id'),
		// The scope id, or '*' for every scope.
		scopeKey: text('scope_key').notNull(),
		startDate: text('start_date').notNull(),
		endDate: text('end_date').notNull(),
		status: text('status').notNull().default('open'),
		closedAt: integer('closed_at'),
		closedBy: text('closed_by'),
		lockedAt: integer('locked_at'),
		lockedBy: text('locked_by'),
		createdBy: text('created_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_timesheet_periods_range').on(
			table.scopeKey,
			table.startDate,
			table.endDate,
		),
	],
)

// Messages tenant-api owes staff (for example "your time card was edited"). A
// row is written in the same transaction as the change that caused it, so a
// delivery tick can send it later and never twice (`dedupe_key` is unique).
// The payload names ids and a few facts, never pay.
export const NOTIFICATION_OUTBOX_STATUS_VALUES = [
	'pending',
	'sent',
	'failed',
	'skipped',
] as const

export const notificationOutbox = sqliteTable(
	'notification_outbox',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// Event name, for example `time_card_edited`.
		kind: text('kind').notNull(),
		staffId: text('staff_id').notNull(),
		scopeId: text('scope_id'),
		dedupeKey: text('dedupe_key').notNull(),
		payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
		status: text('status', { enum: [...NOTIFICATION_OUTBOX_STATUS_VALUES] })
			.notNull()
			.default('pending'),
		attempts: integer('attempts').notNull().default(0),
		nextAttemptAt: integer('next_attempt_at').notNull().default(nowMs),
		lastError: text('last_error'),
		sentAt: integer('sent_at'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_notification_outbox_dedupe').on(table.dedupeKey),
		index('idx_notification_outbox_due').on(table.status, table.nextAttemptAt),
		index('idx_notification_outbox_staff').on(table.staffId, table.createdAt),
	],
)

export const timeEntriesRelations = relations(timeEntries, ({ one, many }) => ({
	staff: one(staffMembers, {
		fields: [timeEntries.staffId],
		references: [staffMembers.id],
	}),
	breaks: many(timeBreaks),
	edits: many(timeEntryEdits),
}))

export const timeBreaksRelations = relations(timeBreaks, ({ one }) => ({
	entry: one(timeEntries, {
		fields: [timeBreaks.entryId],
		references: [timeEntries.id],
	}),
}))

export const timeEntryEditsRelations = relations(timeEntryEdits, ({ one }) => ({
	entry: one(timeEntries, {
		fields: [timeEntryEdits.entryId],
		references: [timeEntries.id],
	}),
}))

// ==========================================
// 11d. SCHEDULING (weeks, shifts, templates, availability, time off, requests)
// ==========================================
// Same conventions as the staff tables: `*_at` epoch milliseconds (UTC),
// `*_date` as `YYYY-MM-DD` in the scope time zone, minutes as integers.
// Everything here is HR data and stays in the regional database.
//
// A shift is `draft` until its week is published. Editing a published shift
// never touches the published fields: the proposed change is written to
// `draft_patch` and applied when the week is published, so staff keep seeing
// the published version until then.

export const SHIFT_STATUS_VALUES = ['draft', 'published', 'cancelled'] as const
export const AVAILABILITY_KIND_VALUES = ['weekly', 'one_off'] as const
export const AVAILABILITY_WINDOW_VALUES = ['available', 'unavailable'] as const
export const SCHEDULE_REQUEST_STATUS_VALUES = [
	'pending',
	'approved',
	'rejected',
	'cancelled',
] as const
export const AVAILABILITY_STATUS_VALUES = [
	'pending',
	'approved',
	'rejected',
	'cancelled',
	'superseded',
] as const
export const TIME_OFF_CATEGORY_VALUES = ['unpaid', 'pto', 'sick'] as const
export const SCHEDULE_SOURCE_VALUES = ['manager', 'staff'] as const
export const SHIFT_REQUEST_KIND_VALUES = ['swap', 'cover', 'drop'] as const
export const SCHEDULE_NOTIFY_MODE_VALUES = [
	'everyone',
	'changed',
	'nobody',
] as const

/** A proposed change to a published shift, applied at publish time. */
export type ShiftDraftPatch = {
	/** `null` makes the shift open; absent leaves the person unchanged. */
	staffId?: string | null
	positionId?: string | null
	startsAt?: number
	endsAt?: number
	localDate?: string
	unpaidBreakMinutes?: number
	notes?: string | null
	/** Delete: the shift is cancelled when the week is published. */
	cancel?: boolean
}

/** One slot of a shift template, relative to a weekday rather than a date. */
export type ShiftTemplateSlot = {
	/** 0 = Sunday ... 6 = Saturday. */
	weekday: number
	startMinute: number
	/** Whole days after the start day the shift ends on (1 for an overnight). */
	endDayOffset: number
	endMinute: number
	positionId: string | null
	staffId: string | null
	unpaidBreakMinutes: number
	notes: string | null
}

/** Who a publication meant to tell. Ids and counts only. */
export type SchedulePublicationNotification = {
	mode: (typeof SCHEDULE_NOTIFY_MODE_VALUES)[number]
	recipients: number
	queued: number
	notReached: Array<{
		staffId: string
		reason: 'no_email' | 'inactive' | 'email_disabled'
	}>
}

export type SchedulePublicationChange = {
	shiftId: string
	kind: 'created' | 'changed' | 'cancelled'
	staffId: string | null
	/** Person the shift belonged to before a change, when it moved. */
	previousStaffId?: string | null
}

// One row per organization (`id = 'org'`).
export const scheduleSettings = sqliteTable('schedule_settings', {
	id: text('id').primaryKey().default('org'),
	// Shortest rest between a shift ending and the person's next shift on
	// another day. Zero switches the warning off.
	minRestMinutes: integer('min_rest_minutes').notNull().default(480),
	// Days of notice a time-off request should give; a shorter notice is a
	// warning for the approver, never a refusal.
	timeOffMinNoticeDays: integer('time_off_min_notice_days')
		.notNull()
		.default(0),
	updatedBy: text('updated_by'),
	updatedAt: integer('updated_at').notNull().default(nowMs),
})

// One row per scope and workweek; carries the publish counter. Shifts are
// found by `local_date`, not by a foreign key, so changing the scope's week
// start never orphans a shift.
export const scheduleWeeks = sqliteTable(
	'schedule_weeks',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		scopeId: text('scope_id').notNull(),
		weekStartDate: text('week_start_date').notNull(),
		// Number of times the week was published.
		version: integer('version').notNull().default(0),
		lastPublishedAt: integer('last_published_at'),
		lastPublishedBy: text('last_published_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_schedule_weeks_scope_week').on(
			table.scopeId,
			table.weekStartDate,
		),
	],
)

export const shifts = sqliteTable(
	'shifts',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// Opaque control-plane scope id.
		scopeId: text('scope_id').notNull(),
		// Null means an open shift nobody holds yet.
		staffId: text('staff_id').references(() => staffMembers.id),
		positionId: text('position_id').references(() => staffPositions.id),
		startsAt: integer('starts_at').notNull(),
		endsAt: integer('ends_at').notNull(),
		// Business date of the start in the scope time zone, and the zone
		// itself, fixed when the shift is written.
		localDate: text('local_date').notNull(),
		timeZone: text('time_zone').notNull(),
		unpaidBreakMinutes: integer('unpaid_break_minutes').notNull().default(0),
		notes: text('notes'),
		status: text('status', { enum: [...SHIFT_STATUS_VALUES] })
			.notNull()
			.default('draft'),
		draftPatch: text('draft_patch', { mode: 'json' }).$type<ShiftDraftPatch>(),
		publishedAt: integer('published_at'),
		// `schedule_weeks.version` of the publication that last changed it.
		publishedVersion: integer('published_version'),
		cancelledAt: integer('cancelled_at'),
		createdBy: text('created_by'),
		updatedBy: text('updated_by'),
		version: integer('version').notNull().default(1),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_shifts_scope_date').on(table.scopeId, table.localDate),
		index('idx_shifts_staff_start').on(table.staffId, table.startsAt),
		index('idx_shifts_range').on(table.startsAt, table.endsAt),
		index('idx_shifts_status').on(table.status),
	],
)

// Append-only (triggers reject update and delete): publish history.
export const schedulePublications = sqliteTable(
	'schedule_publications',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		scopeId: text('scope_id').notNull(),
		weekStartDate: text('week_start_date').notNull(),
		version: integer('version').notNull(),
		notifyMode: text('notify_mode', { enum: [...SCHEDULE_NOTIFY_MODE_VALUES] })
			.notNull()
			.default('changed'),
		// Counts only: created, changed, cancelled, shifts and open shifts.
		summary: text('summary', { mode: 'json' })
			.$type<Record<string, number>>()
			.notNull(),
		// Shift and staff ids only, never names or times.
		changes: text('changes', { mode: 'json' })
			.$type<SchedulePublicationChange[]>()
			.notNull()
			.default(sql`'[]'`),
		// Who the publication meant to tell and who could not be reached (ids and
		// counts). Written with the row: the table is append-only. Null on rows
		// published before notifications existed.
		notification: text('notification', {
			mode: 'json',
		}).$type<SchedulePublicationNotification>(),
		publishedBy: text('published_by').notNull(),
		publishedAt: integer('published_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_schedule_publications_version').on(
			table.scopeId,
			table.weekStartDate,
			table.version,
		),
		index('idx_schedule_publications_scope').on(
			table.scopeId,
			table.publishedAt,
		),
	],
)

// A person's read-only "my schedule" capability. The token itself is derived
// (HMAC of the link and the person, from AUTH_HMAC_SECRET) so the same email can
// be sent again; only a keyed hash of it is stored. At most one live link per
// person. Revoking sets `revoked_at`; the row is kept as history.
export const scheduleLinks = sqliteTable(
	'schedule_links',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		staffId: text('staff_id')
			.notNull()
			.references(() => staffMembers.id),
		tokenHash: text('token_hash').notNull(),
		createdAt: integer('created_at').notNull().default(nowMs),
		// Extended each time an email carries the link.
		expiresAt: integer('expires_at').notNull(),
		lastUsedAt: integer('last_used_at'),
		revokedAt: integer('revoked_at'),
		// Opaque operator user id, or `system` (left the roster).
		revokedBy: text('revoked_by'),
	},
	(table) => [
		uniqueIndex('uniq_schedule_links_token_hash').on(table.tokenHash),
		uniqueIndex('uniq_schedule_links_live')
			.on(table.staffId)
			.where(sql`${table.revokedAt} is null`),
		index('idx_schedule_links_staff').on(table.staffId),
	],
)

export const shiftTemplates = sqliteTable(
	'shift_templates',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		scopeId: text('scope_id').notNull(),
		name: text('name').notNull(),
		slots: text('slots', { mode: 'json' })
			.$type<ShiftTemplateSlot[]>()
			.notNull(),
		slotCount: integer('slot_count').notNull().default(0),
		createdBy: text('created_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_shift_templates_scope_name').on(
			table.scopeId,
			sql`lower(${table.name})`,
		),
	],
)

// Weekly or one-off windows when a person can or cannot work. Only approved
// rows count. A one-off row for a date replaces that weekday's weekly rows for
// the date. A person with approved "available" windows on a day can work only
// inside them; "unavailable" windows always rule time out.
export const staffAvailability = sqliteTable(
	'staff_availability',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		staffId: text('staff_id')
			.notNull()
			.references(() => staffMembers.id),
		kind: text('kind', { enum: [...AVAILABILITY_KIND_VALUES] }).notNull(),
		// 0 = Sunday ... 6 = Saturday (weekly rows).
		weekday: integer('weekday'),
		// `YYYY-MM-DD` (one-off rows).
		date: text('date'),
		availability: text('availability', {
			enum: [...AVAILABILITY_WINDOW_VALUES],
		})
			.notNull()
			.default('unavailable'),
		allDay: integer('all_day', { mode: 'boolean' }).notNull().default(true),
		// Minutes after local midnight; the end is exclusive and at most 1440.
		startMinute: integer('start_minute'),
		endMinute: integer('end_minute'),
		effectiveFrom: text('effective_from'),
		effectiveTo: text('effective_to'),
		note: text('note'),
		status: text('status', { enum: [...AVAILABILITY_STATUS_VALUES] })
			.notNull()
			.default('pending'),
		source: text('source', { enum: [...SCHEDULE_SOURCE_VALUES] })
			.notNull()
			.default('manager'),
		// Opaque operator id for manager-entered rows.
		requestedBy: text('requested_by'),
		decidedBy: text('decided_by'),
		decidedAt: integer('decided_at'),
		decisionNote: text('decision_note'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_staff_availability_staff').on(table.staffId, table.status),
		index('idx_staff_availability_status').on(table.status, table.createdAt),
	],
)

export const timeOffRequests = sqliteTable(
	'time_off_requests',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		staffId: text('staff_id')
			.notNull()
			.references(() => staffMembers.id),
		category: text('category', { enum: [...TIME_OFF_CATEGORY_VALUES] })
			.notNull()
			.default('unpaid'),
		// Inclusive calendar dates in the person's working time zone.
		startDate: text('start_date').notNull(),
		endDate: text('end_date').notNull(),
		allDay: integer('all_day', { mode: 'boolean' }).notNull().default(true),
		// A partial day (single date only): minutes after local midnight, end exclusive.
		startMinute: integer('start_minute'),
		endMinute: integer('end_minute'),
		note: text('note'),
		status: text('status', { enum: [...SCHEDULE_REQUEST_STATUS_VALUES] })
			.notNull()
			.default('pending'),
		source: text('source', { enum: [...SCHEDULE_SOURCE_VALUES] })
			.notNull()
			.default('manager'),
		requestedBy: text('requested_by'),
		decidedBy: text('decided_by'),
		decidedAt: integer('decided_at'),
		decisionNote: text('decision_note'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_time_off_staff').on(table.staffId, table.startDate),
		index('idx_time_off_status').on(table.status, table.startDate),
	],
)

// A swap, cover or drop asked for a shift, waiting for a manager. Approval
// changes the shift through the same draft mechanics as any edit.
export const shiftRequests = sqliteTable(
	'shift_requests',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		kind: text('kind', { enum: [...SHIFT_REQUEST_KIND_VALUES] }).notNull(),
		shiftId: text('shift_id')
			.notNull()
			.references(() => shifts.id),
		requesterStaffId: text('requester_staff_id')
			.notNull()
			.references(() => staffMembers.id),
		// Swap: the person trading shifts. Cover: the person taking the shift.
		targetStaffId: text('target_staff_id').references(() => staffMembers.id),
		// Swap only: the shift the requester gets in return.
		targetShiftId: text('target_shift_id').references(() => shifts.id),
		note: text('note'),
		status: text('status', { enum: [...SCHEDULE_REQUEST_STATUS_VALUES] })
			.notNull()
			.default('pending'),
		source: text('source', { enum: [...SCHEDULE_SOURCE_VALUES] })
			.notNull()
			.default('manager'),
		requestedBy: text('requested_by'),
		decidedBy: text('decided_by'),
		decidedAt: integer('decided_at'),
		decisionNote: text('decision_note'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		// One open request per shift keeps approvals unambiguous.
		uniqueIndex('uniq_shift_requests_pending_shift')
			.on(table.shiftId)
			.where(sql`${table.status} = 'pending'`),
		index('idx_shift_requests_status').on(table.status, table.createdAt),
		index('idx_shift_requests_requester').on(table.requesterStaffId),
	],
)

// ==========================================
// LABOR SUMMARY: SALES, TIP POOL AND STAFFING STANDARDS (labor_daily is
// derived on read from time entries, rate snapshots and orders; nothing is
// stored for it)
// ==========================================

export const SALES_SOURCE_VALUES = [
	'online_orders',
	'online_only',
	'manual',
] as const
export const SALES_ENTRY_SOURCE_VALUES = ['manual', 'csv'] as const
export const TIP_SPLIT_BASIS_VALUES = ['hours', 'position_percent'] as const
export const TIP_CADENCE_VALUES = ['period', 'daily'] as const

// One row per scope. Where the scope's sales for the labor share come
// from, and how many orders one person in a position handles per hour (the
// standard behind the forecast gap in the schedule).
export const laborScopeSettings = sqliteTable('labor_scope_settings', {
	scopeId: text('scope_id').primaryKey(),
	salesSource: text('sales_source', { enum: [...SALES_SOURCE_VALUES] })
		.notNull()
		.default('manual'),
	// JSON object: position id -> orders per labor hour (one decimal).
	ordersPerLaborHour: text('orders_per_labor_hour', { mode: 'json' })
		.$type<Record<string, number>>()
		.notNull()
		.default(sql`'{}'`),
	// JSON object: demand source id (`orders`, `visits`) -> position id ->
	// units one person in the position handles per hour. `orders` mirrors
	// `orders_per_labor_hour`, which older code still reads.
	demandPerLaborHour: text('demand_per_labor_hour', { mode: 'json' })
		.$type<Record<string, Record<string, number>>>()
		.notNull()
		.default(sql`'{}'`),
	updatedBy: text('updated_by'),
	updatedAt: integer('updated_at').notNull().default(nowMs),
})

// Net sales a team enters by hand or uploads as a file, one row per scope
// and business date. Money is integer minor units with an explicit currency.
export const salesManualEntries = sqliteTable(
	'sales_manual_entries',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		scopeId: text('scope_id').notNull(),
		// `YYYY-MM-DD`, the scope's business date.
		businessDate: text('business_date').notNull(),
		netSalesMinor: integer('net_sales_minor').notNull(),
		currency: text('currency').notNull(),
		source: text('source', { enum: [...SALES_ENTRY_SOURCE_VALUES] })
			.notNull()
			.default('manual'),
		note: text('note'),
		createdBy: text('created_by'),
		updatedBy: text('updated_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_sales_manual_entries_day').on(
			table.scopeId,
			table.businessDate,
		),
		index('idx_sales_manual_entries_date').on(table.businessDate),
	],
)

// One row per scope. How the tip-pool report splits tips: a report to help
// a manager, never a payout.
export const tipPoolSettings = sqliteTable('tip_pool_settings', {
	scopeId: text('scope_id').primaryKey(),
	splitBasis: text('split_basis', { enum: [...TIP_SPLIT_BASIS_VALUES] })
		.notNull()
		.default('hours'),
	cadence: text('cadence', { enum: [...TIP_CADENCE_VALUES] })
		.notNull()
		.default('period'),
	// Share of online-order tips withheld for card fees, in basis points.
	cardFeeBp: integer('card_fee_bp').notNull().default(0),
	// JSON array of fulfillment types whose online tips join the pool.
	fulfillment: text('fulfillment', { mode: 'json' })
		.$type<string[]>()
		.notNull()
		.default(sql`'["pickup"]'`),
	// JSON object: position id -> share of the pool in basis points.
	positionPercentBp: text('position_percent_bp', { mode: 'json' })
		.$type<Record<string, number>>()
		.notNull()
		.default(sql`'{}'`),
	updatedBy: text('updated_by'),
	updatedAt: integer('updated_at').notNull().default(nowMs),
})

// ==========================================
// 11f. HIRING (applicants, notes, interviews, timeline) AND ONBOARDING TASKS
// ==========================================
// Applicants are people who have not been hired: their contact details and
// answers are personal data and stay in the regional database. A posting is
// referred to by its opaque control-plane id plus a snapshot of its title, so a
// posting edited or deleted later never changes what an applicant applied to.
//
// `*_at` columns are epoch milliseconds (UTC). Declined applicants are purged
// when `retention_expires_at` passes; the audit log is never touched and holds
// ids only.

export const HIRING_STAGE_VALUES = [
	'new',
	'screening',
	'interview',
	'offer',
	'hired',
	'declined',
] as const
export const HIRING_SOURCE_VALUES = [
	'careers_page',
	'qr',
	'share_link',
] as const
export const HIRING_INTERVIEW_MODE_VALUES = [
	'in_person',
	'phone',
	'video',
] as const
export const HIRING_INTERVIEW_STATUS_VALUES = [
	'scheduled',
	'completed',
	'cancelled',
	'no_show',
] as const
export const HIRING_INVITE_STATUS_VALUES = [
	'not_sent',
	'sent',
	'failed',
	'no_email',
	'email_disabled',
] as const
export const HIRING_EVENT_KIND_VALUES = [
	'applied',
	'stage_changed',
	'note_added',
	'interview_scheduled',
	'interview_updated',
	'invite_sent',
	'declined',
	'reopened',
	'decline_email_sent',
	'hired',
] as const
export const ONBOARDING_TASK_STATUS_VALUES = [
	'todo',
	'done',
	'skipped',
] as const
export const ONBOARDING_TASK_SOURCE_VALUES = [
	'hire',
	'manual',
	'template',
] as const
export const ONBOARDING_TASK_TYPE_VALUES = [
	'review_profile',
	'acknowledge_policy',
	'form_link',
	'custom',
] as const
export const ONBOARDING_ASSIGNEE_VALUES = [
	'manager',
	'staff',
	'member',
] as const
export const CERTIFICATE_KIND_VALUES = [
	'food_handler',
	'health_card',
	'alcohol_service',
	'first_aid',
	'fire_safety',
	'other',
] as const

/** One answer as it was asked and given (see `@repo/staffing` screener). */
export type StoredApplicantAnswer =
	| {
			id: string
			kind: 'yes_no'
			prompt: string
			category: string
			answer: 'yes' | 'no'
			requiredAnswer: 'yes' | 'no'
			dealbreaker: boolean
	  }
	| { id: string; kind: 'open'; prompt: string; answer: string }

export const hiringApplications = sqliteTable(
	'hiring_applications',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		// Opaque control-plane id of the posting, with a snapshot of what it said.
		postingId: text('posting_id').notNull(),
		postingSlug: text('posting_slug').notNull(),
		postingTitle: text('posting_title').notNull(),
		positionName: text('position_name'),
		// The scope the person is applying at (opaque id, no foreign key). Null is
		// organization-wide.
		scopeId: text('scope_id'),
		// Every scope they said they would work at, the primary included. Empty for
		// an application that named only one.
		interestedScopeIds: text('interested_scope_ids', { mode: 'json' })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		source: text('source', { enum: [...HIRING_SOURCE_VALUES] })
			.notNull()
			.default('careers_page'),
		firstName: text('first_name').notNull(),
		lastName: text('last_name').notNull(),
		email: text('email'),
		// E.164.
		phone: text('phone'),
		// Keyed hashes of the contact details, for dedupe only (never reversible
		// without the node's secret).
		emailHash: text('email_hash'),
		phoneHash: text('phone_hash'),
		locale: text('locale').notNull().default('en'),
		answers: text('answers', { mode: 'json' })
			.$type<StoredApplicantAnswer[]>()
			.notNull()
			.default(sql`'[]'`),
		screenerScore: integer('screener_score'),
		// Question ids of dealbreakers whose answer differed from the wanted one.
		screenerFlags: text('screener_flags', { mode: 'json' })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		stage: text('stage', { enum: [...HIRING_STAGE_VALUES] })
			.notNull()
			.default('new'),
		stageChangedAt: integer('stage_changed_at').notNull().default(nowMs),
		declinedReason: text('declined_reason'),
		declinedAt: integer('declined_at'),
		// Consent to hold the application, recorded when it was submitted.
		consentAt: integer('consent_at').notNull(),
		consentVersion: text('consent_version').notNull(),
		// Set when declined; the retention job purges the row after it passes.
		retentionExpiresAt: integer('retention_expires_at'),
		hiredStaffId: text('hired_staff_id').references(() => staffMembers.id, {
			onDelete: 'set null',
		}),
		hiredAt: integer('hired_at'),
		// Keyed hash of the client address, for the per-address limit only.
		ipHash: text('ip_hash'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		// One live application per person per posting. A declined one does not
		// block applying again.
		uniqueIndex('uniq_hiring_applications_email')
			.on(table.postingId, table.emailHash)
			.where(
				sql`${table.emailHash} is not null and ${table.stage} <> 'declined'`,
			),
		uniqueIndex('uniq_hiring_applications_phone')
			.on(table.postingId, table.phoneHash)
			.where(
				sql`${table.phoneHash} is not null and ${table.stage} <> 'declined'`,
			),
		index('idx_hiring_applications_stage').on(table.stage, table.createdAt),
		index('idx_hiring_applications_posting').on(table.postingId),
		index('idx_hiring_applications_scope').on(table.scopeId),
		index('idx_hiring_applications_retention')
			.on(table.retentionExpiresAt)
			.where(sql`${table.retentionExpiresAt} is not null`),
		index('idx_hiring_applications_ip').on(table.ipHash, table.createdAt),
		index('idx_hiring_applications_hired_staff')
			.on(table.hiredStaffId)
			.where(sql`${table.hiredStaffId} is not null`),
	],
)

export const hiringNotes = sqliteTable(
	'hiring_notes',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		applicationId: text('application_id')
			.notNull()
			.references(() => hiringApplications.id, { onDelete: 'cascade' }),
		// Opaque operator user id.
		authorId: text('author_id').notNull(),
		body: text('body').notNull(),
		deletedAt: integer('deleted_at'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_hiring_notes_application').on(
			table.applicationId,
			table.createdAt,
		),
	],
)

export const hiringInterviews = sqliteTable(
	'hiring_interviews',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		applicationId: text('application_id')
			.notNull()
			.references(() => hiringApplications.id, { onDelete: 'cascade' }),
		scopeId: text('scope_id'),
		scheduledAt: integer('scheduled_at').notNull(),
		durationMinutes: integer('duration_minutes').notNull().default(30),
		mode: text('mode', { enum: [...HIRING_INTERVIEW_MODE_VALUES] })
			.notNull()
			.default('in_person'),
		// Address, call-in details or a meeting link; shown to the applicant.
		details: text('details'),
		status: text('status', { enum: [...HIRING_INTERVIEW_STATUS_VALUES] })
			.notNull()
			.default('scheduled'),
		// The manager's private notes on how it went.
		outcome: text('outcome'),
		inviteStatus: text('invite_status', {
			enum: [...HIRING_INVITE_STATUS_VALUES],
		})
			.notNull()
			.default('not_sent'),
		inviteSentAt: integer('invite_sent_at'),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_hiring_interviews_application').on(
			table.applicationId,
			table.scheduledAt,
		),
	],
)

// The candidate's timeline: what happened and when. Codes only, never free
// text, so it can be shown to anyone who may open the candidate.
export const hiringEvents = sqliteTable(
	'hiring_events',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		applicationId: text('application_id')
			.notNull()
			.references(() => hiringApplications.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: [...HIRING_EVENT_KIND_VALUES] }).notNull(),
		// Opaque operator user id; null for the applicant or the system.
		actorId: text('actor_id'),
		fromStage: text('from_stage', { enum: [...HIRING_STAGE_VALUES] }),
		toStage: text('to_stage', { enum: [...HIRING_STAGE_VALUES] }),
		detail: text('detail'),
		at: integer('at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_hiring_events_application').on(table.applicationId, table.at),
	],
)

// Checklist templates are organization-wide recipes (no personal data). A hire
// or a manual "apply template" copies the template's tasks onto the person, so
// editing or archiving a template never changes a checklist already in flight.
export const onboardingTemplates = sqliteTable(
	'onboarding_templates',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		name: text('name').notNull(),
		// At most one live default: it is attached automatically on hire.
		isDefault: integer('is_default', { mode: 'boolean' })
			.notNull()
			.default(false),
		archivedAt: integer('archived_at'),
		createdBy: text('created_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_onboarding_templates_default')
			.on(table.isDefault)
			.where(sql`${table.isDefault} = 1 AND ${table.archivedAt} IS NULL`),
	],
)

export const onboardingTemplateTasks = sqliteTable(
	'onboarding_template_tasks',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		templateId: text('template_id')
			.notNull()
			.references(() => onboardingTemplates.id, { onDelete: 'cascade' }),
		type: text('type', { enum: [...ONBOARDING_TASK_TYPE_VALUES] })
			.notNull()
			.default('custom'),
		title: text('title').notNull(),
		// The policy text to acknowledge, or what to do for a custom task.
		instructions: text('instructions'),
		// An https link to a form the organization hosts (`form_link` only).
		linkUrl: text('link_url'),
		dueInDays: integer('due_in_days').notNull().default(3),
		assignee: text('assignee', { enum: [...ONBOARDING_ASSIGNEE_VALUES] })
			.notNull()
			.default('manager'),
		// Opaque control-plane user id when `assignee` is `member`.
		assigneeUserId: text('assignee_user_id'),
		sortOrder: integer('sort_order').notNull().default(0),
	},
	(table) => [
		index('idx_onboarding_template_tasks_template').on(
			table.templateId,
			table.sortOrder,
		),
	],
)

// A new hire's checklist. Titles are not stored for the built-in tasks: the App
// renders the label for `task_key` in the viewer's language. A custom task
// carries its own `title`. Document upload is deliberately not a task type: it
// needs in-region object storage (ADR 047), which the Durable Object runtime
// does not have.
export const onboardingTasks = sqliteTable(
	'onboarding_tasks',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		staffId: text('staff_id')
			.notNull()
			.references(() => staffMembers.id, { onDelete: 'cascade' }),
		taskKey: text('task_key'),
		title: text('title'),
		type: text('type', { enum: [...ONBOARDING_TASK_TYPE_VALUES] })
			.notNull()
			.default('custom'),
		instructions: text('instructions'),
		linkUrl: text('link_url'),
		assignee: text('assignee', { enum: [...ONBOARDING_ASSIGNEE_VALUES] })
			.notNull()
			.default('manager'),
		assigneeUserId: text('assignee_user_id'),
		// Set null (not cascade) so deleting a template keeps checklists intact.
		templateId: text('template_id').references(() => onboardingTemplates.id, {
			onDelete: 'set null',
		}),
		status: text('status', { enum: [...ONBOARDING_TASK_STATUS_VALUES] })
			.notNull()
			.default('todo'),
		// `YYYY-MM-DD`.
		dueDate: text('due_date'),
		sortOrder: integer('sort_order').notNull().default(0),
		source: text('source', { enum: [...ONBOARDING_TASK_SOURCE_VALUES] })
			.notNull()
			.default('hire'),
		// 0 none, 1 due-day reminder queued, 2 overdue reminder queued.
		remindedStage: integer('reminded_stage').notNull().default(0),
		completedAt: integer('completed_at'),
		completedBy: text('completed_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_onboarding_tasks_staff').on(table.staffId, table.sortOrder),
		index('idx_onboarding_tasks_open')
			.on(table.status, table.dueDate)
			.where(sql`${table.status} = 'todo'`),
	],
)

// Certificates with an expiry (food-handler cards and the like). Dates are
// `YYYY-MM-DD` in the person's scope. No certificate number, no document:
// only that a person holds one and when it lapses.
export const staffCertificates = sqliteTable(
	'staff_certificates',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		staffId: text('staff_id')
			.notNull()
			.references(() => staffMembers.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: [...CERTIFICATE_KIND_VALUES] }).notNull(),
		// Free label, used when `kind` is `other`.
		label: text('label'),
		issuedOn: text('issued_on'),
		expiresOn: text('expires_on'),
		note: text('note'),
		// 0 none, 1 expiring-soon alert queued, 2 expired alert queued.
		alertStage: integer('alert_stage').notNull().default(0),
		createdBy: text('created_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_staff_certificates_staff').on(table.staffId),
		index('idx_staff_certificates_expiry')
			.on(table.expiresOn)
			.where(sql`${table.expiresOn} IS NOT NULL`),
	],
)

export const hiringApplicationsRelations = relations(
	hiringApplications,
	({ many }) => ({
		notes: many(hiringNotes),
		interviews: many(hiringInterviews),
		events: many(hiringEvents),
	}),
)

export const hiringNotesRelations = relations(hiringNotes, ({ one }) => ({
	application: one(hiringApplications, {
		fields: [hiringNotes.applicationId],
		references: [hiringApplications.id],
	}),
}))

export const hiringInterviewsRelations = relations(
	hiringInterviews,
	({ one }) => ({
		application: one(hiringApplications, {
			fields: [hiringInterviews.applicationId],
			references: [hiringApplications.id],
		}),
	}),
)

export const hiringEventsRelations = relations(hiringEvents, ({ one }) => ({
	application: one(hiringApplications, {
		fields: [hiringEvents.applicationId],
		references: [hiringApplications.id],
	}),
}))

// ==========================================
// 12. RESERVATIONS
// ==========================================
// Regional customer & operational reservations tables (rsv_*). Guest PII
// (names, phones, emails, allergy/dietary notes, free-form notes) stays in
// this regional SQLite database. Cross-plane events emitted through rsv_outbox
// carry only opaque IDs, counts, and money amounts — never guest PII.

export const RSV_LARGE_PARTY_MODE_VALUES = [
	'contact',
	'request',
	'disabled',
	'call_only',
] as const
export type RsvLargePartyMode = (typeof RSV_LARGE_PARTY_MODE_VALUES)[number]

export const RSV_SEATING_PREF_MODE_VALUES = [
	'off',
	'preferred',
	'strict',
	'preference',
] as const
export type RsvSeatingPrefMode = (typeof RSV_SEATING_PREF_MODE_VALUES)[number]

export const RSV_VOICE_MODE_VALUES = ['hold_link', 'confirm_on_call'] as const
export type RsvVoiceMode = (typeof RSV_VOICE_MODE_VALUES)[number]

export const RSV_TABLE_SHAPE_VALUES = [
	'round',
	'square',
	'rect',
	'booth',
	'bar',
] as const
export type RsvTableShape = (typeof RSV_TABLE_SHAPE_VALUES)[number]

export const RSV_FLOOR_ELEMENT_KIND_VALUES = [
	'wall',
	'bar',
	'door',
	'window',
	'label',
	'plant',
	'zone',
] as const
export type RsvFloorElementKind = (typeof RSV_FLOOR_ELEMENT_KIND_VALUES)[number]

export const RSV_SERVICE_AVAILABILITY_MODE_VALUES = [
	'online',
	'staff_only',
	'walk_in_only',
	'unavailable',
] as const
export type RsvServiceAvailabilityMode =
	(typeof RSV_SERVICE_AVAILABILITY_MODE_VALUES)[number]

export const RSV_PACING_CHANNEL_VALUES = ['all', 'online'] as const
export type RsvPacingChannel = (typeof RSV_PACING_CHANNEL_VALUES)[number]

export const RSV_SPECIAL_DAY_KIND_VALUES = [
	'closed',
	'online_closed',
	'modified',
	'replace',
] as const
export type RsvSpecialDayKind = (typeof RSV_SPECIAL_DAY_KIND_VALUES)[number]

export const RSV_POLICY_KIND_VALUES = [
	'none',
	'card_guarantee',
	'card_hold',
	'deposit',
	'prepay',
] as const
export type RsvPolicyKind = (typeof RSV_POLICY_KIND_VALUES)[number]

export const RSV_POLICY_REFUND_RULE_VALUES = [
	'full_before_window',
	'none',
	'partial',
] as const
export type RsvPolicyRefundRule = (typeof RSV_POLICY_REFUND_RULE_VALUES)[number]

/** The site content languages: the organization enables a subset in Website settings. */
export const RSV_MESSAGE_LOCALE_VALUES = SITE_CONTENT_LOCALES
export type RsvMessageLocale = (typeof RSV_MESSAGE_LOCALE_VALUES)[number]

export const RSV_MESSAGE_KIND_VALUES = [
	'confirmation',
	'modification',
	'cancellation',
	'cancellation_guest',
	'cancellation_restaurant',
	'reminder',
	'reconfirm_request',
	'request_received',
	'request_approved',
	'request_declined',
	'waitlist_joined',
	'waitlist_ready',
	'waitlist_called',
	'notify_available',
	'notify_me_available',
	'payment_required',
	'payment_received',
	'payment_failed',
	'payment_refunded',
	'refund_issued',
	'fee_charged',
	'fee_action_required',
	'late_payment_refunded',
] as const
export type RsvMessageKind = (typeof RSV_MESSAGE_KIND_VALUES)[number]

export const RSV_EXPERIENCE_KIND_VALUES = ['ticketed', 'prix_fixe'] as const
export type RsvExperienceKind = (typeof RSV_EXPERIENCE_KIND_VALUES)[number]

export const RSV_EXPERIENCE_STATUS_VALUES = [
	'draft',
	'published',
	'archived',
] as const
export type RsvExperienceStatus = (typeof RSV_EXPERIENCE_STATUS_VALUES)[number]

export const RSV_TAG_SCOPE_VALUES = ['guest', 'reservation'] as const
export type RsvTagScope = (typeof RSV_TAG_SCOPE_VALUES)[number]

export const RSV_TAG_CATEGORY_VALUES = [
	'vip',
	'dietary',
	'occasion',
	'seating',
	'regular',
	'custom',
	'system',
] as const
export type RsvTagCategory = (typeof RSV_TAG_CATEGORY_VALUES)[number]

export const RSV_TAG_SYSTEM_KEY_VALUES = [
	'first_visit',
	'frequent_no_show',
	'birthday',
	'anniversary',
] as const
export type RsvTagSystemKey = (typeof RSV_TAG_SYSTEM_KEY_VALUES)[number]

export const RSV_RESERVATION_STATUS_VALUES = [
	'requested',
	'pending_payment',
	'pending_approval',
	'booked',
	'confirmed',
	'arrived',
	'partially_arrived',
	'partially_seated',
	'seated',
	'finished',
	'cancelled',
	'no_show',
	'declined',
	'expired',
	'disputed',
] as const
export type RsvReservationStatus =
	(typeof RSV_RESERVATION_STATUS_VALUES)[number]

export const RSV_CONTACT_STATUS_VALUES = [
	'not_contacted',
	'left_message',
	'no_answer',
	'wrong_number',
	'confirmed',
	'confirmed_by_phone',
	'confirmed_phone',
	'confirmed_sms',
] as const
export type RsvContactStatus = (typeof RSV_CONTACT_STATUS_VALUES)[number]

export const RSV_COURSE_STATUS_VALUES = [
	'Ordered',
	'ordered',
	'appetizer',
	'apps',
	'starters',
	'entree',
	'mains',
	'dessert',
	'check_dropped',
	'check_presented',
	'check',
	'paid',
	'bussing',
] as const
export type RsvCourseStatus = (typeof RSV_COURSE_STATUS_VALUES)[number]

export const RSV_RESERVATION_CHANNEL_VALUES = [
	'online',
	'native',
	'voice_agent',
	'phone',
	'host',
	'walk_in',
	'waitlist',
] as const
export type RsvReservationChannel =
	(typeof RSV_RESERVATION_CHANNEL_VALUES)[number]

export const RSV_ASSIGNMENT_MODE_VALUES = ['soft', 'locked'] as const
export type RsvAssignmentMode = (typeof RSV_ASSIGNMENT_MODE_VALUES)[number]

export const RSV_PAYMENT_STATUS_VALUES = [
	'none',
	'pending',
	'guaranteed',
	'paid',
	'refund_pending',
	'refunded',
	'partially_refunded',
	'fee_pending',
	'fee_charged',
	'fee_failed',
	'review',
	'disputed',
] as const
export type RsvPaymentStatus = (typeof RSV_PAYMENT_STATUS_VALUES)[number]

export const RSV_CANCELLED_BY_VALUES = [
	'guest',
	'restaurant',
	'system',
] as const
export type RsvCancelledBy = (typeof RSV_CANCELLED_BY_VALUES)[number]

export const RSV_ACTOR_KIND_VALUES = [
	'guest',
	'operator',
	'system',
	'voice_agent',
] as const
export type RsvActorKind = (typeof RSV_ACTOR_KIND_VALUES)[number]

export const RSV_OCCUPANCY_KIND_VALUES = [
	'reservation',
	'hold',
	'block',
] as const
export type RsvOccupancyKind = (typeof RSV_OCCUPANCY_KIND_VALUES)[number]

export const RSV_HOLD_SOURCE_VALUES = ['web', 'native', 'voice_agent'] as const
export type RsvHoldSource = (typeof RSV_HOLD_SOURCE_VALUES)[number]

export const RSV_HOLD_STATUS_VALUES = [
	'active',
	'converted',
	'released',
	'expired',
] as const
export type RsvHoldStatus = (typeof RSV_HOLD_STATUS_VALUES)[number]

export const RSV_WAITLIST_CHANNEL_VALUES = ['walk_in', 'remote'] as const
export type RsvWaitlistChannel = (typeof RSV_WAITLIST_CHANNEL_VALUES)[number]

export const RSV_WAITLIST_STATUS_VALUES = [
	'waiting',
	'notified',
	'on_the_way',
	'seated',
	'cancelled',
	'left',
	'no_response',
] as const
export type RsvWaitlistStatus = (typeof RSV_WAITLIST_STATUS_VALUES)[number]

export const RSV_NOTIFY_STATUS_VALUES = [
	'active',
	'notified',
	'booked',
	'expired',
	'cancelled',
] as const
export type RsvNotifyStatus = (typeof RSV_NOTIFY_STATUS_VALUES)[number]

export const RSV_MESSAGE_CHANNEL_VALUES = ['email', 'sms'] as const
export type RsvMessageChannel = (typeof RSV_MESSAGE_CHANNEL_VALUES)[number]

export const RSV_MESSAGE_CATEGORY_VALUES = ['transactional'] as const
export type RsvMessageCategory = (typeof RSV_MESSAGE_CATEGORY_VALUES)[number]

export const RSV_MESSAGE_STATUS_VALUES = [
	'pending',
	'sending',
	'sent',
	'failed',
	'cancelled',
	'suppressed',
	'dropped',
] as const
export type RsvMessageStatus = (typeof RSV_MESSAGE_STATUS_VALUES)[number]

export const RSV_PAYMENT_PROVIDER_VALUES = ['stripe', 'checkout'] as const
export type RsvPaymentProvider = (typeof RSV_PAYMENT_PROVIDER_VALUES)[number]

export const RSV_PAYMENT_KIND_VALUES = [
	'card_setup',
	'hold_auth',
	'deposit_charge',
	'prepay_charge',
	'cancel_fee_charge',
	'no_show_fee_charge',
	'refund',
	'release',
] as const
export type RsvPaymentKind = (typeof RSV_PAYMENT_KIND_VALUES)[number]

export const RSV_PAYMENT_RECORD_STATUS_VALUES = [
	// `created`: row exists, no provider session bound yet. `charging`: a fee
	// or refund claimed by the App and in flight. `requested`: a refund waiting
	// for the App. `refund_pending`: the provider accepted a refund that has not
	// settled. `refunded` / `partially_refunded` live on the original payment.
	'created',
	'pending',
	'charging',
	'requires_action',
	'succeeded',
	'failed',
	'cancelled',
	'expired',
	'requested',
	'refund_pending',
	'refunded',
	'partially_refunded',
	'disputed',
	'review',
] as const
export type RsvPaymentRecordStatus =
	(typeof RSV_PAYMENT_RECORD_STATUS_VALUES)[number]

export const RSV_OUTBOX_STATUS_VALUES = ['pending', 'sent', 'failed'] as const
export type RsvOutboxStatus = (typeof RSV_OUTBOX_STATUS_VALUES)[number]

export const RSV_OUTBOX_KIND_VALUES = [
	'manager_alert',
	'payment_command',
	'refund_request',
	'checkout_expire',
] as const
export type RsvOutboxKind = (typeof RSV_OUTBOX_KIND_VALUES)[number]

// The two dotted values predate the journey triggers and stay valid; the four
// `reservation_*` values are the journey trigger types and the dedupe key.
export const RSV_JOURNEY_EVENT_TYPE_VALUES = [
	'reservation.visited',
	'reservation.no_show',
	'reservation_booked',
	'reservation_completed',
	'reservation_no_show',
	'reservation_cancelled',
] as const
export type RsvJourneyEventType = (typeof RSV_JOURNEY_EVENT_TYPE_VALUES)[number]

export const RSV_AUDIT_ACTOR_KIND_VALUES = [
	'operator',
	'system',
	'guest',
	'voice_agent',
] as const
export type RsvAuditActorKind = (typeof RSV_AUDIT_ACTOR_KIND_VALUES)[number]

// 4.1 Configuration

export const rsvLocationSettings = sqliteTable('rsv_location_settings', {
	locationId: text('location_id').primaryKey(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
	onlineEnabled: integer('online_enabled', { mode: 'boolean' })
		.notNull()
		.default(false),
	timeZone: text('time_zone').notNull().default('UTC'),
	tzSyncedAt: integer('tz_synced_at').notNull().default(nowMs),
	currency: text('currency').notNull().default('USD'),
	dayStartMin: integer('day_start_min').notNull().default(240),
	intervalMin: integer('interval_min').notNull().default(15),
	horizonDays: integer('horizon_days').notNull().default(30),
	releaseLocalMin: integer('release_local_min'),
	minNoticeMin: integer('min_notice_min').notNull().default(60),
	sameDayCutoffMin: integer('same_day_cutoff_min'),
	onlinePartyMin: integer('online_party_min').notNull().default(1),
	onlinePartyMax: integer('online_party_max').notNull().default(8),
	partyMax: integer('party_max').notNull().default(30),
	largePartyMode: text('large_party_mode', {
		enum: RSV_LARGE_PARTY_MODE_VALUES,
	})
		.notNull()
		.default('contact'),
	largePartyNoteI18n: text('large_party_note_i18n', { mode: 'json' }).$type<
		Record<string, string>
	>(),
	requestHoldsCapacity: integer('request_holds_capacity', { mode: 'boolean' })
		.notNull()
		.default(true),
	requestDeadlineHours: integer('request_deadline_hours').notNull().default(24),
	seatingPrefMode: text('seating_pref_mode', {
		enum: RSV_SEATING_PREF_MODE_VALUES,
	})
		.notNull()
		.default('off'),
	holdMinutes: integer('hold_minutes').notNull().default(7),
	paymentHoldMinutes: integer('payment_hold_minutes').notNull().default(20),
	voiceHoldMinutes: integer('voice_hold_minutes').notNull().default(15),
	voiceMode: text('voice_mode', { enum: RSV_VOICE_MODE_VALUES })
		.notNull()
		.default('hold_link'),
	freezeMin: integer('freeze_min').notNull().default(30),
	lateGraceMin: integer('late_grace_min').notNull().default(15),
	autoNoShowAfterMin: integer('auto_no_show_after_min'),
	maxActivePerPhone: integer('max_active_per_phone').notNull().default(3),
	blockSamePhoneOverlap: integer('block_same_phone_overlap', {
		mode: 'boolean',
	})
		.notNull()
		.default(true),
	guestModifyCutoffMin: integer('guest_modify_cutoff_min')
		.notNull()
		.default(120),
	contactStatusesEnabled: integer('contact_statuses_enabled', {
		mode: 'boolean',
	})
		.notNull()
		.default(true),
	courseStatusesEnabled: integer('course_statuses_enabled', {
		mode: 'boolean',
	})
		.notNull()
		.default(false),
	defaultPolicyId: text('default_policy_id').references(
		(): AnySQLiteColumn => rsvPolicies.id,
		{ onDelete: 'set null' },
	),
	waitlistEnabled: integer('waitlist_enabled', { mode: 'boolean' })
		.notNull()
		.default(false),
	waitlistOnline: integer('waitlist_online', { mode: 'boolean' })
		.notNull()
		.default(false),
	notifyMeEnabled: integer('notify_me_enabled', { mode: 'boolean' })
		.notNull()
		.default(false),
	waitlistResponseMin: integer('waitlist_response_min').notNull().default(10),
	waitlistMaxParties: integer('waitlist_max_parties'),
	messaging: text('messaging', { mode: 'json' })
		.$type<Record<string, unknown>>()
		.notNull()
		.default(sql`'{}'`),
	publicNoteI18n: text('public_note_i18n', { mode: 'json' }).$type<
		Record<string, string>
	>(),
	contactPhone: text('contact_phone'),
	floorPlanVersion: integer('floor_plan_version').notNull().default(1),
	version: integer('version').notNull().default(1),
	updatedAt: integer('updated_at').notNull().default(nowMs),
	updatedBy: text('updated_by'),
})

export const rsvAreas = sqliteTable(
	'rsv_areas',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		name: text('name').notNull(),
		nameI18n: text('name_i18n', { mode: 'json' }).$type<
			Record<string, string>
		>(),
		sort: integer('sort').notNull().default(0),
		onlineBookable: integer('online_bookable', { mode: 'boolean' })
			.notNull()
			.default(true),
		guestSelectable: integer('guest_selectable', { mode: 'boolean' })
			.notNull()
			.default(true),
		canvasW: integer('canvas_w').notNull().default(1200),
		canvasH: integer('canvas_h').notNull().default(800),
		archivedAt: integer('archived_at'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
		version: integer('version').notNull().default(1),
	},
	(table) => [
		index('idx_rsv_areas_location_sort').on(table.locationId, table.sort),
	],
)

export const rsvTables = sqliteTable(
	'rsv_tables',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		areaId: text('area_id')
			.notNull()
			.references(() => rsvAreas.id, { onDelete: 'cascade' }),
		label: text('label').notNull(),
		minCovers: integer('min_covers').notNull().default(1),
		maxCovers: integer('max_covers').notNull().default(2),
		onlineBookable: integer('online_bookable', { mode: 'boolean' })
			.notNull()
			.default(true),
		combinable: integer('combinable', { mode: 'boolean' })
			.notNull()
			.default(false),
		priority: integer('priority').notNull().default(0),
		resetBufferMin: integer('reset_buffer_min').notNull().default(0),
		shape: text('shape', { enum: RSV_TABLE_SHAPE_VALUES })
			.notNull()
			.default('square'),
		x: integer('x').notNull().default(0),
		y: integer('y').notNull().default(0),
		w: integer('w').notNull().default(60),
		h: integer('h').notNull().default(60),
		rotation: integer('rotation').notNull().default(0),
		archivedAt: integer('archived_at'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_rsv_tables_area_id').on(table.areaId),
		index('idx_rsv_tables_location_area').on(table.locationId, table.areaId),
		uniqueIndex('uniq_rsv_tables_location_label')
			.on(table.locationId, table.label)
			.where(sql`${table.archivedAt} IS NULL`),
		check(
			'chk_rsv_tables_covers',
			sql`${table.minCovers} >= 1 AND ${table.minCovers} <= ${table.maxCovers} AND ${table.maxCovers} <= 99`,
		),
		check(
			'chk_rsv_tables_reset_buffer',
			sql`${table.resetBufferMin} BETWEEN 0 AND 120`,
		),
	],
)

export const rsvTableCombos = sqliteTable(
	'rsv_table_combos',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		label: text('label').notNull(),
		minCovers: integer('min_covers').notNull(),
		maxCovers: integer('max_covers').notNull(),
		onlineBookable: integer('online_bookable', { mode: 'boolean' })
			.notNull()
			.default(true),
		priority: integer('priority').notNull().default(0),
		archivedAt: integer('archived_at'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_rsv_table_combos_location').on(table.locationId),
		check(
			'chk_rsv_table_combos_covers',
			sql`${table.minCovers} >= 1 AND ${table.minCovers} <= ${table.maxCovers} AND ${table.maxCovers} <= 99`,
		),
	],
)

export const rsvTableComboMembers = sqliteTable(
	'rsv_table_combo_members',
	{
		comboId: text('combo_id')
			.notNull()
			.references(() => rsvTableCombos.id, { onDelete: 'cascade' }),
		tableId: text('table_id')
			.notNull()
			.references(() => rsvTables.id, { onDelete: 'cascade' }),
	},
	(table) => [
		primaryKey({ columns: [table.comboId, table.tableId] }),
		index('idx_rsv_table_combo_members_table').on(table.tableId),
	],
)

export const rsvFloorElements = sqliteTable(
	'rsv_floor_elements',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		areaId: text('area_id')
			.notNull()
			.references(() => rsvAreas.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: RSV_FLOOR_ELEMENT_KIND_VALUES }).notNull(),
		label: text('label'),
		x: integer('x').notNull().default(0),
		y: integer('y').notNull().default(0),
		w: integer('w').notNull().default(60),
		h: integer('h').notNull().default(20),
		rotation: integer('rotation').notNull().default(0),
	},
	(table) => [index('idx_rsv_floor_elements_area').on(table.areaId)],
)

export const rsvServices = sqliteTable(
	'rsv_services',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		name: text('name').notNull(),
		nameI18n: text('name_i18n', { mode: 'json' }).$type<
			Record<string, string>
		>(),
		daysMask: integer('days_mask').notNull().default(127),
		firstSeatingMin: integer('first_seating_min').notNull(),
		lastSeatingMin: integer('last_seating_min').notNull(),
		endMin: integer('end_min').notNull(),
		intervalMin: integer('interval_min'),
		effectiveFrom: text('effective_from'),
		effectiveTo: text('effective_to'),
		priority: integer('priority').notNull().default(0),
		specialDayId: text('special_day_id').references(
			(): AnySQLiteColumn => rsvSpecialDays.id,
			{ onDelete: 'cascade' },
		),
		onlineEnabled: integer('online_enabled', { mode: 'boolean' })
			.notNull()
			.default(true),
		onlineFromMin: integer('online_from_min'),
		onlineToMin: integer('online_to_min'),
		maxParty: integer('max_party'),
		onlinePartyMax: integer('online_party_max'),
		onlineCapPerInterval: integer('online_cap_per_interval'),
		concurrentCoversCap: integer('concurrent_covers_cap'),
		policyId: text('policy_id').references(
			(): AnySQLiteColumn => rsvPolicies.id,
			{ onDelete: 'set null' },
		),
		sectionLayoutId: text('section_layout_id').references(
			(): AnySQLiteColumn => rsvSectionLayouts.id,
			{ onDelete: 'set null' },
		),
		allowOverrunPastEnd: integer('allow_overrun_past_end', {
			mode: 'boolean',
		})
			.notNull()
			.default(true),
		colorToken: text('color_token').notNull().default('neutral'),
		sort: integer('sort').notNull().default(0),
		archivedAt: integer('archived_at'),
		version: integer('version').notNull().default(1),
	},
	(table) => [
		index('idx_rsv_services_section_layout_id').on(table.sectionLayoutId),
		index('idx_rsv_services_policy_id').on(table.policyId),
		index('idx_rsv_services_special_day_id').on(table.specialDayId),
		index('idx_rsv_services_location_archived').on(
			table.locationId,
			table.archivedAt,
		),
		check(
			'chk_rsv_services_seating_order',
			sql`${table.firstSeatingMin} <= ${table.lastSeatingMin} AND ${table.lastSeatingMin} <= ${table.endMin}`,
		),
		check(
			'chk_rsv_services_max_span',
			sql`${table.endMin} - ${table.firstSeatingMin} <= 1440`,
		),
	],
)

export const rsvServiceAvailability = sqliteTable(
	'rsv_service_availability',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		serviceId: text('service_id')
			.notNull()
			.references(() => rsvServices.id, { onDelete: 'cascade' }),
		areaId: text('area_id').references(() => rsvAreas.id, {
			onDelete: 'cascade',
		}),
		tableId: text('table_id').references(() => rsvTables.id, {
			onDelete: 'cascade',
		}),
		comboId: text('combo_id').references(() => rsvTableCombos.id, {
			onDelete: 'cascade',
		}),
		mode: text('mode', {
			enum: RSV_SERVICE_AVAILABILITY_MODE_VALUES,
		}).notNull(),
		fromMin: integer('from_min'),
		toMin: integer('to_min'),
	},
	(table) => [
		index('idx_rsv_service_availability_combo_id').on(table.comboId),
		index('idx_rsv_service_availability_table_id').on(table.tableId),
		index('idx_rsv_service_availability_area_id').on(table.areaId),
		index('idx_rsv_service_availability_service').on(table.serviceId),
		check(
			'chk_rsv_service_availability_target',
			sql`((${table.areaId} IS NOT NULL) + (${table.tableId} IS NOT NULL) + (${table.comboId} IS NOT NULL)) = 1`,
		),
	],
)

export const rsvTurnTimes = sqliteTable(
	'rsv_turn_times',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		serviceId: text('service_id').references(() => rsvServices.id, {
			onDelete: 'cascade',
		}),
		partyMin: integer('party_min').notNull(),
		partyMax: integer('party_max').notNull(),
		minutes: integer('minutes').notNull(),
		daysMask: integer('days_mask'),
	},
	(table) => [
		index('idx_rsv_turn_times_service_id').on(table.serviceId),
		uniqueIndex('uniq_rsv_turn_times_bucket').on(
			table.locationId,
			table.serviceId,
			table.partyMin,
			table.daysMask,
		),
	],
)

export const rsvPacingRules = sqliteTable(
	'rsv_pacing_rules',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		serviceId: text('service_id')
			.notNull()
			.references(() => rsvServices.id, { onDelete: 'cascade' }),
		fromMin: integer('from_min'),
		toMin: integer('to_min'),
		bucketMin: integer('bucket_min').notNull().default(15),
		maxCovers: integer('max_covers'),
		maxParties: integer('max_parties'),
		rollingMin: integer('rolling_min'),
		rollingMaxCovers: integer('rolling_max_covers'),
		channel: text('channel', { enum: RSV_PACING_CHANNEL_VALUES })
			.notNull()
			.default('all'),
	},
	(table) => [index('idx_rsv_pacing_rules_service').on(table.serviceId)],
)

export const rsvSpecialDays = sqliteTable(
	'rsv_special_days',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		fromDate: text('from_date').notNull(),
		toDate: text('to_date').notNull(),
		kind: text('kind', { enum: RSV_SPECIAL_DAY_KIND_VALUES }).notNull(),
		serviceId: text('service_id').references(
			(): AnySQLiteColumn => rsvServices.id,
			{ onDelete: 'set null' },
		),
		patch: text('patch', { mode: 'json' }).$type<Record<string, unknown>>(),
		name: text('name'),
		publicNoteI18n: text('public_note_i18n', { mode: 'json' }).$type<
			Record<string, string>
		>(),
		createdBy: text('created_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
		version: integer('version').notNull().default(1),
	},
	(table) => [
		index('idx_rsv_special_days_service_id').on(table.serviceId),
		index('idx_rsv_special_days_location_dates').on(
			table.locationId,
			table.fromDate,
			table.toDate,
		),
	],
)

export const rsvBlocks = sqliteTable(
	'rsv_blocks',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		tableId: text('table_id').references(() => rsvTables.id, {
			onDelete: 'cascade',
		}),
		areaId: text('area_id').references(() => rsvAreas.id, {
			onDelete: 'cascade',
		}),
		businessDate: text('business_date').notNull(),
		startAt: integer('start_at').notNull(),
		endAt: integer('end_at').notNull(),
		reason: text('reason'),
		note: text('note'),
		createdBy: text('created_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_rsv_blocks_area_id').on(table.areaId),
		index('idx_rsv_blocks_table_id').on(table.tableId),
		index('idx_rsv_blocks_location_date').on(
			table.locationId,
			table.businessDate,
		),
		check(
			'chk_rsv_blocks_target',
			sql`((${table.tableId} IS NOT NULL) + (${table.areaId} IS NOT NULL)) = 1`,
		),
		check('chk_rsv_blocks_time_range', sql`${table.endAt} > ${table.startAt}`),
	],
)

export const rsvPolicies = sqliteTable(
	'rsv_policies',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		name: text('name').notNull(),
		kind: text('kind', { enum: RSV_POLICY_KIND_VALUES })
			.notNull()
			.default('none'),
		amountMinor: integer('amount_minor').notNull().default(0),
		perCover: integer('per_cover', { mode: 'boolean' })
			.notNull()
			.default(false),
		currency: text('currency').notNull().default('USD'),
		freeCancelUntilMin: integer('free_cancel_until_min').notNull().default(0),
		lateCancelFeeMinor: integer('late_cancel_fee_minor').notNull().default(0),
		noShowFeeMinor: integer('no_show_fee_minor').notNull().default(0),
		feePerCover: integer('fee_per_cover', { mode: 'boolean' })
			.notNull()
			.default(false),
		feeCapMinor: integer('fee_cap_minor'),
		refundRule: text('refund_rule', { enum: RSV_POLICY_REFUND_RULE_VALUES })
			.notNull()
			.default('full_before_window'),
		partialRefundBp: integer('partial_refund_bp'),
		appliesPartyMin: integer('applies_party_min'),
		termsI18n: text('terms_i18n', { mode: 'json' }).$type<
			Record<string, string>
		>(),
		termsVersion: integer('terms_version').notNull().default(1),
		archivedAt: integer('archived_at'),
		version: integer('version').notNull().default(1),
	},
	(table) => [index('idx_rsv_policies_location').on(table.locationId)],
)

export const rsvSectionLayouts = sqliteTable(
	'rsv_section_layouts',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		name: text('name').notNull(),
		archivedAt: integer('archived_at'),
	},
	(table) => [index('idx_rsv_section_layouts_location').on(table.locationId)],
)

export const rsvSections = sqliteTable(
	'rsv_sections',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		layoutId: text('layout_id')
			.notNull()
			.references(() => rsvSectionLayouts.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		colorToken: text('color_token').notNull().default('neutral'),
		sort: integer('sort').notNull().default(0),
	},
	(table) => [
		index('idx_rsv_sections_layout_sort').on(table.layoutId, table.sort),
	],
)

export const rsvSectionTables = sqliteTable(
	'rsv_section_tables',
	{
		sectionId: text('section_id')
			.notNull()
			.references(() => rsvSections.id, { onDelete: 'cascade' }),
		tableId: text('table_id')
			.notNull()
			.references(() => rsvTables.id, { onDelete: 'cascade' }),
		layoutId: text('layout_id')
			.notNull()
			.references(() => rsvSectionLayouts.id, { onDelete: 'cascade' }),
	},
	(table) => [
		index('idx_rsv_section_tables_table_id').on(table.tableId),
		primaryKey({ columns: [table.sectionId, table.tableId] }),
		uniqueIndex('uniq_rsv_section_tables_layout_table').on(
			table.layoutId,
			table.tableId,
		),
	],
)

export const rsvSectionAssignments = sqliteTable(
	'rsv_section_assignments',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		businessDate: text('business_date').notNull(),
		serviceId: text('service_id').notNull(),
		sectionId: text('section_id')
			.notNull()
			.references(() => rsvSections.id, { onDelete: 'cascade' }),
		staffId: text('staff_id'),
		serverLabel: text('server_label'),
		version: integer('version').notNull().default(1),
	},
	(table) => [
		index('idx_rsv_section_assignments_section_id').on(table.sectionId),
		uniqueIndex('uniq_rsv_section_assignments_day_service_section').on(
			table.businessDate,
			table.serviceId,
			table.sectionId,
		),
		index('idx_rsv_section_assignments_location_date').on(
			table.locationId,
			table.businessDate,
		),
	],
)

export const rsvMessageTexts = sqliteTable(
	'rsv_message_texts',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id'),
		kind: text('kind', { enum: RSV_MESSAGE_KIND_VALUES }).notNull(),
		locale: text('locale', { enum: RSV_MESSAGE_LOCALE_VALUES }).notNull(),
		customNote: text('custom_note').notNull().default(''),
		updatedBy: text('updated_by'),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_rsv_message_texts_loc_kind_locale').on(
			table.locationId,
			table.kind,
			table.locale,
		),
		uniqueIndex('uniq_rsv_message_texts_org_kind_locale')
			.on(table.kind, table.locale)
			.where(sql`${table.locationId} IS NULL`),
	],
)

export const rsvExperiences = sqliteTable(
	'rsv_experiences',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		slug: text('slug').notNull(),
		kind: text('kind', { enum: RSV_EXPERIENCE_KIND_VALUES }).notNull(),
		nameI18n: text('name_i18n', { mode: 'json' })
			.$type<Record<string, string>>()
			.notNull()
			.default(sql`'{}'`),
		descriptionI18n: text('description_i18n', { mode: 'json' }).$type<
			Record<string, string>
		>(),
		imageUrl: text('image_url'),
		priceMinor: integer('price_minor'),
		pricePerCover: integer('price_per_cover', { mode: 'boolean' })
			.notNull()
			.default(true),
		currency: text('currency').notNull().default('USD'),
		policyId: text('policy_id').references(() => rsvPolicies.id, {
			onDelete: 'set null',
		}),
		partyMin: integer('party_min').notNull().default(1),
		partyMax: integer('party_max').notNull().default(8),
		usesTables: integer('uses_tables', { mode: 'boolean' })
			.notNull()
			.default(true),
		exclusive: integer('exclusive', { mode: 'boolean' })
			.notNull()
			.default(false),
		status: text('status', { enum: RSV_EXPERIENCE_STATUS_VALUES })
			.notNull()
			.default('draft'),
		sort: integer('sort').notNull().default(0),
		version: integer('version').notNull().default(1),
	},
	(table) => [
		index('idx_rsv_experiences_policy_id').on(table.policyId),
		uniqueIndex('uniq_rsv_experiences_location_slug')
			.on(table.locationId, table.slug)
			.where(sql`${table.status} <> 'archived'`),
		index('idx_rsv_experiences_location_status').on(
			table.locationId,
			table.status,
			table.sort,
		),
	],
)

export const rsvExperienceSchedules = sqliteTable(
	'rsv_experience_schedules',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		experienceId: text('experience_id')
			.notNull()
			.references(() => rsvExperiences.id, { onDelete: 'cascade' }),
		fromDate: text('from_date').notNull(),
		toDate: text('to_date').notNull(),
		daysMask: integer('days_mask').notNull().default(127),
		seatingMins: text('seating_mins', { mode: 'json' }).$type<number[]>(),
		startMin: integer('start_min'),
		endMin: integer('end_min'),
		intervalMin: integer('interval_min'),
		turnMin: integer('turn_min').notNull().default(90),
		coversCapPerSeating: integer('covers_cap_per_seating'),
		coversCapPerDay: integer('covers_cap_per_day'),
		areaIds: text('area_ids', { mode: 'json' }).$type<string[]>(),
		serviceId: text('service_id').references(() => rsvServices.id, {
			onDelete: 'set null',
		}),
	},
	(table) => [
		index('idx_rsv_experience_schedules_service_id').on(table.serviceId),
		index('idx_rsv_experience_schedules_experience').on(table.experienceId),
	],
)

// 4.2 Guests

export const rsvGuests = sqliteTable(
	'rsv_guests',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		customerId: text('customer_id').references(() => customers.id, {
			onDelete: 'set null',
		}),
		marketingCustomerId: text('marketing_customer_id').references(
			() => customers.id,
			{ onDelete: 'set null' },
		),
		firstName: text('first_name').notNull(),
		lastName: text('last_name').notNull().default(''),
		phoneE164: text('phone_e164'),
		emailNorm: text('email_norm'),
		locale: text('locale').notNull().default('en'),
		allergyNotes: text('allergy_notes'),
		// DEPRECATED, never read or written (ADR 048, "Single consent source").
		// `customer_subscriptions` is the only marketing consent store; these
		// columns only hold evidence for rows written before that decision and
		// are dropped in a later release. Do not add readers or writers.
		marketingEmailConsentAt: integer('marketing_email_consent_at'),
		marketingSmsConsentAt: integer('marketing_sms_consent_at'),
		consentSource: text('consent_source'),
		consentTextVersion: text('consent_text_version'),
		visits: integer('visits').notNull().default(0),
		covers: integer('covers').notNull().default(0),
		noShows: integer('no_shows').notNull().default(0),
		lateCancels: integer('late_cancels').notNull().default(0),
		cancels: integer('cancels').notNull().default(0),
		firstVisitAt: integer('first_visit_at'),
		lastVisitAt: integer('last_visit_at'),
		mergedIntoId: text('merged_into_id'),
		erasedAt: integer('erased_at'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
		version: integer('version').notNull().default(1),
	},
	(table) => [
		index('idx_rsv_guests_marketing_customer_id').on(table.marketingCustomerId),
		uniqueIndex('uniq_rsv_guests_customer_id')
			.on(table.customerId)
			.where(sql`${table.customerId} IS NOT NULL`),
		index('idx_rsv_guests_phone').on(table.phoneE164),
		index('idx_rsv_guests_email').on(table.emailNorm),
		index('idx_rsv_guests_last_name').on(table.lastName),
		index('idx_rsv_guests_last_visit_at').on(table.lastVisitAt),
	],
)

export const rsvTags = sqliteTable(
	'rsv_tags',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		scope: text('scope', { enum: RSV_TAG_SCOPE_VALUES }).notNull(),
		category: text('category', { enum: RSV_TAG_CATEGORY_VALUES }).notNull(),
		name: text('name').notNull(),
		nameI18n: text('name_i18n', { mode: 'json' }).$type<
			Record<string, string>
		>(),
		colorToken: text('color_token').notNull().default('neutral'),
		sensitive: integer('sensitive', { mode: 'boolean' })
			.notNull()
			.default(false),
		systemKey: text('system_key', { enum: RSV_TAG_SYSTEM_KEY_VALUES }),
		guestSelectable: integer('guest_selectable', { mode: 'boolean' })
			.notNull()
			.default(false),
		archivedAt: integer('archived_at'),
	},
	(table) => [
		uniqueIndex('uniq_rsv_tags_system_key')
			.on(table.systemKey)
			.where(sql`${table.systemKey} IS NOT NULL`),
		index('idx_rsv_tags_scope_category').on(table.scope, table.category),
	],
)

export const rsvGuestTags = sqliteTable(
	'rsv_guest_tags',
	{
		guestId: text('guest_id')
			.notNull()
			.references(() => rsvGuests.id, { onDelete: 'cascade' }),
		tagId: text('tag_id')
			.notNull()
			.references(() => rsvTags.id, { onDelete: 'cascade' }),
	},
	(table) => [
		primaryKey({ columns: [table.guestId, table.tagId] }),
		index('idx_rsv_guest_tags_tag').on(table.tagId),
	],
)

export const rsvGuestNotes = sqliteTable(
	'rsv_guest_notes',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		guestId: text('guest_id')
			.notNull()
			.references(() => rsvGuests.id, { onDelete: 'cascade' }),
		body: text('body').notNull(),
		pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
		authorId: text('author_id').notNull(),
		createdAt: integer('created_at').notNull().default(nowMs),
		deletedAt: integer('deleted_at'),
	},
	(table) => [
		index('idx_rsv_guest_notes_guest').on(table.guestId, table.createdAt),
	],
)

export const rsvGuestMerges = sqliteTable(
	'rsv_guest_merges',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		keptGuestId: text('kept_guest_id')
			.notNull()
			.references(() => rsvGuests.id),
		mergedGuestId: text('merged_guest_id')
			.notNull()
			.references(() => rsvGuests.id),
		actorId: text('actor_id').notNull(),
		at: integer('at').notNull().default(nowMs),
		movedCounts: text('moved_counts', { mode: 'json' })
			.$type<Record<string, number>>()
			.notNull()
			.default(sql`'{}'`),
	},
	(table) => [
		index('idx_rsv_guest_merges_merged_guest_id').on(table.mergedGuestId),
		index('idx_rsv_guest_merges_kept').on(table.keptGuestId, table.at),
	],
)

// 4.3 Reservations

export const rsvReservations = sqliteTable(
	'rsv_reservations',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		guestId: text('guest_id')
			.notNull()
			.references(() => rsvGuests.id),
		customerId: text('customer_id').references(() => customers.id, {
			onDelete: 'set null',
		}),
		confirmationCode: text('confirmation_code').notNull(),
		businessDate: text('business_date').notNull(),
		localStartMin: integer('local_start_min').notNull(),
		timeZone: text('time_zone').notNull(),
		startAt: integer('start_at').notNull(),
		endAt: integer('end_at').notNull(),
		durationMin: integer('duration_min').notNull(),
		serviceId: text('service_id').references(() => rsvServices.id, {
			onDelete: 'set null',
		}),
		experienceId: text('experience_id').references(() => rsvExperiences.id, {
			onDelete: 'set null',
		}),
		partySize: integer('party_size').notNull(),
		arrivedCovers: integer('arrived_covers'),
		seatedCovers: integer('seated_covers'),
		coversActual: integer('covers_actual'),
		status: text('status', { enum: RSV_RESERVATION_STATUS_VALUES })
			.notNull()
			.default('booked'),
		contactStatus: text('contact_status', { enum: RSV_CONTACT_STATUS_VALUES }),
		runningLateMin: integer('running_late_min'),
		courseStatus: text('course_status', { enum: RSV_COURSE_STATUS_VALUES }),
		channel: text('channel', { enum: RSV_RESERVATION_CHANNEL_VALUES })
			.notNull()
			.default('online'),
		client: text('client'),
		assignment: text('assignment', { enum: RSV_ASSIGNMENT_MODE_VALUES })
			.notNull()
			.default('soft'),
		comboId: text('combo_id').references(() => rsvTableCombos.id, {
			onDelete: 'set null',
		}),
		overbooked: integer('overbooked', { mode: 'boolean' })
			.notNull()
			.default(false),
		areaPrefId: text('area_pref_id').references(() => rsvAreas.id, {
			onDelete: 'set null',
		}),
		areaPrefStrict: integer('area_pref_strict', { mode: 'boolean' })
			.notNull()
			.default(false),
		occasionTagId: text('occasion_tag_id').references(() => rsvTags.id, {
			onDelete: 'set null',
		}),
		guestRequests: text('guest_requests'),
		dietaryNotes: text('dietary_notes'),
		staffNotes: text('staff_notes'),
		policySnapshot: text('policy_snapshot', { mode: 'json' }).$type<
			Record<string, unknown>
		>(),
		policyAcceptedAt: integer('policy_accepted_at'),
		policyTextHash: text('policy_text_hash'),
		paymentStatus: text('payment_status', { enum: RSV_PAYMENT_STATUS_VALUES })
			.notNull()
			.default('none'),
		paymentExpiresAt: integer('payment_expires_at'),
		requestDeadlineAt: integer('request_deadline_at'),
		lateCancel: integer('late_cancel', { mode: 'boolean' })
			.notNull()
			.default(false),
		holdId: text('hold_id'),
		voiceCallId: text('voice_call_id'),
		manageTokenVersion: integer('manage_token_version').notNull().default(1),
		smsOptIn: integer('sms_opt_in', { mode: 'boolean' })
			.notNull()
			.default(false),
		guestLocale: text('guest_locale').notNull().default('en'),
		scheduleVersion: integer('schedule_version').notNull().default(1),
		version: integer('version').notNull().default(1),
		arrivedAt: integer('arrived_at'),
		seatedAt: integer('seated_at'),
		finishedAt: integer('finished_at'),
		cancelledAt: integer('cancelled_at'),
		noShowAt: integer('no_show_at'),
		cancelledBy: text('cancelled_by', { enum: RSV_CANCELLED_BY_VALUES }),
		cancelReason: text('cancel_reason'),
		createdByKind: text('created_by_kind', { enum: RSV_ACTOR_KIND_VALUES })
			.notNull()
			.default('guest'),
		createdById: text('created_by_id'),
		ipHash: text('ip_hash'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_rsv_reservations_occasion_tag_id').on(table.occasionTagId),
		index('idx_rsv_reservations_area_pref_id').on(table.areaPrefId),
		index('idx_rsv_reservations_combo_id').on(table.comboId),
		index('idx_rsv_reservations_experience_id').on(table.experienceId),
		index('idx_rsv_reservations_service_id').on(table.serviceId),
		uniqueIndex('uniq_rsv_reservations_confirmation_code').on(
			table.confirmationCode,
		),
		uniqueIndex('uniq_rsv_reservations_hold_id').on(table.holdId),
		index('idx_rsv_reservations_location_date_status').on(
			table.locationId,
			table.businessDate,
			table.status,
		),
		index('idx_rsv_reservations_location_start').on(
			table.locationId,
			table.startAt,
		),
		index('idx_rsv_reservations_guest_start').on(table.guestId, table.startAt),
		index('idx_rsv_reservations_status_start').on(table.status, table.startAt),
		index('idx_rsv_reservations_customer_start').on(
			table.customerId,
			table.startAt,
		),
		check(
			'chk_rsv_reservations_time_range',
			sql`${table.endAt} > ${table.startAt}`,
		),
		check(
			'chk_rsv_reservations_party_size',
			sql`${table.partySize} BETWEEN 1 AND 99`,
		),
	],
)

export const rsvReservationTags = sqliteTable(
	'rsv_reservation_tags',
	{
		reservationId: text('reservation_id')
			.notNull()
			.references(() => rsvReservations.id, { onDelete: 'cascade' }),
		tagId: text('tag_id')
			.notNull()
			.references(() => rsvTags.id, { onDelete: 'cascade' }),
	},
	(table) => [
		primaryKey({ columns: [table.reservationId, table.tagId] }),
		index('idx_rsv_reservation_tags_tag').on(table.tagId),
	],
)

export const rsvHolds = sqliteTable(
	'rsv_holds',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		tokenHash: text('token_hash').notNull(),
		businessDate: text('business_date').notNull(),
		localStartMin: integer('local_start_min').notNull(),
		startAt: integer('start_at').notNull(),
		endAt: integer('end_at').notNull(),
		partySize: integer('party_size').notNull(),
		serviceId: text('service_id').references(() => rsvServices.id, {
			onDelete: 'set null',
		}),
		experienceId: text('experience_id').references(() => rsvExperiences.id, {
			onDelete: 'set null',
		}),
		areaPrefId: text('area_pref_id').references(() => rsvAreas.id, {
			onDelete: 'set null',
		}),
		comboId: text('combo_id').references(() => rsvTableCombos.id, {
			onDelete: 'set null',
		}),
		source: text('source', { enum: RSV_HOLD_SOURCE_VALUES })
			.notNull()
			.default('web'),
		voiceCallId: text('voice_call_id'),
		status: text('status', { enum: RSV_HOLD_STATUS_VALUES })
			.notNull()
			.default('active'),
		expiresAt: integer('expires_at').notNull(),
		extendedForPayment: integer('extended_for_payment', { mode: 'boolean' })
			.notNull()
			.default(false),
		ipHash: text('ip_hash'),
		reservationId: text('reservation_id'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_rsv_holds_combo_id').on(table.comboId),
		index('idx_rsv_holds_area_pref_id').on(table.areaPrefId),
		index('idx_rsv_holds_experience_id').on(table.experienceId),
		index('idx_rsv_holds_service_id').on(table.serviceId),
		uniqueIndex('uniq_rsv_holds_token_hash').on(table.tokenHash),
		index('idx_rsv_holds_location_date_status_expires').on(
			table.locationId,
			table.businessDate,
			table.status,
			table.expiresAt,
		),
		index('idx_rsv_holds_ip_created').on(table.ipHash, table.createdAt),
		check('chk_rsv_holds_time_range', sql`${table.endAt} > ${table.startAt}`),
		check('chk_rsv_holds_party_size', sql`${table.partySize} BETWEEN 1 AND 99`),
	],
)

export const rsvTableOccupancies = sqliteTable(
	'rsv_table_occupancies',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		tableId: text('table_id')
			.notNull()
			.references(() => rsvTables.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: RSV_OCCUPANCY_KIND_VALUES }).notNull(),
		reservationId: text('reservation_id').references(() => rsvReservations.id, {
			onDelete: 'cascade',
		}),
		holdId: text('hold_id').references(() => rsvHolds.id, {
			onDelete: 'cascade',
		}),
		blockId: text('block_id').references(() => rsvBlocks.id, {
			onDelete: 'cascade',
		}),
		startAt: integer('start_at').notNull(),
		endAt: integer('end_at').notNull(),
		active: integer('active', { mode: 'boolean' }).notNull().default(true),
		overbook: integer('overbook', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_rsv_table_occupancies_table_active_start').on(
			table.tableId,
			table.active,
			table.startAt,
		),
		index('idx_rsv_table_occupancies_location_active_end').on(
			table.locationId,
			table.active,
			table.endAt,
		),
		index('idx_rsv_table_occupancies_reservation').on(table.reservationId),
		index('idx_rsv_table_occupancies_hold').on(table.holdId),
		index('idx_rsv_table_occupancies_block').on(table.blockId),
		check(
			'chk_rsv_table_occupancies_owner',
			sql`((${table.kind} = 'reservation' AND ${table.reservationId} IS NOT NULL AND ${table.holdId} IS NULL AND ${table.blockId} IS NULL) OR (${table.kind} = 'hold' AND ${table.holdId} IS NOT NULL AND ${table.reservationId} IS NULL AND ${table.blockId} IS NULL) OR (${table.kind} = 'block' AND ${table.blockId} IS NOT NULL AND ${table.reservationId} IS NULL AND ${table.holdId} IS NULL))`,
		),
		check(
			'chk_rsv_table_occupancies_time_range',
			sql`${table.endAt} > ${table.startAt}`,
		),
	],
)

export const rsvReservationEvents = sqliteTable(
	'rsv_reservation_events',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		reservationId: text('reservation_id')
			.notNull()
			.references(() => rsvReservations.id, { onDelete: 'cascade' }),
		at: integer('at').notNull().default(nowMs),
		actorKind: text('actor_kind', { enum: RSV_ACTOR_KIND_VALUES }).notNull(),
		actorId: text('actor_id'),
		type: text('type').notNull(),
		fromStatus: text('from_status', { enum: RSV_RESERVATION_STATUS_VALUES }),
		toStatus: text('to_status', { enum: RSV_RESERVATION_STATUS_VALUES }),
		data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
	},
	(table) => [
		index('idx_rsv_reservation_events_reservation_at').on(
			table.reservationId,
			table.at,
		),
	],
)

export const rsvServiceNotes = sqliteTable(
	'rsv_service_notes',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		businessDate: text('business_date').notNull(),
		serviceId: text('service_id').references(() => rsvServices.id, {
			onDelete: 'cascade',
		}),
		body: text('body').notNull().default(''),
		updatedBy: text('updated_by'),
		updatedAt: integer('updated_at').notNull().default(nowMs),
		version: integer('version').notNull().default(1),
	},
	(table) => [
		index('idx_rsv_service_notes_service_id').on(table.serviceId),
		uniqueIndex('uniq_rsv_service_notes_loc_date_service').on(
			table.locationId,
			table.businessDate,
			table.serviceId,
		),
		uniqueIndex('uniq_rsv_service_notes_loc_date_day')
			.on(table.locationId, table.businessDate)
			.where(sql`${table.serviceId} IS NULL`),
	],
)

// 4.4 Waitlist and notify-me

export const rsvWaitlistEntries = sqliteTable(
	'rsv_waitlist_entries',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		businessDate: text('business_date').notNull(),
		guestId: text('guest_id').references(() => rsvGuests.id, {
			onDelete: 'set null',
		}),
		displayName: text('display_name').notNull(),
		phoneE164: text('phone_e164'),
		emailNorm: text('email_norm'),
		partySize: integer('party_size').notNull(),
		areaPrefId: text('area_pref_id').references(() => rsvAreas.id, {
			onDelete: 'set null',
		}),
		channel: text('channel', { enum: RSV_WAITLIST_CHANNEL_VALUES })
			.notNull()
			.default('walk_in'),
		joinedAt: integer('joined_at').notNull().default(nowMs),
		quotedMin: integer('quoted_min'),
		quotedReadyAt: integer('quoted_ready_at'),
		status: text('status', { enum: RSV_WAITLIST_STATUS_VALUES })
			.notNull()
			.default('waiting'),
		notifiedAt: integer('notified_at'),
		responseDeadlineAt: integer('response_deadline_at'),
		reservationId: text('reservation_id').references(() => rsvReservations.id, {
			onDelete: 'set null',
		}),
		statusTokenVersion: integer('status_token_version').notNull().default(1),
		sortKey: real('sort_key').notNull().default(0),
		notes: text('notes'),
		smsOptIn: integer('sms_opt_in', { mode: 'boolean' })
			.notNull()
			.default(false),
		locale: text('locale').notNull().default('en'),
		ipHash: text('ip_hash'),
		createdAt: integer('created_at').notNull().default(nowMs),
		version: integer('version').notNull().default(1),
	},
	(table) => [
		index('idx_rsv_waitlist_entries_reservation_id').on(table.reservationId),
		index('idx_rsv_waitlist_entries_area_pref_id').on(table.areaPrefId),
		index('idx_rsv_waitlist_entries_guest_id').on(table.guestId),
		index('idx_rsv_waitlist_entries_loc_date_status_sort').on(
			table.locationId,
			table.businessDate,
			table.status,
			table.sortKey,
		),
		index('idx_rsv_waitlist_entries_loc_date_phone').on(
			table.locationId,
			table.businessDate,
			table.phoneE164,
		),
		check(
			'chk_rsv_waitlist_entries_party_size',
			sql`${table.partySize} BETWEEN 1 AND 99`,
		),
	],
)

export const rsvNotifyRequests = sqliteTable(
	'rsv_notify_requests',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		businessDate: text('business_date').notNull(),
		partySize: integer('party_size').notNull(),
		fromLocalMin: integer('from_local_min').notNull(),
		toLocalMin: integer('to_local_min').notNull(),
		areaPrefId: text('area_pref_id').references(() => rsvAreas.id, {
			onDelete: 'set null',
		}),
		experienceId: text('experience_id').references(() => rsvExperiences.id, {
			onDelete: 'set null',
		}),
		contactPhoneE164: text('contact_phone_e164'),
		contactEmailNorm: text('contact_email_norm'),
		guestId: text('guest_id').references(() => rsvGuests.id, {
			onDelete: 'set null',
		}),
		locale: text('locale').notNull().default('en'),
		status: text('status', { enum: RSV_NOTIFY_STATUS_VALUES })
			.notNull()
			.default('active'),
		notifiedCount: integer('notified_count').notNull().default(0),
		lastNotifiedAt: integer('last_notified_at'),
		/** Local start minute of the opening the last notification offered. */
		lastNotifiedSlotMin: integer('last_notified_slot_min'),
		expiresAt: integer('expires_at').notNull(),
		tokenVersion: integer('token_version').notNull().default(1),
		ipHash: text('ip_hash'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_rsv_notify_requests_guest_id').on(table.guestId),
		index('idx_rsv_notify_requests_experience_id').on(table.experienceId),
		index('idx_rsv_notify_requests_area_pref_id').on(table.areaPrefId),
		index('idx_rsv_notify_requests_loc_date_status').on(
			table.locationId,
			table.businessDate,
			table.status,
		),
		check(
			'chk_rsv_notify_requests_party_size',
			sql`${table.partySize} BETWEEN 1 AND 99`,
		),
	],
)

// 4.5 Messages, payments, cross-plane outbox, journeys

export const rsvMessages = sqliteTable(
	'rsv_messages',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		reservationId: text('reservation_id').references(() => rsvReservations.id, {
			onDelete: 'set null',
		}),
		waitlistEntryId: text('waitlist_entry_id').references(
			() => rsvWaitlistEntries.id,
			{ onDelete: 'set null' },
		),
		notifyRequestId: text('notify_request_id').references(
			() => rsvNotifyRequests.id,
			{ onDelete: 'set null' },
		),
		kind: text('kind', { enum: RSV_MESSAGE_KIND_VALUES }).notNull(),
		channel: text('channel', { enum: RSV_MESSAGE_CHANNEL_VALUES }).notNull(),
		category: text('category', { enum: RSV_MESSAGE_CATEGORY_VALUES })
			.notNull()
			.default('transactional'),
		locale: text('locale').notNull().default('en'),
		sendAt: integer('send_at').notNull(),
		status: text('status', { enum: RSV_MESSAGE_STATUS_VALUES })
			.notNull()
			.default('pending'),
		attempts: integer('attempts').notNull().default(0),
		nextAttemptAt: integer('next_attempt_at').notNull().default(nowMs),
		dedupeKey: text('dedupe_key').notNull(),
		providerMessageId: text('provider_message_id'),
		lastErrorCode: text('last_error_code'),
		sentAt: integer('sent_at'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		index('idx_rsv_messages_notify_request_id').on(table.notifyRequestId),
		index('idx_rsv_messages_waitlist_entry_id').on(table.waitlistEntryId),
		uniqueIndex('uniq_rsv_messages_dedupe_key').on(table.dedupeKey),
		index('idx_rsv_messages_status_next_attempt').on(
			table.status,
			table.nextAttemptAt,
		),
		index('idx_rsv_messages_reservation').on(table.reservationId),
	],
)

export const rsvPayments = sqliteTable(
	'rsv_payments',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		reservationId: text('reservation_id')
			.notNull()
			.references(() => rsvReservations.id, { onDelete: 'cascade' }),
		provider: text('provider', { enum: RSV_PAYMENT_PROVIDER_VALUES }).notNull(),
		kind: text('kind', { enum: RSV_PAYMENT_KIND_VALUES }).notNull(),
		amountMinor: integer('amount_minor').notNull().default(0),
		currency: text('currency').notNull().default('USD'),
		platformFeeMinor: integer('platform_fee_minor').notNull().default(0),
		status: text('status', { enum: RSV_PAYMENT_RECORD_STATUS_VALUES })
			.notNull()
			.default('pending'),
		providerRef: text('provider_ref'),
		paymentMethodRef: text('payment_method_ref'),
		customerRef: text('customer_ref'),
		cardBrand: text('card_brand'),
		cardLast4: text('card_last4'),
		idempotencyKey: text('idempotency_key').notNull(),
		failureCode: text('failure_code'),
		failureMessage: text('failure_message'),
		createdBy: text('created_by'),
		createdAt: integer('created_at').notNull().default(nowMs),
		updatedAt: integer('updated_at').notNull().default(nowMs),
		// Payments contract columns.
		purpose: text('purpose'),
		providerSessionId: text('provider_session_id'),
		refundedMinor: integer('refunded_minor').notNull().default(0),
		platformFeeBp: integer('platform_fee_bp').notNull().default(0),
		attempt: integer('attempt').notNull().default(1),
		declineCode: text('decline_code'),
		previousPaymentRef: text('previous_payment_ref'),
		cardExpMonth: integer('card_exp_month'),
		cardExpYear: integer('card_exp_year'),
		disputeStatus: text('dispute_status'),
		disputeRef: text('dispute_ref'),
		parentPaymentId: text('parent_payment_id'),
		refundRef: text('refund_ref'),
		version: integer('version').notNull().default(1),
	},
	(table) => [
		uniqueIndex('uniq_rsv_payments_provider_session')
			.on(table.providerSessionId)
			.where(sql`${table.providerSessionId} IS NOT NULL`),
		index('idx_rsv_payments_parent').on(table.parentPaymentId),
		uniqueIndex('uniq_rsv_payments_idempotency_key').on(table.idempotencyKey),
		uniqueIndex('uniq_rsv_payments_provider_ref')
			.on(table.provider, table.providerRef)
			.where(sql`${table.providerRef} IS NOT NULL`),
		index('idx_rsv_payments_reservation').on(table.reservationId),
	],
)

export const rsvOutbox = sqliteTable(
	'rsv_outbox',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		kind: text('kind', { enum: RSV_OUTBOX_KIND_VALUES }).notNull(),
		dedupeKey: text('dedupe_key').notNull(),
		payload: text('payload', { mode: 'json' })
			.$type<Record<string, unknown>>()
			.notNull(),
		status: text('status', { enum: RSV_OUTBOX_STATUS_VALUES })
			.notNull()
			.default('pending'),
		attempts: integer('attempts').notNull().default(0),
		nextAttemptAt: integer('next_attempt_at').notNull().default(nowMs),
		deliveredAt: integer('delivered_at'),
		lastError: text('last_error'),
		createdAt: integer('created_at').notNull().default(nowMs),
	},
	(table) => [
		uniqueIndex('uniq_rsv_outbox_dedupe_key').on(table.dedupeKey),
		index('idx_rsv_outbox_pending').on(table.deliveredAt, table.nextAttemptAt),
	],
)

export const rsvJourneyEmissions = sqliteTable(
	'rsv_journey_emissions',
	{
		reservationId: text('reservation_id')
			.notNull()
			.references(() => rsvReservations.id, { onDelete: 'cascade' }),
		eventType: text('event_type', {
			enum: RSV_JOURNEY_EVENT_TYPE_VALUES,
		}).notNull(),
		emittedAt: integer('emitted_at').notNull().default(nowMs),
	},
	(table) => [primaryKey({ columns: [table.reservationId, table.eventType] })],
)

// 4.6 Operational

export const rsvIdempotencyKeys = sqliteTable(
	'rsv_idempotency_keys',
	{
		scope: text('scope').notNull(),
		key: text('key').notNull(),
		requestHash: text('request_hash').notNull(),
		statusCode: integer('status_code').notNull(),
		responseJson: text('response_json').notNull(),
		createdAt: integer('created_at').notNull().default(nowMs),
		expiresAt: integer('expires_at').notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.scope, table.key] }),
		index('idx_rsv_idempotency_keys_expires').on(table.expiresAt),
	],
)

export const rsvDayVersions = sqliteTable(
	'rsv_day_versions',
	{
		locationId: text('location_id').notNull(),
		businessDate: text('business_date').notNull(),
		version: integer('version').notNull().default(1),
		availabilityIncreasedAt: integer('availability_increased_at'),
		updatedAt: integer('updated_at').notNull().default(nowMs),
	},
	(table) => [primaryKey({ columns: [table.locationId, table.businessDate] })],
)

export const rsvRateCounters = sqliteTable(
	'rsv_rate_counters',
	{
		bucket: text('bucket').notNull(),
		subjectHash: text('subject_hash').notNull(),
		windowStart: integer('window_start').notNull(),
		count: integer('count').notNull().default(1),
	},
	(table) => [
		primaryKey({
			columns: [table.bucket, table.subjectHash, table.windowStart],
		}),
	],
)

export const rsvAuditLog = sqliteTable(
	'rsv_audit_log',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		at: integer('at').notNull().default(nowMs),
		actorKind: text('actor_kind', {
			enum: RSV_AUDIT_ACTOR_KIND_VALUES,
		}).notNull(),
		actorId: text('actor_id'),
		locationId: text('location_id'),
		action: text('action').notNull(),
		entityType: text('entity_type').notNull(),
		entityId: text('entity_id').notNull(),
		changes: text('changes', { mode: 'json' }).$type<Record<string, unknown>>(),
	},
	(table) => [
		index('idx_rsv_audit_log_location_at').on(table.locationId, table.at),
	],
)

// ==========================================
// 13. INFERRED TYPES
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

export type CustomerSubscription = typeof customerSubscriptions.$inferSelect
export type NewCustomerSubscription = typeof customerSubscriptions.$inferInsert

export type ShopOrder = typeof shopOrders.$inferSelect
export type NewShopOrder = typeof shopOrders.$inferInsert

export type CustomerPaymentMethod = typeof customerPaymentMethods.$inferSelect
export type NewCustomerPaymentMethod =
	typeof customerPaymentMethods.$inferInsert
export type WebsiteForm = typeof websiteForms.$inferSelect
export type WebsiteFormSubmission = typeof websiteFormSubmissions.$inferSelect

export type RestaurantOrder = typeof restaurantOrders.$inferSelect
export type NewRestaurantOrder = typeof restaurantOrders.$inferInsert
export type RestaurantOrderReservation =
	typeof restaurantOrderReservations.$inferSelect
export type NewRestaurantOrderReservation =
	typeof restaurantOrderReservations.$inferInsert
export type VoiceCall = typeof voiceCalls.$inferSelect
export type VoiceLinkHandoff = typeof voiceLinkHandoffs.$inferSelect
export type VoiceCallRequest = typeof voiceCallRequests.$inferSelect
export type VoiceSmsSend = typeof voiceSmsSends.$inferSelect
export type VoiceRecordingDeletion = typeof voiceRecordingDeletions.$inferSelect
export type VoiceLineVerification = typeof voiceLineVerifications.$inferSelect

export type StaffMember = typeof staffMembers.$inferSelect
export type NewStaffMember = typeof staffMembers.$inferInsert
export type StaffPrivate = typeof staffPrivate.$inferSelect
export type StaffPosition = typeof staffPositions.$inferSelect
export type StaffScopeAssignment = typeof staffScopeAssignments.$inferSelect
export type StaffJob = typeof staffJobs.$inferSelect
export type StaffNote = typeof staffNotes.$inferSelect
export type StaffingSettings = typeof staffingSettings.$inferSelect
export type StaffAuditLogEntry = typeof staffAuditLog.$inferSelect
export type NewStaffAuditLogEntry = typeof staffAuditLog.$inferInsert

export type LaborPolicyRow = typeof laborPolicies.$inferSelect
export type PosDevice = typeof posDevices.$inferSelect
export type PosPairingCode = typeof posPairingCodes.$inferSelect
export type PosOrderRow = typeof posOrders.$inferSelect
export type PosPaymentRow = typeof posPayments.$inferSelect
export type PosPinAttempt = typeof posPinAttempts.$inferSelect
export type PosManager = typeof posManagers.$inferSelect
export type PosOrderRevision = typeof posOrderRevisions.$inferSelect
export type PosHeldUpload = typeof posHeldUploads.$inferSelect
export type PosFiscalDocumentRow = typeof posFiscalDocuments.$inferSelect
export type PosShiftRow = typeof posShifts.$inferSelect
export type PosZatcaSettingsRow = typeof posZatcaSettings.$inferSelect
export type PosZatcaUnitRow = typeof posZatcaUnits.$inferSelect
export type PosZatcaSubmissionRow = typeof posZatcaSubmissions.$inferSelect
export type PosCashMovementRow = typeof posCashMovements.$inferSelect
export type KioskDevice = typeof kioskDevices.$inferSelect
export type KioskPairingCode = typeof kioskPairingCodes.$inferSelect
export type KioskAttempt = typeof kioskAttempts.$inferSelect
export type TimeEntry = typeof timeEntries.$inferSelect
export type TimeBreakRow = typeof timeBreaks.$inferSelect
export type TimePunch = typeof timePunches.$inferSelect
export type TimeEntryEdit = typeof timeEntryEdits.$inferSelect
export type TimesheetPeriod = typeof timesheetPeriods.$inferSelect
export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect

export type ScheduleSettingsRow = typeof scheduleSettings.$inferSelect
export type ScheduleWeekRow = typeof scheduleWeeks.$inferSelect
export type ShiftRow = typeof shifts.$inferSelect
export type NewShiftRow = typeof shifts.$inferInsert
export type SchedulePublicationRow = typeof schedulePublications.$inferSelect
export type ScheduleLinkRow = typeof scheduleLinks.$inferSelect
export type ShiftTemplateRow = typeof shiftTemplates.$inferSelect
export type StaffAvailabilityRow = typeof staffAvailability.$inferSelect
export type TimeOffRequestRow = typeof timeOffRequests.$inferSelect
export type ShiftRequestRow = typeof shiftRequests.$inferSelect

export type VoiceCallActionRow = typeof voiceCallActions.$inferSelect
export type LaborScopeSettingsRow = typeof laborScopeSettings.$inferSelect
export type SalesManualEntryRow = typeof salesManualEntries.$inferSelect
export type TipPoolSettingsRow = typeof tipPoolSettings.$inferSelect

export type HiringApplicationRow = typeof hiringApplications.$inferSelect
export type NewHiringApplicationRow = typeof hiringApplications.$inferInsert
export type HiringNoteRow = typeof hiringNotes.$inferSelect
export type HiringInterviewRow = typeof hiringInterviews.$inferSelect
export type HiringEventRow = typeof hiringEvents.$inferSelect
export type OnboardingTaskRow = typeof onboardingTasks.$inferSelect
export type OnboardingTemplateRow = typeof onboardingTemplates.$inferSelect
export type OnboardingTemplateTaskRow =
	typeof onboardingTemplateTasks.$inferSelect
export type StaffCertificateRow = typeof staffCertificates.$inferSelect

export type RsvLocationSettingsRow = typeof rsvLocationSettings.$inferSelect
export type NewRsvLocationSettingsRow = typeof rsvLocationSettings.$inferInsert
export type RsvAreaRow = typeof rsvAreas.$inferSelect
export type NewRsvAreaRow = typeof rsvAreas.$inferInsert
export type RsvTableRow = typeof rsvTables.$inferSelect
export type NewRsvTableRow = typeof rsvTables.$inferInsert
export type RsvTableComboRow = typeof rsvTableCombos.$inferSelect
export type NewRsvTableComboRow = typeof rsvTableCombos.$inferInsert
export type RsvTableComboMemberRow = typeof rsvTableComboMembers.$inferSelect
export type NewRsvTableComboMemberRow = typeof rsvTableComboMembers.$inferInsert
export type RsvFloorElementRow = typeof rsvFloorElements.$inferSelect
export type NewRsvFloorElementRow = typeof rsvFloorElements.$inferInsert
export type RsvServiceRow = typeof rsvServices.$inferSelect
export type NewRsvServiceRow = typeof rsvServices.$inferInsert
export type RsvServiceAvailabilityRow =
	typeof rsvServiceAvailability.$inferSelect
export type NewRsvServiceAvailabilityRow =
	typeof rsvServiceAvailability.$inferInsert
export type RsvTurnTimeRow = typeof rsvTurnTimes.$inferSelect
export type NewRsvTurnTimeRow = typeof rsvTurnTimes.$inferInsert
export type RsvPacingRuleRow = typeof rsvPacingRules.$inferSelect
export type NewRsvPacingRuleRow = typeof rsvPacingRules.$inferInsert
export type RsvSpecialDayRow = typeof rsvSpecialDays.$inferSelect
export type NewRsvSpecialDayRow = typeof rsvSpecialDays.$inferInsert
export type RsvBlockRow = typeof rsvBlocks.$inferSelect
export type NewRsvBlockRow = typeof rsvBlocks.$inferInsert
export type RsvPolicyRow = typeof rsvPolicies.$inferSelect
export type NewRsvPolicyRow = typeof rsvPolicies.$inferInsert
export type RsvSectionLayoutRow = typeof rsvSectionLayouts.$inferSelect
export type NewRsvSectionLayoutRow = typeof rsvSectionLayouts.$inferInsert
export type RsvSectionRow = typeof rsvSections.$inferSelect
export type NewRsvSectionRow = typeof rsvSections.$inferInsert
export type RsvSectionTableRow = typeof rsvSectionTables.$inferSelect
export type NewRsvSectionTableRow = typeof rsvSectionTables.$inferInsert
export type RsvSectionAssignmentRow = typeof rsvSectionAssignments.$inferSelect
export type NewRsvSectionAssignmentRow =
	typeof rsvSectionAssignments.$inferInsert
export type RsvMessageTextRow = typeof rsvMessageTexts.$inferSelect
export type NewRsvMessageTextRow = typeof rsvMessageTexts.$inferInsert
export type RsvExperienceRow = typeof rsvExperiences.$inferSelect
export type NewRsvExperienceRow = typeof rsvExperiences.$inferInsert
export type RsvExperienceScheduleRow =
	typeof rsvExperienceSchedules.$inferSelect
export type NewRsvExperienceScheduleRow =
	typeof rsvExperienceSchedules.$inferInsert
export type RsvGuestRow = typeof rsvGuests.$inferSelect
export type NewRsvGuestRow = typeof rsvGuests.$inferInsert
export type RsvTagRow = typeof rsvTags.$inferSelect
export type NewRsvTagRow = typeof rsvTags.$inferInsert
export type RsvGuestTagRow = typeof rsvGuestTags.$inferSelect
export type NewRsvGuestTagRow = typeof rsvGuestTags.$inferInsert
export type RsvGuestNoteRow = typeof rsvGuestNotes.$inferSelect
export type NewRsvGuestNoteRow = typeof rsvGuestNotes.$inferInsert
export type RsvGuestMergeRow = typeof rsvGuestMerges.$inferSelect
export type NewRsvGuestMergeRow = typeof rsvGuestMerges.$inferInsert
export type RsvReservationRow = typeof rsvReservations.$inferSelect
export type NewRsvReservationRow = typeof rsvReservations.$inferInsert
export type RsvReservationTagRow = typeof rsvReservationTags.$inferSelect
export type NewRsvReservationTagRow = typeof rsvReservationTags.$inferInsert
export type RsvHoldRow = typeof rsvHolds.$inferSelect
export type NewRsvHoldRow = typeof rsvHolds.$inferInsert
export type RsvTableOccupancyRow = typeof rsvTableOccupancies.$inferSelect
export type NewRsvTableOccupancyRow = typeof rsvTableOccupancies.$inferInsert
export type RsvReservationEventRow = typeof rsvReservationEvents.$inferSelect
export type NewRsvReservationEventRow = typeof rsvReservationEvents.$inferInsert
export type RsvServiceNoteRow = typeof rsvServiceNotes.$inferSelect
export type NewRsvServiceNoteRow = typeof rsvServiceNotes.$inferInsert
export type RsvWaitlistEntryRow = typeof rsvWaitlistEntries.$inferSelect
export type NewRsvWaitlistEntryRow = typeof rsvWaitlistEntries.$inferInsert
export type RsvNotifyRequestRow = typeof rsvNotifyRequests.$inferSelect
export type NewRsvNotifyRequestRow = typeof rsvNotifyRequests.$inferInsert
export type RsvMessageRow = typeof rsvMessages.$inferSelect
export type NewRsvMessageRow = typeof rsvMessages.$inferInsert
export type RsvPaymentRow = typeof rsvPayments.$inferSelect
export type NewRsvPaymentRow = typeof rsvPayments.$inferInsert
export type RsvOutboxRow = typeof rsvOutbox.$inferSelect
export type NewRsvOutboxRow = typeof rsvOutbox.$inferInsert
export type RsvJourneyEmissionRow = typeof rsvJourneyEmissions.$inferSelect
export type NewRsvJourneyEmissionRow = typeof rsvJourneyEmissions.$inferInsert
export type RsvIdempotencyKeyRow = typeof rsvIdempotencyKeys.$inferSelect
export type NewRsvIdempotencyKeyRow = typeof rsvIdempotencyKeys.$inferInsert
export type RsvDayVersionRow = typeof rsvDayVersions.$inferSelect
export type NewRsvDayVersionRow = typeof rsvDayVersions.$inferInsert
export type RsvRateCounterRow = typeof rsvRateCounters.$inferSelect
export type NewRsvRateCounterRow = typeof rsvRateCounters.$inferInsert
export type RsvAuditLogRow = typeof rsvAuditLog.$inferSelect
export type NewRsvAuditLogRow = typeof rsvAuditLog.$inferInsert
