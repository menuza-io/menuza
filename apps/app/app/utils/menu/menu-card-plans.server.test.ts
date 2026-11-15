import {
	ConfigFlag,
	db,
	eq,
	Integration,
	MenuSnapshot,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
	OrganizationMenuPosLink,
} from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

const snapshotStore = vi.hoisted(() => new Map<string, string>())

vi.mock('#app/utils/storage.server.ts', () => ({
	uploadMenuSnapshotJson: vi.fn(
		async (orgId: string, snapshotId: string, body: string) => {
			const key = `menu-snapshots/${orgId}/${snapshotId}.json`
			snapshotStore.set(key, body)
			return key
		},
	),
	readMenuSnapshotJson: vi.fn(
		async (contentKey: string) => snapshotStore.get(contentKey) ?? null,
	),
	deleteMenuSnapshotJson: vi.fn(async (contentKey: string) => {
		snapshotStore.delete(contentKey)
	}),
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => true),
}))
vi.mock('@repo/audit', () => ({
	auditService: { log: vi.fn() },
	AuditAction: {
		MENU_ITEM_UPDATED: 'menu_item_updated',
		MENU_CATEGORY_UPDATED: 'menu_category_updated',
	},
}))

import {
	type MenuCardContext,
	type MenuCardDraft,
	type MenuCardKindImpl,
	emptyKind,
} from './menu-card-kinds.ts'
import {
	applyMenuCards,
	detectMenuCards,
	setMenuCardKindForTests,
	signMenuCardUndo,
	undoMenuCard,
	validateCardPlan,
} from './menu-card-plans.server.ts'
import {
	menuCardFingerprint,
	menuCardId,
	MENU_CARD_KINDS,
	type MenuCardApplyInput,
	type MenuCardKind,
	type MenuCardOp,
	type MenuCardRef,
	type MenuCardUndo,
} from './menu-cards.ts'
import { loadMenuGraph } from './menu-graph.server.ts'
import {
	indexMenuGraph,
	makeMenuGraph,
	sourceText,
	type MenuGraph,
} from './menu-graph.ts'
import { captureMenuSnapshotContent } from './snapshot.server.ts'

// --- Test kinds ---------------------------------------------------------------

const draftOf = (
	graph: MenuGraph,
	kind: MenuCardKind,
	primary: { type: 'item'; id: string },
	refs: MenuCardRef[],
	params: Record<string, unknown>,
	extra: Partial<MenuCardDraft> = {},
): MenuCardDraft => ({
	kind,
	id: menuCardId(kind, primary.id),
	primary,
	subject: sourceText(graph, graph.items.find((i) => i.id === primary.id)?.displayName),
	refs,
	fingerprint: menuCardFingerprint(refs),
	params,
	preview: { before: [], after: [] },
	...extra,
})

const itemRef = (graph: MenuGraph, id: string): MenuCardRef => ({
	type: 'item',
	id,
	updatedAt: graph.items.find((i) => i.id === id)!.updatedAt,
})
const groupRef = (graph: MenuGraph, id: string): MenuCardRef => ({
	type: 'modifier_group',
	id,
	updatedAt: graph.groups.find((g) => g.id === id)!.updatedAt,
})
const categoryRef = (graph: MenuGraph, id: string): MenuCardRef => ({
	type: 'category',
	id,
	updatedAt: graph.categories.find((c) => c.id === id)!.updatedAt,
})

/** Reorders a dish's group links, required groups first (like required_first). */
const requiredFirst: MenuCardKindImpl = {
	kind: 'required_first',
	detect(graph) {
		const index = indexMenuGraph(graph)
		const out: MenuCardDraft[] = []
		for (const item of graph.items) {
			const links = index.groupsOfItem(item.id)
			const groups = links.map((link) => index.group.get(link.modifierGroupId)!)
			const sorted = [...groups].sort(
				(a, b) => Number(b.minSelections > 0) - Number(a.minSelections > 0),
			)
			if (sorted.every((group, i) => group.id === groups[i]!.id)) continue
			out.push(
				draftOf(
					graph,
					'required_first',
					{ type: 'item', id: item.id },
					[itemRef(graph, item.id), ...groups.map((g) => groupRef(graph, g.id))],
					{ itemId: item.id },
				),
			)
		}
		return out
	},
	plan(graph, request) {
		const itemId = request.params.itemId
		if (typeof itemId !== 'string') return { ok: false, error: 'invalid_input' }
		const index = indexMenuGraph(graph)
		if (!index.item.has(itemId)) return { ok: false, error: 'not_applicable' }
		const groups = index
			.groupsOfItem(itemId)
			.map((link) => index.group.get(link.modifierGroupId)!)
		const sorted = [...groups].sort(
			(a, b) => Number(b.minSelections > 0) - Number(a.minSelections > 0),
		)
		return {
			ok: true,
			ops: sorted.map((group, position) => ({
				op: 'assign' as const,
				link: 'item_modifier_group' as const,
				parentId: itemId,
				childId: group.id,
				position,
			})),
		}
	},
}

/** Hides one of two same-named dishes and moves its categories to the other. */
const mergeDuplicates: MenuCardKindImpl = {
	kind: 'merge_duplicates',
	detect(graph) {
		const index = indexMenuGraph(graph)
		const out: MenuCardDraft[] = []
		const byName = new Map<string, string[]>()
		for (const item of graph.items) {
			if (item.availabilityStatus === 'hidden') continue
			const name = sourceText(graph, item.displayName)
			byName.set(name, [...(byName.get(name) ?? []), item.id])
		}
		for (const ids of byName.values()) {
			if (ids.length !== 2) continue
			const [keepId, loseId] = ids as [string, string]
			const categories = index.categoriesOfItem(loseId)
			out.push(
				draftOf(
					graph,
					'merge_duplicates',
					{ type: 'item', id: loseId },
					[
						itemRef(graph, keepId),
						itemRef(graph, loseId),
						...categories.map((link) => categoryRef(graph, link.categoryId)),
					],
					{ keepId, loseId },
				),
			)
		}
		return out
	},
	plan(graph, request) {
		const { keepId, loseId } = request.params
		if (typeof keepId !== 'string' || typeof loseId !== 'string')
			return { ok: false, error: 'invalid_input' }
		const index = indexMenuGraph(graph)
		if (!index.item.has(keepId) || !index.item.has(loseId))
			return { ok: false, error: 'not_applicable' }
		const ops: MenuCardOp[] = [
			{
				op: 'update',
				entity: 'item',
				id: loseId,
				set: { availabilityStatus: 'hidden' },
			},
		]
		for (const link of index.categoriesOfItem(loseId)) {
			ops.push({
				op: 'assign',
				link: 'item_category',
				parentId: link.categoryId,
				childId: keepId,
				position: 99,
			})
		}
		return { ok: true, ops }
	},
}

/** Inserts a copy of "Fries" with a new group and option (like make_sizes). */
const makeSizes: MenuCardKindImpl = {
	kind: 'make_sizes',
	detect(graph) {
		const fries = graph.items.find(
			(item) => sourceText(graph, item.displayName) === 'Fries',
		)
		if (!fries) return []
		if (graph.items.some((item) => sourceText(graph, item.displayName) === 'Fries Large'))
			return []
		const index = indexMenuGraph(graph)
		const category = index.categoriesOfItem(fries.id)[0]
		if (!category) return []
		return [
			draftOf(
				graph,
				'make_sizes',
				{ type: 'item', id: fries.id },
				[itemRef(graph, fries.id), categoryRef(graph, category.categoryId)],
				{ itemId: fries.id },
			),
		]
	},
	plan(graph, request) {
		const itemId = request.params.itemId
		if (typeof itemId !== 'string') return { ok: false, error: 'invalid_input' }
		const index = indexMenuGraph(graph)
		const category = index.categoriesOfItem(itemId)[0]
		if (!index.item.has(itemId) || !category)
			return { ok: false, error: 'not_applicable' }
		return {
			ok: true,
			ops: [
				{
					op: 'insert',
					entity: 'item',
					tempId: 'big',
					copyFrom: itemId,
					values: {
						displayName: '{"en":"Fries Large"}',
						price: 14,
						position: 7,
					},
				},
				{
					op: 'assign',
					link: 'item_category',
					parentId: category.categoryId,
					childId: 'new:big',
					position: 5,
				},
				{
					op: 'insert',
					entity: 'modifier_group',
					tempId: 'g',
					values: { name: '{"en":"Dip"}', selectionType: 'single' },
				},
				{
					op: 'insert',
					entity: 'option',
					tempId: 'o',
					values: { displayName: '{"en":"Ketchup"}', price: 1 },
				},
				{
					op: 'assign',
					link: 'item_modifier_group',
					parentId: 'new:big',
					childId: 'new:g',
				},
				{
					op: 'assign',
					link: 'group_option',
					parentId: 'new:g',
					childId: 'new:o',
					priceOverride: 2,
					isDefault: true,
				},
			],
		}
	},
}

/**
 * A kind whose default fix is harmless but whose plan does something else
 * for `optionId`. Detect never offers those, Accept's validation must catch
 * them.
 */
const rogue: MenuCardKindImpl = {
	kind: 'typo',
	detect(graph) {
		const target = graph.items.find((item) =>
			sourceText(graph, item.displayName).startsWith('Target'),
		)
		if (!target) return []
		return [
			draftOf(graph, 'typo', { type: 'item', id: target.id }, [itemRef(graph, target.id)], {
				itemId: target.id,
			}),
		]
	},
	plan(graph, request) {
		const itemId = request.params.itemId as string
		const other = graph.items.find((item) => item.id !== itemId)!
		const hide = (id: string): MenuCardOp => ({
			op: 'update',
			entity: 'item',
			id,
			set: { availabilityStatus: 'hidden' },
		})
		const raw = (set: Record<string, unknown>): MenuCardOp =>
			({ op: 'update', entity: 'item', id: itemId, set }) as MenuCardOp
		switch (request.optionId) {
			case undefined:
				return { ok: true, ops: [hide(itemId)] }
			case 'outside':
				return { ok: true, ops: [hide(other.id)] }
			case 'price':
				return {
					ok: true,
					ops: [{ op: 'update', entity: 'item', id: itemId, set: { price: 99 } }],
				}
			case 'allergens':
				return { ok: true, ops: [raw({ allergens: '[]' })] }
			case 'vegetarian':
				return { ok: true, ops: [raw({ isVegetarian: true })] }
			case 'calories':
				return { ok: true, ops: [raw({ calorieMin: 1 })] }
			case 'unknown_column':
				return { ok: true, ops: [raw({ internalName: 'x' })] }
			case 'copy_outside':
				return {
					ok: true,
					ops: [
						{
							op: 'insert',
							entity: 'item',
							tempId: 't',
							copyFrom: other.id,
							values: { displayName: '{"en":"Copy"}' },
						},
					],
				}
			case 'ghost':
				return {
					ok: true,
					ops: [
						{
							op: 'assign',
							link: 'item_category',
							parentId: 'x',
							childId: 'new:ghost',
						},
					],
				}
			default:
				return { ok: false, error: 'invalid_input' }
		}
	},
}

function installKinds(overrides: MenuCardKindImpl[]) {
	for (const kind of MENU_CARD_KINDS) setMenuCardKindForTests(kind, emptyKind(kind))
	for (const impl of overrides) setMenuCardKindForTests(impl.kind, impl)
}

// --- World -----------------------------------------------------------------------

const OLD = new Date('2026-01-01T00:00:00.000Z')
const NOW = new Date('2026-06-01T12:00:00.000Z')

const ctx: MenuCardContext = {
	defaultLocale: 'en',
	locales: ['en'],
	settings: { capitalStyle: null },
	now: NOW,
}

type World = Awaited<ReturnType<typeof seedWorld>>

const name = (text: string) => JSON.stringify({ en: text })

async function seedWorld() {
	const user = await insertTestUser()
	const org = await createTestOrganization(user.id)
	const organization = {
		id: org.id,
		slug: org.slug,
		siteLocales: null,
		siteDefaultLocale: null,
	}
	const base = { organizationId: org.id, createdAt: OLD, updatedAt: OLD }
	const [menu] = await db
		.insert(OrganizationMenu)
		.values({ ...base, displayName: 'Main' })
		.returning()
	const [c1, c2] = await db
		.insert(OrganizationMenuCategory)
		.values([
			{ ...base, displayName: name('Mains'), position: 0 },
			{ ...base, displayName: name('Sides'), position: 1 },
		])
		.returning()
	await db.insert(OrganizationMenuCategoryAssignment).values([
		{ menuId: menu!.id, categoryId: c1!.id, position: 0 },
		{ menuId: menu!.id, categoryId: c2!.id, position: 1 },
	])
	const items = await db
		.insert(OrganizationMenuItem)
		.values([
			{ ...base, displayName: name('Burger'), price: 10, position: 0 },
			{ ...base, displayName: name('Burger'), price: 11, position: 1 },
			{
				...base,
				displayName: name('Pizza'),
				price: 12,
				position: 2,
			},
			{
				...base,
				displayName: name('Fries'),
				price: 5,
				position: 3,
				description: 'Crispy',
				allergens: '["celery"]',
				isVegetarian: true,
				isGlutenFree: true,
				isAlcohol: false,
				calorieMin: 300,
				calorieMax: 420,
				applySalesTax: false,
				imageUrl: 'https://img.example/fries.png',
				imageKeys: '["k1"]',
			},
			{ ...base, displayName: name('Target Dish'), price: 8, position: 4 },
			{ ...base, displayName: name('Other'), price: 3, position: 5 },
		])
		.returning()
	const [burgerA, burgerB, pizza, fries, target, other] = items as [
		(typeof items)[number],
		(typeof items)[number],
		(typeof items)[number],
		(typeof items)[number],
		(typeof items)[number],
		(typeof items)[number],
	]
	await db.insert(OrganizationMenuItemCategoryAssignment).values([
		{ categoryId: c1!.id, itemId: burgerA.id, position: 0 },
		{ categoryId: c2!.id, itemId: burgerB.id, position: 0 },
		{ categoryId: c1!.id, itemId: pizza.id, position: 1 },
		{ categoryId: c2!.id, itemId: fries.id, position: 1 },
		{ categoryId: c1!.id, itemId: target.id, position: 2 },
		{ categoryId: c1!.id, itemId: other.id, position: 3 },
	])
	const groups = await db
		.insert(OrganizationMenuModifierGroup)
		.values([
			{ ...base, name: name('Toppings'), minSelections: 0, position: 0 },
			{ ...base, name: name('Size'), minSelections: 1, position: 1 },
		])
		.returning()
	const [optional, required] = groups as [
		(typeof groups)[number],
		(typeof groups)[number],
	]
	await db.insert(OrganizationMenuItemModifierGroupAssignment).values([
		{ itemId: pizza.id, modifierGroupId: optional.id, position: 0 },
		{ itemId: pizza.id, modifierGroupId: required.id, position: 1 },
	])
	const options = await db
		.insert(OrganizationMenuOption)
		.values([
			{ ...base, displayName: name('Cheese'), price: 1 },
			{ ...base, displayName: name('Large'), price: 3 },
		])
		.returning()
	await db.insert(OrganizationMenuModifierGroupOptionAssignment).values([
		{ modifierGroupId: optional.id, optionId: options[0]!.id, position: 0 },
		{ modifierGroupId: required.id, optionId: options[1]!.id, position: 0 },
	])
	return {
		user,
		org,
		organization,
		menu: menu!,
		c1: c1!,
		c2: c2!,
		burgerA,
		burgerB,
		pizza,
		fries,
		target,
		other,
		optional,
		required,
	}
}

async function detectDrafts(
	w: World,
	kind: MenuCardKind,
	structureEnabled = true,
) {
	const { graph } = await loadMenuGraph(w.organization)
	return {
		graph,
		drafts: detectMenuCards(graph, ctx, { structureEnabled, kinds: [kind] }),
	}
}

const input = (
	draft: MenuCardDraft,
	extra: Partial<MenuCardApplyInput> = {},
): MenuCardApplyInput => ({
	kind: draft.kind,
	id: draft.id,
	refs: draft.refs,
	params: draft.params,
	...extra,
})

async function detectInput(
	w: World,
	kind: MenuCardKind,
	pick?: (draft: MenuCardDraft) => boolean,
	extra: Partial<MenuCardApplyInput> = {},
) {
	const { drafts } = await detectDrafts(w, kind)
	const draft = pick ? drafts.find(pick) : drafts[0]
	if (!draft) throw new Error(`no ${kind} card detected`)
	return input(draft, extra)
}

function apply(
	w: World,
	cards: MenuCardApplyInput[],
	options: { structureEnabled?: boolean } = {},
) {
	return applyMenuCards({
		organization: w.organization,
		userId: w.user.id,
		cards,
		ctx,
		structureEnabled: options.structureEnabled ?? true,
		now: () => NOW,
	})
}

function undo(w: World, undoData: MenuCardUndo) {
	return undoMenuCard({
		organization: w.organization,
		userId: w.user.id,
		undo: undoData,
	})
}

async function okUndo(w: World, card: MenuCardApplyInput) {
	const [result] = await apply(w, [card])
	if (!result?.ok) throw new Error(`apply failed: ${JSON.stringify(result)}`)
	return result.undo
}

/** The whole menu as plain, order-independent data. */
async function menuState(w: World) {
	const content = JSON.parse(
		JSON.stringify(await captureMenuSnapshotContent(w.org.id)),
	) as Record<string, unknown>
	for (const [key, value] of Object.entries(content)) {
		if (Array.isArray(value)) {
			content[key] = [...value].sort((a, b) =>
				String((a as { id: string }).id).localeCompare(
					String((b as { id: string }).id),
				),
			)
		}
	}
	return content
}

async function snapshotRows(w: World) {
	return db
		.select()
		.from(MenuSnapshot)
		.where(eq(MenuSnapshot.organizationId, w.org.id))
}

async function bump(table: typeof OrganizationMenuItem, id: string, patch: object) {
	await db
		.update(table)
		.set({ ...patch, updatedAt: new Date(Date.now() + 60_000) })
		.where(eq(table.id, id))
}

async function itemRow(id: string) {
	const [row] = await db
		.select()
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.id, id))
	return row
}

beforeEach(() => {
	snapshotStore.clear()
	installKinds([requiredFirst, mergeDuplicates, makeSizes, rogue])
})

afterEach(() => {
	for (const kind of MENU_CARD_KINDS) setMenuCardKindForTests(kind, null)
	snapshotStore.clear()
})

// --- Tests -----------------------------------------------------------------------

describe('detectMenuCards', () => {
	it('returns cards of the asked kinds only, and skips structure kinds when off', async () => {
		const w = await seedWorld()
		const { graph } = await loadMenuGraph(w.organization)
		const all = detectMenuCards(graph, ctx, { structureEnabled: true })
		expect(new Set(all.map((draft) => draft.kind))).toEqual(
			new Set(['required_first', 'merge_duplicates', 'make_sizes', 'typo']),
		)
		const off = detectMenuCards(graph, ctx, { structureEnabled: false })
		expect(off.map((draft) => draft.kind).sort()).toEqual(['required_first', 'typo'])
	})

	it('drops a card whose default plan is invalid or POS-owned, and a kind that throws', async () => {
		const w = await seedWorld()
		const { graph } = await loadMenuGraph(w.organization)
		const outside: MenuCardKindImpl = {
			...rogue,
			plan: (g, request) => rogue.plan(g, { ...request, optionId: 'outside' }, ctx),
		}
		const pos: MenuCardKindImpl = {
			...rogue,
			plan: (g, request) => rogue.plan(g, { ...request, optionId: 'price' }, ctx),
		}
		const throwing: MenuCardKindImpl = {
			...rogue,
			detect: () => {
				throw new Error('boom')
			},
		}
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		try {
			setMenuCardKindForTests('typo', outside)
			expect(detectMenuCards(graph, ctx, { structureEnabled: true, kinds: ['typo'] })).toEqual([])
			setMenuCardKindForTests('typo', throwing)
			expect(detectMenuCards(graph, ctx, { structureEnabled: true, kinds: ['typo'] })).toEqual([])
			expect(errors).toHaveBeenCalled()
		} finally {
			errors.mockRestore()
		}
		// POS-owned: link the target dish to a POS, its price card goes away.
		const [integration] = await db
			.insert(Integration)
			.values({
				organizationId: w.org.id,
				providerName: 'square',
				providerType: 'pos',
				config: '{}',
			})
			.returning()
		await db.insert(OrganizationMenuPosLink).values({
			organizationId: w.org.id,
			integrationId: integration!.id,
			providerName: 'square',
			entityType: 'item',
			remoteId: 'r1',
			localId: w.target.id,
		})
		const { graph: linked } = await loadMenuGraph(w.organization)
		setMenuCardKindForTests('typo', pos)
		expect(detectMenuCards(linked, ctx, { structureEnabled: true, kinds: ['typo'] })).toEqual([])
		setMenuCardKindForTests('typo', rogue)
		expect(detectMenuCards(linked, ctx, { structureEnabled: true, kinds: ['typo'] })).toHaveLength(1)
	})
})

describe('applyMenuCards', () => {
	it('reorders group links exactly as planned, with one snapshot and one updatedAt', async () => {
		const w = await seedWorld()
		const card = await detectInput(w, 'required_first')
		const other = await itemRow(w.other.id)

		const [result] = await apply(w, [card])
		expect(result?.ok).toBe(true)
		if (!result?.ok) return

		const links = await db
			.select()
			.from(OrganizationMenuItemModifierGroupAssignment)
			.where(eq(OrganizationMenuItemModifierGroupAssignment.itemId, w.pizza.id))
		const positions = Object.fromEntries(
			links.map((link) => [link.modifierGroupId, link.position]),
		)
		expect(positions).toEqual({ [w.required.id]: 0, [w.optional.id]: 1 })

		// Every touched record, link ends included, shares the new updatedAt.
		const [pizza] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, w.pizza.id))
		expect(pizza!.updatedAt.getTime()).toBe(NOW.getTime())
		for (const group of [w.optional, w.required]) {
			const [row] = await db
				.select()
				.from(OrganizationMenuModifierGroup)
				.where(eq(OrganizationMenuModifierGroup.id, group.id))
			expect(row!.updatedAt.getTime()).toBe(NOW.getTime())
		}
		// Nothing else moved.
		expect((await itemRow(w.other.id))!.updatedAt.getTime()).toBe(
			other!.updatedAt.getTime(),
		)

		const snapshots = await snapshotRows(w)
		expect(snapshots).toHaveLength(1)
		expect(snapshots[0]!.reason).toBe('before_suggestion')
		expect(snapshots[0]!.id).toBe(result.undo.snapshotId)

		expect(result.undo.touched.map((r) => `${r.type}:${r.id}`).sort()).toEqual(
			[
				`item:${w.pizza.id}`,
				`modifier_group:${w.optional.id}`,
				`modifier_group:${w.required.id}`,
			].sort(),
		)
		expect(result.undo.touched.every((r) => r.updatedAt === NOW.toISOString())).toBe(true)
		expect(result.undo.created).toEqual([])
		expect(result.undo.links).toHaveLength(2)
		expect(
			result.undo.links.every(
				(pair) => pair.link === 'item_modifier_group' && pair.parentId === w.pizza.id,
			),
		).toBe(true)
	})

	it('undo puts the menu back deep-equal and keeps an unrelated later edit', async () => {
		const w = await seedWorld()
		const before = await menuState(w)
		const undoData = await okUndo(w, await detectInput(w, 'required_first'))
		expect(await menuState(w)).not.toEqual(before)

		await bump(OrganizationMenuItem, w.other.id, { description: 'edited later' })
		const result = await undo(w, undoData)
		expect(result).toEqual({ ok: true })

		const after = await menuState(w)
		const expected = JSON.parse(JSON.stringify(before)) as typeof before
		const others = expected.items as Array<{ id: string; description: string | null }>
		const edited = (after.items as typeof others).find((row) => row.id === w.other.id)!
		expect(edited.description).toBe('edited later')
		const restored = (after.items as Array<{ id: string; updatedAt: string }>).filter(
			(row) => row.id !== w.other.id,
		)
		expect(restored).toEqual(
			(expected.items as Array<{ id: string }>).filter((row) => row.id !== w.other.id),
		)
		// Everything but the edited dish is identical, links included.
		for (const key of Object.keys(before)) {
			if (key === 'items') continue
			expect(after[key]).toEqual(before[key])
		}
	})

	it('hides one dish and moves its category to the other, undo restores all', async () => {
		const w = await seedWorld()
		const before = await menuState(w)
		const card = await detectInput(w, 'merge_duplicates')
		const loseId = card.params.loseId as string
		const keepId = card.params.keepId as string

		const [result] = await apply(w, [card])
		expect(result?.ok).toBe(true)
		if (!result?.ok) return
		expect((await itemRow(loseId))!.availabilityStatus).toBe('hidden')
		const keeperLinks = await db
			.select()
			.from(OrganizationMenuItemCategoryAssignment)
			.where(eq(OrganizationMenuItemCategoryAssignment.itemId, keepId))
		const categories = keeperLinks.map((link) => link.categoryId).sort()
		expect(categories).toEqual([w.c1.id, w.c2.id].sort())
		// The loser keeps its own links: a merge hides, never deletes.
		const loserLinks = await db
			.select()
			.from(OrganizationMenuItemCategoryAssignment)
			.where(eq(OrganizationMenuItemCategoryAssignment.itemId, loseId))
		expect(loserLinks).toHaveLength(1)
		expect(result.undo.touched.some((r) => r.type === 'category')).toBe(true)

		expect(await undo(w, result.undo)).toEqual({ ok: true })
		expect(await menuState(w)).toEqual(before)
	})

	it('inserts a copy that keeps allergens and dietary flags, with its option and links; undo removes it', async () => {
		const w = await seedWorld()
		const before = await menuState(w)
		const card = await detectInput(w, 'make_sizes')
		const [result] = await apply(w, [card])
		expect(result?.ok).toBe(true)
		if (!result?.ok) return

		expect(result.undo.created.map((r) => r.type).sort()).toEqual([
			'item',
			'modifier_group',
			'option',
		])
		const created = result.undo.created.find((r) => r.type === 'item')!
		const copy = (await itemRow(created.id))!
		const source = (await itemRow(w.fries.id))!
		expect(copy.displayName).toBe('{"en":"Fries Large"}')
		expect(copy.price).toBe(14)
		expect(copy.position).toBe(7)
		expect(copy.organizationId).toBe(w.org.id)
		expect(copy.id).not.toBe(source.id)
		expect(copy.createdAt.getTime()).toBe(NOW.getTime())
		expect(copy.updatedAt.getTime()).toBe(NOW.getTime())
		for (const key of [
			'allergens',
			'isVegetarian',
			'isGlutenFree',
			'isAlcohol',
			'calorieMin',
			'calorieMax',
			'applySalesTax',
			'imageUrl',
			'imageKeys',
			'description',
		] as const) {
			expect(copy[key]).toEqual(source[key])
		}
		expect(copy.allergens).toBe('["celery"]')

		// New links point at the new ids.
		const [category] = await db
			.select()
			.from(OrganizationMenuItemCategoryAssignment)
			.where(eq(OrganizationMenuItemCategoryAssignment.itemId, created.id))
		expect(category).toMatchObject({ categoryId: w.c2.id, position: 5 })
		const group = result.undo.created.find((r) => r.type === 'modifier_group')!
		const option = result.undo.created.find((r) => r.type === 'option')!
		const [groupLink] = await db
			.select()
			.from(OrganizationMenuItemModifierGroupAssignment)
			.where(eq(OrganizationMenuItemModifierGroupAssignment.itemId, created.id))
		expect(groupLink!.modifierGroupId).toBe(group.id)
		const [optionLink] = await db
			.select()
			.from(OrganizationMenuModifierGroupOptionAssignment)
			.where(eq(OrganizationMenuModifierGroupOptionAssignment.modifierGroupId, group.id))
		expect(optionLink).toMatchObject({
			optionId: option.id,
			priceOverride: 2,
			isDefault: true,
		})
		// The category is touched (a link end), the copy is not "touched".
		expect(result.undo.touched.map((r) => r.id)).toContain(w.c2.id)
		expect(result.undo.touched.map((r) => r.id)).not.toContain(created.id)
		expect(result.undo.links.length).toBeGreaterThanOrEqual(3)

		expect(await undo(w, result.undo)).toEqual({ ok: true })
		expect(await itemRow(created.id)).toBeUndefined()
		expect(await menuState(w)).toEqual(before)
	})

	it('refuses with stale_suggestion when a ref changed or was deleted after detection', async () => {
		const w = await seedWorld()
		const card = await detectInput(w, 'required_first')
		await bump(OrganizationMenuItem, w.pizza.id, { description: 'changed' })
		expect(await apply(w, [card])).toEqual([{ ok: false, error: 'stale_suggestion' }])
		expect(await snapshotRows(w)).toHaveLength(0)

		const w2 = await seedWorld()
		const card2 = await detectInput(w2, 'required_first')
		await db
			.delete(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.id, w2.optional.id))
		expect(await apply(w2, [card2])).toEqual([{ ok: false, error: 'stale_suggestion' }])
		expect(await snapshotRows(w2)).toHaveLength(0)
	})

	it('refuses with not_applicable when the card is not detected now, whatever the params say', async () => {
		const w = await seedWorld()
		const { graph } = await loadMenuGraph(w.organization)
		const refs = [itemRef(graph, w.other.id)]
		const forged: MenuCardApplyInput = {
			kind: 'required_first',
			id: menuCardId('required_first', w.other.id),
			refs,
			params: { itemId: w.other.id },
		}
		expect(await apply(w, [forged])).toEqual([{ ok: false, error: 'not_applicable' }])

		// Applied once: the card is gone, so a replay is refused (refs are stale too).
		const card = await detectInput(w, 'required_first')
		expect((await apply(w, [card]))[0]?.ok).toBe(true)
		const replay = (await apply(w, [card]))[0]
		expect(replay?.ok).toBe(false)
		// Fresh refs, card gone: not_applicable.
		const { graph: now } = await loadMenuGraph(w.organization)
		const fresh: MenuCardApplyInput = {
			...card,
			refs: [
				itemRef(now, w.pizza.id),
				groupRef(now, w.optional.id),
				groupRef(now, w.required.id),
			],
		}
		expect(await apply(w, [fresh])).toEqual([{ ok: false, error: 'not_applicable' }])
	})

	it('does not let a detected card id carry the params and refs of a different record', async () => {
		const w = await seedWorld()
		const card = await detectInput(w, 'typo')
		expect(card.params.itemId).toBe(w.target.id)
		const { graph } = await loadMenuGraph(w.organization)
		// Same (detected) card id, but params and refs aim at another dish.
		const forged: MenuCardApplyInput = {
			...card,
			refs: [itemRef(graph, w.other.id)],
			params: { itemId: w.other.id },
		}
		const [result] = await apply(w, [forged])
		expect(result?.ok).toBe(false)
		expect((await itemRow(w.other.id))!.availabilityStatus).toBe('available')
	})

	it('refuses a plan that writes outside its refs, or invents ids', async () => {
		const w = await seedWorld()
		const before = await menuState(w)
		for (const optionId of ['outside', 'copy_outside', 'ghost']) {
			const card = await detectInput(w, 'typo', undefined, { optionId })
			expect(await apply(w, [card])).toEqual([{ ok: false, error: 'invalid_plan' }])
		}
		expect(await menuState(w)).toEqual(before)
		expect(await snapshotRows(w)).toHaveLength(0)
	})

	it('never writes safety columns or unknown columns', async () => {
		const w = await seedWorld()
		const before = await menuState(w)
		for (const optionId of ['allergens', 'vegetarian', 'calories', 'unknown_column']) {
			const card = await detectInput(w, 'typo', undefined, { optionId })
			expect(await apply(w, [card])).toEqual([{ ok: false, error: 'invalid_plan' }])
		}
		expect(await menuState(w)).toEqual(before)
	})

	it('refuses to change a POS-owned field but allows hiding the same dish', async () => {
		const w = await seedWorld()
		const [integration] = await db
			.insert(Integration)
			.values({
				organizationId: w.org.id,
				providerName: 'square',
				providerType: 'pos',
				config: '{}',
			})
			.returning()
		await db.insert(OrganizationMenuPosLink).values({
			organizationId: w.org.id,
			integrationId: integration!.id,
			providerName: 'square',
			entityType: 'item',
			remoteId: 'r-target',
			localId: w.target.id,
		})
		const priceCard = await detectInput(w, 'typo', undefined, { optionId: 'price' })
		expect(await apply(w, [priceCard])).toEqual([{ ok: false, error: 'pos_owned' }])
		expect((await itemRow(w.target.id))!.price).toBe(8)

		const hideCard = await detectInput(w, 'typo')
		expect((await apply(w, [hideCard]))[0]?.ok).toBe(true)
		expect((await itemRow(w.target.id))!.availabilityStatus).toBe('hidden')
	})

	it('refuses structure kinds with feature_off when the flag is off', async () => {
		const w = await seedWorld()
		const card = await detectInput(w, 'merge_duplicates')
		expect(await apply(w, [card], { structureEnabled: false })).toEqual([
			{ ok: false, error: 'feature_off' },
		])
		expect(await snapshotRows(w)).toHaveLength(0)
		expect(await itemRow(card.params.loseId as string)).toMatchObject({
			availabilityStatus: 'available',
		})
	})

	it('applies several cards with one snapshot, each with its own result', async () => {
		const w = await seedWorld()
		// A second dish with a required group after an optional one.
		const base = { organizationId: w.org.id, createdAt: OLD, updatedAt: OLD }
		const [pasta] = await db
			.insert(OrganizationMenuItem)
			.values({ ...base, displayName: name('Pasta'), position: 9 })
			.returning()
		const [g3, g4] = await db
			.insert(OrganizationMenuModifierGroup)
			.values([
				{ ...base, name: name('Extras'), minSelections: 0 },
				{ ...base, name: name('Sauce'), minSelections: 1 },
			])
			.returning()
		await db.insert(OrganizationMenuItemModifierGroupAssignment).values([
			{ itemId: pasta!.id, modifierGroupId: g3!.id, position: 0 },
			{ itemId: pasta!.id, modifierGroupId: g4!.id, position: 1 },
		])
		const { drafts } = await detectDrafts(w, 'required_first')
		expect(drafts).toHaveLength(2)
		const before = await menuState(w)

		const results = await apply(w, drafts.map((draft) => input(draft)))
		expect(results.map((r) => r.ok)).toEqual([true, true])
		if (!results[0]?.ok || !results[1]?.ok) return
		const snapshots = await snapshotRows(w)
		expect(snapshots).toHaveLength(1)
		expect(results[0].undo.snapshotId).toBe(snapshots[0]!.id)
		expect(results[1].undo.snapshotId).toBe(snapshots[0]!.id)
		const stored = JSON.parse(snapshotStore.get(snapshots[0]!.contentKey)!) as {
			itemModifierGroupAssignments: Array<{ itemId: string; modifierGroupId: string; position: number }>
		}
		// The snapshot is the menu before the first write.
		expect(
			stored.itemModifierGroupAssignments.find(
				(row) => row.itemId === w.pizza.id && row.modifierGroupId === w.required.id,
			)!.position,
		).toBe(1)

		// Each undo works on its own records.
		expect(await undo(w, results[1].undo)).toEqual({ ok: true })
		expect(await undo(w, results[0].undo)).toEqual({ ok: true })
		expect(await menuState(w)).toEqual(before)
	})

	it('plans the second card against the state the first left (a shared record is stale)', async () => {
		const w = await seedWorld()
		const first = await detectInput(w, 'required_first')
		// Same dish, same refs: once the first card has run, the second is stale.
		const results = await apply(w, [first, { ...first }])
		expect(results[0]?.ok).toBe(true)
		expect(results[1]).toEqual({ ok: false, error: 'stale_suggestion' })
		expect(await snapshotRows(w)).toHaveLength(1)
	})

	it('refuses more than 20 cards at once', async () => {
		const w = await seedWorld()
		const card = await detectInput(w, 'required_first')
		const results = await apply(w, Array.from({ length: 21 }, () => card))
		expect(results).toHaveLength(21)
		expect(results.every((r) => !r.ok && r.error === 'invalid_input')).toBe(true)
		expect(await snapshotRows(w)).toHaveLength(0)
	})

	it('refuses with restore_in_progress while a History restore runs', async () => {
		const w = await seedWorld()
		const card = await detectInput(w, 'required_first')
		await db.insert(ConfigFlag).values({
			key: 'menu.restore_in_progress',
			value: 'true',
			level: 'organization',
			organizationId: w.org.id,
		})
		expect(await apply(w, [card])).toEqual([{ ok: false, error: 'restore_in_progress' }])
		expect(await snapshotRows(w)).toHaveLength(0)
	})

	it('does not touch another organization’s records even if the ids are sent', async () => {
		const w = await seedWorld()
		const stranger = await seedWorld()
		const theirs = await detectInput(stranger, 'required_first')
		const before = await menuState(stranger)
		const results = await apply(w, [theirs])
		expect(results[0]?.ok).toBe(false)
		expect(await menuState(stranger)).toEqual(before)
	})
})

describe('undoMenuCard', () => {
	it('refuses with stale_suggestion when a touched record changed after Accept', async () => {
		const w = await seedWorld()
		const before = await menuState(w)
		const undoData = await okUndo(w, await detectInput(w, 'required_first'))
		await bump(OrganizationMenuItem, w.pizza.id, { description: 'edited after' })
		expect(await undo(w, undoData)).toEqual({ ok: false, error: 'stale_suggestion' })
		expect(await menuState(w)).not.toEqual(before)
		expect((await itemRow(w.pizza.id))!.description).toBe('edited after')
	})

	it('refuses with stale_suggestion when a created record changed or is gone', async () => {
		const w = await seedWorld()
		const undoData = await okUndo(w, await detectInput(w, 'make_sizes'))
		const created = undoData.created.find((r) => r.type === 'item')!
		await bump(OrganizationMenuItem, created.id, { price: 99 })
		expect(await undo(w, undoData)).toEqual({ ok: false, error: 'stale_suggestion' })

		const w2 = await seedWorld()
		const undo2 = await okUndo(w2, await detectInput(w2, 'make_sizes'))
		const created2 = undo2.created.find((r) => r.type === 'item')!
		await db.delete(OrganizationMenuItem).where(eq(OrganizationMenuItem.id, created2.id))
		expect(await undo(w2, undo2)).toEqual({ ok: false, error: 'stale_suggestion' })
	})

	it('refuses with snapshot_gone for an unknown snapshot, another organization’s snapshot, or another reason', async () => {
		const w = await seedWorld()
		const undoData = await okUndo(w, await detectInput(w, 'required_first'))
		// A body this server did not sign is refused before any lookup.
		expect(await undo(w, { ...undoData, snapshotId: 'nope' })).toEqual({
			ok: false,
			error: 'invalid_input',
		})
		const { signature: _signature, ...manifest } = undoData
		const unknown = { ...manifest, snapshotId: 'nope' }
		expect(
			await undo(w, {
				...unknown,
				signature: signMenuCardUndo(w.org.id, unknown),
			}),
		).toEqual({ ok: false, error: 'snapshot_gone' })
		// Signed for one organization: refused for another.
		const stranger = await seedWorld()
		expect(await undo(stranger, undoData)).toEqual({ ok: false, error: 'invalid_input' })
		expect(
			await undo(stranger, {
				...manifest,
				signature: signMenuCardUndo(stranger.org.id, manifest),
			}),
		).toEqual({ ok: false, error: 'snapshot_gone' })

		// A manual snapshot of this organization is not an Undo snapshot.
		await db
			.update(MenuSnapshot)
			.set({ reason: 'manual' })
			.where(eq(MenuSnapshot.id, undoData.snapshotId))
		expect(await undo(w, undoData)).toEqual({ ok: false, error: 'snapshot_gone' })
	})

	it('refuses with snapshot_gone when the stored content was pruned', async () => {
		const w = await seedWorld()
		const undoData = await okUndo(w, await detectInput(w, 'required_first'))
		snapshotStore.clear()
		const result = await undo(w, undoData)
		expect(result).toEqual({ ok: false, error: 'snapshot_gone' })
	})

	it('refuses with restore_in_progress while a History restore runs', async () => {
		const w = await seedWorld()
		const undoData = await okUndo(w, await detectInput(w, 'required_first'))
		await db.insert(ConfigFlag).values({
			key: 'menu.restore_in_progress',
			value: 'true',
			level: 'organization',
			organizationId: w.org.id,
		})
		expect(await undo(w, undoData)).toEqual({ ok: false, error: 'restore_in_progress' })
	})

	it('does not overwrite a record Accept never touched, even if the Undo body names it', async () => {
		const w = await seedWorld()
		const undoData = await okUndo(w, await detectInput(w, 'required_first'))
		await bump(OrganizationMenuItem, w.other.id, { price: 77 })
		const { graph: latest } = await loadMenuGraph(w.organization)
		const forged: MenuCardUndo = {
			...undoData,
			touched: [
				...undoData.touched,
				{ type: 'item', id: w.other.id, updatedAt: itemRef(latest, w.other.id).updatedAt },
			],
		}
		await undo(w, forged)
		expect((await itemRow(w.other.id))!.price).toBe(77)
	})
})

describe('validateCardPlan', () => {
	const graph = makeMenuGraph({
		menus: [{ id: 'm' }],
		categories: [{ id: 'c' }],
		items: [{ id: 'a' }, { id: 'b' }, { id: 'posd' }],
		groups: [{ id: 'g' }],
		options: [{ id: 'o' }],
		posLinks: [{ entityType: 'item', localId: 'posd' }],
	})
	const refs = [
		{ type: 'item' as const, id: 'a' },
		{ type: 'category' as const, id: 'c' },
		{ type: 'item' as const, id: 'posd' },
		{ type: 'item' as const, id: 'gone' },
	]
	const update = (set: Record<string, unknown>, id = 'a'): MenuCardOp =>
		({ op: 'update', entity: 'item', id, set }) as MenuCardOp

	it('accepts a plan inside its refs', () => {
		expect(
			validateCardPlan(graph, refs, [
				update({ availabilityStatus: 'hidden' }),
				{ op: 'assign', link: 'item_category', parentId: 'c', childId: 'a', position: 1 },
			]),
		).toBeNull()
	})

	it('refuses every safety column, unknown columns and writes outside refs', () => {
		for (const column of [
			'allergens',
			'isGlutenFree',
			'isVegetarian',
			'isAlcohol',
			'calorieMin',
			'calorieMax',
			'calories',
		]) {
			expect(validateCardPlan(graph, refs, [update({ [column]: 1 })])).toBe('invalid_plan')
		}
		expect(validateCardPlan(graph, refs, [update({ internalName: 'x' })])).toBe('invalid_plan')
		expect(validateCardPlan(graph, refs, [update({ price: -1 })])).toBe('invalid_plan')
		expect(validateCardPlan(graph, refs, [update({ position: 1 }, 'b')])).toBe('invalid_plan')
		expect(
			validateCardPlan(graph, refs, [
				{ op: 'unassign', link: 'item_category', parentId: 'c', childId: 'b' },
			]),
		).toBe('invalid_plan')
		expect(
			validateCardPlan(graph, refs, [
				{ op: 'insert', entity: 'item', tempId: 't', copyFrom: 'b', values: { displayName: 'x' } },
			]),
		).toBe('invalid_plan')
	})

	it('refuses a ref that is gone, forward or duplicate new: ids, and updating a new record', () => {
		expect(validateCardPlan(graph, refs, [update({ position: 1 }, 'gone')])).toBe(
			'stale_suggestion',
		)
		expect(
			validateCardPlan(graph, refs, [
				{ op: 'assign', link: 'item_category', parentId: 'c', childId: 'new:t' },
			]),
		).toBe('invalid_plan')
		const insert: MenuCardOp = {
			op: 'insert',
			entity: 'category',
			tempId: 't',
			values: { displayName: 'x' },
		}
		expect(validateCardPlan(graph, refs, [insert, insert])).toBe('invalid_plan')
		expect(
			validateCardPlan(graph, refs, [
				insert,
				{ op: 'update', entity: 'category', id: 'new:t', set: { position: 1 } },
			]),
		).toBe('invalid_plan')
		expect(
			validateCardPlan(graph, refs, [
				insert,
				{ op: 'assign', link: 'menu_category', parentId: 'm', childId: 'new:t' },
			]),
		).toBe('invalid_plan') // menu 'm' is not in refs
	})

	it('refuses POS-owned fields and links, allows availability and position', () => {
		expect(validateCardPlan(graph, refs, [update({ price: 5 }, 'posd')])).toBe('pos_owned')
		expect(validateCardPlan(graph, refs, [update({ displayName: 'x' }, 'posd')])).toBe('pos_owned')
		expect(
			validateCardPlan(graph, refs, [update({ availabilityStatus: 'hidden', position: 2 }, 'posd')]),
		).toBeNull()
		const withGroup = [...refs, { type: 'modifier_group' as const, id: 'g' }]
		expect(
			validateCardPlan(graph, withGroup, [
				{ op: 'assign', link: 'item_modifier_group', parentId: 'posd', childId: 'g' },
			]),
		).toBe('pos_owned')
	})
})
