/**
 * Client-safe shop exports (no Stripe/Polar/Checkout.com SDKs).
 * Use this entry from browser code and route UI modules.
 */

export {
	SHOP_PLATFORM_FEE_PERCENT,
	calculateShopFees,
} from '../connect/shop-fees'

export type {
	ShopProcessorId,
	ShopProcessorDbValue,
	ShopProcessorDefinition,
	ShopCheckoutUi,
	ShopOrganizationSnapshot,
} from './types'

export type { ShopCheckoutCspOptions } from './client-csp'

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
	getShopCheckoutScriptSrc,
	getShopCheckoutConnectSrc,
	getShopCheckoutFrameSrc,
	getShopCheckoutFrameSources,
	getShopCheckoutUiForProcessor,
	SHOP_INLINE_CARD_SDK_URL,
	SHOP_HOSTED_EMBED_SDK_URL,
} from './client-csp'
