import { requireUserId } from '@repo/auth'
import {
	db,
	eq,
	and,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

const ReorderSchema = z.discriminatedUnion('entity', [
	z.object({
		entity: z.literal('category'),
		menuId: z.string().min(1),
		orderedIds: z.array(z.string().min(1)),
	}),
	z.object({
		entity: z.literal('item'),
		categoryId: z.string().min(1),
		orderedIds: z.array(z.string().min(1)),
	}),
])

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	await requireUserOrganization(request, params.orgSlug, { id: true })

	const raw = await request.json().catch(() => ({}))
	const parsed = ReorderSchema.safeParse(raw)

	if (!parsed.success) {
		return Response.json({ error: 'Invalid payload' }, { status: 400 })
	}

	const data = parsed.data

	if (data.entity === 'category') {
		// Update position in OrganizationMenuCategoryAssignment
		for (let i = 0; i < data.orderedIds.length; i++) {
			const categoryId = data.orderedIds[i]
			if (!categoryId) continue
			await db
				.update(OrganizationMenuCategoryAssignment)
				.set({ position: i })
				.where(
					and(
						eq(OrganizationMenuCategoryAssignment.menuId, data.menuId),
						eq(OrganizationMenuCategoryAssignment.categoryId, categoryId),
					),
				)
		}
	} else if (data.entity === 'item') {
		// Update position in OrganizationMenuItemCategoryAssignment
		for (let i = 0; i < data.orderedIds.length; i++) {
			const itemId = data.orderedIds[i]
			if (!itemId) continue
			await db
				.update(OrganizationMenuItemCategoryAssignment)
				.set({ position: i })
				.where(
					and(
						eq(
							OrganizationMenuItemCategoryAssignment.categoryId,
							data.categoryId,
						),
						eq(OrganizationMenuItemCategoryAssignment.itemId, itemId),
					),
				)
		}
	}

	return Response.json({ success: true })
}
