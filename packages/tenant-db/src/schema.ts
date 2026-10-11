import {
	sqliteTable,
	text,
	integer,
	index,
	uniqueIndex,
	primaryKey,
	real,
} from 'drizzle-orm/sqlite-core'
import { sql, relations } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

import {
	RESTAURANT_ACTIVE_ORDER_STATUSES,
	RESTAURANT_ORDER_STATUS_VALUES,
	RESTAURANT_PAYMENT_STATUS_VALUES,
} from '@repo/common/restaurant-orders'

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

export const CUSTOMER_SUBSCRIPTION_TOPICS = ['drops'] as const
export const CUSTOMER_SUBSCRIPTION_CHANNELS = ['sms'] as const
export const CUSTOMER_SUBSCRIPTION_SOURCES = [
	'menu',
	'drops_page',
	'drop_page',
	'order_success',
	'profile',
] as const

// Explicit marketing consent, one row per customer + topic + channel. Opting
// out keeps the row (unsubscribedAt set) as the record of the opt-out; a later
// opt-in clears it and restamps subscribedAt/source.
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
// 12. STAFFING (workforce records stay regional; see ADR 047)
// ==========================================
// Staff are not operator accounts. `user_id` is an optional opaque link to a
// control-plane user and is never used for authorization. The per-org database
// file is the tenancy boundary, like `customers`.
export const staffMembers = sqliteTable(
	'staff_members',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		userId: text('user_id'),
		firstName: text('first_name').notNull(),
		lastName: text('last_name').notNull().default(''),
		email: text('email'),
		phone: text('phone'),
		status: text('status', { enum: ['active', 'terminated'] })
			.notNull()
			.default('active'),
		hiredOn: text('hired_on'),
		terminatedOn: text('terminated_on'),
		terminationReason: text('termination_reason'),
		note: text('note').notNull().default(''),
		// HMAC of the kiosk PIN keyed by AUTH_HMAC_SECRET. Unique so a PIN alone
		// identifies one person at the kiosk.
		pinHash: text('pin_hash'),
		pinSetAt: integer('pin_set_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
		updatedAt: integer('updated_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
	},
	(table) => [
		index('idx_staff_members_status').on(table.status, table.lastName),
		index('idx_staff_members_email').on(table.email),
		uniqueIndex('staff_members_pin_hash_unique').on(table.pinHash),
	],
)

export const staffPositions = sqliteTable(
	'staff_positions',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		name: text('name').notNull(),
		colorKey: text('color_key').notNull().default('gray'),
		sortOrder: integer('sort_order').notNull().default(0),
		archivedAt: integer('archived_at', { mode: 'timestamp' }),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
	},
	(table) => [
		uniqueIndex('staff_positions_name_unique').on(sql`lower(${table.name})`),
	],
)

// `location_id` is an opaque control-plane location id, like
// `restaurant_orders.location_id`.
export const staffAssignments = sqliteTable(
	'staff_assignments',
	{
		staffId: text('staff_id')
			.notNull()
			.references(() => staffMembers.id, { onDelete: 'cascade' }),
		locationId: text('location_id').notNull(),
		positionId: text('position_id')
			.notNull()
			.references(() => staffPositions.id, { onDelete: 'restrict' }),
		isPrimary: integer('is_primary', { mode: 'boolean' })
			.notNull()
			.default(false),
	},
	(table) => [
		primaryKey({
			columns: [table.staffId, table.locationId, table.positionId],
		}),
		index('idx_staff_assignments_location').on(table.locationId),
		index('idx_staff_assignments_position').on(table.positionId),
	],
)

// Regional audit trail for workforce changes. `actor_ref` is the operator
// token subject (opaque control-plane user id) or `kiosk:<deviceId>`.
export const staffEvents = sqliteTable(
	'staff_events',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		staffId: text('staff_id'),
		kind: text('kind').notNull(),
		actorRef: text('actor_ref').notNull(),
		detail: text('detail', { mode: 'json' }),
		at: integer('at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
	},
	(table) => [
		index('idx_staff_events_staff').on(table.staffId, table.at),
		index('idx_staff_events_at').on(table.at),
	],
)

export const staffingSettings = sqliteTable('staffing_settings', {
	id: text('id').primaryKey().default('default'),
	weekStart: text('week_start', { enum: ['monday', 'sunday'] })
		.notNull()
		.default('monday'),
	weeklyHoursThreshold: real('weekly_hours_threshold').default(40),
	lateGraceMinutes: integer('late_grace_minutes').notNull().default(5),
	updatedAt: integer('updated_at', { mode: 'timestamp' })
		.notNull()
		.default(sql`(strftime('%s', 'now'))`),
})

/** What staff were last told about a shift; null until its first publish. */
export type PublishedShift = {
	staffId: string | null
	positionId: string | null
	localDate: string
	startTime: string
	endTime: string
	unpaidBreakMinutes: number
	note: string
}

// Managers edit the draft columns. Publishing copies them into `published`,
// which is the only version kiosks and notifications read. Deleting a
// published shift sets `deleted_at` so the next publish can tell the person;
// unpublished shifts are removed outright. Wall-clock times are kept next to
// the UTC instants so copying a week across a DST change keeps local times.
export const shifts = sqliteTable(
	'shifts',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		staffId: text('staff_id').references(() => staffMembers.id, {
			onDelete: 'set null',
		}),
		positionId: text('position_id').references(() => staffPositions.id, {
			onDelete: 'set null',
		}),
		localDate: text('local_date').notNull(),
		startTime: text('start_time').notNull(),
		endTime: text('end_time').notNull(),
		startAt: integer('start_at', { mode: 'timestamp' }).notNull(),
		endAt: integer('end_at', { mode: 'timestamp' }).notNull(),
		timeZone: text('tz').notNull(),
		unpaidBreakMinutes: integer('unpaid_break_min').notNull().default(0),
		note: text('note').notNull().default(''),
		published: text('published', { mode: 'json' }).$type<PublishedShift>(),
		publishedAt: integer('published_at', { mode: 'timestamp' }),
		deletedAt: integer('deleted_at', { mode: 'timestamp' }),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
		updatedAt: integer('updated_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
	},
	(table) => [
		index('idx_shifts_location_date').on(table.locationId, table.localDate),
		index('idx_shifts_staff_start').on(table.staffId, table.startAt),
	],
)

export const schedulePublications = sqliteTable(
	'schedule_publications',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		weekStart: text('week_start').notNull(),
		publishedBy: text('published_by').notNull(),
		shiftCount: integer('shift_count').notNull(),
		changedCount: integer('changed_count').notNull(),
		notifiedCount: integer('notified_count').notNull().default(0),
		notNotifiedCount: integer('not_notified_count').notNull().default(0),
		publishedAt: integer('published_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
	},
	(table) => [
		index('idx_schedule_publications_week').on(
			table.locationId,
			table.weekStart,
			table.publishedAt,
		),
	],
)

// A shared tablet paired to one location. The device token is shown once at
// pairing; only its hash is stored. Wrong PINs lock the device, not a person,
// because a PIN alone identifies who is punching.
export const kioskDevices = sqliteTable(
	'kiosk_devices',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		locationName: text('location_name').notNull().default(''),
		timeZone: text('tz').notNull(),
		name: text('name').notNull(),
		tokenHash: text('token_hash').notNull(),
		createdBy: text('created_by').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
		lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
		failedPinCount: integer('failed_pin_count').notNull().default(0),
		lockedUntil: integer('locked_until', { mode: 'timestamp' }),
		revokedAt: integer('revoked_at', { mode: 'timestamp' }),
		revokedBy: text('revoked_by'),
	},
	(table) => [
		uniqueIndex('kiosk_devices_token_hash_unique').on(table.tokenHash),
		index('idx_kiosk_devices_location').on(table.locationId),
	],
)

export const kioskPairingCodes = sqliteTable('kiosk_pairing_codes', {
	codeHash: text('code_hash').primaryKey(),
	locationId: text('location_id').notNull(),
	locationName: text('location_name').notNull().default(''),
	timeZone: text('tz').notNull(),
	name: text('name').notNull(),
	createdBy: text('created_by').notNull(),
	expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
	usedAt: integer('used_at', { mode: 'timestamp' }),
	deviceId: text('device_id'),
})

// One row per worked stretch. Approval locks the row against edits until a
// manager reopens it. Every change writes a `time_entry_events` row.
export const timeEntries = sqliteTable(
	'time_entries',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		staffId: text('staff_id')
			.notNull()
			.references(() => staffMembers.id),
		locationId: text('location_id').notNull(),
		positionId: text('position_id').references(() => staffPositions.id, {
			onDelete: 'set null',
		}),
		shiftId: text('shift_id').references(() => shifts.id, {
			onDelete: 'set null',
		}),
		clockInAt: integer('clock_in_at', { mode: 'timestamp' }).notNull(),
		clockOutAt: integer('clock_out_at', { mode: 'timestamp' }),
		timeZone: text('tz').notNull(),
		localDate: text('local_date').notNull(),
		source: text('source', { enum: ['kiosk', 'manager'] }).notNull(),
		deviceId: text('device_id'),
		unpaidBreakMinutes: integer('unpaid_break_min').notNull().default(0),
		note: text('note').notNull().default(''),
		approvedAt: integer('approved_at', { mode: 'timestamp' }),
		approvedBy: text('approved_by'),
		deletedAt: integer('deleted_at', { mode: 'timestamp' }),
		clientRequestId: text('client_request_id'),
		clockOutRequestId: text('clock_out_request_id'),
		createdAt: integer('created_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
		updatedAt: integer('updated_at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
	},
	(table) => [
		uniqueIndex('time_entries_client_request_unique').on(table.clientRequestId),
		uniqueIndex('time_entries_clock_out_request_unique').on(
			table.clockOutRequestId,
		),
		// At most one open entry per person, so a double tap cannot clock in twice.
		uniqueIndex('time_entries_one_open_per_staff')
			.on(table.staffId)
			.where(sql`clock_out_at IS NULL AND deleted_at IS NULL`),
		index('idx_time_entries_location_date').on(
			table.locationId,
			table.localDate,
		),
		index('idx_time_entries_staff_in').on(table.staffId, table.clockInAt),
	],
)

// Append-only. `actor_ref` is an operator user id or `kiosk:<deviceId>`.
export const timeEntryEvents = sqliteTable(
	'time_entry_events',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		entryId: text('entry_id')
			.notNull()
			.references(() => timeEntries.id),
		kind: text('kind').notNull(),
		actorType: text('actor_type', { enum: ['operator', 'kiosk'] }).notNull(),
		actorRef: text('actor_ref').notNull(),
		before: text('before_json', { mode: 'json' }),
		after: text('after_json', { mode: 'json' }),
		reason: text('reason'),
		at: integer('at', { mode: 'timestamp' })
			.notNull()
			.default(sql`(strftime('%s', 'now'))`),
	},
	(table) => [index('idx_time_entry_events_entry').on(table.entryId, table.at)],
)

export type StaffMember = typeof staffMembers.$inferSelect
export type StaffPosition = typeof staffPositions.$inferSelect
export type StaffAssignment = typeof staffAssignments.$inferSelect
export type StaffEvent = typeof staffEvents.$inferSelect
export type StaffingSettingsRow = typeof staffingSettings.$inferSelect
export type Shift = typeof shifts.$inferSelect
export type SchedulePublication = typeof schedulePublications.$inferSelect
export type KioskDevice = typeof kioskDevices.$inferSelect
export type TimeEntry = typeof timeEntries.$inferSelect
export type TimeEntryEvent = typeof timeEntryEvents.$inferSelect

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
