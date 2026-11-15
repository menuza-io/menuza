import { parseMarketingOffer } from '@repo/discounts'
import {
	normalizeEmailBlocks,
	renderMarketingEmail,
} from '@repo/marketing/server/email-render'
import { type OrganizationEmailBranding } from '#app/utils/email-branding.server.ts'
import { resolveBlockImageUrls } from './designer.server.ts'
import { resolveMenuItemBlocks } from './menu-items.server.ts'
import { loadEmailRenderContext } from './render-context.server.ts'

type JourneyNodeLike = {
	type?: string
	data?: Record<string, unknown>
} & Record<string, unknown>

export type RenderedJourneyNodes<T> =
	| { ok: true; nodes: T[] }
	| { ok: false; error: 'item_not_available'; nodeId: string }

/**
 * Renders every designed email step of an automation at save time, so the send
 * path never needs React. Dishes are re-read from the live menu and frozen
 * (`item_not_available` refuses the save), and the coupon block gets the words
 * of the step's own coupon.
 */
export async function renderJourneyEmailNodes<T extends JourneyNodeLike>(
	organizationId: string,
	nodes: T[],
	branding: OrganizationEmailBranding,
	baseUrl: string,
): Promise<RenderedJourneyNodes<T>> {
	const out: T[] = []
	for (const node of nodes) {
		if (
			!node ||
			typeof node !== 'object' ||
			node.type !== 'action_email' ||
			!node.data ||
			!Array.isArray(node.data.blocks)
		) {
			out.push(node)
			continue
		}
		if (node.data.blocks.length === 0) {
			out.push({
				...node,
				data: {
					...node.data,
					emailFormat: 'designed',
					bodyHtml: '',
					bodyText: '',
				},
			})
			continue
		}
		const resolved = await resolveMenuItemBlocks(
			organizationId,
			resolveBlockImageUrls(normalizeEmailBlocks(node.data.blocks), baseUrl),
			baseUrl,
		)
		const nodeId = String((node as { id?: unknown }).id ?? '')
		if (!resolved.ok) {
			return { ok: false, error: resolved.error, nodeId }
		}
		const context = await loadEmailRenderContext({
			organizationId,
			offer: parseMarketingOffer(node.data.discountOffer),
		})
		const rendered = await renderMarketingEmail({
			blocks: resolved.blocks,
			theme: branding,
			socials: branding.socials,
			subject: typeof node.data.subject === 'string' ? node.data.subject : '',
			context,
		})
		out.push({
			...node,
			data: {
				...node.data,
				// The saved blocks carry the frozen dishes.
				blocks: resolved.blocks,
				emailFormat: 'designed',
				bodyHtml: rendered.html,
				bodyText: rendered.text,
			},
		})
	}
	return { ok: true, nodes: out }
}
