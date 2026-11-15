import { MenuVariationsSchema } from '@repo/common/menu-types'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => true),
}))

import { type MenuCardContext, type MenuCardDraft } from './menu-card-kinds.ts'
import { validateCardPlan } from './menu-card-plans.server.ts'
import {
	DEFAULT_MENU_CARD_SETTINGS,
	MENU_CARD_SAFETY_COLUMNS,
	type MenuCardOp,
	type MenuStructureCardKind,
} from './menu-cards.ts'
import { makeMenuGraph, type MenuGraph } from './menu-graph.ts'
import { STRUCTURE_CARD_KINDS_IMPL } from './structure-suggestions.ts'

const ctx: MenuCardContext = {
	defaultLocale: 'en',
	locales: ['en'],
	settings: DEFAULT_MENU_CARD_SETTINGS,
	now: new Date('2026-11-14T00:00:00.000Z'),
}

function detect(kind: MenuStructureCardKind, graph: MenuGraph) {
	return STRUCTURE_CARD_KINDS_IMPL[kind].detect(graph, ctx)
}

function plan(
	kind: MenuStructureCardKind,
	graph: MenuGraph,
	request: {
		params: Record<string, unknown>
		optionId?: string
		input?: string
	},
) {
	return STRUCTURE_CARD_KINDS_IMPL[kind].plan(
		graph,
		{ id: 'x', ...request },
		ctx,
	)
}

/** Detects one card, plans its default, validates it and returns the ops. */
function acceptDefault(
	kind: MenuStructureCardKind,
	graph: MenuGraph,
	input?: string,
): { draft: MenuCardDraft; ops: MenuCardOp[] } {
	const drafts = detect(kind, graph)
	expect(drafts).toHaveLength(1)
	const draft = drafts[0]!
	expect(draft.kind).toBe(kind)
	expect(draft.preview.before.length).toBeGreaterThan(0)
	expect(draft.preview.after.length).toBeGreaterThan(0)
	expect(draft.id.length).toBeLessThanOrEqual(120)
	const result = plan(kind, graph, {
		params: draft.params,
		optionId: draft.defaultOptionId,
		input,
	})
	if (!result.ok) throw new Error(`plan refused: ${result.error}`)
	expect(validateCardPlan(graph, draft.refs, result.ops)).toBeNull()
	noSafetyColumns(result.ops)
	return { draft, ops: result.ops }
}

function noSafetyColumns(ops: readonly MenuCardOp[]) {
	for (const op of ops) {
		for (const part of [
			op,
			'set' in op ? op.set : {},
			'values' in op ? op.values : {},
		]) {
			for (const column of MENU_CARD_SAFETY_COLUMNS) {
				expect(Object.keys(part)).not.toContain(column)
			}
		}
	}
}

const refIds = (draft: MenuCardDraft) =>
	draft.refs.map((ref) => `${ref.type}:${ref.id}`)

describe('merge_duplicates', () => {
	const graph = () =>
		makeMenuGraph({
			categories: [{ id: 'c1' }, { id: 'c2' }],
			groups: [{ id: 'g1' }],
			items: [
				{ id: 'a', displayName: 'Margherita', price: 10 },
				{ id: 'b', displayName: ' margherita! ', price: 12, imageUrl: 'x.jpg' },
				{ id: 'other', displayName: 'Pepperoni' },
			],
			itemCategories: [
				{ categoryId: 'c1', itemId: 'a' },
				{ categoryId: 'c2', itemId: 'a' },
				{ categoryId: 'c1', itemId: 'b' },
			],
			itemGroups: [{ itemId: 'a', modifierGroupId: 'g1' }],
		})

	it('keeps the dish with a photo and moves what the loser has', () => {
		const g = graph()
		const { draft, ops } = acceptDefault('merge_duplicates', g)
		expect(draft.primary).toEqual({ type: 'item', id: 'b' })
		expect(draft.defaultOptionId).toBe('keep:b')
		expect(draft.options?.map((option) => option.id).sort()).toEqual([
			'keep:a',
			'keep:b',
		])
		expect(draft.warnings).toEqual(['prices_differ'])
		expect(ops).toContainEqual({
			op: 'update',
			entity: 'item',
			id: 'a',
			set: { availabilityStatus: 'hidden' },
		})
		expect(ops).toContainEqual(
			expect.objectContaining({
				op: 'assign',
				link: 'item_category',
				parentId: 'c2',
				childId: 'b',
			}),
		)
		expect(ops).toContainEqual(
			expect.objectContaining({
				op: 'assign',
				link: 'item_modifier_group',
				parentId: 'b',
				childId: 'g1',
			}),
		)
		// c1 is already on the kept dish.
		expect(
			ops.some(
				(op) => op.op === 'assign' && 'parentId' in op && op.parentId === 'c1',
			),
		).toBe(false)
		expect(refIds(draft)).toEqual(
			expect.arrayContaining([
				'item:a',
				'item:b',
				'category:c2',
				'modifier_group:g1',
			]),
		)
	})

	it('lets the option override the keep', () => {
		const g = graph()
		const result = plan('merge_duplicates', g, {
			params: { itemIds: ['a', 'b'], keepId: 'b' },
			optionId: 'keep:a',
		})
		expect(result.ok && result.ops[0]).toMatchObject({ id: 'b' })
	})

	it('refuses a keep outside the group and too few dishes', () => {
		const g = graph()
		expect(
			plan('merge_duplicates', g, {
				params: { itemIds: ['a', 'b'], keepId: 'other' },
			}),
		).toEqual({ ok: false, error: 'invalid_keep' })
		expect(
			plan('merge_duplicates', g, {
				params: { itemIds: ['a', 'b'] },
				optionId: 'keep:other',
			}),
		).toEqual({ ok: false, error: 'invalid_keep' })
		expect(
			plan('merge_duplicates', g, {
				params: { itemIds: ['a', 'nope'], keepId: 'a' },
			}),
		).toEqual({ ok: false, error: 'too_few_records' })
	})

	it('finds nothing for hidden, different or single dishes', () => {
		expect(
			detect(
				'merge_duplicates',
				makeMenuGraph({
					items: [
						{ id: 'a', displayName: 'Soup' },
						{ id: 'b', displayName: 'Soup', availabilityStatus: 'hidden' },
					],
				}),
			),
		).toEqual([])
		expect(
			detect(
				'merge_duplicates',
				makeMenuGraph({
					items: [
						{ id: 'a', displayName: 'Soup' },
						{ id: 'b', displayName: 'Salad' },
					],
				}),
			),
		).toEqual([])
	})

	it('skips a POS dish that would gain option groups', () => {
		const g = makeMenuGraph({
			groups: [{ id: 'g1' }],
			items: [
				{ id: 'a', displayName: 'Soup', imageUrl: 'p.jpg' },
				{ id: 'b', displayName: 'Soup' },
			],
			itemGroups: [{ itemId: 'b', modifierGroupId: 'g1' }],
			posLinks: [{ entityType: 'item', localId: 'a' }],
		})
		expect(detect('merge_duplicates', g)).toEqual([])
	})
})

describe('make_sizes', () => {
	const graph = (extra: Parameters<typeof makeMenuGraph>[0] = {}) =>
		makeMenuGraph({
			categories: [{ id: 'coffee' }],
			groups: [{ id: 'milk' }],
			items: [
				{ id: 'large', displayName: 'Large Latte', price: 6 },
				{ id: 'small', displayName: 'Small Latte', price: 4 },
				{ id: 'tea', displayName: 'Tea' },
			],
			itemCategories: [
				{ categoryId: 'coffee', itemId: 'large', position: 3 },
				{ categoryId: 'coffee', itemId: 'small', position: 1 },
			],
			itemGroups: [
				{ itemId: 'large', modifierGroupId: 'milk' },
				{ itemId: 'small', modifierGroupId: 'milk' },
			],
			...extra,
		})

	it('Small Latte and Large Latte make one card with two sizes', () => {
		const g = graph()
		const { draft, ops } = acceptDefault('make_sizes', g)
		expect(draft.subject).toBe('Latte')
		expect(draft.params.itemIds).toEqual(['small', 'large'])
		const insert = ops.find((op) => op.op === 'insert')
		expect(insert).toMatchObject({
			entity: 'item',
			copyFrom: 'small',
			values: { price: 4 },
		})
		if (!insert || insert.op !== 'insert' || insert.entity !== 'item')
			throw new Error('no insert')
		expect(JSON.parse(insert.values.displayName)).toEqual({ en: 'Latte' })
		const variations = MenuVariationsSchema.parse(
			JSON.parse(insert.values.variations!),
		)
		expect(variations.groups[0]).toMatchObject({ name: 'Size' })
		expect(variations.groups[0]!.values.map((value) => value.name)).toEqual([
			'Small',
			'Large',
		])
		expect(variations.variants.map((variant) => variant.price)).toEqual([4, 6])
		for (const id of ['small', 'large']) {
			expect(ops).toContainEqual({
				op: 'update',
				entity: 'item',
				id,
				set: { availabilityStatus: 'hidden' },
			})
		}
		// The first original's position in the category, and its group.
		expect(ops).toContainEqual({
			op: 'assign',
			link: 'item_category',
			parentId: 'coffee',
			childId: 'new:merged',
			position: 1,
		})
		expect(ops).toContainEqual(
			expect.objectContaining({
				link: 'item_modifier_group',
				parentId: 'new:merged',
				childId: 'milk',
			}),
		)
		expect(refIds(draft)).toEqual(
			expect.arrayContaining([
				'item:small',
				'item:large',
				'category:coffee',
				'modifier_group:milk',
			]),
		)
	})

	it('knows Arabic, numbers and trailing size words', () => {
		const arabic = makeMenuGraph({
			defaultLocale: 'ar',
			locales: ['ar'],
			items: [
				{ id: 'a', displayName: 'لاتيه صغير' },
				{ id: 'b', displayName: 'لاتيه كبير' },
			],
		})
		const drafts = STRUCTURE_CARD_KINDS_IMPL.make_sizes.detect(arabic, {
			...ctx,
			defaultLocale: 'ar',
		})
		expect(drafts).toHaveLength(1)
		const result = STRUCTURE_CARD_KINDS_IMPL.make_sizes.plan(
			arabic,
			{ id: 'x', params: drafts[0]!.params },
			ctx,
		)
		const insert = result.ok ? result.ops[0] : null
		expect(insert).toMatchObject({ op: 'insert' })
		if (insert?.op === 'insert' && insert.entity === 'item') {
			expect(
				MenuVariationsSchema.parse(JSON.parse(insert.values.variations!))
					.groups[0]!.name,
			).toBe('الحجم')
		}
		const numbers = makeMenuGraph({
			items: [
				{ id: 'a', displayName: 'Pizza 12"', price: 12 },
				{ id: 'b', displayName: 'Pizza 8 inch', price: 8 },
				{ id: 'c', displayName: 'Pizza 16 inch', price: 16 },
			],
		})
		const card = acceptDefault('make_sizes', numbers)
		expect(card.draft.params.itemIds).toEqual(['b', 'a', 'c'])
	})

	it('finds nothing for a hidden size, same sizes, or existing sizes', () => {
		expect(
			detect(
				'make_sizes',
				makeMenuGraph({
					items: [
						{ id: 'a', displayName: 'Small Latte' },
						{
							id: 'b',
							displayName: 'Large Latte',
							availabilityStatus: 'hidden',
						},
					],
				}),
			),
		).toEqual([])
		expect(
			detect(
				'make_sizes',
				makeMenuGraph({
					items: [
						{ id: 'a', displayName: 'Large Latte' },
						{ id: 'b', displayName: 'Large latte' },
					],
				}),
			),
		).toEqual([])
		const variations = JSON.stringify({
			groups: [{ id: 'g', name: 'Milk', values: [{ id: 'v', name: 'Oat' }] }],
			variants: [{ id: 'x', valueIds: ['v'], price: 1 }],
		})
		expect(
			detect(
				'make_sizes',
				makeMenuGraph({
					items: [
						{ id: 'a', displayName: 'Small Latte', variations },
						{ id: 'b', displayName: 'Large Latte' },
					],
				}),
			),
		).toEqual([])
		expect(
			detect(
				'make_sizes',
				makeMenuGraph({ items: [{ id: 'a', displayName: 'Large Latte' }] }),
			),
		).toEqual([])
	})

	it('needs the same option groups on every size', () => {
		const g = graph({
			itemGroups: [{ itemId: 'large', modifierGroupId: 'milk' }],
		})
		expect(detect('make_sizes', g)).toEqual([])
		expect(
			plan('make_sizes', g, { params: { itemIds: ['small', 'large'] } }),
		).toEqual({ ok: false, error: 'groups_differ' })
		expect(
			plan('make_sizes', g, { params: { itemIds: ['small', 'tea'] } }),
		).toEqual({ ok: false, error: 'not_applicable' })
		expect(plan('make_sizes', g, { params: { itemIds: ['small'] } })).toEqual({
			ok: false,
			error: 'too_few_records',
		})
	})

	it('takes an AI name and labels only when clean and complete', () => {
		const g = graph()
		const draft = detect('make_sizes', g)[0]!
		const ai = STRUCTURE_CARD_KINDS_IMPL.make_sizes.ai!
		const applied = ai.apply(draft, {
			name: '<b>Caffe Latte</b>',
			sizeLabels: ['Regular', '12 oz'],
		})!
		expect(applied.params).toMatchObject({
			name: 'Caffe Latte',
			sizeLabels: ['Regular', '12 oz'],
		})
		const result = plan('make_sizes', g, { params: applied.params })
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(validateCardPlan(g, applied.refs, result.ops)).toBeNull()
			expect(JSON.stringify(result.ops)).toContain('Caffe Latte')
		}
		const wrongCount = ai.apply(draft, { sizeLabels: ['Only one'] })!
		expect(wrongCount.params).toEqual(draft.params)
		expect(ai.required).toBeFalsy()
	})
})

describe('merge_categories', () => {
	const graph = (extra: Parameters<typeof makeMenuGraph>[0] = {}) =>
		makeMenuGraph({
			menus: [{ id: 'm' }],
			categories: [
				{ id: 'c1', displayName: 'Dessert' },
				{ id: 'c2', displayName: 'Desserts' },
				{ id: 'c3', displayName: 'Drinks' },
			],
			items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
			itemCategories: [
				{ categoryId: 'c2', itemId: 'd' },
				{ categoryId: 'c1', itemId: 'a' },
				{ categoryId: 'c2', itemId: 'b' },
				{ categoryId: 'c2', itemId: 'c' },
				{ categoryId: 'c1', itemId: 'c' },
			],
			...extra,
		})

	it('merges a plural into the larger category and hides it', () => {
		const g = graph()
		const { draft, ops } = acceptDefault('merge_categories', g)
		expect(draft.primary.id).toBe('c2')
		expect(ops).toContainEqual(
			expect.objectContaining({
				op: 'assign',
				link: 'item_category',
				parentId: 'c2',
				childId: 'a',
			}),
		)
		expect(ops).toContainEqual({
			op: 'update',
			entity: 'category',
			id: 'c1',
			set: { availabilityStatus: 'hidden' },
		})
		expect(refIds(draft)).toEqual(
			expect.arrayContaining(['category:c1', 'category:c2', 'item:a']),
		)
	})

	it('merges a small category named inside another', () => {
		const g = makeMenuGraph({
			categories: [
				{ id: 'c1', displayName: 'Pizza' },
				{ id: 'c2', displayName: 'Pizza and Pasta' },
			],
			items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
			itemCategories: [
				{ categoryId: 'c1', itemId: 'a' },
				{ categoryId: 'c2', itemId: 'b' },
				{ categoryId: 'c2', itemId: 'c' },
				{ categoryId: 'c2', itemId: 'd' },
			],
		})
		const { draft } = acceptDefault('merge_categories', g)
		expect(draft.primary.id).toBe('c2')
	})

	it('finds nothing for hidden, unrelated or nested categories', () => {
		expect(
			detect(
				'merge_categories',
				graph({
					categories: [
						{ id: 'c1', displayName: 'Dessert' },
						{ id: 'c2', displayName: 'Desserts', availabilityStatus: 'hidden' },
					],
				}),
			),
		).toEqual([])
		expect(
			detect(
				'merge_categories',
				makeMenuGraph({
					categories: [
						{ id: 'c1', displayName: 'Starters' },
						{ id: 'c2', displayName: 'Mains' },
					],
				}),
			),
		).toEqual([])
		expect(
			detect(
				'merge_categories',
				makeMenuGraph({
					categories: [
						{ id: 'c1', displayName: 'Dessert' },
						{ id: 'c2', displayName: 'Desserts', parentId: 'c1' },
					],
				}),
			),
		).toEqual([])
	})

	it('refuses a bad keep and too few categories', () => {
		const g = graph()
		expect(
			plan('merge_categories', g, {
				params: { categoryIds: ['c1', 'c2'], keepId: 'c3' },
			}),
		).toEqual({ ok: false, error: 'invalid_keep' })
		expect(
			plan('merge_categories', g, {
				params: { categoryIds: ['c1'], keepId: 'c1' },
			}),
		).toEqual({ ok: false, error: 'too_few_records' })
	})
})

describe('split_add_remove', () => {
	const graph = (extra: Parameters<typeof makeMenuGraph>[0] = {}) =>
		makeMenuGraph({
			groups: [{ id: 'mods', name: 'Customize' }],
			options: [
				{ id: 'onions', displayName: 'No onions' },
				{ id: 'bacon', displayName: 'Add bacon', price: 2 },
				{ id: 'plain', displayName: 'Toasted' },
			],
			items: [{ id: 'd1' }, { id: 'd2' }],
			groupOptions: [
				{
					modifierGroupId: 'mods',
					optionId: 'onions',
					priceOverride: 0,
					isDefault: true,
				},
				{ modifierGroupId: 'mods', optionId: 'bacon' },
				{ modifierGroupId: 'mods', optionId: 'plain' },
			],
			itemGroups: [
				{ itemId: 'd1', modifierGroupId: 'mods', position: 2 },
				{ itemId: 'd2', modifierGroupId: 'mods', position: 0 },
			],
			...extra,
		})

	it('No onions + Add bacon makes two groups on the same dishes', () => {
		const g = graph()
		const { draft, ops } = acceptDefault('split_add_remove', g)
		expect(draft.primary.id).toBe('mods')
		expect(ops[0]).toMatchObject({
			op: 'insert',
			entity: 'modifier_group',
			tempId: 'remove',
			values: {
				selectionType: 'multiple',
				minSelections: 0,
				maxSelections: null,
			},
		})
		expect(ops).toContainEqual({
			op: 'unassign',
			link: 'group_option',
			parentId: 'mods',
			childId: 'onions',
		})
		expect(ops).toContainEqual(
			expect.objectContaining({
				op: 'assign',
				link: 'group_option',
				parentId: 'new:remove',
				childId: 'onions',
				priceOverride: 0,
				isDefault: true,
			}),
		)
		expect(
			ops.filter((op) => op.op === 'unassign' && op.childId === 'bacon'),
		).toEqual([])
		expect(ops).toContainEqual({
			op: 'assign',
			link: 'item_modifier_group',
			parentId: 'd1',
			childId: 'new:remove',
			position: 3,
		})
		expect(ops).toContainEqual({
			op: 'assign',
			link: 'item_modifier_group',
			parentId: 'd2',
			childId: 'new:remove',
			position: 1,
		})
		expect(refIds(draft)).toEqual(
			expect.arrayContaining([
				'modifier_group:mods',
				'option:onions',
				'item:d1',
				'item:d2',
			]),
		)
	})

	it('knows Arabic wording', () => {
		const g = makeMenuGraph({
			groups: [{ id: 'g' }],
			options: [
				{ id: 'o1', displayName: 'بدون بصل' },
				{ id: 'o2', displayName: 'إضافة جبنة' },
			],
			items: [{ id: 'd' }],
			groupOptions: [
				{ modifierGroupId: 'g', optionId: 'o1' },
				{ modifierGroupId: 'g', optionId: 'o2' },
			],
			itemGroups: [{ itemId: 'd', modifierGroupId: 'g' }],
		})
		expect(detect('split_add_remove', g)).toHaveLength(1)
	})

	it('finds nothing for one-sided, required, hidden or POS groups', () => {
		expect(
			detect(
				'split_add_remove',
				graph({
					options: [
						{ id: 'onions', displayName: 'No onions' },
						{ id: 'bacon', displayName: 'Bacon' },
						{ id: 'plain', displayName: 'Toasted' },
					],
				}),
			),
		).toEqual([])
		expect(
			detect(
				'split_add_remove',
				graph({ groups: [{ id: 'mods', minSelections: 1 }] }),
			),
		).toEqual([])
		expect(
			detect(
				'split_add_remove',
				graph({ groups: [{ id: 'mods', availabilityStatus: 'hidden' }] }),
			),
		).toEqual([])
		expect(
			detect(
				'split_add_remove',
				graph({
					posLinks: [{ entityType: 'modifier_group', localId: 'mods' }],
				}),
			),
		).toEqual([])
	})

	it('refuses an option that is both', () => {
		const g = graph({
			options: [
				{ id: 'onions', displayName: 'No onions, add pickles' },
				{ id: 'bacon', displayName: 'Add bacon' },
				{ id: 'plain', displayName: 'Toasted' },
			],
		})
		expect(detect('split_add_remove', g)).toEqual([])
		expect(
			plan('split_add_remove', g, { params: { groupId: 'mods' } }),
		).toEqual({ ok: false, error: 'option_in_both' })
		expect(
			plan('split_add_remove', g, { params: { groupId: 'nope' } }),
		).toEqual({ ok: false, error: 'not_applicable' })
	})
})

describe('make_required', () => {
	const graph = (extra: Parameters<typeof makeMenuGraph>[0] = {}) =>
		makeMenuGraph({
			groups: [{ id: 'g', name: 'Choose your sauce' }],
			options: [
				{ id: 'o1', displayName: 'Garlic' },
				{ id: 'o2', displayName: 'Chili' },
			],
			groupOptions: [
				{ modifierGroupId: 'g', optionId: 'o1' },
				{ modifierGroupId: 'g', optionId: 'o2' },
			],
			...extra,
		})

	it('makes a must-pick single group required', () => {
		const { draft, ops } = acceptDefault('make_required', graph())
		expect(ops).toEqual([
			{
				op: 'update',
				entity: 'modifier_group',
				id: 'g',
				set: { minSelections: 1 },
			},
		])
		expect(refIds(draft)).toEqual(['modifier_group:g'])
	})

	it('finds nothing for a none option, multiple, required, other names, one option or POS', () => {
		expect(
			detect(
				'make_required',
				graph({
					options: [
						{ id: 'o1', displayName: 'Garlic' },
						{ id: 'o2', displayName: 'No sauce' },
					],
				}),
			),
		).toEqual([])
		expect(
			detect(
				'make_required',
				graph({
					groups: [{ id: 'g', name: 'Sauce', selectionType: 'multiple' }],
				}),
			),
		).toEqual([])
		expect(
			detect(
				'make_required',
				graph({ groups: [{ id: 'g', name: 'Sauce', minSelections: 1 }] }),
			),
		).toEqual([])
		expect(
			detect(
				'make_required',
				graph({ groups: [{ id: 'g', name: 'Garnish' }] }),
			),
		).toEqual([])
		expect(
			detect(
				'make_required',
				graph({ groups: [{ id: 'g', name: 'Extra sauce' }] }),
			),
		).toEqual([])
		expect(
			detect(
				'make_required',
				graph({
					groups: [{ id: 'g', name: 'Sauce', availabilityStatus: 'hidden' }],
				}),
			),
		).toEqual([])
		expect(
			detect(
				'make_required',
				graph({ groupOptions: [{ modifierGroupId: 'g', optionId: 'o1' }] }),
			),
		).toEqual([])
		expect(
			detect(
				'make_required',
				graph({ posLinks: [{ entityType: 'modifier_group', localId: 'g' }] }),
			),
		).toEqual([])
	})
})

describe('half_whole_toppings', () => {
	const graph = (extra: Parameters<typeof makeMenuGraph>[0] = {}) =>
		makeMenuGraph({
			categories: [{ id: 'c', displayName: 'Mains' }],
			items: [{ id: 'd', displayName: 'Pizza Margherita' }],
			groups: [{ id: 'g', name: 'Toppings', selectionType: 'multiple' }],
			options: [
				{ id: 'o1', displayName: 'Olives', price: 3 },
				{ id: 'o2', displayName: 'Ham', price: 2.5 },
				{
					id: 'o3',
					displayName: 'Mushroom',
					price: 2,
					priceWhole: 2,
					priceLeft: 1,
					priceRight: 1,
				},
			],
			itemCategories: [{ categoryId: 'c', itemId: 'd' }],
			itemGroups: [{ itemId: 'd', modifierGroupId: 'g' }],
			groupOptions: [
				{ modifierGroupId: 'g', optionId: 'o1' },
				{ modifierGroupId: 'g', optionId: 'o2' },
				{ modifierGroupId: 'g', optionId: 'o3' },
			],
			...extra,
		})

	it('turns a pizza toppings group into half and whole', () => {
		const { draft, ops } = acceptDefault('half_whole_toppings', graph())
		expect(ops[0]).toEqual({
			op: 'update',
			entity: 'modifier_group',
			id: 'g',
			set: { selectionType: 'pizza' },
		})
		expect(ops).toContainEqual({
			op: 'update',
			entity: 'option',
			id: 'o2',
			set: { priceWhole: 2.5, priceLeft: 1.25, priceRight: 1.25 },
		})
		// Already priced: left alone.
		expect(
			ops.some((op) => op.op === 'update' && 'id' in op && op.id === 'o3'),
		).toBe(false)
		expect(draft.preview.after[0]!.rows[0]).toMatchObject({ detail: '3/1.5' })
		expect(refIds(draft)).toEqual(
			expect.arrayContaining(['modifier_group:g', 'option:o1', 'option:o2']),
		)
	})

	it('matches by pizza category and by topping options', () => {
		const g = graph({
			items: [{ id: 'd', displayName: 'Margherita' }],
			categories: [{ id: 'c', displayName: 'Pizzas' }],
			groups: [{ id: 'g', name: 'Choose', selectionType: 'multiple' }],
			options: [
				{ id: 'o1', displayName: 'Olives', isTopping: true },
				{ id: 'o2', displayName: 'Ham', isTopping: true },
				{ id: 'o3', displayName: 'Plain' },
			],
		})
		expect(detect('half_whole_toppings', g)).toHaveLength(1)
	})

	it('finds nothing off pizza, for single groups, hidden groups or POS options', () => {
		expect(
			detect(
				'half_whole_toppings',
				graph({ items: [{ id: 'd', displayName: 'Burger' }] }),
			),
		).toEqual([])
		expect(
			detect(
				'half_whole_toppings',
				graph({
					groups: [{ id: 'g', name: 'Toppings', selectionType: 'single' }],
				}),
			),
		).toEqual([])
		expect(
			detect(
				'half_whole_toppings',
				graph({
					groups: [
						{
							id: 'g',
							name: 'Toppings',
							selectionType: 'multiple',
							availabilityStatus: 'hidden',
						},
					],
				}),
			),
		).toEqual([])
		expect(
			detect(
				'half_whole_toppings',
				graph({ posLinks: [{ entityType: 'modifier_option', localId: 'o1' }] }),
			),
		).toEqual([])
		expect(
			detect(
				'half_whole_toppings',
				graph({
					groups: [{ id: 'g', name: 'Sides', selectionType: 'multiple' }],
				}),
			),
		).toEqual([])
	})
})

describe('check_price', () => {
	const prices = [10, 11, 12, 13, 14]
	const graph = (extra: Parameters<typeof makeMenuGraph>[0] = {}) =>
		makeMenuGraph({
			categories: [{ id: 'c' }],
			items: [
				...prices.map((price, i) => ({ id: `d${i}`, price })),
				{ id: 'odd', displayName: 'Odd', price: 1200 },
			],
			itemCategories: [
				...prices.map((_, i) => ({ categoryId: 'c', itemId: `d${i}` })),
				{ categoryId: 'c', itemId: 'odd' },
			],
			...extra,
		})

	it('flags a dish far from its category median', () => {
		const g = graph()
		const drafts = detect('check_price', g)
		expect(drafts).toHaveLength(1)
		const draft = drafts[0]!
		expect(draft.primary.id).toBe('odd')
		expect(draft.params).toMatchObject({ case: 'category', itemId: 'odd' })
		expect(draft.defaultOptionId).toBe('set_price')
		expect(draft.options).toEqual([
			{ id: 'set_price', code: 'set_price', input: 'price' },
		])
		expect(
			plan('check_price', g, { params: draft.params, optionId: 'set_price' }),
		).toEqual({
			ok: false,
			error: 'invalid_input',
		})
		const result = acceptDefault('check_price', g, '12.50')
		expect(result.ops).toEqual([
			{ op: 'update', entity: 'item', id: 'odd', set: { price: 12.5 } },
		])
	})

	it('rejects bad input', () => {
		const g = graph()
		for (const input of ['', 'abc', '-1', '1.234', '1e3', 'NaN', '1,5']) {
			expect(
				plan('check_price', g, {
					params: { case: 'category', itemId: 'odd' },
					input,
				}),
			).toEqual({ ok: false, error: 'invalid_input' })
		}
		expect(
			plan('check_price', g, {
				params: { case: 'category', itemId: 'd1' },
				input: '5',
			}),
		).toEqual({ ok: false, error: 'not_applicable' })
	})

	it('flags a larger size priced below a smaller one and rewrites that variant', () => {
		const variations = {
			groups: [
				{
					id: 'g',
					name: 'Size',
					values: [
						{ id: 'v1', name: 'Large' },
						{ id: 'v2', name: 'Small' },
					],
				},
			],
			variants: [
				{ id: 'x1', valueIds: ['v1'], price: 3, imageKey: null },
				{ id: 'x2', valueIds: ['v2'], price: 5, imageKey: null },
			],
		}
		const g = makeMenuGraph({
			items: [
				{
					id: 'latte',
					displayName: 'Latte',
					variations: JSON.stringify(variations),
				},
			],
		})
		const { draft, ops } = acceptDefault('check_price', g, '7')
		expect(draft.params).toEqual({
			case: 'variant',
			itemId: 'latte',
			variantId: 'x1',
		})
		const op = ops[0]!
		expect(op).toMatchObject({ op: 'update', entity: 'item', id: 'latte' })
		if (op.op === 'update' && op.entity === 'item') {
			const next = JSON.parse(op.set.variations!) as {
				variants: Array<{ price: number }>
			}
			expect(next.variants.map((v: { price: number }) => v.price)).toEqual([
				7, 5,
			])
			expect(MenuVariationsSchema.safeParse(next).success).toBe(true)
		}
	})

	it('finds nothing for small categories, hidden dishes, sane sizes or POS dishes', () => {
		expect(
			detect(
				'check_price',
				makeMenuGraph({
					categories: [{ id: 'c' }],
					items: [
						{ id: 'a', price: 1 },
						{ id: 'b', price: 100 },
					],
					itemCategories: [
						{ categoryId: 'c', itemId: 'a' },
						{ categoryId: 'c', itemId: 'b' },
					],
				}),
			),
		).toEqual([])
		expect(
			detect(
				'check_price',
				graph({
					items: [
						...prices.map((price, i) => ({ id: `d${i}`, price })),
						{ id: 'odd', price: 1200, availabilityStatus: 'hidden' },
					],
				}),
			),
		).toEqual([])
		expect(
			detect(
				'check_price',
				graph({ posLinks: [{ entityType: 'item', localId: 'odd' }] }),
			),
		).toEqual([])
		const sane = {
			groups: [
				{
					id: 'g',
					name: 'Size',
					values: [
						{ id: 'v1', name: 'Small' },
						{ id: 'v2', name: 'Large' },
					],
				},
			],
			variants: [
				{ id: 'x1', valueIds: ['v1'], price: 3, imageKey: null },
				{ id: 'x2', valueIds: ['v2'], price: 5, imageKey: null },
			],
		}
		expect(
			detect(
				'check_price',
				makeMenuGraph({
					items: [{ id: 'latte', variations: JSON.stringify(sane) }],
				}),
			),
		).toEqual([])
	})
})
