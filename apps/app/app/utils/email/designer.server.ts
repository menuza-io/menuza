import { type EmailBlock } from '@repo/common/email-blocks'
import {
	menuItemChanges,
	type EmailMenuItemBlock,
} from '@repo/common/email-blocks-restaurant'
import { type MarketingOffer } from '@repo/discounts'
import {
	normalizeEmailBlocks,
	renderMarketingEmail,
} from '@repo/marketing/server/email-render'
import { resolveEmailBrandingForOrg } from '#app/utils/email-branding.server.ts'
import {
	listPickableMenuItems,
	resolveMenuItemBlocks,
} from './menu-items.server.ts'
import { loadEmailRenderContext } from './render-context.server.ts'

/**
 * The server half of the email designer, shared by broadcasts and automations:
 * the preview, the dish list and stale check for the Menu item block, and the
 * design-time render that freezes dishes and coupon words into the stored HTML.
 * Control-plane data only; no guest PII.
 */

/** Makes relative image URLs absolute so they load in a mail client. */
export function resolveBlockImageUrls(
	emailBlocks: EmailBlock[],
	originUrl: string,
): EmailBlock[] {
	return emailBlocks.map((block) => {
		if (
			block.type === 'image' &&
			typeof block.config?.url === 'string' &&
			!block.config.url.startsWith('http://') &&
			!block.config.url.startsWith('https://')
		) {
			return {
				...block,
				config: {
					...block.config,
					url: `${originUrl}${block.config.url.startsWith('/') ? '' : '/'}${block.config.url}`,
				},
			}
		}
		return block
	})
}

export type DesignedEmail =
	| {
			ok: true
			blocks: EmailBlock[]
			html: string
			text: string
	  }
	| { ok: false; error: 'empty' | 'item_not_available'; blockId?: string }

/**
 * Renders blocks for sending: dishes are re-read from the live menu (a dish
 * that cannot be picked now is `item_not_available`) and frozen, and the coupon
 * block gets the words of the message's coupon. `offer` is the already checked
 * coupon or null.
 */
export async function designEmail(input: {
	organizationId: string
	blocks: unknown
	subject: string
	baseUrl: string
	offer: MarketingOffer | null
}): Promise<DesignedEmail> {
	const branding = await resolveEmailBrandingForOrg(input.organizationId)
	const normalized = resolveBlockImageUrls(
		normalizeEmailBlocks(input.blocks),
		input.baseUrl,
	)
	if (normalized.length === 0) return { ok: false, error: 'empty' }

	const resolved = await resolveMenuItemBlocks(
		input.organizationId,
		normalized,
		input.baseUrl,
	)
	if (!resolved.ok) {
		return { ok: false, error: resolved.error, blockId: resolved.blockId }
	}
	const context = await loadEmailRenderContext({
		organizationId: input.organizationId,
		offer: input.offer,
	})
	const rendered = await renderMarketingEmail({
		blocks: resolved.blocks,
		theme: branding,
		socials: branding.socials,
		subject: input.subject,
		context,
	})
	return { ok: true, blocks: resolved.blocks, ...rendered }
}

/** The designer's live preview: what is frozen in the blocks, no menu lookup. */
export async function previewEmail(input: {
	organizationId: string
	blocks: unknown
	subject: string
	baseUrl: string
	offer: MarketingOffer | null
}): Promise<{ html: string }> {
	const branding = await resolveEmailBrandingForOrg(input.organizationId)
	const blocks = resolveBlockImageUrls(
		normalizeEmailBlocks(input.blocks),
		input.baseUrl,
	)
	const context = await loadEmailRenderContext({
		organizationId: input.organizationId,
		offer: input.offer,
	})
	const { html } = await renderMarketingEmail({
		blocks,
		theme: branding,
		socials: branding.socials,
		subject: input.subject,
		context,
	})
	return { html }
}

/**
 * Menu item block intents posted by the designer:
 * - `menu_items`: the dishes that can be picked at a location (empty = base price).
 * - `menu_items_check`: what changed on the menu since each block was saved.
 * Returns null when the intent is not one of these.
 */
export async function handleMenuItemIntent(input: {
	intent: unknown
	formData: FormData
	organizationId: string
	baseUrl: string
}) {
	if (input.intent === 'menu_items') {
		const locationId = String(input.formData.get('locationId') ?? '') || null
		return {
			...(await listPickableMenuItems(
				input.organizationId,
				locationId,
				input.baseUrl,
			)),
			// Echoed so the designer knows which location a list belongs to.
			locationId,
		}
	}
	if (input.intent === 'menu_items_check') {
		const blocks = normalizeEmailBlocks(input.formData.get('blocks')).filter(
			(block): block is EmailMenuItemBlock => block.type === 'menu_item',
		)
		const changes = []
		const fresh: Record<string, unknown> = {}
		for (const block of blocks) {
			if (!block.config.snapshot) continue
			const catalog = await listPickableMenuItems(
				input.organizationId,
				block.config.locationId,
				input.baseUrl,
			)
			const live = new Map(
				catalog.items.map((item) => [item.itemId, item] as const),
			)
			const found = menuItemChanges(block, live)
			if (found.length > 0) {
				changes.push(...found)
				fresh[block.id] = block.config.itemIds.flatMap((id) => {
					const item = live.get(id)
					return item ? [item] : []
				})
			}
		}
		return { changes, fresh }
	}
	return null
}
