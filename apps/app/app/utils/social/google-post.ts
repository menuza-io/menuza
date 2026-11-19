/**
 * Google Business Profile posts (#135): the rules the composer (browser) and
 * the server both apply, and the `localPosts` body sent to Google. Pure: no
 * I/O, no UI strings (problems are codes, worded in `social-labels.ts`).
 *
 * Google's post types map to `topicType`: an Update is `STANDARD`; an Offer is
 * `OFFER` and carries a title and dates (as an event schedule) plus the coupon
 * code, redeem link and terms; an Event is `EVENT` with a title and schedule.
 */
import { z } from 'zod'

export const GOOGLE_TOPIC_TYPES = ['STANDARD', 'OFFER', 'EVENT'] as const
export type GoogleTopicType = (typeof GOOGLE_TOPIC_TYPES)[number]

export function isGoogleTopicType(value: unknown): value is GoogleTopicType {
	return (GOOGLE_TOPIC_TYPES as readonly string[]).includes(value as string)
}

/** Google's limit for the text of a post. */
export const GOOGLE_POST_MAX_TEXT = 1500
export const GOOGLE_POST_MAX_MEDIA = 1
export const GOOGLE_TITLE_MAX = 58
export const GOOGLE_COUPON_MAX = 58
export const GOOGLE_TERMS_MAX = 5000
/** One image: JPEG or PNG, at least 400 by 300 pixels. */
export const GOOGLE_IMAGE_MIN = { width: 400, height: 300 } as const

export const GOOGLE_BUTTON_TYPES = [
	'ORDER',
	'BOOK',
	'LEARN_MORE',
	'CALL',
] as const
export type GoogleButtonType = (typeof GOOGLE_BUTTON_TYPES)[number]

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u)

export const googlePostDetailsSchema = z
	.object({
		button: z
			.object({
				type: z.enum(GOOGLE_BUTTON_TYPES),
				url: z.string().max(2000).optional(),
			})
			.optional(),
		offer: z
			.object({
				title: z.string().max(200).default(''),
				startDate: isoDate.or(z.literal('')).default(''),
				endDate: isoDate.or(z.literal('')).default(''),
				couponCode: z.string().max(200).default(''),
				termsConditions: z
					.string()
					.max(GOOGLE_TERMS_MAX + 100)
					.default(''),
				redeemUrl: z.string().max(2000).default(''),
			})
			.optional(),
		event: z
			.object({
				title: z.string().max(200).default(''),
				startDate: isoDate.or(z.literal('')).default(''),
				startTime: hhmm.or(z.literal('')).default(''),
				endDate: isoDate.or(z.literal('')).default(''),
				endTime: hhmm.or(z.literal('')).default(''),
			})
			.optional(),
	})
	.strict()
export type GooglePostDetails = z.infer<typeof googlePostDetailsSchema>

export function parseGooglePostDetails(raw: unknown): GooglePostDetails {
	let value: unknown = raw
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw)
		} catch {
			return {}
		}
	}
	const parsed = googlePostDetailsSchema.safeParse(value ?? {})
	return parsed.success ? parsed.data : {}
}

export type GooglePostProblem =
	| 'empty'
	| 'too_long'
	| 'has_phone'
	| 'too_many_media'
	| 'media_type'
	| 'media_too_small'
	| 'title_required'
	| 'title_too_long'
	| 'dates_required'
	| 'dates_order'
	| 'bad_url'
	| 'button_needs_url'
	| 'coupon_too_long'
	| 'terms_too_long'
	| 'coupon_not_valid_online'

export type GoogleMediaFacts = {
	mimeType: string
	width: number | null
	height: number | null
}

const PHONE_PATTERN = /(\+?\d[\d\s().-]{6,}\d)/

export function hasPhoneNumber(text: string): boolean {
	return PHONE_PATTERN.test(text)
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value)
		return url.protocol === 'https:' || url.protocol === 'http:'
	} catch {
		return false
	}
}

/**
 * What keeps a post from going to Google. `media` carries the dimensions of
 * each chosen image (the composer and the server both know them).
 */
export function googlePostProblems(input: {
	body: string
	topicType: GoogleTopicType
	details: GooglePostDetails
	media: readonly GoogleMediaFacts[]
}): GooglePostProblem[] {
	const problems = new Set<GooglePostProblem>()
	const body = input.body.trim()
	const { details } = input
	if ([...body].length > GOOGLE_POST_MAX_TEXT) problems.add('too_long')
	if (hasPhoneNumber(body)) problems.add('has_phone')
	if (input.topicType === 'STANDARD' && !body && input.media.length === 0) {
		problems.add('empty')
	}
	if (input.topicType !== 'STANDARD' && !body) problems.add('empty')
	if (input.media.length > GOOGLE_POST_MAX_MEDIA) problems.add('too_many_media')
	for (const item of input.media) {
		if (!['image/jpeg', 'image/jpg', 'image/png'].includes(item.mimeType)) {
			problems.add('media_type')
		} else if (
			(item.width ?? 0) < GOOGLE_IMAGE_MIN.width ||
			(item.height ?? 0) < GOOGLE_IMAGE_MIN.height
		) {
			problems.add('media_too_small')
		}
	}

	const button = details.button
	if (button) {
		if (button.type !== 'CALL') {
			if (!button.url) problems.add('button_needs_url')
			else if (!isHttpUrl(button.url)) problems.add('bad_url')
		}
	}

	if (input.topicType === 'OFFER') {
		const offer = details.offer
		if (!offer?.title?.trim()) problems.add('title_required')
		else if ([...offer.title.trim()].length > GOOGLE_TITLE_MAX) {
			problems.add('title_too_long')
		}
		if (!offer?.startDate || !offer.endDate) problems.add('dates_required')
		else if (offer.endDate < offer.startDate) problems.add('dates_order')
		if (offer?.couponCode && [...offer.couponCode].length > GOOGLE_COUPON_MAX) {
			problems.add('coupon_too_long')
		}
		if (
			offer?.termsConditions &&
			[...offer.termsConditions].length > GOOGLE_TERMS_MAX
		) {
			problems.add('terms_too_long')
		}
		if (offer?.redeemUrl && !isHttpUrl(offer.redeemUrl)) problems.add('bad_url')
	}

	if (input.topicType === 'EVENT') {
		const event = details.event
		if (!event?.title?.trim()) problems.add('title_required')
		else if ([...event.title.trim()].length > GOOGLE_TITLE_MAX) {
			problems.add('title_too_long')
		}
		if (!event?.startDate || !event.endDate) problems.add('dates_required')
		else {
			const start = `${event.startDate}T${event.startTime || '00:00'}`
			const end = `${event.endDate}T${event.endTime || '23:59'}`
			if (end < start) problems.add('dates_order')
		}
	}
	return [...problems]
}

function dateParts(iso: string) {
	const [year, month, day] = iso.split('-').map(Number)
	return { year: year!, month: month!, day: day! }
}

function timeParts(value: string) {
	const [hours, minutes] = value.split(':').map(Number)
	return { hours: hours ?? 0, minutes: minutes ?? 0, seconds: 0, nanos: 0 }
}

/** The `localPosts.create` body. Image links are signed by the caller. */
export function buildLocalPostBody(input: {
	body: string
	topicType: GoogleTopicType
	details: GooglePostDetails
	imageUrl: string | null
	languageCode: string
}): Record<string, unknown> {
	const { details } = input
	const body: Record<string, unknown> = {
		languageCode: input.languageCode,
		summary: input.body.trim(),
		topicType: input.topicType,
	}
	if (details.button) {
		body.callToAction =
			details.button.type === 'CALL'
				? { actionType: 'CALL' }
				: { actionType: details.button.type, url: details.button.url }
	}
	if (input.imageUrl) {
		body.media = [{ mediaFormat: 'PHOTO', sourceUrl: input.imageUrl }]
	}
	if (input.topicType === 'OFFER' && details.offer) {
		const offer = details.offer
		body.event = {
			title: offer.title.trim(),
			schedule: {
				startDate: dateParts(offer.startDate),
				endDate: dateParts(offer.endDate),
			},
		}
		body.offer = {
			...(offer.couponCode ? { couponCode: offer.couponCode } : {}),
			...(offer.redeemUrl ? { redeemOnlineUrl: offer.redeemUrl } : {}),
			...(offer.termsConditions
				? { termsConditions: offer.termsConditions }
				: {}),
		}
	}
	if (input.topicType === 'EVENT' && details.event) {
		const event = details.event
		body.event = {
			title: event.title.trim(),
			schedule: {
				startDate: dateParts(event.startDate),
				...(event.startTime ? { startTime: timeParts(event.startTime) } : {}),
				endDate: dateParts(event.endDate),
				...(event.endTime ? { endTime: timeParts(event.endTime) } : {}),
			},
		}
	}
	return body
}

/** Pre-fill for "Post this offer to Google" from a coupon. */
export function offerDetailsFromCoupon(input: {
	title: string
	code: string
	startDate: string | null
	endDate: string | null
	redeemUrl: string
}): GooglePostDetails {
	return {
		button: { type: 'ORDER', url: input.redeemUrl },
		offer: {
			title: input.title.slice(0, GOOGLE_TITLE_MAX),
			startDate: input.startDate ?? '',
			endDate: input.endDate ?? '',
			couponCode: input.code,
			termsConditions: '',
			redeemUrl: input.redeemUrl,
		},
	}
}
