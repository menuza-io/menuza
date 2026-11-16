import { requireUserId } from '@repo/auth'
import { getDomainUrl } from '@repo/common'
import { marketingOfferSchema, parseMarketingOffer } from '@repo/discounts'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { loadEmailRenderContext } from '#app/utils/email/render-context.server.ts'
import { listPickableMenuItems } from '#app/utils/email/menu-items.server.ts'
import {
	AI_DRAFT_GOALS,
	AI_DRAFT_LANGUAGES,
	AI_DRAFT_MAX_DISHES,
	AI_DRAFT_TONES,
	bestSellersSchema,
	buildAiDraftContext,
} from '#app/utils/marketing/ai-draft-context.ts'
import { AiDraftError } from '#app/utils/marketing/ai-draft-sanitize.ts'
import {
	createAiDraft,
	REWRITE_INSTRUCTIONS,
	rewriteText,
	type DraftGenerator,
} from '#app/utils/marketing/ai-draft.server.ts'
import { getMarketingFeatures } from '#app/utils/marketing/marketing-flags.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireAnyUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	AI_DRAFT_OPERATOR_RATE_LIMIT,
	AI_DRAFT_ORGANIZATION_RATE_LIMIT,
	checkRateLimit,
} from '#app/utils/rate-limit.server.ts'

/**
 * `POST /resources/marketing/ai-draft` (#155): drafts a broadcast or an
 * automation step with AI, or rewrites one block. The model sees control-plane,
 * non-personal context only (`buildAiDraftContext`); the answer is validated
 * and sanitised before it reaches the editor, which it only fills.
 *
 * Needs `update:campaign:any` or `update:automation:any`, the flag
 * `ai.marketing_drafts` (404 while off), and stays inside 20 drafts per
 * operator per hour and 200 per organization per day.
 */

const common = {
	orgSlug: z.string().min(1).max(100),
	language: z.enum(AI_DRAFT_LANGUAGES).default('en'),
}

const draftSchema = z
	.object({
		...common,
		action: z.literal('draft').default('draft'),
		channel: z.enum(['email', 'sms']),
		/** A preset, or the operator's own words. */
		goal: z
			.string()
			.trim()
			.min(1)
			.max(300)
			.or(z.enum(AI_DRAFT_GOALS)),
		tone: z.enum(AI_DRAFT_TONES).default('friendly'),
		itemIds: z.array(z.string().min(1).max(100)).max(AI_DRAFT_MAX_DISHES).default([]),
		bestSellers: bestSellersSchema.optional(),
		offer: marketingOfferSchema.nullish(),
	})
	.strict()

const rewriteSchema = z
	.object({
		...common,
		action: z.literal('rewrite'),
		text: z.string().trim().min(1).max(10_000),
		instruction: z.enum(REWRITE_INSTRUCTIONS),
		sms: z.boolean().optional(),
		offer: marketingOfferSchema.nullish(),
	})
	.strict()

const bodySchema = z.union([rewriteSchema, draftSchema])

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function fail(error: string, status: number, extra?: Record<string, unknown>) {
	return Response.json({ error, ...extra }, { status, headers: NO_STORE })
}

/** The real model; tests pass their own. */
async function liveGenerator(): Promise<DraftGenerator> {
	const { generateObject } = await import('@repo/ai/server')
	return ({ system, prompt, schema }) =>
		generateObject({ system, prompt, schema })
}

export async function action(
	{ request }: ActionFunctionArgs,
	deps: { generate?: DraftGenerator } = {},
) {
	const userId = await requireUserId(request)
	if (request.method !== 'POST') return fail('method_not_allowed', 405)

	const raw = await request.json().catch(() => null)
	const parsed = bodySchema.safeParse(raw)
	if (!parsed.success) return fail('invalid_request', 400)
	const body = parsed.data

	const organization = (await requireUserOrganization(request, body.orgSlug, {
		id: true,
		name: true,
		description: true,
	})) as { id: string; name: string; description: string | null }
	await requireAnyUserWithOrganizationPermission(request, organization.id, [
		ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
		ORG_PERMISSIONS.UPDATE_AUTOMATION_ANY,
	])

	const features = await getMarketingFeatures(organization.id)
	if (!features.aiDrafts) return fail('not_found', 404)

	const generate = deps.generate ?? (process.env.GOOGLE_GENERATIVE_AI_API_KEY ? await liveGenerator() : null)
	if (!generate) return fail('ai_not_configured', 503)

	const operatorLimit = await checkRateLimit(
		{ type: 'user', value: userId },
		AI_DRAFT_OPERATOR_RATE_LIMIT,
	)
	const organizationLimit = operatorLimit.allowed
		? await checkRateLimit(
				{ type: 'org', value: organization.id },
				AI_DRAFT_ORGANIZATION_RATE_LIMIT,
			)
		: null
	if (!operatorLimit.allowed || !organizationLimit?.allowed) {
		return fail('ai_draft_limit', 429)
	}

	try {
		const offer = parseMarketingOffer(body.offer ?? null)
		const [menu, renderContext] = await Promise.all([
			listPickableMenuItems(organization.id, null, getDomainUrl(request)),
			loadEmailRenderContext({ organizationId: organization.id, offer }),
		])
		const context = buildAiDraftContext({
			organization: {
				name: organization.name,
				description: organization.description,
				siteOrigin: renderContext.siteOrigin,
			},
			menuItems: menu.items.map((item) => ({
				id: item.itemId,
				name: item.name,
				description: item.description,
				priceMinor: item.priceMinor,
				currency: item.currency,
			})),
			selectedItemIds: body.action === 'rewrite' ? [] : body.itemIds,
			bestSellers: body.action === 'rewrite' ? [] : (body.bestSellers ?? []),
			coupon: renderContext.coupon
				? {
						headline: renderContext.coupon.headline,
						terms: renderContext.coupon.terms,
					}
				: null,
		})

		if (body.action === 'rewrite') {
			const text = await rewriteText({
				context,
				text: body.text,
				instruction: body.instruction,
				sms: body.sms,
				generate,
			})
			return Response.json({ text }, { headers: NO_STORE })
		}
		const draft = await createAiDraft({
			context,
			request: {
				channel: body.channel,
				goal: body.goal,
				tone: body.tone,
				language: body.language,
			},
			generate,
		})
		return Response.json({ draft }, { headers: NO_STORE })
	} catch (error) {
		if (error instanceof AiDraftError) {
			return fail(error.code, error.code === 'ai_draft_limit' ? 429 : 422)
		}
		// Names only: a model or provider error can echo the prompt.
		console.error('AI draft failed', {
			organizationId: organization.id,
			name: error instanceof Error ? error.name : 'unknown',
		})
		return fail('ai_draft_failed', 502)
	}
}
