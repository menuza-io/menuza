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
// 12. INFERRED TYPES
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
