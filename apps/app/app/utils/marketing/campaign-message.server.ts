import { i18n } from '@lingui/core'
import { t } from '@lingui/macro'
import { type EmailBlock } from '@repo/common/email-blocks'
import { parseMarketingOffer, type MarketingOffer } from '@repo/discounts'
import { MARKETING_OFFER_ERROR_MESSAGES } from '#app/utils/discounts/marketing-offer-labels.ts'
import {
	checkMarketingOffer,
	readOfferField,
} from '#app/utils/discounts/marketing-offers.server.ts'
import { designEmail } from '#app/utils/email/designer.server.ts'

/**
 * A broadcast's message as the App prepares it for tenant-api, shared by
 * create, edit and the pre-send check: the designed email is rendered here (so
 * dishes and the coupon's words are frozen at save, like the rest of the
 * design), and the coupon is checked against the discounts it may use.
 */

export type PreparedCampaignMessage = {
	channel: 'email' | 'sms'
	subject: string
	content: string
	contentHtml: string | null
	/** JSON of the saved blocks (dishes re-resolved), or null for SMS. */
	contentBlocks: string | null
	blocks: EmailBlock[]
	discountOffer: MarketingOffer | null
}

export type PrepareResult =
	| { ok: true; message: PreparedCampaignMessage }
	| { ok: false; error: string; blockId?: string }

export async function prepareCampaignMessage(input: {
	formData: FormData
	organizationId: string
	userId: string
	baseUrl: string
	/** The coupon is already saved on this campaign exactly as posted. */
	unchangedOffer?: boolean
}): Promise<PrepareResult> {
	const { formData } = input
	const channel = formData.get('channel') === 'sms' ? 'sms' : 'email'
	const subject =
		channel === 'email' && typeof formData.get('subject') === 'string'
			? String(formData.get('subject'))
			: ''
	const blocksRaw = formData.get('blocks')
	const offerRaw = readOfferField(formData.get('discountOffer'))

	let content =
		typeof formData.get('content') === 'string'
			? String(formData.get('content'))
			: ''
	let contentHtml: string | null = null
	let contentBlocks: string | null = null
	let blocks: EmailBlock[] = []

	if (
		channel === 'email' &&
		typeof blocksRaw === 'string' &&
		blocksRaw.trim()
	) {
		const designed = await designEmail({
			organizationId: input.organizationId,
			blocks: blocksRaw,
			subject,
			baseUrl: input.baseUrl,
			// Only the words come from this; permission is checked below.
			offer: parseMarketingOffer(offerRaw),
		})
		if (!designed.ok) {
			return {
				ok: false,
				blockId: designed.blockId,
				error:
					designed.error === 'item_not_available'
						? i18n._(
								t`A dish in your email is no longer on the live menu. Remove it or choose another one.`,
							)
						: i18n._(t`Add at least one email block`),
			}
		}
		content = designed.text
		contentHtml = designed.html
		contentBlocks = JSON.stringify(designed.blocks)
		blocks = designed.blocks
	}

	if (!content) {
		return { ok: false, error: i18n._(t`Message content is required`) }
	}

	const offerCheck = await checkMarketingOffer({
		userId: input.userId,
		organizationId: input.organizationId,
		raw: offerRaw,
		texts: channel === 'email' ? [subject, content, contentHtml] : [content],
		unchanged: input.unchangedOffer,
	})
	if (!offerCheck.ok) {
		return {
			ok: false,
			error: i18n._(MARKETING_OFFER_ERROR_MESSAGES[offerCheck.error]),
		}
	}

	return {
		ok: true,
		message: {
			channel,
			subject,
			content,
			contentHtml,
			contentBlocks,
			blocks,
			discountOffer: offerCheck.offer,
		},
	}
}
