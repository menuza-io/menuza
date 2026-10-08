import type Stripe from 'stripe'

import {
	createConnectAccountLink,
	createConnectExpressAccount,
	createConnectLoginLink,
	createOrUpdatePolarShopProduct,
	createPolarShopCheckout,
	createShopCheckoutSession,
	createShopPaymentIntent,
	createCheckoutShopClient,
	createCheckoutShopPaymentSession,
	expireShopCheckoutSession,
	getCheckoutDashboardUrl,
	getPolarDashboardUrl,
	inviteCheckoutSubEntity,
	type mapCheckoutShopPayment,
	mapCheckoutWebhookToPayment,
	mapPolarShopOrder,
	checkoutPaymentStatusToOrderStatus,
	polarCheckoutStatusToOrderStatus,
	retrieveCheckoutShopPayment,
	retrieveCheckoutSubEntityStatus,
	retrieveConnectAccountStatus,
	retrievePolarShopCheckout,
	verifyCheckoutWebhookEvent,
	verifyPolarWebhookEvent,
	type PolarShopCheckout,
	type PolarShopOrder,
} from '../connect'
import {
	calculateShopFees,
	SHOP_PLATFORM_FEE_PERCENT,
} from '../connect/shop-fees'
import { createPolarProvider, createStripeProvider } from '../factory'
import { type ShopCommerceConfig } from './config'
import {
	getShopProcessorDefinition,
	normalizeShopProcessor,
} from './processors'
import {
	type ShopCheckoutSession,
	type ShopCheckoutUi,
	type ShopConnectAccountUpdate,
	type ShopInlinePayment,
	type ShopCheckoutWebhookEvent,
	type ShopMorWebhookEvent,
	type ShopOrderSnapshot,
	type ShopOrderStatus,
	type ShopOrderUpsert,
	type ShopProcessorId,
	SHOP_ORDER_METADATA_TYPE,
} from './types'

function redactSecret(message: string, secret: string | undefined) {
	if (!secret) return message
	return message.replaceAll(secret, '[redacted]')
}

export class ShopOrderNotFoundError extends Error {
	constructor() {
		super('Order not found')
		this.name = 'ShopOrderNotFoundError'
	}
}

function isProviderNotFoundError(error: unknown) {
	if (!error || typeof error !== 'object') return false
	const candidate = error as {
		status?: number
		statusCode?: number
		response?: { status?: number }
	}
	return (
		candidate.status === 404 ||
		candidate.statusCode === 404 ||
		candidate.response?.status === 404
	)
}

function getStripeKeyPayload(key: string) {
	return key.match(/^(?:sk|rk|pk)_(?:test|live)_(.+)$/)?.[1] ?? null
}

function getStripeKeyMode(key: string) {
	if (key.startsWith('sk_test_') || key.startsWith('pk_test_')) return 'test'
	if (key.startsWith('sk_live_') || key.startsWith('pk_live_')) return 'live'
	return null
}

function assertStripePublishableKey(secretKey: string, publishableKey: string) {
	if (
		!publishableKey.startsWith('pk_test_') &&
		!publishableKey.startsWith('pk_live_')
	) {
		throw new Error(
			'STRIPE_PUBLISHABLE_KEY must be a valid pk_test_ or pk_live_ key.',
		)
	}

	const secretMode = getStripeKeyMode(secretKey)
	const publishableMode = getStripeKeyMode(publishableKey)
	if (secretMode && publishableMode && secretMode !== publishableMode) {
		throw new Error(
			'STRIPE_PUBLISHABLE_KEY mode does not match STRIPE_SECRET_KEY (test vs live).',
		)
	}

	const secretPayload = getStripeKeyPayload(secretKey)
	const publishablePayload = getStripeKeyPayload(publishableKey)
	if (!secretPayload || !publishablePayload) return

	const usesNewFormat = (payload: string) =>
		payload.startsWith('51') && payload.length >= 20

	if (usesNewFormat(secretPayload) && usesNewFormat(publishablePayload)) {
		const compareLength = Math.min(
			secretPayload.length,
			publishablePayload.length,
			14,
		)
		if (
			secretPayload.slice(0, compareLength) !==
			publishablePayload.slice(0, compareLength)
		) {
			throw new Error(
				'STRIPE_PUBLISHABLE_KEY does not match STRIPE_SECRET_KEY (different accounts).',
			)
		}
	}
}

function mapPaymentIntentStatus(
	status: Stripe.PaymentIntent.Status,
): ShopOrderStatus {
	if (status === 'succeeded') return 'paid'
	if (status === 'canceled') return 'failed'
	return 'pending'
}

function buildShopOrderUpsert(options: {
	orgId: string
	customerIdFromMetadata: string | null
	productName: string
	amountCents: number
	currency: string
	processor: ShopProcessorId
	processorCheckoutId: string | null
	processorPaymentId: string | null
	processorOrderId: string | null
	status: ShopOrderStatus
}): ShopOrderUpsert {
	const { platformFeeCents, orgPayoutCents } = calculateShopFees(
		options.amountCents,
	)

	return {
		orgId: options.orgId,
		customerIdFromMetadata: options.customerIdFromMetadata,
		productName: options.productName,
		amountCents: options.amountCents,
		platformFeeCents,
		orgPayoutCents,
		currency: options.currency,
		processor: options.processor,
		processorCheckoutId: options.processorCheckoutId,
		processorPaymentId: options.processorPaymentId,
		processorOrderId: options.processorOrderId,
		status: options.status,
	}
}

export class ShopCommerce {
	private stripeProvider: ReturnType<typeof createStripeProvider> | null = null
	private polarProvider:
		ReturnType<typeof createPolarProvider> | null | undefined
	private checkoutClient: ReturnType<typeof createCheckoutShopClient> | null =
		null
	private cachedPublishableKey: string | undefined

	constructor(private readonly config: ShopCommerceConfig) {}

	get platformFeePercent() {
		return SHOP_PLATFORM_FEE_PERCENT
	}

	listConfiguredProcessors(): ShopProcessorId[] {
		const processors: ShopProcessorId[] = []
		if (this.isProcessorConfigured('connect')) processors.push('connect')
		if (this.isProcessorConfigured('mor')) processors.push('mor')
		if (this.isProcessorConfigured('checkout')) processors.push('checkout')
		return processors
	}

	isProcessorConfigured(processor: ShopProcessorId) {
		if (processor === 'connect') {
			return Boolean(this.config.stripeSecretKey)
		}
		if (processor === 'mor') {
			return Boolean(this.config.polarAccessToken)
		}
		if (processor === 'checkout') {
			return Boolean(
				this.config.checkoutSecretKey &&
				this.config.checkoutPublicKey &&
				this.config.checkoutSubdomain &&
				this.config.checkoutProcessingChannelId,
			)
		}
		return false
	}

	getProcessorDashboardUrl(processor: ShopProcessorId): string | null {
		if (processor === 'mor' && this.isProcessorConfigured('mor')) {
			return getPolarDashboardUrl(this.config.polarServer ?? 'sandbox')
		}
		if (processor === 'checkout' && this.isProcessorConfigured('checkout')) {
			return getCheckoutDashboardUrl(
				this.config.checkoutEnvironment ?? 'sandbox',
			)
		}
		return null
	}

	getHostedDashboardUrl(processor: ShopProcessorId): string | null {
		return this.getProcessorDashboardUrl(processor)
	}

	getProcessorCheckoutUi(processor: ShopProcessorId): ShopCheckoutUi {
		const definition = getShopProcessorDefinition(processor)
		if (definition.supportsHostedEmbed) return 'hosted-embed'
		if (definition.supportsInlineCard) return 'inline-card'
		return 'redirect'
	}

	private getCheckoutShop() {
		if (
			!this.config.checkoutSecretKey ||
			!this.config.checkoutPublicKey ||
			!this.config.checkoutSubdomain ||
			!this.config.checkoutProcessingChannelId
		) {
			throw new Error('Checkout.com shop is not configured on this platform.')
		}
		if (!this.checkoutClient) {
			this.checkoutClient = createCheckoutShopClient({
				secretKey: this.config.checkoutSecretKey,
				publicKey: this.config.checkoutPublicKey,
				subdomain: this.config.checkoutSubdomain,
				processingChannelId: this.config.checkoutProcessingChannelId,
				environment: this.config.checkoutEnvironment,
			})
		}
		return this.checkoutClient
	}

	private getStripe() {
		if (!this.config.stripeSecretKey) {
			throw new Error('Connect checkout is not configured on this platform.')
		}
		if (!this.stripeProvider) {
			this.stripeProvider = createStripeProvider(this.config.stripeSecretKey)
		}
		return this.stripeProvider.getClient()
	}

	private getPolar() {
		if (!this.config.polarAccessToken) {
			throw new Error('Hosted checkout is not configured on this platform.')
		}
		if (this.polarProvider === undefined) {
			this.polarProvider = createPolarProvider(
				this.config.polarAccessToken,
				this.config.polarOrganizationId,
				this.config.polarServer,
			)
		}
		if (!this.polarProvider) {
			throw new Error('Hosted checkout is not configured on this platform.')
		}
		return this.polarProvider.getClient()
	}

	private getPublishableKey() {
		if (!this.config.stripePublishableKey) {
			throw new Error('STRIPE_PUBLISHABLE_KEY is not configured.')
		}
		if (!this.cachedPublishableKey) {
			if (this.config.validateStripeKeys && this.config.stripeSecretKey) {
				assertStripePublishableKey(
					this.config.stripeSecretKey,
					this.config.stripePublishableKey,
				)
			}
			this.cachedPublishableKey = this.config.stripePublishableKey
		}
		return this.cachedPublishableKey
	}

	private async withConnect<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation()
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Connect checkout failed'
			throw new Error(redactSecret(message, this.config.stripeSecretKey))
		}
	}

	private async withHosted<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation()
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Hosted checkout failed'
			throw new Error(redactSecret(message, this.config.polarAccessToken))
		}
	}

	private async withCheckoutCommerce<T>(
		operation: () => Promise<T>,
	): Promise<T> {
		try {
			return await operation()
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Checkout.com request failed'
			throw new Error(redactSecret(message, this.config.checkoutSecretKey))
		}
	}

	async retrieveConnectAccountStatus(accountId: string) {
		return this.withConnect(() =>
			retrieveConnectAccountStatus(this.getStripe(), accountId),
		)
	}

	async createConnectExpressAccount(options: {
		organizationId: string
		organizationName: string
	}) {
		return this.withConnect(() =>
			createConnectExpressAccount(this.getStripe(), options),
		)
	}

	async createConnectOnboardingLink(options: {
		accountId: string
		refreshUrl: string
		returnUrl: string
	}) {
		const link = await this.withConnect(() =>
			createConnectAccountLink(this.getStripe(), options),
		)
		return link.url
	}

	async createConnectDashboardLink(accountId: string) {
		const link = await this.withConnect(() =>
			createConnectLoginLink(this.getStripe(), accountId),
		)
		return link.url
	}

	async inviteCheckoutSubEntity(options: {
		organizationId: string
		inviteeEmail: string
	}) {
		return this.withCheckoutCommerce(() =>
			inviteCheckoutSubEntity(this.getCheckoutShop(), options),
		)
	}

	async retrieveCheckoutSubEntityStatus(entityId: string) {
		return this.withCheckoutCommerce(() =>
			retrieveCheckoutSubEntityStatus(this.getCheckoutShop(), entityId),
		)
	}

	async syncHostedCatalogProduct(options: {
		organizationId: string
		organizationName: string
		productId?: string | null
		productName: string
		productDescription?: string | null
		amountCents: number
	}) {
		if (options.amountCents < 50) {
			throw new Error('Minimum shop price is $0.50')
		}

		return this.withHosted(() =>
			createOrUpdatePolarShopProduct(this.getPolar(), {
				productId: options.productId,
				organizationId: options.organizationId,
				organizationName: options.organizationName,
				productName: options.productName,
				productDescription: options.productDescription,
				amountCents: options.amountCents,
				polarOrganizationId: this.config.polarOrganizationId ?? null,
			}),
		)
	}

	async createCheckout(options: {
		processor: ShopProcessorId
		productName: string
		productDescription?: string | null
		amountCents: number
		/**
		 * ISO currency (lowercase for Stripe, any case for Checkout.com which
		 * uppercases internally). Omit to keep the existing shop default ('usd').
		 */
		currency?: string | null
		connectAccountId?: string | null
		checkoutSubEntityId?: string | null
		hostedProductId?: string | null
		successUrl: string
		cancelUrl: string
		returnUrl?: string
		metadata: Record<string, string>
		customerEmail?: string | null
		externalCustomerId?: string | null
		embedOrigin?: string | null
		/** Stripe Checkout session expiry (minimum 30 minutes from now). */
		expiresAt?: Date | null
		/** Deterministic Stripe idempotency key for retried creates. */
		idempotencyKey?: string | null
		/** Checkout.com merchant reference (defaults to metadata orgId). */
		reference?: string | null
		/** Checkout.com billing country (defaults to 'US'). */
		billingCountry?: string | null
	}): Promise<ShopCheckoutSession> {
		if (options.processor === 'mor') {
			if (!options.hostedProductId) {
				throw new Error('Hosted checkout product is not configured.')
			}

			const session = await this.withHosted(() =>
				createPolarShopCheckout(this.getPolar(), {
					productId: options.hostedProductId!,
					productName: options.productName,
					amountCents: options.amountCents,
					successUrl: options.successUrl,
					returnUrl: options.returnUrl || options.cancelUrl,
					metadata: options.metadata,
					customerEmail: options.customerEmail,
					externalCustomerId: options.externalCustomerId,
					embedOrigin: options.embedOrigin,
				}),
			)

			return {
				id: session.id,
				url: session.url,
				processor: 'mor',
			}
		}

		if (options.processor === 'checkout') {
			if (!options.checkoutSubEntityId) {
				throw new Error('Checkout.com sub-entity is not configured.')
			}

			const session = await this.withCheckoutCommerce(() =>
				createCheckoutShopPaymentSession(this.getCheckoutShop(), {
					subEntityId: options.checkoutSubEntityId!,
					productName: options.productName,
					amountCents: options.amountCents,
					currency: options.currency ?? undefined,
					processingChannelId: this.config.checkoutProcessingChannelId!,
					successUrl: options.successUrl,
					failureUrl: options.cancelUrl,
					metadata: options.metadata,
					customerEmail: options.customerEmail,
					reference: options.reference,
					billingCountry: options.billingCountry,
				}),
			)

			return {
				id: session.id,
				url: session.url,
				processor: 'checkout',
			}
		}

		if (!options.connectAccountId) {
			throw new Error('Connect payout account is not configured.')
		}

		const session = await this.withConnect(() =>
			createShopCheckoutSession(this.getStripe(), {
				connectedAccountId: options.connectAccountId!,
				productName: options.productName,
				productDescription: options.productDescription,
				amountCents: options.amountCents,
				currency: options.currency ?? undefined,
				successUrl: options.successUrl,
				cancelUrl: options.cancelUrl,
				metadata: options.metadata,
				customerEmail: options.customerEmail,
				expiresAt: options.expiresAt,
				idempotencyKey: options.idempotencyKey,
			}),
		)

		if (!session.url) {
			throw new Error('Unable to create checkout session.')
		}

		return {
			id: session.id,
			url: session.url,
			processor: 'connect',
		}
	}

	/**
	 * Expire an open Connect checkout session. Best-effort cleanup for sessions
	 * that could not be bound to their regional order.
	 */
	async expireConnectCheckoutSession(sessionId: string) {
		return this.withConnect(() =>
			expireShopCheckoutSession(this.getStripe(), sessionId),
		)
	}

	async createInlineCardPayment(options: {
		connectAccountId: string
		amountCents: number
		currency?: string
		metadata: Record<string, string>
		platformCustomerId?: string | null
		saveForFutureUse?: boolean
	}): Promise<ShopInlinePayment> {
		const paymentIntent = await this.withConnect(() =>
			createShopPaymentIntent(this.getStripe(), {
				connectedAccountId: options.connectAccountId,
				amountCents: options.amountCents,
				currency: options.currency,
				metadata: options.metadata,
				stripeCustomerId: options.platformCustomerId,
				setupFutureUsage: options.saveForFutureUse ? 'off_session' : undefined,
			}),
		)

		if (!paymentIntent.client_secret) {
			throw new Error('Unable to create inline card payment.')
		}

		return {
			clientSecret: paymentIntent.client_secret,
			paymentId: paymentIntent.id,
			publishableKey: this.getPublishableKey(),
			processor: 'connect',
		}
	}

	async createConnectPlatformCustomer(options: {
		name?: string | null
		email?: string | null
		phone?: string | null
		metadata: Record<string, string>
	}) {
		const customer = await this.withConnect(() =>
			this.getStripe().customers.create({
				name: options.name || undefined,
				email: options.email || undefined,
				phone: options.phone || undefined,
				metadata: options.metadata,
			}),
		)
		return customer.id
	}

	async attachPaymentMethodToCustomer(
		customerId: string,
		paymentMethodId: string,
	) {
		try {
			await this.withConnect(() =>
				this.getStripe().paymentMethods.attach(paymentMethodId, {
					customer: customerId,
				}),
			)
		} catch (error) {
			const code =
				error && typeof error === 'object' && 'code' in error
					? String((error as { code?: string }).code)
					: ''
			if (code === 'resource_already_exists') return
			throw error
		}
	}

	async retrievePaymentIntent(paymentId: string) {
		return this.withConnect(() =>
			this.getStripe().paymentIntents.retrieve(paymentId, {
				expand: ['payment_method'],
			}),
		)
	}

	async retrieveConnectCheckoutSession(sessionId: string) {
		return this.withConnect(() =>
			this.getStripe().checkout.sessions.retrieve(sessionId),
		)
	}

	async retrieveHostedCheckout(checkoutId: string) {
		return this.withHosted(() =>
			retrievePolarShopCheckout(this.getPolar(), checkoutId),
		)
	}

	async getOrderStatus(options: {
		processor: ShopProcessorId
		organizationId: string
		sessionId?: string | null
		paymentId?: string | null
		checkoutId?: string | null
	}): Promise<ShopOrderSnapshot & { order?: ShopOrderUpsert | null }> {
		try {
			return await this.getOrderStatusFromProcessor(options)
		} catch (error) {
			if (error instanceof ShopOrderNotFoundError) throw error
			if (isProviderNotFoundError(error)) throw new ShopOrderNotFoundError()
			throw error
		}
	}

	private async getOrderStatusFromProcessor(options: {
		processor: ShopProcessorId
		organizationId: string
		sessionId?: string | null
		paymentId?: string | null
		checkoutId?: string | null
	}): Promise<ShopOrderSnapshot & { order?: ShopOrderUpsert | null }> {
		if (options.processor === 'mor' && options.checkoutId) {
			const checkout = await this.retrieveHostedCheckout(options.checkoutId)
			if (checkout.metadata.orgId !== options.organizationId) {
				throw new ShopOrderNotFoundError()
			}

			const order =
				checkout.metadata.type === SHOP_ORDER_METADATA_TYPE
					? this.mapHostedCheckoutToOrder(checkout)
					: null

			return {
				status: polarCheckoutStatusToOrderStatus(checkout.status),
				productName: checkout.metadata.productName || 'Product',
				amountCents: checkout.amountCents,
				currency: checkout.currency || 'usd',
				order,
			}
		}

		if (options.processor === 'checkout' && options.paymentId) {
			const payment = await this.withCheckoutCommerce(() =>
				retrieveCheckoutShopPayment(this.getCheckoutShop(), options.paymentId!),
			)
			if (payment.metadata.orgId !== options.organizationId) {
				throw new ShopOrderNotFoundError()
			}

			const order =
				payment.metadata.type === SHOP_ORDER_METADATA_TYPE
					? this.mapCheckoutPaymentToOrder(payment)
					: null

			return {
				status: checkoutPaymentStatusToOrderStatus(payment.paid),
				productName: payment.productName,
				amountCents: payment.amountCents,
				currency: payment.currency,
				order,
			}
		}

		if (options.processor === 'connect' && options.paymentId) {
			const paymentIntent = await this.retrievePaymentIntent(options.paymentId)
			if (paymentIntent.metadata?.orgId !== options.organizationId) {
				throw new ShopOrderNotFoundError()
			}

			const order =
				paymentIntent.metadata?.type === SHOP_ORDER_METADATA_TYPE
					? this.mapConnectPaymentIntentToOrder(paymentIntent)
					: null

			return {
				status:
					paymentIntent.status === 'succeeded' ? 'paid' : paymentIntent.status,
				productName: paymentIntent.metadata.productName || 'Product',
				amountCents: paymentIntent.amount,
				currency: paymentIntent.currency || 'usd',
				order,
			}
		}

		if (!options.sessionId) {
			throw new ShopOrderNotFoundError()
		}

		if (options.processor !== 'connect') {
			throw new ShopOrderNotFoundError()
		}

		const session = await this.retrieveConnectCheckoutSession(options.sessionId)
		if (session.metadata?.orgId !== options.organizationId) {
			throw new ShopOrderNotFoundError()
		}

		const order =
			session.metadata?.type === SHOP_ORDER_METADATA_TYPE
				? this.mapConnectCheckoutSessionToOrder(session)
				: null

		return {
			status: session.payment_status,
			productName: session.metadata.productName || 'Product',
			amountCents: session.amount_total,
			currency: session.currency || 'usd',
			order,
		}
	}

	mapConnectCheckoutSessionToOrder(
		session: Stripe.Checkout.Session,
	): ShopOrderUpsert | null {
		if (session.metadata?.type !== SHOP_ORDER_METADATA_TYPE) return null
		const orgId = session.metadata.orgId
		if (!orgId || session.amount_total == null) return null

		const paymentIntentId =
			typeof session.payment_intent === 'string'
				? session.payment_intent
				: session.payment_intent?.id || null

		return buildShopOrderUpsert({
			orgId,
			customerIdFromMetadata: session.metadata.customerId || null,
			productName:
				session.metadata.productName ||
				session.metadata.product_name ||
				'Product',
			amountCents: session.amount_total,
			currency: session.currency || 'usd',
			processor: 'connect',
			processorCheckoutId: session.id,
			processorPaymentId: paymentIntentId,
			processorOrderId: null,
			status: session.payment_status === 'paid' ? 'paid' : 'pending',
		})
	}

	mapConnectPaymentIntentToOrder(
		paymentIntent: Stripe.PaymentIntent,
	): ShopOrderUpsert | null {
		if (paymentIntent.metadata?.type !== SHOP_ORDER_METADATA_TYPE) return null
		const orgId = paymentIntent.metadata.orgId
		if (!orgId || paymentIntent.amount == null) return null

		return buildShopOrderUpsert({
			orgId,
			customerIdFromMetadata: paymentIntent.metadata.customerId || null,
			productName:
				paymentIntent.metadata.productName ||
				paymentIntent.metadata.product_name ||
				'Product',
			amountCents: paymentIntent.amount,
			currency: paymentIntent.currency || 'usd',
			processor: 'connect',
			processorCheckoutId: null,
			processorPaymentId: paymentIntent.id,
			processorOrderId: null,
			status: mapPaymentIntentStatus(paymentIntent.status),
		})
	}

	mapConnectAccountUpdate(
		account: Stripe.Account,
	): ShopConnectAccountUpdate | null {
		const organizationId = account.metadata?.organizationId
		if (!organizationId) return null
		return {
			organizationId,
			accountId: account.id,
			chargesEnabled: Boolean(account.charges_enabled),
			payoutsEnabled: Boolean(account.payouts_enabled),
		}
	}

	mapHostedCheckoutToOrder(
		checkout: PolarShopCheckout,
	): ShopOrderUpsert | null {
		if (checkout.metadata.type !== SHOP_ORDER_METADATA_TYPE) return null
		const orgId = checkout.metadata.orgId
		if (!orgId) return null

		return buildShopOrderUpsert({
			orgId,
			customerIdFromMetadata: checkout.metadata.customerId || null,
			productName: checkout.metadata.productName || 'Product',
			amountCents: checkout.amountCents,
			currency: checkout.currency,
			processor: 'mor',
			processorCheckoutId: checkout.id,
			processorPaymentId: null,
			processorOrderId: null,
			status: polarCheckoutStatusToOrderStatus(checkout.status),
		})
	}

	mapHostedOrderToOrder(order: PolarShopOrder): ShopOrderUpsert | null {
		if (order.metadata.type !== SHOP_ORDER_METADATA_TYPE) return null
		const orgId = order.metadata.orgId
		if (!orgId) return null

		return buildShopOrderUpsert({
			orgId,
			customerIdFromMetadata: order.metadata.customerId || null,
			productName: order.productName,
			amountCents: order.amountCents,
			currency: order.currency,
			processor: 'mor',
			processorCheckoutId: order.checkoutId,
			processorPaymentId: null,
			processorOrderId: order.id,
			status: order.paid ? 'paid' : 'pending',
		})
	}

	mapCheckoutPaymentToOrder(
		payment: ReturnType<typeof mapCheckoutShopPayment>,
	): ShopOrderUpsert | null {
		if (payment.metadata.type !== SHOP_ORDER_METADATA_TYPE) return null
		const orgId = payment.metadata.orgId
		if (!orgId) return null

		return buildShopOrderUpsert({
			orgId,
			customerIdFromMetadata: payment.metadata.customerId || null,
			productName: payment.productName,
			amountCents: payment.amountCents,
			currency: payment.currency,
			processor: 'checkout',
			processorCheckoutId: payment.sessionId,
			processorPaymentId: payment.id,
			processorOrderId: null,
			status: checkoutPaymentStatusToOrderStatus(payment.paid),
		})
	}

	verifyCheckoutWebhook(
		payload: string,
		signature: string,
	): { type: string; data: unknown } {
		const secret = this.config.checkoutWebhookSecret
		if (!secret) {
			throw new Error('Checkout.com webhooks are not configured.')
		}
		return verifyCheckoutWebhookEvent(payload, signature, secret)
	}

	parseCheckoutWebhookEvent(event: {
		type: string
		data: unknown
	}): ShopCheckoutWebhookEvent | null {
		const payment = mapCheckoutWebhookToPayment(event)
		if (!payment) return null
		const order = this.mapCheckoutPaymentToOrder(payment)
		return order ? { type: 'payment', order } : null
	}

	verifyHostedWebhook(
		payload: string,
		headers: Record<string, string>,
	): { type: string; data: unknown } {
		const secret = this.config.polarWebhookSecret
		if (!secret) {
			throw new Error('Hosted checkout webhooks are not configured.')
		}

		return verifyPolarWebhookEvent(payload, headers, secret) as {
			type: string
			data: unknown
		}
	}

	parseHostedWebhookEvent(event: {
		type: string
		data: unknown
	}): ShopMorWebhookEvent | null {
		if (event.type === 'order.paid' || event.type === 'order.updated') {
			const order = mapPolarShopOrder(
				event.data as Parameters<typeof mapPolarShopOrder>[0],
			)
			const mapped = this.mapHostedOrderToOrder(order)
			return mapped ? { type: 'order', order: mapped } : null
		}

		if (event.type === 'checkout.updated') {
			const checkout = parseHostedCheckoutPayload(event.data)
			if (!checkout) return null
			const mapped = this.mapHostedCheckoutToOrder(checkout)
			return mapped ? { type: 'checkout', order: mapped } : null
		}

		return null
	}

	resolveProcessorFromOrganization(shopPaymentProvider: string | null) {
		return normalizeShopProcessor(shopPaymentProvider)
	}
}

function parseHostedCheckoutPayload(data: unknown): PolarShopCheckout | null {
	if (!data || typeof data !== 'object') return null
	const checkout = data as {
		id?: string
		url?: string
		status?: string
		netAmount?: number
		amount?: number
		currency?: string
		metadata?: Record<string, string | number | boolean>
		customerEmail?: string | null
	}
	if (!checkout.id || !checkout.status) return null
	const metadata: Record<string, string> = {}
	for (const [key, value] of Object.entries(checkout.metadata ?? {})) {
		metadata[key] = String(value)
	}
	return {
		id: checkout.id,
		url: checkout.url || '',
		status: checkout.status,
		amountCents: checkout.netAmount || checkout.amount || 0,
		currency: checkout.currency || 'usd',
		metadata,
		customerEmail: checkout.customerEmail,
	}
}

export function createShopCommerce(config: ShopCommerceConfig) {
	return new ShopCommerce(config)
}
