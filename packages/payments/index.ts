/**
 * @repo/payments - Centralized payment provider package
 *
 * This package provides a unified interface for payment processing,
 * making it easy to switch between different payment providers
 * (Stripe, Polar, Lemon Squeezy, etc.)
 *
 * @example
 * ```ts
 * import { createPaymentProvider } from '@repo/payments'
 *
 * const provider = createPaymentProvider({
 *   provider: 'stripe',
 *   apiKey: process.env.STRIPE_SECRET_KEY!,
 * })
 *
 * const products = await provider.getProducts()
 * ```
 */

// Core types
export type {
	PaymentProvider,
	PaymentProviderConfig,
	Product,
	Price,
	PriceTier,
	PlansAndPrices,
	Subscription,
	SubscriptionItem,
	CheckoutSession,
	CheckoutSessionOptions,
	CustomerPortalSession,
	CustomerPortalOptions,
	Invoice,
	WebhookEvent,
	SubscriptionUpdateOptions,
	TrialConfig,
} from './src/types'

// Factory functions
export {
	createPaymentProvider,
	createStripeProvider,
	createPolarProvider,
} from './src/factory'

// Providers
export { StripeProvider, PolarProvider } from './src/providers'

// Trial configuration
export {
	getTrialConfig,
	calculateManualTrialDaysRemaining,
} from './src/trial-config'

// Route handlers
export {
	handleStripeWebhook,
	handleStripeCheckout,
	type StripeWebhookDependencies,
	type StripeCheckoutDependencies,
} from './src/route-handlers'

// Subscription utilities
export {
	cleanupDuplicateSubscriptions,
	type DuplicateSubscriptionCleanupResult,
} from './src/utils/duplicate-subscriptions'

// Stripe Connect (tenant site commerce)
export {
	SHOP_PLATFORM_FEE_PERCENT,
	calculateShopFees,
	createConnectExpressAccount,
	createConnectAccountLink,
	createConnectLoginLink,
	retrieveConnectAccountStatus,
	createShopCheckoutSession,
	createShopPaymentIntent,
	type ConnectAccountStatus,
} from './src/connect/stripe-connect'

// Polar shop (tenant site commerce, Merchant of Record)
export {
	createOrUpdatePolarShopProduct,
	createPolarShopCheckout,
	retrievePolarShopCheckout,
	polarCheckoutStatusToOrderStatus,
	mapPolarShopOrder,
	polarWebhookHeadersFromRequest,
	verifyPolarWebhookEvent,
	getPolarDashboardUrl,
	type PolarShopCheckout,
	type PolarShopOrder,
	type PolarShopProduct,
} from './src/connect/polar-shop'

// Tenant shop commerce (platform-agnostic facade)
export {
	SHOP_PROCESSOR_CATALOG,
	getShopProcessorDefinition,
	normalizeShopProcessor,
	shopProcessorToDbValue,
	shopProcessorLabel,
	isShopProductConfigured,
	isShopProcessorReady,
	isShopAvailableForOrganization,
	mapOrganizationToShopSnapshot,
	createShopCommerceConfigFromEnv,
	createShopCommerce,
	ShopCommerce,
	ShopOrderNotFoundError,
	hostedWebhookHeadersFromRequest,
	parseHostedShopWebhook,
	parseCheckoutShopWebhook,
	checkoutWebhookSignatureFromRequest,
	verifyCheckoutWebhookEvent,
	getShopCheckoutScriptSrc,
	getShopCheckoutConnectSrc,
	getShopCheckoutFrameSrc,
	getShopCheckoutFrameSources,
	getShopCheckoutUiForProcessor,
	SHOP_INLINE_CARD_SDK_URL,
	SHOP_HOSTED_EMBED_SDK_URL,
	type ShopCommerceConfig,
	type ShopProcessorId,
	type ShopProcessorDbValue,
	type ShopOrderStatus,
	type ShopCheckoutUi,
	type ShopOrganizationSnapshot,
	type ShopPublicProduct,
	type ShopCheckoutSession,
	type ShopInlinePayment,
	type ShopOrderSnapshot,
	type ShopOrderUpsert,
	type ShopConnectAccountUpdate,
	type ShopProcessorDefinition,
	type ShopMorWebhookEvent,
	type ShopCheckoutWebhookEvent,
	type ShopCheckoutCspOptions,
	SHOP_ORDER_METADATA_TYPE,
} from './src/shop'
