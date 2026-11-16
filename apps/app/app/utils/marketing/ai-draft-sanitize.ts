import {
	emailBlocksSchema,
	type EmailBlock,
} from '@repo/common/email-blocks'
import { MERGE_TOKENS, replaceMergeTokens } from '@repo/common/merge-tags'
import { z } from 'zod'
import {
	AI_DRAFT_MAX_DISHES,
	SMS_BODY_LIMIT,
	type AiDraftContext,
	type AiDraftLanguage,
} from './ai-draft-context.ts'

/**
 * Everything a model returns is untrusted (#155). These pure functions turn it
 * into something an operator may safely see in the editor: only known merge
 * tags, only links to the organization's own site, no price or discount that is
 * not on the menu or the attached coupon, only real dishes. The output still
 * only FILLS the editor; the operator reads it and sends nothing from here.
 */

export type AiDraftErrorCode =
	| 'ai_draft_invalid'
	| 'ai_draft_limit'
	| 'ai_not_configured'

export class AiDraftError extends Error {
	constructor(readonly code: AiDraftErrorCode) {
		super(code)
		this.name = 'AiDraftError'
	}
}

// ---------------------------------------------------------------------------
// What the model may return
// ---------------------------------------------------------------------------

export const modelBlockSchema = z.object({
	type: z.enum(['heading', 'paragraph', 'menu_item', 'button']),
	text: z.string().max(4000).optional(),
	label: z.string().max(200).optional(),
	url: z.string().max(2000).optional(),
	itemIds: z.array(z.string().max(100)).max(10).optional(),
})
export const emailDraftOutputSchema = z.object({
	subjects: z.array(z.string().max(300)).min(1).max(6),
	blocks: z.array(modelBlockSchema).min(1).max(12),
})
export const smsDraftOutputSchema = z.object({
	message: z.string().min(1).max(1000),
})
export const rewriteOutputSchema = z.object({
	text: z.string().min(1).max(10_000),
})

// ---------------------------------------------------------------------------
// Merge tags, links, claims
// ---------------------------------------------------------------------------

/** The general merge tags (not the loyalty or cart ones), plus the coupon code only when one is attached. */
export function allowedMergeTags(hasCoupon: boolean): Set<string> {
	const tags = new Set<string>(
		(MERGE_TOKENS as ReadonlyArray<{ tag: string; scope?: string }>)
			.filter((entry) => entry.scope === undefined)
			.map((entry) => entry.tag),
	)
	if (!hasCoupon) tags.delete('couponCode')
	return tags
}

/** Unknown `{{tags}}` are removed (their fallback text stays); known ones are kept as written. */
export function keepKnownMergeTags(text: string, allowed: Set<string>): string {
	return replaceMergeTokens(text, (tag, fallback, raw) =>
		allowed.has(tag) ? raw : fallback.trim(),
	)
}

function originOf(value: string): string | null {
	try {
		const url = new URL(value)
		return url.protocol === 'https:' || url.protocol === 'http:'
			? url.origin
			: null
	} catch {
		return null
	}
}

/** Links to anything but the organization's own site are removed from text. */
export function limitLinks(text: string, siteOrigin: string): string {
	const own = originOf(siteOrigin)
	return text
		.replace(/\bhttps?:\/\/[^\s<>"')\]]+/gi, (link) =>
			own && originOf(link) === own ? link : '',
		)
		.replace(/\bwww\.[^\s<>"')\]]+/gi, '')
}

/** A button's link: the site's own address, or its `/menu`; anything else is left empty for the operator. */
export function buttonUrl(url: string | undefined, siteOrigin: string): string {
	const own = originOf(siteOrigin)
	const value = (url ?? '').trim()
	if (!own || !value) return ''
	if (value.startsWith('/') && !value.startsWith('//')) return `${own}${value}`
	return originOf(value) === own ? value : ''
}

const CURRENCY =
	'(?:[$€£]|SAR|SR|USD|EUR|GBP|ر\\.?\\s?س|ريال|دولار)'
const AMOUNT = '\\d+(?:[.,]\\d+)?'

function numberOf(value: string): number {
	return Number(value.replace(',', '.'))
}

/** Prices a draft may state: the menu's (and the coupon's own numbers). */
export function allowedNumbers(context: AiDraftContext): Set<number> {
	const allowed = new Set<number>()
	for (const item of context.menuItems) {
		if (item.price !== null) allowed.add(item.price)
	}
	const couponText = `${context.coupon?.headline ?? ''} ${context.coupon?.terms ?? ''}`
	for (const match of couponText.matchAll(/\d+(?:[.,]\d+)?/g)) {
		allowed.add(numberOf(match[0]))
	}
	return allowed
}

/**
 * Removes a price, percentage or offer that is not on the menu or in the
 * coupon: an amount that matches no menu price, any "N% off" the coupon does
 * not state, and free-offer phrases when no coupon is attached.
 */
export function neutralizeClaims(text: string, context: AiDraftContext): string {
	const allowed = allowedNumbers(context)
	const hasCoupon = Boolean(context.coupon)
	let out = text
	const amount = new RegExp(
		`(${CURRENCY}\\s?(${AMOUNT}))|((${AMOUNT})\\s?${CURRENCY})`,
		'gi',
	)
	out = out.replace(amount, (match, _a, first, _b, second) => {
		const value = numberOf(String(first ?? second))
		return allowed.has(value) ? match : ''
	})
	const percent = /(\d+(?:[.,]\d+)?)\s?%|%\s?(\d+(?:[.,]\d+)?)/g
	out = out.replace(percent, (match, first, second) => {
		const value = numberOf(String(first ?? second))
		const couponStates =
			hasCoupon &&
			new RegExp(`${String(value).replace('.', '[.,]')}\\s?%|%\\s?${String(value)}`).test(
				`${context.coupon?.headline} ${context.coupon?.terms}`,
			)
		return couponStates ? match : ''
	})
	if (!hasCoupon) {
		out = out.replace(
			/\b(free delivery|free shipping|buy one,? get one|bogo|half[- ]price|\d+\s?off)\b/gi,
			'',
		)
	}
	return out
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/\s+([.,!?،؟])/g, '$1')
		.replace(/\(\s*\)/g, '')
		.trim()
}

/** The full clean-up for any text the model wrote. */
export function sanitizeText(text: string, context: AiDraftContext): string {
	return neutralizeClaims(
		limitLinks(
			keepKnownMergeTags(text, allowedMergeTags(Boolean(context.coupon))),
			context.organization.siteOrigin,
		),
		context,
	)
}

// ---------------------------------------------------------------------------
// Email and SMS drafts
// ---------------------------------------------------------------------------

type ModelBlock = z.infer<typeof modelBlockSchema>

function couponLine(language: AiDraftLanguage) {
	return language === 'ar'
		? 'استخدم الرمز {{couponCode}}.'
		: 'Use code {{couponCode}}.'
}

/**
 * Model blocks to designer blocks. Dishes are only real ones (ids on the live
 * menu); their prices are frozen later, at save, from the live menu. Anything
 * that does not pass the designer's own schema is `ai_draft_invalid`.
 */
export function toEmailBlocks(
	blocks: ModelBlock[],
	context: AiDraftContext,
	language: AiDraftLanguage,
): EmailBlock[] {
	const known = new Set(context.menuItems.map((item) => item.id))
	const out: unknown[] = []
	let counter = 0
	const id = (kind: string) => `ai-${kind}-${++counter}`
	for (const block of blocks) {
		if (block.type === 'heading' || block.type === 'paragraph') {
			const text = sanitizeText(block.text ?? '', context)
			if (!text) continue
			out.push(
				block.type === 'heading'
					? {
							id: id('heading'),
							type: 'heading',
							config: { text, level: 'h2', align: 'left' },
						}
					: {
							id: id('text'),
							type: 'paragraph',
							config: { text, align: 'left' },
						},
			)
		} else if (block.type === 'menu_item') {
			const itemIds = [
				...new Set((block.itemIds ?? []).filter((item) => known.has(item))),
			].slice(0, AI_DRAFT_MAX_DISHES)
			if (itemIds.length === 0) continue
			out.push({
				id: id('dishes'),
				type: 'menu_item',
				config: {
					itemIds,
					locationId: null,
					showPrice: true,
					showDescription: true,
					snapshot: null,
				},
			})
		} else {
			const label = sanitizeText(block.label ?? block.text ?? '', context)
			if (!label) continue
			out.push({
				id: id('button'),
				type: 'button',
				config: {
					label,
					url: buttonUrl(block.url, context.organization.siteOrigin),
					variant: 'primary',
					width: 'auto',
					align: 'left',
				},
			})
		}
	}
	const hasWords = out.some(
		(block) =>
			(block as { type: string }).type === 'heading' ||
			(block as { type: string }).type === 'paragraph',
	)
	if (!hasWords) throw new AiDraftError('ai_draft_invalid')
	// A coupon is only usable when its code appears in the message.
	if (
		context.coupon &&
		!JSON.stringify(out).includes('{{couponCode}}')
	) {
		out.push({
			id: id('coupon'),
			type: 'paragraph',
			config: { text: couponLine(language), align: 'left' },
		})
	}
	const parsed = emailBlocksSchema.safeParse(out)
	if (!parsed.success) throw new AiDraftError('ai_draft_invalid')
	return parsed.data
}

export function toSubjects(
	subjects: string[],
	context: AiDraftContext,
): string[] {
	const clean = [
		...new Set(
			subjects
				.map((subject) =>
					sanitizeText(subject, context).replace(/\s+/g, ' ').slice(0, 150),
				)
				.filter(Boolean),
		),
	].slice(0, 3)
	if (clean.length === 0) throw new AiDraftError('ai_draft_invalid')
	return clean
}

/** One text message, short enough that the opt-out footer still fits in 160 characters. */
export function toSmsMessage(message: string, context: AiDraftContext): string {
	const clean = sanitizeText(message, context).replace(/\s+/g, ' ').trim()
	if (!clean) throw new AiDraftError('ai_draft_invalid')
	if (clean.length <= SMS_BODY_LIMIT) return clean
	const cut = clean.slice(0, SMS_BODY_LIMIT)
	const space = cut.lastIndexOf(' ')
	return (space > SMS_BODY_LIMIT * 0.6 ? cut.slice(0, space) : cut).trim()
}
