import { requireUserId } from '@repo/auth'
import { data, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { getInventoryNavAccess } from '#app/utils/inventory/access.server.ts'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import {
	DELETE_EFFECT_ENTITY_TYPES,
	getDeleteEffects,
} from '#app/utils/menu/delete-effects.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

const QuerySchema = z.object({
	type: z.enum(DELETE_EFFECT_ENTITY_TYPES),
	id: z.string().trim().min(1).max(64),
})

/**
 * `GET /:orgSlug/menu/delete-effects?type=&id=`: what uses a menu record, for
 * its delete dialog and Used in card. Needs `read:menu:any`. Control-plane
 * names, ids and counts only; `recipes` says whether the browser should ask
 * the region about `recipeOwners` (inventory recipes on and readable).
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		siteDefaultLocale: true,
	})
	await requireMenuRead(request, organization.id)

	const url = new URL(request.url)
	const query = QuerySchema.safeParse({
		type: url.searchParams.get('type'),
		id: url.searchParams.get('id'),
	})
	if (!query.success) {
		throw data({ error: 'invalid_query' }, { status: 400 })
	}

	const [effects, inventory] = await Promise.all([
		getDeleteEffects(organization.id, query.data.type, query.data.id, {
			locale: organization.siteDefaultLocale ?? 'en',
		}),
		getInventoryNavAccess(userId, organization.id),
	])
	const recipes = inventory.recipes && effects.recipeOwners.length > 0

	return data(
		{
			...effects,
			recipes,
			recipeOwners: recipes ? effects.recipeOwners : [],
			checkedAt: Date.now(),
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
