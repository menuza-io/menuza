import { z } from 'zod'

/**
 * What the AI draft prompt may know (#155). ONE pure function builds it, and it
 * copies field by field from a closed list: whatever else a caller passes (a
 * guest's name, a phone, an order) never reaches the model, by construction.
 * Control-plane, non-personal data only: the organization's name and site
 * description, live menu items, a coupon's terms, and aggregated best-seller
 * counts (item ids and numbers).
 *
 * Locale: the draft is written in one language (the operator's pick, the
 * organization's default first). Per-recipient language is #102.
 */

export const AI_DRAFT_GOALS = [
	'announce_dish',
	'promote_coupon',
	'win_back',
	'event',
] as const
export type AiDraftGoal = (typeof AI_DRAFT_GOALS)[number]

export const AI_DRAFT_TONES = [
	'friendly',
	'formal',
	'playful',
	'urgent',
] as const
export type AiDraftTone = (typeof AI_DRAFT_TONES)[number]

export const AI_DRAFT_LANGUAGES = ['en', 'ar'] as const
export type AiDraftLanguage = (typeof AI_DRAFT_LANGUAGES)[number]

export const AI_DRAFT_MAX_DISHES = 3
const MAX_MENU_ITEMS = 120
const MAX_BEST_SELLERS = 10

export type AiDraftMenuItem = {
	id: string
	name: string
	description: string
	/** Price in major units as the menu shows it (e.g. 12.5), or null. */
	price: number | null
	currency: string
}

export type AiDraftContext = {
	organization: {
		name: string
		description: string
		/** The only origin a link in a draft may use. */
		siteOrigin: string
	}
	menuItems: AiDraftMenuItem[]
	selectedItemIds: string[]
	/** Item ids and counts only, most sold first. */
	bestSellers: Array<{ itemId: string; count: number }>
	/** The coupon's words (`couponCopy`), or null when none is attached. */
	coupon: { headline: string; terms: string } | null
}

export type AiDraftContextInput = {
	organization: { name?: unknown; description?: unknown; siteOrigin?: unknown }
	menuItems?: ReadonlyArray<Record<string, unknown>>
	selectedItemIds?: readonly unknown[]
	bestSellers?: ReadonlyArray<Record<string, unknown>>
	coupon?: { headline?: unknown; terms?: unknown } | null
}

const text = (value: unknown, max: number): string =>
	typeof value === 'string'
		? value.replace(/\s+/g, ' ').trim().slice(0, max)
		: ''

/** Best-sellers as the browser sends them: strict, ids and counts only. */
export const bestSellersSchema = z
	.array(
		z
			.object({
				itemId: z.string().min(1).max(100),
				count: z.number().int().min(0).max(10_000_000),
			})
			.strict(),
	)
	.max(50)

export function buildAiDraftContext(input: AiDraftContextInput): AiDraftContext {
	const menuItems: AiDraftMenuItem[] = []
	for (const raw of input.menuItems ?? []) {
		const id = text(raw.id ?? raw.itemId, 100)
		const name = text(raw.name, 120)
		if (!id || !name) continue
		const price =
			typeof raw.price === 'number' && Number.isFinite(raw.price)
				? Math.round(raw.price * 100) / 100
				: typeof raw.priceMinor === 'number' && Number.isFinite(raw.priceMinor)
					? Math.round(raw.priceMinor) / 100
					: null
		menuItems.push({
			id,
			name,
			description: text(raw.description, 140),
			price,
			currency: text(raw.currency, 3),
		})
		if (menuItems.length >= MAX_MENU_ITEMS) break
	}
	const known = new Set(menuItems.map((item) => item.id))
	const selectedItemIds = [
		...new Set(
			(input.selectedItemIds ?? []).filter(
				(id): id is string => typeof id === 'string' && known.has(id),
			),
		),
	].slice(0, AI_DRAFT_MAX_DISHES)
	const bestSellers = (input.bestSellers ?? [])
		.flatMap((raw) => {
			const itemId = text(raw.itemId, 100)
			const count = raw.count
			return known.has(itemId) &&
				typeof count === 'number' &&
				Number.isInteger(count) &&
				count >= 0
				? [{ itemId, count }]
				: []
		})
		.sort((a, b) => b.count - a.count)
		.slice(0, MAX_BEST_SELLERS)
	const coupon = input.coupon
		? {
				headline: text(input.coupon.headline, 160),
				terms: text(input.coupon.terms, 400),
			}
		: null
	return {
		organization: {
			name: text(input.organization.name, 120),
			description: text(input.organization.description, 400),
			siteOrigin: text(input.organization.siteOrigin, 200),
		},
		menuItems,
		selectedItemIds,
		bestSellers,
		coupon: coupon && (coupon.headline || coupon.terms) ? coupon : null,
	}
}

export type AiDraftRequest = {
	channel: 'email' | 'sms'
	goal: string
	tone: AiDraftTone
	language: AiDraftLanguage
}

/** Characters the opt-out footer takes in a text; the draft leaves room for it. */
export const SMS_OPT_OUT_FOOTER = ' Reply STOP to opt out.'
export const SMS_MAX_LENGTH = 160
export const SMS_BODY_LIMIT = SMS_MAX_LENGTH - SMS_OPT_OUT_FOOTER.length

const GOAL_TEXT: Record<AiDraftGoal, string> = {
	announce_dish: 'Announce a dish and make guests want to order it.',
	promote_coupon: 'Promote the attached coupon.',
	win_back: 'Win back guests who have not ordered in a while.',
	event: 'Announce an event or an occasion.',
}

export function describeGoal(goal: string): string {
	return (AI_DRAFT_GOALS as readonly string[]).includes(goal)
		? GOAL_TEXT[goal as AiDraftGoal]
		: text(goal, 300)
}

/**
 * The model call's instructions. The only inputs are the context above and the
 * operator's own choices, so this string holds no guest data.
 */
export function buildAiDraftPrompt(
	context: AiDraftContext,
	request: AiDraftRequest,
): { system: string; prompt: string } {
	const language = request.language === 'ar' ? 'Arabic' : 'English'
	const system = [
		'You write marketing messages for a restaurant. You never invent facts.',
		`Write in ${language}. Tone: ${request.tone}.`,
		'Use only these merge tags when addressing the reader: {{firstName|there}}, {{organizationName}}' +
			(context.coupon ? ', {{couponCode}}' : '') +
			'. Never write any other {{tag}}.',
		'Do not state any price, discount, percentage or offer that is not in the menu or the coupon terms given below.',
		`Links may only point to ${context.organization.siteOrigin || 'the restaurant website'}; otherwise leave the link empty.`,
		'Never ask for or mention personal information.',
	].join('\n')

	const dishes = context.menuItems.filter((item) =>
		context.selectedItemIds.includes(item.id),
	)
	const lines: string[] = [
		`Restaurant: ${context.organization.name}`,
		context.organization.description
			? `About: ${context.organization.description}`
			: '',
		`Goal: ${describeGoal(request.goal)}`,
		dishes.length
			? `Feature these dishes (use their ids in itemIds): ${dishes
					.map(
						(item) =>
							`${item.id} = ${item.name}${item.description ? ` (${item.description})` : ''}${item.price !== null ? ` ${item.price} ${item.currency}`.trimEnd() : ''}`,
					)
					.join('; ')}`
			: '',
		context.bestSellers.length
			? `Best sellers (ids and units sold): ${context.bestSellers
					.map((seller) => `${seller.itemId}: ${seller.count}`)
					.join(', ')}`
			: '',
		context.coupon
			? `Coupon attached (use {{couponCode}} for the code): ${context.coupon.headline} ${context.coupon.terms}`.trim()
			: 'No coupon is attached: do not offer any discount.',
		`Menu (id = name, price): ${context.menuItems
			.slice(0, 40)
			.map(
				(item) =>
					`${item.id} = ${item.name}${item.price !== null ? `, ${item.price} ${item.currency}`.trimEnd() : ''}`,
			)
			.join('; ')}`,
	].filter(Boolean)

	const output =
		request.channel === 'sms'
			? `Return one text message of at most ${SMS_BODY_LIMIT} characters (an opt-out footer is added after it).`
			: 'Return exactly 3 subject lines (each under 70 characters) and the email body as blocks: one heading, one or two short paragraphs, a menu_item block listing itemIds only when dishes are featured, and a button with a short label and a link.'
	return { system, prompt: `${lines.join('\n')}\n\n${output}` }
}
