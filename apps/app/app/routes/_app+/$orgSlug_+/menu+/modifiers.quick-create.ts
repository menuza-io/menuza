import { requireUserId } from '@repo/auth'
import {
	ModifierGroupInputSchema,
	ModifierSelectionTypeSchema,
} from '@repo/common/menu-types'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { modifierGraphErrorResponse } from '#app/utils/menu/modifier-graph.server.ts'
import { createModifierGroup } from '#app/utils/menu/modifier-groups.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const price = z.coerce.number().finite().min(0).max(1_000_000)

/**
 * The compact "Create new group" sheet on the dish and option forms. Only the
 * default-language name is asked for; other languages are added later on the
 * full group page.
 */
export const QuickModifierGroupSchema = z.object({
	/** Client-generated id: a retried or double-clicked save makes one group. */
	clientId: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]{15,63}$/i, 'Invalid request id'),
	name: z.string().trim().min(1, 'Group name is required').max(200),
	selectionType: ModifierSelectionTypeSchema,
	minSelections: z.coerce.number().int().min(0).max(200).default(0),
	maxSelections: z.coerce
		.number()
		.int()
		.min(1)
		.max(200)
		.nullable()
		.default(null),
	options: z
		.array(
			z.object({
				displayName: z
					.string()
					.trim()
					.min(1, 'Option name is required')
					.max(200),
				price: price.default(0),
			}),
		)
		.max(200)
		.default([]),
})

export type QuickModifierGroupInput = z.input<typeof QuickModifierGroupSchema>

export interface QuickModifierGroupResult {
	group: { id: string; name: string; selectionType: string }
	created: boolean
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
		siteLocales: true,
	})
	await requireMenuWrite(request, organization.id)

	let body: unknown
	try {
		body = await request.json()
	} catch {
		return Response.json(
			{ error: { form: ['Invalid request'] } },
			{ status: 400 },
		)
	}
	const quick = QuickModifierGroupSchema.safeParse(body)
	if (!quick.success) {
		return Response.json(
			{ error: z.flattenError(quick.error).fieldErrors },
			{ status: 400 },
		)
	}

	const { defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const localized = (value: string) =>
		JSON.stringify({ [defaultLocale]: value })
	const isPizza = quick.data.selectionType === 'pizza'
	// The same schema and rules as the full Menu, Modifiers form.
	const parsed = ModifierGroupInputSchema.safeParse({
		name: localized(quick.data.name),
		selectionType: quick.data.selectionType,
		minSelections: quick.data.minSelections,
		maxSelections: quick.data.maxSelections,
		options: quick.data.options.map((option, position) => ({
			displayName: localized(option.displayName),
			price: option.price,
			// Pizza toppings price the whole pie; halves default to half of it.
			priceLeft: isPizza ? option.price / 2 : null,
			priceRight: isPizza ? option.price / 2 : null,
			position,
		})),
	})
	if (!parsed.success) {
		return Response.json(
			{ error: z.flattenError(parsed.error).fieldErrors },
			{ status: 400 },
		)
	}

	const result = await createModifierGroup(organization.id, parsed.data, {
		id: quick.data.clientId,
	})
	if (!result.ok) return modifierGraphErrorResponse(result.failure)

	if (result.created) {
		await purgeOrganizationSiteCache(organization.id, organization.slug)
	}
	return Response.json({
		group: result.group,
		created: result.created,
	} satisfies QuickModifierGroupResult)
}
