export { SHOP_ORDER_METADATA_TYPE } from './types'

export {
	RESTAURANT_ORDER_METADATA_TYPE,
	RESTAURANT_ORDER_PRODUCT_NAME,
	RESTAURANT_ORDER_PROCESSORS,
	RESTAURANT_TERMINAL_PAYMENT_STATUSES,
	buildRestaurantOrderMetadata,
	buildRestaurantOrderSessionIdempotencyKey,
	isRestaurantOrderMetadata,
	isRestaurantOrderProcessor,
	isTerminalRestaurantPaymentStatus,
	mapConnectSessionToRestaurantOrder,
	mapCheckoutWebhookToRestaurantOrder,
	type RestaurantOrderProcessor,
	type RestaurantOrderPaymentEvent,
	type RestaurantOrderPaymentStatus,
	type RestaurantTerminalPaymentStatus,
} from './restaurant'

export {
	SHOP_PLATFORM_FEE_PERCENT,
	calculateShopFees,
} from '../connect/shop-fees'

export type {
	ShopProcessorId,
	ShopProcessorDbValue,
	ShopOrderStatus,
	ShopCheckoutUi,
	ShopOrganizationSnapshot,
	ShopPublicProduct,
	ShopCheckoutSession,
	ShopInlinePayment,
	ShopOrderSnapshot,
	ShopOrderUpsert,
	ShopConnectAccountUpdate,
	ShopProcessorDefinition,
	ShopMorWebhookEvent,
	ShopCheckoutWebhookEvent,
} from './types'

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
} from './processors'

export {
	type ShopCommerceConfig,
	createShopCommerceConfigFromEnv,
} from './config'

export {
	ShopCommerce,
	ShopOrderNotFoundError,
	createShopCommerce,
} from './commerce'

export {
	hostedWebhookHeadersFromRequest,
	parseHostedShopWebhook,
	parseCheckoutShopWebhook,
	checkoutWebhookSignatureFromRequest,
	verifyCheckoutWebhookEvent,
} from './webhooks'

export {
	type ShopCheckoutCspOptions,
	getShopCheckoutScriptSrc,
	getShopCheckoutConnectSrc,
	getShopCheckoutFrameSrc,
	getShopCheckoutFrameSources,
	getShopCheckoutUiForProcessor,
	SHOP_INLINE_CARD_SDK_URL,
	SHOP_HOSTED_EMBED_SDK_URL,
} from './client-csp'
