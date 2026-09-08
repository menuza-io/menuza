/**
 * Organization shop utilities — product config, checkout, and order recording
 * (US region only). Payment processors are accessed via @repo/payments.
 */

import { getDomainUrl } from '@repo/common'
import {
	and,
	db,
	desc,
	eq,
	inArray,
	isNull,
	Organization as OrganizationTable,
} from '@repo/database'
import {
	calculateShopFees,
	createShopCommerce,
	createShopCommerceConfigFromEnv,
	isShopAvailableForOrganization as isShopSnapshotAvailable,
	mapOrganizationToShopSnapshot,
	normalizeShopProcessor,
	SHOP_ORDER_METADATA_TYPE,
	SHOP_PLATFORM_FEE_PERCENT,
	ShopOrderNotFoundError,
	shopProcessorToDbValue,
	type ShopCommerce,
	type ShopOrderUpsert,
	type ShopOrganizationSnapshot,
	type ShopProcessorId,
} from '@repo/payments'
import {
	getTenantDb,
	shopOrders,
	customers,
	customerPaymentMethods,
} from '@repo/tenant-db'
import { resolveVerifiedShopCustomer } from '#app/utils/tenant-customer-auth.server.ts'
import { type ShopOrganization } from './shop.types.ts'

let shopCommerce = createShopCommerce(
	createShopCommerceConfigFromEnv(process.env),
)

function getShopCommerce() {
	return shopCommerce
}

export function configureShopCommerceForTests(
	config: Parameters<typeof createShopCommerceConfigFromEnv>[0],
) {
	shopCommerce = createShopCommerce(createShopCommerceConfigFromEnv(config))
}

export {
	SHOP_PLATFORM_FEE_PERCENT,
	calculateShopFees,
	isShopAvailableForOrganization,
	normalizeShopProcessor,
	SHOP_PROCESSOR_CATALOG,
	getShopProcessorDefinition,
	shopProcessorToDbValue,
	type ShopOrganization,
	type ShopOrderSummary,
	type ShopProcessorId,
} from './shop.types.ts'

export function listConfiguredShopProcessors() {
	return getShopCommerce().listConfiguredProcessors()
}

export function isHostedShopConfigured() {
	return getShopCommerce().isProcessorConfigured('mor')
}

export function getHostedShopDashboardUrl() {
	return getShopCommerce().getHostedDashboardUrl('mor')
}

export function getCheckoutShopDashboardUrl() {
	return getShopCommerce().getProcessorDashboardUrl('checkout')
}

const shopOrganizationColumns = {
	id: OrganizationTable.id,
	name: OrganizationTable.name,
	slug: OrganizationTable.slug,
	dataRegion: OrganizationTable.dataRegion,
	hasProvisionedDb: OrganizationTable.hasProvisionedDb,
	customDomain: OrganizationTable.customDomain,
	sitePublished: OrganizationTable.sitePublished,
	shopPaymentProvider: OrganizationTable.shopPaymentProvider,
	stripeConnectAccountId: OrganizationTable.stripeConnectAccountId,
	stripeConnectChargesEnabled: OrganizationTable.stripeConnectChargesEnabled,
	stripeConnectPayoutsEnabled: OrganizationTable.stripeConnectPayoutsEnabled,
	checkoutSubEntityId: OrganizationTable.checkoutSubEntityId,
	checkoutChargesEnabled: OrganizationTable.checkoutChargesEnabled,
	checkoutPayoutsEnabled: OrganizationTable.checkoutPayoutsEnabled,
	polarProductId: OrganizationTable.polarProductId,
	shopProductName: OrganizationTable.shopProductName,
	shopProductDescription: OrganizationTable.shopProductDescription,
	shopProductPriceCents: OrganizationTable.shopProductPriceCents,
	shopEnabled: OrganizationTable.shopEnabled,
} as const

function toShopSnapshot(
	organization: Pick<
		ShopOrganization,
		| 'dataRegion'
		| 'shopPaymentProvider'
		| 'shopEnabled'
		| 'shopProductName'
		| 'shopProductDescription'
		| 'shopProductPriceCents'
		| 'stripeConnectAccountId'
		| 'stripeConnectChargesEnabled'
		| 'stripeConnectPayoutsEnabled'
		| 'checkoutSubEntityId'
		| 'checkoutChargesEnabled'
		| 'checkoutPayoutsEnabled'
		| 'polarProductId'
	>,
): ShopOrganizationSnapshot {
	return mapOrganizationToShopSnapshot(organization)
}

export async function findPublishedShopOrganization(options: {
	slug?: string | null
	host?: string | null
}): Promise<ShopOrganization | null> {
	const slug = options.slug?.trim().toLowerCase() || null
	const host = options.host?.trim().toLowerCase().split(':')[0] || null

	if (!slug && !host) return null

	const [organization] = await db
		.select(shopOrganizationColumns)
		.from(OrganizationTable)
		.where(
			slug
				? and(
						eq(OrganizationTable.slug, slug),
						eq(OrganizationTable.active, true),
						eq(OrganizationTable.sitePublished, true),
					)
				: and(
						eq(OrganizationTable.customDomain, host!),
						eq(OrganizationTable.active, true),
						eq(OrganizationTable.sitePublished, true),
						inArray(OrganizationTable.customDomainStatus, [
							'active',
							'pending',
						]),
					),
		)
		.limit(1)

	return organization
		? {
				...organization,
				shopPaymentProvider: normalizeShopProcessor(
					organization.shopPaymentProvider,
				),
			}
		: null
}

export function getPublicShopProduct(organization: ShopOrganization) {
	if (!isShopSnapshotAvailable(toShopSnapshot(organization))) return null
	const name = organization.shopProductName?.trim()
	const priceCents = organization.shopProductPriceCents
	if (!name || priceCents === null) return null

	const { platformFeeCents, orgPayoutCents } = calculateShopFees(priceCents)

	return {
		name,
		description: organization.shopProductDescription,
		priceCents,
		currency: 'usd',
		processor: normalizeShopProcessor(organization.shopPaymentProvider),
		platformFeePercent: SHOP_PLATFORM_FEE_PERCENT,
		platformFeeCents,
		orgPayoutCents,
	}
}

export function getSiteBaseUrl(organization: {
	slug: string
	customDomain: string | null
}) {
	const suffix =
		process.env.PUBLIC_SITE_HOST_SUFFIXES?.split(',')[0]?.trim() ||
		'localhost:3008'
	const protocol = suffix.includes('localhost') ? 'http' : 'https'
	if (organization.customDomain) {
		return `${protocol}://${organization.customDomain}`
	}
	return `${protocol}://${organization.slug}.${suffix}`
}

export async function syncConnectAccountStatus(organizationId: string) {
	const [organization] = await db
		.select({
			id: OrganizationTable.id,
			stripeConnectAccountId: OrganizationTable.stripeConnectAccountId,
		})
		.from(OrganizationTable)
		.where(eq(OrganizationTable.id, organizationId))
		.limit(1)

	if (!organization?.stripeConnectAccountId) return null

	const status = await getShopCommerce().retrieveConnectAccountStatus(
		organization.stripeConnectAccountId,
	)

	await db
		.update(OrganizationTable)
		.set({
			stripeConnectChargesEnabled: status.chargesEnabled,
			stripeConnectPayoutsEnabled: status.payoutsEnabled,
			updatedAt: new Date(),
		})
		.where(eq(OrganizationTable.id, organizationId))

	return status
}

export async function startConnectOnboarding(
	request: Request,
	organization: Pick<
		ShopOrganization,
		'id' | 'name' | 'slug' | 'dataRegion' | 'stripeConnectAccountId'
	>,
) {
	if ((organization.dataRegion || 'us') !== 'us') {
		throw new Error('Shop payouts are only available for US organizations.')
	}

	let accountId = organization.stripeConnectAccountId
	const commerce = getShopCommerce()

	if (!accountId) {
		const account = await commerce.createConnectExpressAccount({
			organizationId: organization.id,
			organizationName: organization.name,
		})

		const [claimed] = await db
			.update(OrganizationTable)
			.set({
				stripeConnectAccountId: account.id,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(OrganizationTable.id, organization.id),
					isNull(OrganizationTable.stripeConnectAccountId),
				),
			)
			.returning({
				stripeConnectAccountId: OrganizationTable.stripeConnectAccountId,
			})

		if (claimed?.stripeConnectAccountId) {
			accountId = claimed.stripeConnectAccountId
		} else {
			const [refreshed] = await db
				.select({
					stripeConnectAccountId: OrganizationTable.stripeConnectAccountId,
				})
				.from(OrganizationTable)
				.where(eq(OrganizationTable.id, organization.id))
				.limit(1)
			accountId = refreshed?.stripeConnectAccountId ?? account.id
		}
	}

	const appBase = getDomainUrl(request)
	return commerce.createConnectOnboardingLink({
		accountId: accountId!,
		refreshUrl: `${appBase}/${organization.slug}/settings/shop?connect=refresh`,
		returnUrl: `${appBase}/${organization.slug}/settings/shop?connect=return`,
	})
}

export async function createConnectDashboardLink(accountId: string) {
	return getShopCommerce().createConnectDashboardLink(accountId)
}

export async function syncCheckoutSubEntityStatus(organizationId: string) {
	const [organization] = await db
		.select({
			id: OrganizationTable.id,
			checkoutSubEntityId: OrganizationTable.checkoutSubEntityId,
		})
		.from(OrganizationTable)
		.where(eq(OrganizationTable.id, organizationId))
		.limit(1)

	if (!organization?.checkoutSubEntityId) return null

	const status = await getShopCommerce().retrieveCheckoutSubEntityStatus(
		organization.checkoutSubEntityId,
	)

	await db
		.update(OrganizationTable)
		.set({
			checkoutChargesEnabled: status.chargesEnabled,
			checkoutPayoutsEnabled: status.payoutsEnabled,
			updatedAt: new Date(),
		})
		.where(eq(OrganizationTable.id, organizationId))

	return status
}

export async function inviteCheckoutSubEntityOnboarding(
	organization: Pick<
		ShopOrganization,
		'id' | 'dataRegion' | 'checkoutSubEntityId'
	>,
	inviteeEmail: string,
) {
	if ((organization.dataRegion || 'us') !== 'us') {
		throw new Error('Shop payouts are only available for US organizations.')
	}

	if (organization.checkoutSubEntityId) {
		await syncCheckoutSubEntityStatus(organization.id)
		return { id: organization.checkoutSubEntityId }
	}

	const entity = await getShopCommerce().inviteCheckoutSubEntity({
		organizationId: organization.id,
		inviteeEmail,
	})

	await db
		.update(OrganizationTable)
		.set({
			shopPaymentProvider: shopProcessorToDbValue('checkout'),
			checkoutSubEntityId: entity.id,
			updatedAt: new Date(),
		})
		.where(eq(OrganizationTable.id, organization.id))

	return entity
}

export async function syncHostedShopProduct(
	organization: Pick<
		ShopOrganization,
		| 'id'
		| 'name'
		| 'dataRegion'
		| 'polarProductId'
		| 'shopProductName'
		| 'shopProductDescription'
		| 'shopProductPriceCents'
	>,
) {
	if ((organization.dataRegion || 'us') !== 'us') {
		throw new Error('Shop checkout is only available for US organizations.')
	}

	const productName =
		organization.shopProductName?.trim() || `${organization.name} shop product`
	const priceCents = organization.shopProductPriceCents ?? 1999

	const product = await getShopCommerce().syncHostedCatalogProduct({
		productId: organization.polarProductId,
		organizationId: organization.id,
		organizationName: organization.name,
		productName,
		productDescription: organization.shopProductDescription,
		amountCents: priceCents,
	})

	await db
		.update(OrganizationTable)
		.set({
			shopPaymentProvider: shopProcessorToDbValue('mor'),
			polarProductId: product.id,
			updatedAt: new Date(),
		})
		.where(eq(OrganizationTable.id, organization.id))

	return product
}

export async function updateShopProduct(
	organizationId: string,
	data: {
		productName: string
		productDescription?: string
		priceCents: number
		enabled: boolean
		paymentProvider?: ShopProcessorId
	},
) {
	const provider = data.paymentProvider
		? normalizeShopProcessor(data.paymentProvider)
		: undefined

	await db
		.update(OrganizationTable)
		.set({
			shopProductName: data.productName.trim(),
			shopProductDescription: data.productDescription?.trim() || null,
			shopProductPriceCents: data.priceCents,
			shopEnabled: data.enabled,
			...(provider
				? { shopPaymentProvider: shopProcessorToDbValue(provider) }
				: {}),
			updatedAt: new Date(),
		})
		.where(eq(OrganizationTable.id, organizationId))
}

export async function createPublicShopCheckoutSession(options: {
	request: Request
	slug?: string | null
	host?: string | null
	customerId?: string | null
	customerEmail?: string | null
	embed?: boolean
}) {
	const organization = await findPublishedShopOrganization({
		slug: options.slug,
		host: options.host,
	})

	if (!organization) {
		throw new Response('Organization not found', { status: 404 })
	}

	if ((organization.dataRegion || 'us') !== 'us') {
		throw new Response('Shop is not available in this region', { status: 403 })
	}

	const snapshot = toShopSnapshot(organization)
	if (!isShopSnapshotAvailable(snapshot)) {
		throw new Response('Shop is not configured', { status: 404 })
	}
	const product = getPublicShopProduct(organization)
	if (!product) {
		throw new Response('Shop is not configured', { status: 404 })
	}

	const verifiedCustomer = await resolveVerifiedShopCustomer(
		options.request,
		organization.id,
		options.customerId,
	)

	if (options.customerEmail) {
		throw new Response(
			'Customer email must not be supplied in the request body',
			{ status: 400 },
		)
	}

	const processor = normalizeShopProcessor(organization.shopPaymentProvider)
	const siteBase = getSiteBaseUrl(organization)
	const metadata: Record<string, string> = {
		type: SHOP_ORDER_METADATA_TYPE,
		orgId: organization.id,
		productName: product.name,
	}

	if (verifiedCustomer?.customerId) {
		metadata.customerId = verifiedCustomer.customerId
	}

	const session = await getShopCommerce().createCheckout({
		processor,
		productName: product.name,
		productDescription: product.description,
		amountCents: product.priceCents,
		connectAccountId: organization.stripeConnectAccountId,
		checkoutSubEntityId: organization.checkoutSubEntityId,
		hostedProductId: organization.polarProductId,
		successUrl:
			processor === 'mor'
				? `${siteBase}/shop/success?checkout_id={CHECKOUT_ID}`
				: processor === 'checkout'
					? `${siteBase}/shop/success`
					: `${siteBase}/shop/success?session_id={CHECKOUT_SESSION_ID}`,
		cancelUrl: `${siteBase}/shop`,
		returnUrl: `${siteBase}/shop`,
		metadata,
		customerEmail: verifiedCustomer?.customerEmail ?? null,
		externalCustomerId: verifiedCustomer?.customerId ?? null,
		embedOrigin: options.embed ? new URL(siteBase).origin : null,
	})

	return { session, organization, processor }
}

export async function createPublicShopPaymentIntent(options: {
	request: Request
	slug?: string | null
	host?: string | null
	customerId?: string | null
}) {
	const organization = await findPublishedShopOrganization({
		slug: options.slug,
		host: options.host,
	})

	if (!organization) {
		throw new Response('Organization not found', { status: 404 })
	}

	if ((organization.dataRegion || 'us') !== 'us') {
		throw new Response('Shop is not available in this region', { status: 403 })
	}

	const snapshot = toShopSnapshot(organization)
	if (!isShopSnapshotAvailable(snapshot)) {
		throw new Response('Shop is not configured', { status: 404 })
	}
	const product = getPublicShopProduct(organization)
	if (!product || !organization.stripeConnectAccountId) {
		throw new Response('Shop is not configured', { status: 404 })
	}

	const processor = normalizeShopProcessor(organization.shopPaymentProvider)
	if (processor !== 'connect') {
		throw new Response(
			'This checkout processor uses hosted checkout instead of inline card payments',
			{ status: 400 },
		)
	}

	const verifiedCustomer = await resolveVerifiedShopCustomer(
		options.request,
		organization.id,
		options.customerId,
	)

	const metadata: Record<string, string> = {
		type: SHOP_ORDER_METADATA_TYPE,
		orgId: organization.id,
		productName: product.name,
	}

	if (verifiedCustomer?.customerId) {
		metadata.customerId = verifiedCustomer.customerId
	}

	let platformCustomerId: string | undefined
	if (verifiedCustomer?.customerId) {
		const tenantDb = await getTenantDb(organization.id)
		platformCustomerId = await getOrCreateConnectPlatformCustomer(
			tenantDb,
			verifiedCustomer.customerId,
		)
		await syncCustomerPaymentMethodsToConnect(
			tenantDb,
			verifiedCustomer.customerId,
			platformCustomerId,
		)
	}

	const payment = await getShopCommerce().createInlineCardPayment({
		connectAccountId: organization.stripeConnectAccountId,
		amountCents: product.priceCents,
		currency: 'usd',
		metadata,
		platformCustomerId,
		saveForFutureUse: Boolean(platformCustomerId),
	})

	return {
		clientSecret: payment.clientSecret,
		paymentIntentId: payment.paymentId,
		publishableKey: payment.publishableKey,
		organization,
		processor: payment.processor,
	}
}

export async function listOrganizationShopOrders(organizationId: string) {
	const tenantDb = await getTenantDb(organizationId)
	return tenantDb
		.select({
			id: shopOrders.id,
			productName: shopOrders.productName,
			amountCents: shopOrders.amountCents,
			platformFeeCents: shopOrders.platformFeeCents,
			orgPayoutCents: shopOrders.orgPayoutCents,
			currency: shopOrders.currency,
			status: shopOrders.status,
			paymentProvider: shopOrders.paymentProvider,
			createdAt: shopOrders.createdAt,
			customerName: customers.name,
			customerPhone: customers.phone,
			customerEmail: customers.email,
		})
		.from(shopOrders)
		.leftJoin(customers, eq(shopOrders.customerId, customers.id))
		.orderBy(desc(shopOrders.createdAt))
		.limit(50)
}

export async function recordShopOrder(order: ShopOrderUpsert) {
	const customerId = await resolveShopOrderCustomerId(
		order.orgId,
		order.customerIdFromMetadata,
	)
	const tenantDb = await getTenantDb(order.orgId)
	return upsertShopOrder(tenantDb, order, customerId)
}

export async function recordShopOrderFromConnectWebhook(
	event: unknown,
	eventType: string,
) {
	const commerce = getShopCommerce()

	if (eventType === 'checkout.session.completed') {
		const order = commerce.mapConnectCheckoutSessionToOrder(
			event as Parameters<ShopCommerce['mapConnectCheckoutSessionToOrder']>[0],
		)
		if (!order) return null
		return recordShopOrder(order)
	}

	if (eventType === 'payment_intent.succeeded') {
		const order = commerce.mapConnectPaymentIntentToOrder(
			event as Parameters<ShopCommerce['mapConnectPaymentIntentToOrder']>[0],
		)
		if (!order) return null
		const orderId = await recordShopOrder(order)

		if (order.customerIdFromMetadata && order.status === 'paid') {
			try {
				const paymentIntent = await commerce.retrievePaymentIntent(
					order.processorPaymentId!,
				)
				const tenantDb = await getTenantDb(order.orgId)
				await syncCustomerPaymentMethodFromConnectIntent(
					tenantDb,
					order.customerIdFromMetadata,
					paymentIntent,
				)
			} catch (error) {
				console.error(
					'Failed to sync payment method from connect checkout:',
					error,
				)
			}
		}

		return orderId
	}

	return null
}

export async function recordShopOrderFromCheckoutWebhook(
	payload: string,
	signature: string,
) {
	const event = getShopCommerce().parseCheckoutWebhookEvent(
		getShopCommerce().verifyCheckoutWebhook(payload, signature),
	)
	if (!event) return null
	return recordShopOrder(event.order)
}

export async function handleConnectAccountUpdated(event: unknown) {
	const update = getShopCommerce().mapConnectAccountUpdate(
		event as Parameters<ShopCommerce['mapConnectAccountUpdate']>[0],
	)
	if (!update) return

	await db
		.update(OrganizationTable)
		.set({
			stripeConnectChargesEnabled: update.chargesEnabled,
			stripeConnectPayoutsEnabled: update.payoutsEnabled,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(OrganizationTable.id, update.organizationId),
				eq(OrganizationTable.stripeConnectAccountId, update.accountId),
			),
		)
}

export async function getPublicShopOrderStatus(options: {
	slug?: string | null
	host?: string | null
	sessionId?: string | null
	paymentIntentId?: string | null
	checkoutId?: string | null
	checkoutPaymentId?: string | null
}) {
	const organization = await findPublishedShopOrganization({
		slug: options.slug,
		host: options.host,
	})

	if (!organization) {
		throw new Response('Organization not found', { status: 404 })
	}

	const processor = normalizeShopProcessor(organization.shopPaymentProvider)

	try {
		const result = await getShopCommerce().getOrderStatus({
			processor,
			organizationId: organization.id,
			sessionId: options.sessionId,
			paymentId: options.checkoutPaymentId || options.paymentIntentId,
			checkoutId: options.checkoutId,
		})

		if (result.order) {
			try {
				await recordShopOrder(result.order)
			} catch (error) {
				console.error('Failed to record shop order:', error)
			}
		}

		return {
			status: result.status,
			productName: result.productName,
			amountCents: result.amountCents,
			currency: result.currency,
		}
	} catch (error) {
		if (error instanceof ShopOrderNotFoundError) {
			throw new Response('Order not found', { status: 404 })
		}
		throw error
	}
}

async function getOrCreateConnectPlatformCustomer(
	tenantDb: Awaited<ReturnType<typeof getTenantDb>>,
	customerId: string,
) {
	const [customer] = await tenantDb
		.select({
			id: customers.id,
			stripeCustomerId: customers.stripeCustomerId,
			name: customers.name,
			email: customers.email,
			phone: customers.phone,
		})
		.from(customers)
		.where(eq(customers.id, customerId))
		.limit(1)

	if (!customer) {
		throw new Error('Customer not found')
	}

	if (customer.stripeCustomerId) {
		return customer.stripeCustomerId
	}

	const platformCustomerId =
		await getShopCommerce().createConnectPlatformCustomer({
			name: customer.name,
			email: customer.email,
			phone: customer.phone,
			metadata: { tenantCustomerId: customer.id },
		})

	await tenantDb
		.update(customers)
		.set({
			stripeCustomerId: platformCustomerId,
			updatedAt: new Date(),
		})
		.where(eq(customers.id, customer.id))

	return platformCustomerId
}

async function syncCustomerPaymentMethodsToConnect(
	tenantDb: Awaited<ReturnType<typeof getTenantDb>>,
	customerId: string,
	platformCustomerId: string,
) {
	const methods = await tenantDb
		.select({
			stripePaymentMethodId: customerPaymentMethods.stripePaymentMethodId,
		})
		.from(customerPaymentMethods)
		.where(eq(customerPaymentMethods.customerId, customerId))

	const commerce = getShopCommerce()
	for (const method of methods) {
		try {
			await commerce.attachPaymentMethodToCustomer(
				platformCustomerId,
				method.stripePaymentMethodId,
			)
		} catch (error) {
			console.error(
				'Failed to attach saved payment method to platform customer:',
				error,
			)
		}
	}
}

async function syncCustomerPaymentMethodFromConnectIntent(
	tenantDb: Awaited<ReturnType<typeof getTenantDb>>,
	customerId: string | null,
	paymentIntent: Awaited<ReturnType<ShopCommerce['retrievePaymentIntent']>>,
) {
	if (!customerId || paymentIntent.status !== 'succeeded') return

	try {
		const paymentMethod =
			await resolvePaymentMethodFromConnectIntent(paymentIntent)
		if (paymentMethod?.card) {
			await recordCustomerPaymentMethod(tenantDb, customerId, paymentMethod)
		}
	} catch (error) {
		console.error('Failed to record customer payment method:', error)
	}
}

async function resolvePaymentMethodFromConnectIntent(
	paymentIntent: Awaited<ReturnType<ShopCommerce['retrievePaymentIntent']>>,
) {
	if (
		typeof paymentIntent.payment_method === 'object' &&
		paymentIntent.payment_method
	) {
		return paymentIntent.payment_method
	}

	const paymentMethodId =
		typeof paymentIntent.payment_method === 'string'
			? paymentIntent.payment_method
			: null
	if (!paymentMethodId) return null

	const commerce = getShopCommerce()
	const paymentIntentWithMethod = await commerce.retrievePaymentIntent(
		paymentIntent.id,
	)
	if (
		typeof paymentIntentWithMethod.payment_method === 'object' &&
		paymentIntentWithMethod.payment_method
	) {
		return paymentIntentWithMethod.payment_method
	}

	return null
}

async function recordCustomerPaymentMethod(
	tenantDb: Awaited<ReturnType<typeof getTenantDb>>,
	customerId: string,
	paymentMethod: {
		id: string
		card?: {
			brand: string
			last4: string
			exp_month: number
			exp_year: number
		} | null
	},
) {
	if (!paymentMethod.card) return

	const values = {
		customerId,
		stripePaymentMethodId: paymentMethod.id,
		brand: paymentMethod.card.brand,
		last4: paymentMethod.card.last4,
		expMonth: paymentMethod.card.exp_month,
		expYear: paymentMethod.card.exp_year,
		updatedAt: new Date(),
	}

	const [existing] = await tenantDb
		.select({
			id: customerPaymentMethods.id,
			customerId: customerPaymentMethods.customerId,
		})
		.from(customerPaymentMethods)
		.where(eq(customerPaymentMethods.stripePaymentMethodId, paymentMethod.id))
		.limit(1)

	if (existing) {
		if (existing.customerId !== customerId) {
			console.warn(
				'Skipping payment method sync: card already saved for another customer',
			)
			return
		}
		await tenantDb
			.update(customerPaymentMethods)
			.set(values)
			.where(eq(customerPaymentMethods.id, existing.id))
	} else {
		await tenantDb.insert(customerPaymentMethods).values(values)
	}

	const [customer] = await tenantDb
		.select({ stripeCustomerId: customers.stripeCustomerId })
		.from(customers)
		.where(eq(customers.id, customerId))
		.limit(1)

	if (customer?.stripeCustomerId) {
		await getShopCommerce().attachPaymentMethodToCustomer(
			customer.stripeCustomerId,
			paymentMethod.id,
		)
	}
}

async function resolveShopOrderCustomerId(
	orgId: string,
	customerIdFromMetadata: string | null,
) {
	if (!customerIdFromMetadata) return null

	const tenantDb = await getTenantDb(orgId)
	const [customerRow] = await tenantDb
		.select({ id: customers.id })
		.from(customers)
		.where(eq(customers.id, customerIdFromMetadata))
		.limit(1)

	return customerRow?.id ?? null
}

async function upsertShopOrder(
	tenantDb: Awaited<ReturnType<typeof getTenantDb>>,
	order: ShopOrderUpsert,
	customerId: string | null,
) {
	const paymentProvider = shopProcessorToDbValue(order.processor)
	const updateSet = {
		status: order.status,
		customerId,
		paymentProvider,
		stripeCheckoutSessionId:
			order.processor === 'connect' ? order.processorCheckoutId : null,
		stripePaymentIntentId:
			order.processor === 'connect' ? order.processorPaymentId : null,
		polarCheckoutId:
			order.processor === 'mor' ? order.processorCheckoutId : null,
		polarOrderId: order.processor === 'mor' ? order.processorOrderId : null,
		checkoutSessionId:
			order.processor === 'checkout' ? order.processorCheckoutId : null,
		checkoutPaymentId:
			order.processor === 'checkout' ? order.processorPaymentId : null,
		updatedAt: new Date(),
	}

	const values = {
		customerId,
		productName: order.productName,
		amountCents: order.amountCents,
		platformFeeCents: order.platformFeeCents,
		orgPayoutCents: order.orgPayoutCents,
		currency: order.currency,
		paymentProvider,
		stripeCheckoutSessionId: updateSet.stripeCheckoutSessionId,
		stripePaymentIntentId: updateSet.stripePaymentIntentId,
		polarCheckoutId: updateSet.polarCheckoutId,
		polarOrderId: updateSet.polarOrderId,
		checkoutSessionId: updateSet.checkoutSessionId,
		checkoutPaymentId: updateSet.checkoutPaymentId,
		status: order.status,
	}

	if (values.stripeCheckoutSessionId) {
		const [row] = await tenantDb
			.insert(shopOrders)
			.values(values)
			.onConflictDoUpdate({
				target: shopOrders.stripeCheckoutSessionId,
				set: updateSet,
			})
			.returning({ id: shopOrders.id })
		if (row?.id) return row.id
	}

	if (values.stripePaymentIntentId) {
		const [row] = await tenantDb
			.insert(shopOrders)
			.values(values)
			.onConflictDoUpdate({
				target: shopOrders.stripePaymentIntentId,
				set: updateSet,
			})
			.returning({ id: shopOrders.id })
		if (row?.id) return row.id
	}

	if (values.polarCheckoutId) {
		const [row] = await tenantDb
			.insert(shopOrders)
			.values(values)
			.onConflictDoUpdate({
				target: shopOrders.polarCheckoutId,
				set: updateSet,
			})
			.returning({ id: shopOrders.id })
		if (row?.id) return row.id
	}

	if (values.polarOrderId) {
		const [row] = await tenantDb
			.insert(shopOrders)
			.values(values)
			.onConflictDoUpdate({
				target: shopOrders.polarOrderId,
				set: updateSet,
			})
			.returning({ id: shopOrders.id })
		if (row?.id) return row.id
	}

	if (values.checkoutSessionId) {
		const [row] = await tenantDb
			.insert(shopOrders)
			.values(values)
			.onConflictDoUpdate({
				target: shopOrders.checkoutSessionId,
				set: updateSet,
			})
			.returning({ id: shopOrders.id })
		if (row?.id) return row.id
	}

	if (values.checkoutPaymentId) {
		const [row] = await tenantDb
			.insert(shopOrders)
			.values(values)
			.onConflictDoUpdate({
				target: shopOrders.checkoutPaymentId,
				set: updateSet,
			})
			.returning({ id: shopOrders.id })
		return row?.id ?? null
	}

	throw new Error(
		`Cannot persist ${order.processor} shop order without a processor identifier`,
	)
}
