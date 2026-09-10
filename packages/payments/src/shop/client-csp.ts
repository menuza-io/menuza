import { type ShopCheckoutUi, type ShopProcessorId } from './types'

const INLINE_CARD_SCRIPT = 'https://js.stripe.com'
const INLINE_CARD_API = 'https://api.stripe.com'
const INLINE_CARD_FRAMES =
	'https://js.stripe.com https://hooks.stripe.com https://checkout.stripe.com'
const HOSTED_EMBED_SCRIPT = 'https://cdn.jsdelivr.net'
const HOSTED_EMBED_FRAMES = 'https://polar.sh https://sandbox.polar.sh'
const HOSTED_EMBED_CONNECT =
	'https://api.polar.sh https://sandbox-api.polar.sh https://polar.sh https://sandbox.polar.sh'

export type ShopCheckoutCspOptions = {
	inlineCard?: boolean
	hostedEmbed?: boolean
}

export function getShopCheckoutScriptSrc(options: ShopCheckoutCspOptions) {
	let value = ''
	if (options.inlineCard) value += ` ${INLINE_CARD_SCRIPT}`
	if (options.hostedEmbed) value += ` ${HOSTED_EMBED_SCRIPT}`
	return value
}

export function getShopCheckoutConnectSrc(options: ShopCheckoutCspOptions) {
	let value = ''
	if (options.inlineCard) value += ` ${INLINE_CARD_API}`
	if (options.hostedEmbed) value += ` ${HOSTED_EMBED_CONNECT}`
	return value
}

export function getShopCheckoutFrameSrc(options: ShopCheckoutCspOptions) {
	return ` frame-src ${getShopCheckoutFrameSources(options).join(' ')}`
}

export function getShopCheckoutFrameSources(options: ShopCheckoutCspOptions) {
	const frames = ["'self'"]
	if (options.inlineCard) frames.push(...INLINE_CARD_FRAMES.split(' '))
	if (options.hostedEmbed) frames.push(...HOSTED_EMBED_FRAMES.split(' '))
	return frames
}

export function getShopCheckoutUiForProcessor(
	processor: ShopProcessorId,
	inlineCheckoutEnabled: boolean,
): ShopCheckoutUi {
	if (processor === 'mor') {
		return inlineCheckoutEnabled ? 'hosted-embed' : 'redirect'
	}
	return inlineCheckoutEnabled ? 'inline-card' : 'redirect'
}

export const SHOP_INLINE_CARD_SDK_URL = `${INLINE_CARD_SCRIPT}/v3/`
export const SHOP_HOSTED_EMBED_SDK_URL =
	'https://cdn.jsdelivr.net/npm/@polar-sh/checkout@0.1/dist/embed.global.js'
