import {
	sqliteTable,
	text,
	integer,
	index,
	uniqueIndex,
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
		locationId: text('location_id'),
		fulfillmentType: text('fulfillment_type', {
			enum: ['pickup', 'delivery'],
		})
			.notNull()
			.default('pickup'),
		kitchenStatus: text('kitchen_status', {
			enum: ['placed', 'accepted', 'ready', 'completed', 'cancelled'],
		})
			.notNull()
			.default('placed'),
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
		index('idx_shop_orders_location').on(table.locationId),
		index('idx_shop_orders_kitchen_status').on(table.kitchenStatus),
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

export const shopOrdersRelations = relations(shopOrders, ({ one, many }) => ({
	customer: one(customers, {
		fields: [shopOrders.customerId],
		references: [customers.id],
	}),
	lineItems: many(shopOrderLineItems),
}))

export const shopOrderLineItems = sqliteTable(
	'shop_order_line_items',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		orderId: text('order_id')
			.notNull()
			.references(() => shopOrders.id, { onDelete: 'cascade' }),
		menuItemId: text('menu_item_id'),
		name: text('name').notNull(),
		quantity: integer('quantity').notNull().default(1),
		unitPriceCents: integer('unit_price_cents').notNull(),
		lineTotalCents: integer('line_total_cents').notNull(),
		modifierSummary: text('modifier_summary'),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [index('idx_shop_order_line_items_order').on(table.orderId)],
)

export const shopOrderLineItemsRelations = relations(
	shopOrderLineItems,
	({ one }) => ({
		order: one(shopOrders, {
			fields: [shopOrderLineItems.orderId],
			references: [shopOrders.id],
		}),
	}),
)

// ==========================================
// 7b. RESTAURANT MENU (per-location catalog)
// ==========================================

/** Branch menus (e.g. Lunch, Dinner). Categories attach via menu_category_links. */
export const menus = sqliteTable(
	'menus',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		name: text('name').notNull(),
		description: text('description'),
		menuType: text('menu_type', {
			enum: ['olo', 'catering', 'dine-in'],
		})
			.notNull()
			.default('olo'),
		showCalories: integer('show_calories', { mode: 'boolean' })
			.notNull()
			.default(false),
		instructionsEnabled: integer('instructions_enabled', { mode: 'boolean' })
			.notNull()
			.default(true),
		active: integer('active', { mode: 'boolean' }).notNull().default(true),
		sortOrder: integer('sort_order').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [index('idx_menus_location').on(table.locationId)],
)

export const menuCategoryLinks = sqliteTable(
	'menu_category_links',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		menuId: text('menu_id')
			.notNull()
			.references(() => menus.id, { onDelete: 'cascade' }),
		categoryId: text('category_id')
			.notNull()
			.references(() => menuCategories.id, { onDelete: 'cascade' }),
		sortOrder: integer('sort_order').notNull().default(0),
	},
	(table) => [
		index('idx_menu_category_links_menu').on(table.menuId),
		index('idx_menu_category_links_category').on(table.categoryId),
	],
)

export const menuCategories = sqliteTable(
	'menu_categories',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		name: text('name').notNull(),
		description: text('description'),
		imageUrl: text('image_url'),
		upsellCategoryIds: text('upsell_category_ids', { mode: 'json' })
			.$type<string[]>()
			.notNull()
			.default([]),
		sortOrder: integer('sort_order').notNull().default(0),
		active: integer('active', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		index('idx_menu_categories_location').on(table.locationId),
		index('idx_menu_categories_sort').on(table.locationId, table.sortOrder),
	],
)

export const menuItems = sqliteTable(
	'menu_items',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		categoryId: text('category_id')
			.notNull()
			.references(() => menuCategories.id, { onDelete: 'cascade' }),
		locationId: text('location_id').notNull(),
		name: text('name').notNull(),
		description: text('description'),
		priceCents: integer('price_cents').notNull(),
		imageUrl: text('image_url'),
		points: integer('points'),
		alcohol: integer('alcohol', { mode: 'boolean' }).notNull().default(false),
		glutenFree: integer('gluten_free', { mode: 'boolean' })
			.notNull()
			.default(false),
		vegetarian: integer('vegetarian', { mode: 'boolean' })
			.notNull()
			.default(false),
		allergens: text('allergens', { mode: 'json' })
			.$type<string[]>()
			.notNull()
			.default([]),
		calorieMin: integer('calorie_min'),
		calorieMax: integer('calorie_max'),
		popular: integer('popular', { mode: 'boolean' }).notNull().default(false),
		upsell: integer('upsell', { mode: 'boolean' }).notNull().default(false),
		taxable: integer('taxable', { mode: 'boolean' }).notNull().default(true),
		excludeFromThrottle: integer('exclude_from_throttle', { mode: 'boolean' })
			.notNull()
			.default(false),
		active: integer('active', { mode: 'boolean' }).notNull().default(true),
		sortOrder: integer('sort_order').notNull().default(0),
		createdAt: integer('created_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
		updatedAt: integer('updated_at', { mode: 'timestamp' }).default(
			sql`(strftime('%s', 'now'))`,
		),
	},
	(table) => [
		index('idx_menu_items_category').on(table.categoryId),
		index('idx_menu_items_location').on(table.locationId),
	],
)

/** Reusable modifier groups (Owner modifier-sets) at location scope. */
export const menuModifierSets = sqliteTable(
	'menu_modifier_sets',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		locationId: text('location_id').notNull(),
		name: text('name').notNull(),
		displayType: text('display_type', {
			enum: [
				'single-select',
				'multi-select',
				'quantity-select',
				'pizza-topping',
				'custom',
			],
		})
			.notNull()
			.default('single-select'),
		minSelections: integer('min_selections').notNull().default(0),
		maxSelections: integer('max_selections').notNull().default(1),
		required: integer('required', { mode: 'boolean' }).notNull().default(false),
		preselectedOptionIds: text('preselected_option_ids', { mode: 'json' })
			.$type<string[]>()
			.notNull()
			.default([]),
		sortOrder: integer('sort_order').notNull().default(0),
	},
	(table) => [index('idx_menu_modifier_sets_location').on(table.locationId)],
)

export const menuItemModifierSetLinks = sqliteTable(
	'menu_item_modifier_set_links',
	{
		menuItemId: text('menu_item_id')
			.notNull()
			.references(() => menuItems.id, { onDelete: 'cascade' }),
		modifierSetId: text('modifier_set_id')
			.notNull()
			.references(() => menuModifierSets.id, { onDelete: 'cascade' }),
		sortOrder: integer('sort_order').notNull().default(0),
	},
	(table) => [
		index('idx_menu_item_modifier_set_item').on(table.menuItemId),
		index('idx_menu_item_modifier_set_set').on(table.modifierSetId),
	],
)

export const menuModifierOptions = sqliteTable(
	'menu_modifier_options',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => randomUUID()),
		modifierSetId: text('modifier_set_id')
			.notNull()
			.references(() => menuModifierSets.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		description: text('description'),
		priceCents: integer('price_cents').notNull().default(0),
		active: integer('active', { mode: 'boolean' }).notNull().default(true),
		sortOrder: integer('sort_order').notNull().default(0),
	},
	(table) => [index('idx_menu_modifier_options_set').on(table.modifierSetId)],
)

export const menusRelations = relations(menus, ({ many }) => ({
	categoryLinks: many(menuCategoryLinks),
}))

export const menuCategoryLinksRelations = relations(
	menuCategoryLinks,
	({ one }) => ({
		menu: one(menus, {
			fields: [menuCategoryLinks.menuId],
			references: [menus.id],
		}),
		category: one(menuCategories, {
			fields: [menuCategoryLinks.categoryId],
			references: [menuCategories.id],
		}),
	}),
)

export const menuCategoriesRelations = relations(
	menuCategories,
	({ many }) => ({
		items: many(menuItems),
		menuLinks: many(menuCategoryLinks),
	}),
)

export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({
	category: one(menuCategories, {
		fields: [menuItems.categoryId],
		references: [menuCategories.id],
	}),
	modifierSetLinks: many(menuItemModifierSetLinks),
}))

export const menuModifierSetsRelations = relations(
	menuModifierSets,
	({ many }) => ({
		options: many(menuModifierOptions),
		itemLinks: many(menuItemModifierSetLinks),
	}),
)

export const menuItemModifierSetLinksRelations = relations(
	menuItemModifierSetLinks,
	({ one }) => ({
		menuItem: one(menuItems, {
			fields: [menuItemModifierSetLinks.menuItemId],
			references: [menuItems.id],
		}),
		modifierSet: one(menuModifierSets, {
			fields: [menuItemModifierSetLinks.modifierSetId],
			references: [menuModifierSets.id],
		}),
	}),
)

export const menuModifierOptionsRelations = relations(
	menuModifierOptions,
	({ one }) => ({
		modifierSet: one(menuModifierSets, {
			fields: [menuModifierOptions.modifierSetId],
			references: [menuModifierSets.id],
		}),
	}),
)

/** @deprecated Use menuModifierSets — alias for transitional imports */
export const menuModifierGroups = menuModifierSets

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

// ==========================================
// 10. INFERRED TYPES
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

export type ShopOrderLineItem = typeof shopOrderLineItems.$inferSelect
export type MenuCategory = typeof menuCategories.$inferSelect
export type MenuItem = typeof menuItems.$inferSelect
export type Menu = typeof menus.$inferSelect
export type MenuCategoryLink = typeof menuCategoryLinks.$inferSelect
export type MenuModifierSet = typeof menuModifierSets.$inferSelect
export type MenuItemModifierSetLink =
	typeof menuItemModifierSetLinks.$inferSelect
/** @deprecated Renamed to MenuModifierSet */
export type MenuModifierGroup = MenuModifierSet
export type MenuModifierOption = typeof menuModifierOptions.$inferSelect

export type CustomerPaymentMethod = typeof customerPaymentMethods.$inferSelect
export type NewCustomerPaymentMethod =
	typeof customerPaymentMethods.$inferInsert
export type WebsiteForm = typeof websiteForms.$inferSelect
export type WebsiteFormSubmission = typeof websiteFormSubmissions.$inferSelect
