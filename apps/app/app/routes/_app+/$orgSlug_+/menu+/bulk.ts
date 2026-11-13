import { requireUserId } from '@repo/auth'
import { z } from 'zod'
import { type ActionFunctionArgs } from 'react-router'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import {
	applyBulkItemEdit,
	applyBulkOptionEdit,
	currencyExponentFor,
} from '#app/utils/menu/bulk-apply.server.ts'
import {
	BULK_EDIT_MAX_ROWS,
	planBulkEditItem,
	planBulkEditOption,
	type BulkItemOperation,
	type BulkOptionOperation,
} from '#app/utils/menu/bulk-edit.ts'
import { isMenuBulkEditKillSwitchOn } from '#app/utils/menu/bulk-edit-switch.server.ts'
import { requireMenuBulkEditAccess } from '#app/utils/menu/menu-feature-access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { loadModifierGraph } from '#app/utils/menu/modifier-graph.server.ts'
import {
	and,
	db,
	eq,
	inArray,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuOption,
} from '@repo/database'

const PriceChangeSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('percent'), value: z.number() }),
	z.object({ kind: z.literal('amount'), value: z.number() }),
	z.object({ kind: z.literal('set'), value: z.number().min(0) }),
])

const EndingSchema = z.object({
	to: z.enum(['00', '50', '95', '99']),
	direction: z.enum(['up', 'down', 'nearest']),
})

const ItemOperationSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('price'),
		change: PriceChangeSchema,
		ending: EndingSchema.optional(),
	}),
	z.object({
		type: z.literal('availability'),
		status: z.enum([
			'available',
			'unavailable_until',
			'unavailable_until_tomorrow',
			'unavailable',
			'hidden',
		]),
		unavailableUntil: z.coerce.date().nullable().optional(),
	}),
	z.object({ type: z.literal('apply_sales_tax'), enabled: z.boolean() }),
	z.object({
		type: z.literal('dietary'),
		flag: z.enum(['vegetarian', 'gluten_free', 'alcohol']),
		enabled: z.boolean(),
	}),
	z.object({ type: z.literal('popular'), enabled: z.boolean() }),
	z.object({ type: z.literal('upsell'), enabled: z.boolean() }),
	z.object({ type: z.literal('add_category'), categoryId: z.string().min(1) }),
	z.object({ type: z.literal('remove_category'), categoryId: z.string().min(1) }),
	z.object({ type: z.literal('add_modifier_group'), modifierGroupId: z.string().min(1) }),
	z.object({ type: z.literal('remove_modifier_group'), modifierGroupId: z.string().min(1) }),
])

const OptionOperationSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('price'),
		change: PriceChangeSchema,
		ending: EndingSchema.optional(),
	}),
	z.object({
		type: z.literal('availability'),
		status: z.enum([
			'available',
			'unavailable_until',
			'unavailable_until_tomorrow',
			'unavailable',
			'hidden',
		]),
		unavailableUntil: z.coerce.date().nullable().optional(),
	}),
	z.object({
		type: z.literal('dietary'),
		flag: z.enum(['vegetarian', 'gluten_free', 'alcohol']),
		enabled: z.boolean(),
	}),
])

const BodySchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('preview'),
		targetType: z.enum(['item', 'option']),
		ids: z.array(z.string().min(1)).min(1).max(BULK_EDIT_MAX_ROWS),
		operation: z.union([ItemOperationSchema, OptionOperationSchema]),
		locationId: z.string().nullable().optional(),
	}),
	z.object({
		intent: z.literal('apply'),
		targetType: z.enum(['item', 'option']),
		ids: z.array(z.string().min(1)).min(1).max(BULK_EDIT_MAX_ROWS),
		operation: z.union([ItemOperationSchema, OptionOperationSchema]),
		locationId: z.string().nullable().optional(),
		updatedAt: z.record(z.string(), z.string()),
	}),
])

export async function action({ request, params }: ActionFunctionArgs) {
	if (isMenuBulkEditKillSwitchOn(process.env as { MENU_BULK_EDIT_ENABLED?: string })) {
		return Response.json({ error: 'bulk_edit_disabled' }, { status: 503 })
	}

	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	await requireMenuBulkEditAccess(request, organization.id)

	let body: unknown
	try {
		body = await request.json()
	} catch {
		return Response.json({ error: 'invalid_json' }, { status: 400 })
	}
	const parsed = BodySchema.safeParse(body)
	if (!parsed.success) {
		return Response.json({ error: 'invalid_body' }, { status: 400 })
	}

	const org = await db.query.Organization.findFirst({
		where: (fields, { eq: equals }) => equals(fields.id, organization.id),
		columns: { currency: true },
	})
	const exponent = currencyExponentFor(org?.currency ?? 'USD')

	if (parsed.data.intent === 'preview') {
		const { targetType, ids, operation } = parsed.data
		if (targetType === 'item') {
			const items = await db
				.select()
				.from(OrganizationMenuItem)
				.where(
					and(
						eq(OrganizationMenuItem.organizationId, organization.id),
						inArray(OrganizationMenuItem.id, ids),
					),
				)
			if (items.length !== ids.length) {
				return new Response('Item not found', { status: 404 })
			}
			const categoryLinks = await db
				.select()
				.from(OrganizationMenuItemCategoryAssignment)
				.where(inArray(OrganizationMenuItemCategoryAssignment.itemId, ids))
			const groupLinks = await db
				.select()
				.from(OrganizationMenuItemModifierGroupAssignment)
				.where(inArray(OrganizationMenuItemModifierGroupAssignment.itemId, ids))
			const categoryByItem = new Map<string, string[]>()
			for (const link of categoryLinks) {
				const list = categoryByItem.get(link.itemId) ?? []
				list.push(link.categoryId)
				categoryByItem.set(link.itemId, list)
			}
			const groupByItem = new Map<string, string[]>()
			for (const link of groupLinks) {
				const list = groupByItem.get(link.itemId) ?? []
				list.push(link.modifierGroupId)
				groupByItem.set(link.itemId, list)
			}
			const plans = planBulkEditItem({
				rows: items.map((row) => ({
					id: row.id,
					updatedAt: row.updatedAt,
					displayName: row.displayName,
					price: row.price,
					availabilityStatus: row.availabilityStatus as 'available',
					unavailableUntil: row.unavailableUntil,
					applySalesTax: row.applySalesTax,
					isVegetarian: row.isVegetarian,
					isGlutenFree: row.isGlutenFree,
					isAlcohol: row.isAlcohol,
					isPopular: row.isPopular,
					isUpsell: row.isUpsell,
					categoryIds: categoryByItem.get(row.id) ?? [],
					modifierGroupIds: groupByItem.get(row.id) ?? [],
				})),
				operation: operation as BulkItemOperation,
				currencyExponent: exponent,
			})
			if (operation.type === 'add_modifier_group') {
				await loadModifierGraph(organization.id)
				for (const plan of plans) {
					if (!plan.after.modifierGroupIds.includes(operation.modifierGroupId)) {
						plan.skipped = 'modifier_graph'
					}
				}
			}
			return Response.json({ plans })
		}

		const options = await db
			.select()
			.from(OrganizationMenuOption)
			.where(
				and(
					eq(OrganizationMenuOption.organizationId, organization.id),
					inArray(OrganizationMenuOption.id, ids),
				),
			)
		if (options.length !== ids.length) {
			return new Response('Option not found', { status: 404 })
		}
		const plans = planBulkEditOption({
			rows: options.map((row) => ({
				id: row.id,
				updatedAt: row.updatedAt,
				displayName: row.displayName,
				price: row.price,
				availabilityStatus: row.availabilityStatus as 'available',
				unavailableUntil: row.unavailableUntil,
				isVegetarian: row.isVegetarian,
				isGlutenFree: row.isGlutenFree,
				isAlcohol: row.isAlcohol,
			})),
			operation: operation as BulkOptionOperation,
			currencyExponent: exponent,
		})
		return Response.json({ plans })
	}

	const userId = await requireMenuWrite(request, organization.id)
	const { targetType, ids, operation, updatedAt } = parsed.data
	if (targetType === 'item') {
		return applyBulkItemEdit({
			organizationId: organization.id,
			organizationSlug: organization.slug,
			userId,
			request,
			itemIds: ids,
			operation: operation as BulkItemOperation,
			locationId: parsed.data.locationId,
			expectedUpdatedAt: updatedAt,
		})
	}
	return applyBulkOptionEdit({
		organizationId: organization.id,
		organizationSlug: organization.slug,
		userId,
		request,
		optionIds: ids,
		operation: operation as BulkOptionOperation,
		locationId: parsed.data.locationId,
		expectedUpdatedAt: updatedAt,
	})
}
