import { MAX_GROUP_MEMBERS, type ItemGroup } from '@repo/inventory'
import {
	invItemCosts,
	invItemGroupMembers,
	invItemGroups,
	invItems,
	invRecipeLines,
	invRecipes,
	invSoldOut,
} from '@repo/tenant-db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertVersion,
	newId,
	notFound,
	onHandByItem,
} from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'

/**
 * Ingredient groups (#495): several stock items that can stand in for each
 * other ("Olive oil" = brand A, brand B). Each member stays its own item
 * (brand, pack, price, counts and receiving are per product). The group is an
 * item too, so a recipe names it like any ingredient; a sale takes stock from
 * the primary first and then the next member (the engine does this, see
 * `allocateToMembers`), food cost uses the primary's price and auto sold out
 * looks at the members' total.
 */

export type CreateGroupInput = {
	clientId: string
	name: string
	baseUnit: 'g' | 'ml' | 'piece'
	category?: string
	autoSoldOut?: boolean
	members: { itemId: string; memberQuantity: number; groupQuantity: number }[]
}

export type UpdateGroupInput = {
	expectedVersion: number
	name?: string
	autoSoldOut?: boolean
	members?: { itemId: string; memberQuantity: number; groupQuantity: number }[]
}

async function checkMembers(
	tx: InventoryTx,
	groupItemId: string | null,
	baseUnit: 'g' | 'ml' | 'piece',
	members: CreateGroupInput['members'],
): Promise<void> {
	if (members.length === 0 || members.length > MAX_GROUP_MEMBERS) {
		throw new InventoryError('group_invalid', 400, { reason: 'members' })
	}
	const ids = members.map((member) => member.itemId)
	if (new Set(ids).size !== ids.length) {
		throw new InventoryError('group_invalid', 400, { reason: 'duplicate' })
	}
	const items = await tx
		.select()
		.from(invItems)
		.where(inArray(invItems.id, ids))
	if (items.length !== ids.length) throw notFound()
	const groups = new Set(
		(await tx.select({ itemId: invItemGroups.itemId }).from(invItemGroups)).map(
			(row) => row.itemId,
		),
	)
	const taken = await tx
		.select()
		.from(invItemGroupMembers)
		.where(inArray(invItemGroupMembers.memberItemId, ids))
	for (const item of items) {
		if (item.archivedAt !== null) {
			throw new InventoryError('group_invalid', 400, { reason: 'archived' })
		}
		if (groups.has(item.id)) {
			throw new InventoryError('group_invalid', 400, { reason: 'nested' })
		}
		if (item.mergedIntoId !== null) throw notFound()
	}
	for (const row of taken) {
		if (row.groupItemId !== groupItemId) {
			throw new InventoryError('item_in_group', 409, {
				itemId: row.memberItemId,
			})
		}
	}
	for (const member of members) {
		const item = items.find((entry) => entry.id === member.itemId)!
		// Members of another unit type need an explicit conversion.
		if (
			item.baseUnit !== baseUnit &&
			member.memberQuantity === member.groupQuantity
		) {
			throw new InventoryError('group_invalid', 400, {
				reason: 'conversion_required',
				itemId: item.id,
			})
		}
	}
}

async function writeMembers(
	tx: InventoryTx,
	groupItemId: string,
	members: CreateGroupInput['members'],
	now: number,
): Promise<void> {
	await tx
		.delete(invItemGroupMembers)
		.where(eq(invItemGroupMembers.groupItemId, groupItemId))
	for (const [rank, member] of members.entries()) {
		await tx.insert(invItemGroupMembers).values({
			groupItemId,
			memberItemId: member.itemId,
			rank,
			memberQuantity: member.memberQuantity,
			groupQuantity: member.groupQuantity,
			createdAt: now,
		})
	}
}

export async function createGroup(
	caller: InventoryCaller,
	input: { body: CreateGroupInput; idempotency: InventoryIdempotency | null },
): Promise<ItemGroup> {
	const { body } = input
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			await checkMembers(tx, null, body.baseUnit, body.members)
			const id = newId()
			await tx.insert(invItems).values({
				id,
				name: body.name,
				category: body.category ?? 'other',
				kind: 'bought',
				baseUnit: body.baseUnit,
				autoSoldOut: body.autoSoldOut ?? false,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
			await tx.insert(invItemGroups).values({ itemId: id, createdAt: ctx.now })
			await writeMembers(tx, id, body.members, ctx.now)
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'group.create',
				resourceType: 'item',
				resourceId: id,
				detail: { members: body.members.length },
				at: ctx.now,
			})
			return (
				await readGroups(tx, { locationId: null, cost: caller.cost, id })
			)[0]!
		},
	)
}

export async function updateGroup(
	caller: InventoryCaller,
	input: { groupId: string; body: UpdateGroupInput },
): Promise<ItemGroup> {
	const { body } = input
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const group = await tx
			.select({ itemId: invItemGroups.itemId })
			.from(invItemGroups)
			.where(eq(invItemGroups.itemId, input.groupId))
			.get()
		if (!group) throw notFound()
		const item = await tx
			.select()
			.from(invItems)
			.where(eq(invItems.id, input.groupId))
			.get()
		if (!item || item.archivedAt !== null) throw notFound()
		assertVersion(item.version, body.expectedVersion)
		if (body.members) {
			await checkMembers(tx, item.id, item.baseUnit, body.members)
			await writeMembers(tx, item.id, body.members, ctx.now)
		}
		await tx
			.update(invItems)
			.set({
				name: body.name ?? item.name,
				autoSoldOut: body.autoSoldOut ?? item.autoSoldOut,
				version: item.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invItems.id, item.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'group.update',
			resourceType: 'item',
			resourceId: item.id,
			detail: { members: body.members?.length ?? null },
			at: ctx.now,
		})
		return (
			await readGroups(tx, { locationId: null, cost: caller.cost, id: item.id })
		)[0]!
	})
}

/**
 * Dissolves a group: its members stay as plain items. A recipe that names the
 * group keeps the line, so the group must not be in a current recipe.
 */
export async function dissolveGroup(
	caller: InventoryCaller,
	input: { groupId: string; expectedVersion: number },
): Promise<{ dissolved: true }> {
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const item = await tx
			.select()
			.from(invItems)
			.where(eq(invItems.id, input.groupId))
			.get()
		const group = item
			? await tx
					.select({ itemId: invItemGroups.itemId })
					.from(invItemGroups)
					.where(eq(invItemGroups.itemId, item.id))
					.get()
			: null
		if (!item || !group) throw notFound()
		assertVersion(item.version, input.expectedVersion)
		const used = await tx
			.select({ id: invRecipeLines.id })
			.from(invRecipeLines)
			.innerJoin(invRecipes, eq(invRecipes.id, invRecipeLines.recipeId))
			.where(
				and(
					eq(invRecipeLines.itemId, item.id),
					isNull(invRecipes.supersededAt),
				),
			)
			.limit(1)
			.get()
		if (used)
			throw new InventoryError('group_invalid', 409, { reason: 'in_use' })
		await tx
			.delete(invItemGroupMembers)
			.where(eq(invItemGroupMembers.groupItemId, item.id))
		await tx.delete(invSoldOut).where(eq(invSoldOut.causeItemId, item.id))
		await tx.delete(invItemGroups).where(eq(invItemGroups.itemId, item.id))
		await tx
			.update(invItems)
			.set({
				archivedAt: ctx.now,
				version: item.version + 1,
				updatedAt: ctx.now,
			})
			.where(eq(invItems.id, item.id))
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'group.dissolve',
			resourceType: 'item',
			resourceId: item.id,
			at: ctx.now,
		})
		return { dissolved: true as const }
	})
}

async function readGroups(
	db: InventoryReader,
	input: { locationId: string | null; cost: boolean; id?: string },
): Promise<ItemGroup[]> {
	const groupRows = await db
		.select({ item: invItems })
		.from(invItemGroups)
		.innerJoin(invItems, eq(invItems.id, invItemGroups.itemId))
	const wanted = groupRows.filter((row) =>
		input.id ? row.item.id === input.id : row.item.archivedAt === null,
	)
	if (wanted.length === 0) return []
	const [members, itemRows, costs, onHand] = await Promise.all([
		db.select().from(invItemGroupMembers).orderBy(invItemGroupMembers.rank),
		db.select().from(invItems),
		db.select().from(invItemCosts),
		input.locationId
			? onHandByItem(db, input.locationId)
			: Promise.resolve(null),
	])
	const itemById = new Map(itemRows.map((row) => [row.id, row]))
	const costById = new Map(costs.map((row) => [row.itemId, row]))
	return wanted
		.sort((a, b) =>
			a.item.name.toLowerCase().localeCompare(b.item.name.toLowerCase()),
		)
		.map(({ item }) => {
			const own = members.filter((member) => member.groupItemId === item.id)
			const mapped = own.map((member) => {
				const info = itemById.get(member.memberItemId)!
				const stock = onHand?.get(member.memberItemId) ?? 0
				const cost = costById.get(member.memberItemId)
				const out: ItemGroup['members'][number] = {
					itemId: member.memberItemId,
					name: info.name,
					rank: member.rank,
					baseUnit: info.baseUnit,
					memberQuantity: member.memberQuantity,
					groupQuantity: member.groupQuantity,
					onHand: stock,
					onHandInGroupUnit: Math.round(
						(stock * member.groupQuantity) / member.memberQuantity,
					),
					archived: info.archivedAt !== null,
				}
				if (input.cost) {
					out.costMicro = cost?.avgCostMicro ?? null
					if (cost) out.currency = cost.currency
				}
				return out
			})
			const group: ItemGroup = {
				id: item.id,
				name: item.name,
				category: item.category,
				baseUnit: item.baseUnit,
				version: item.version,
				autoSoldOut: item.autoSoldOut,
				archived: item.archivedAt !== null,
				onHand: mapped.reduce(
					(sum, member) => sum + member.onHandInGroupUnit,
					0,
				),
				members: mapped,
			}
			const primary = own[0]
			if (input.cost && primary) {
				const cost = costById.get(primary.memberItemId)
				group.costMicro =
					cost?.avgCostMicro === null || cost?.avgCostMicro === undefined
						? null
						: Math.round(
								(cost.avgCostMicro * primary.memberQuantity) /
									primary.groupQuantity,
							)
				if (cost) group.currency = cost.currency
			}
			return group
		})
}

/** Every active group with its members and the total on hand at a location. */
export async function listGroups(
	db: InventoryReader,
	input: { locationId: string; cost: boolean },
): Promise<{ groups: ItemGroup[] }> {
	return {
		groups: await readGroups(db, {
			locationId: input.locationId,
			cost: input.cost,
		}),
	}
}
