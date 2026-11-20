import { z } from 'zod'

/**
 * "Write it for me" for a popup (#132): a title, a line of text and a button
 * label from the coupon. The model only ever sees the restaurant's name and
 * the coupon's plain facts; whatever it returns is cut to size, stripped of
 * markup and links, and must still carry the coupon's code. Tests and local
 * mock runs use the fixture generator and never reach a model.
 */

export const popupCopySchema = z.object({
	title: z.string(),
	body: z.string(),
	buttonLabel: z.string(),
})
export type PopupCopy = z.infer<typeof popupCopySchema>

export type PopupCopyFacts = {
	restaurantName: string
	/** `10% off`, `SAR 15 off`; null for a popup with no coupon. */
	offer: string | null
	code: string | null
	language: 'en' | 'ar'
}

/** What a generator receives; the real one is `generateObject` from `@repo/ai`. */
export type PopupCopyGenerator = (args: {
	system: string
	prompt: string
	schema: typeof popupCopySchema
}) => Promise<unknown>

export const POPUP_TITLE_MAX = 60
export const POPUP_BODY_MAX = 200
export const POPUP_BUTTON_MAX = 24

/** The deterministic copy: what the fixture generator and the fallback return. */
export function fixturePopupCopy(facts: PopupCopyFacts): PopupCopy {
	if (facts.language === 'ar') {
		return facts.offer && facts.code
			? {
					title: `احصل على خصم ${facts.offer}`,
					body: `اطلب عبر الإنترنت من ${facts.restaurantName} واستخدم الرمز ${facts.code} عند الدفع.`,
					buttonLabel: 'اطلب الآن',
				}
			: {
					title: `أهلاً بك في ${facts.restaurantName}`,
					body: 'اطلب عبر الإنترنت واستلم طلبك طازجاً.',
					buttonLabel: 'اطلب الآن',
				}
	}
	return facts.offer && facts.code
		? {
				title: `Get ${facts.offer} your first online order`,
				body: `Order online from ${facts.restaurantName}. Use code ${facts.code} at checkout.`,
				buttonLabel: 'Order now',
			}
		: {
				title: `Welcome to ${facts.restaurantName}`,
				body: 'Order online and pick it up fresh.',
				buttonLabel: 'Order now',
			}
}

export const fixturePopupGenerator: (
	facts: PopupCopyFacts,
) => PopupCopyGenerator = (facts) => async () => fixturePopupCopy(facts)

/** The real model, loaded only when a key is set. */
export async function livePopupGenerator(): Promise<PopupCopyGenerator> {
	const { generateObject } = await import('@repo/ai/server')
	return ({ system, prompt, schema }) =>
		generateObject({ system, prompt, schema })
}

function clean(text: string, max: number): string {
	return text
		.replace(/<[^>]*>/gu, ' ')
		.replace(/https?:\/\/\S+/giu, '')
		.replace(/[*_`#>]/gu, '')
		.replace(/\s+/gu, ' ')
		.trim()
		.slice(0, max)
		.trim()
}

/**
 * A draft title, text and button for the popup. The model's answer is
 * validated and cleaned; when a coupon is attached, the text must carry its
 * code (it is added when the model left it out) and a percentage or amount the
 * model invented is not trusted: the fixture sentence is used instead.
 */
export async function draftPopupCopy(
	facts: PopupCopyFacts,
	generate: PopupCopyGenerator,
): Promise<PopupCopy> {
	const system = [
		'You write one short promotional popup for a restaurant website.',
		'Use only the facts given. Do not invent discounts, dates, dishes or claims.',
		'No links, no HTML, no emoji. Friendly and brief.',
		`Title at most ${POPUP_TITLE_MAX} characters, text at most ${POPUP_BODY_MAX}, button label at most ${POPUP_BUTTON_MAX}.`,
		`Write in ${facts.language === 'ar' ? 'Arabic' : 'English'}.`,
	].join(' ')
	const prompt = [
		`Restaurant: ${facts.restaurantName}`,
		facts.offer && facts.code
			? `Offer: ${facts.offer}. Code to use at checkout: ${facts.code}.`
			: 'No offer: invite people to order online.',
	].join('\n')
	let raw: unknown
	try {
		raw = await generate({ system, prompt, schema: popupCopySchema })
	} catch {
		return fixturePopupCopy(facts)
	}
	const parsed = popupCopySchema.safeParse(raw)
	if (!parsed.success) return fixturePopupCopy(facts)
	const copy: PopupCopy = {
		title: clean(parsed.data.title, POPUP_TITLE_MAX),
		body: clean(parsed.data.body, POPUP_BODY_MAX),
		buttonLabel: clean(parsed.data.buttonLabel, POPUP_BUTTON_MAX),
	}
	if (!copy.title || !copy.body || !copy.buttonLabel) {
		return fixturePopupCopy(facts)
	}
	if (
		facts.code &&
		!copy.body.toUpperCase().includes(facts.code.toUpperCase())
	) {
		const withCode = `${copy.body} ${facts.language === 'ar' ? 'الرمز' : 'Code'}: ${facts.code}`
		copy.body = withCode.slice(0, POPUP_BODY_MAX)
		if (!copy.body.toUpperCase().includes(facts.code.toUpperCase())) {
			return fixturePopupCopy(facts)
		}
	}
	return copy
}
