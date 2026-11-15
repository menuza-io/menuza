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
	MENU_CARD_SAFETY_COLUMNS,
	type MenuCardKind,
	type MenuCardOp,
} from './menu-cards.ts'
import { makeMenuGraph, type MenuGraph } from './menu-graph.ts'
import { POLISH_CARD_KINDS_IMPL } from './polish-suggestions.ts'
import { extractChoicePhrase } from './polish-text.ts'

const ctx: MenuCardContext = {
	defaultLocale: 'en',
	locales: ['en'],
	settings: { capitalStyle: null },
	now: new Date('2026-06-01T00:00:00Z'),
}

type PolishKind = keyof typeof POLISH_CARD_KINDS_IMPL

function detect(
	kind: PolishKind,
	graph: MenuGraph,
	context: MenuCardContext = ctx,
): MenuCardDraft[] {
	return POLISH_CARD_KINDS_IMPL[kind].detect(graph, context)
}

function planOf(
	graph: MenuGraph,
	draft: MenuCardDraft,
	extra: {
		optionId?: string
		input?: string
		params?: Record<string, unknown>
	} = {},
	context: MenuCardContext = ctx,
) {
	return POLISH_CARD_KINDS_IMPL[draft.kind as PolishKind].plan(
		graph,
		{
			id: draft.id,
			params: extra.params ?? draft.params,
			optionId: extra.optionId ?? draft.defaultOptionId,
			input: extra.input,
		},
		context,
	)
}

function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
	if (Array.isArray(value)) value.forEach((entry) => keysDeep(entry, out))
	else if (value && typeof value === 'object') {
		for (const [key, entry] of Object.entries(value)) {
			out.add(key)
			keysDeep(entry, out)
		}
	}
	return out
}

/** The plan's ops, after the engine's own checks and the safety columns. */
function okOps(
	graph: MenuGraph,
	draft: MenuCardDraft,
	extra: Parameters<typeof planOf>[2] = {},
	context?: MenuCardContext,
): MenuCardOp[] {
	const plan = planOf(graph, draft, extra, context)
	if (!plan.ok) throw new Error(`plan refused: ${plan.error}`)
	expect(validateCardPlan(graph, draft.refs, plan.ops)).toBeNull()
	const keys = keysDeep(plan.ops)
	for (const column of MENU_CARD_SAFETY_COLUMNS) {
		expect(keys.has(column)).toBe(false)
	}
	return plan.ops
}

const localized = (value: string, locale = 'en') =>
	JSON.stringify({ [locale]: value })

describe('every polish kind is implemented', () => {
	it('has a detector and plan for each kind', () => {
		const empty = makeMenuGraph({})
		for (const kind of Object.keys(POLISH_CARD_KINDS_IMPL) as MenuCardKind[]) {
			const impl = POLISH_CARD_KINDS_IMPL[kind as PolishKind]
			expect(impl.kind).toBe(kind)
			expect(impl.detect(empty, ctx)).toEqual([])
		}
	})
})

// --- typo ----------------------------------------------------------------------

describe('typo', () => {
	const graph = makeMenuGraph({
		items: [
			{ id: 'wrap', displayName: 'Chiken Wrap' },
			{ id: 'shawarma', displayName: 'Shawarma Plate' },
			{ id: 'kunafa', displayName: 'Kunafa' },
			{ id: 'mutabbal', displayName: 'Mutabbal' },
			{ id: 'arabic', displayName: 'دجاج مشوي', description: 'مع صلصة الثوم' },
			{
				id: 'fine',
				displayName: 'Chicken Wrap',
				description: 'Grilled chicken and sauces',
			},
			{
				id: 'hidden',
				displayName: 'Chiken Burger',
				availabilityStatus: 'hidden',
			},
			{ id: 'pos', displayName: 'Chiken Pizza' },
			{
				id: 'desc',
				displayName: 'Margherita',
				description: 'Served with mozarella and BASIL',
			},
			{ id: 'caps', displayName: 'CHIKEN SANDWICH' },
		],
		posLinks: [{ entityType: 'item', localId: 'pos' }],
	})

	it('suggests a card only for words one slip from a menu word', () => {
		const drafts = detect('typo', graph)
		expect(drafts.map((draft) => draft.primary.id).sort()).toEqual([
			'caps',
			'desc',
			'wrap',
		])
		const wrap = drafts.find((draft) => draft.primary.id === 'wrap')!
		expect(wrap.params).toMatchObject({
			itemId: 'wrap',
			field: 'displayName',
			locale: 'en',
			fixes: [{ from: 'Chiken', to: 'Chicken' }],
		})
		expect(wrap.preview.before[0]?.rows[0]?.text).toBe('Chiken Wrap')
		expect(wrap.preview.after[0]?.rows[0]?.text).toBe('Chicken Wrap')
		expect(wrap.aiData).toMatchObject({ suspects: ['Chiken'] })
		const desc = drafts.find((draft) => draft.primary.id === 'desc')!
		expect(desc.params).toMatchObject({
			field: 'description',
			fixes: [{ from: 'mozarella', to: 'mozzarella' }],
		})
		const caps = drafts.find((draft) => draft.primary.id === 'caps')!
		expect(caps.params).toMatchObject({
			fixes: [{ from: 'CHIKEN', to: 'CHICKEN' }],
		})
	})

	it('needs the model: apply drops invented fixes and unconfirmed cards', () => {
		const typo = POLISH_CARD_KINDS_IMPL.typo
		expect(typo.ai?.required).toBe(true)
		const wrap = detect('typo', graph).find((d) => d.primary.id === 'wrap')!
		expect(typo.ai!.apply(wrap, { fixes: [] })).toBeNull()
		expect(
			typo.ai!.apply(wrap, { fixes: [{ from: 'Wrap', to: 'Wrapp' }] }),
		).toBeNull()
		expect(
			typo.ai!.apply(wrap, { fixes: [{ from: 'Chiken', to: 'Hamburger' }] }),
		).toBeNull()
		const kept = typo.ai!.apply(wrap, {
			fixes: [
				{ from: 'Chiken', to: '<b>chicken</b>' },
				{ from: 'Wrap', to: 'Wrapp' },
			],
		})!
		expect(kept.params.fixes).toEqual([{ from: 'Chiken', to: 'Chicken' }])
		expect(okOps(graph, kept)).toEqual([
			{
				op: 'update',
				entity: 'item',
				id: 'wrap',
				set: { displayName: localized('Chicken Wrap') },
			},
		])
	})

	it('refuses forged fixes in the plan', () => {
		const wrap = detect('typo', graph).find((d) => d.primary.id === 'wrap')!
		const forged = (fixes: unknown) =>
			planOf(graph, wrap, { params: { ...wrap.params, fixes } })
		expect(forged([{ from: 'Wrap', to: 'Wrapp' }])).toMatchObject({ ok: false })
		expect(forged([{ from: 'Chiken', to: 'Hamburger' }])).toMatchObject({
			ok: false,
		})
		expect(forged([{ from: 'Missing', to: 'Missing' }])).toMatchObject({
			ok: false,
		})
	})

	it('never writes a POS dish and skips non-English menus', () => {
		expect(detect('typo', graph).some((d) => d.primary.id === 'pos')).toBe(
			false,
		)
		const arabic = makeMenuGraph({
			defaultLocale: 'ar',
			locales: ['ar'],
			items: [{ id: 'a', displayName: localized('Chiken Wrap', 'ar') }],
		})
		expect(detect('typo', arabic)).toEqual([])
	})

	it('writes only the locale it checked', () => {
		const bilingual = makeMenuGraph({
			locales: ['en', 'ar'],
			items: [
				{
					id: 'x',
					displayName: JSON.stringify({ en: 'Chiken Wrap', ar: 'راب دجاج' }),
				},
			],
		})
		const [draft] = detect('typo', bilingual)
		const kept = POLISH_CARD_KINDS_IMPL.typo.ai!.apply(draft!, {
			fixes: [{ from: 'Chiken', to: 'Chicken' }],
		})!
		const [op] = okOps(bilingual, kept)
		expect(op).toMatchObject({
			set: {
				displayName: JSON.stringify({ en: 'Chicken Wrap', ar: 'راب دجاج' }),
			},
		})
	})
})

// --- capitals ------------------------------------------------------------------

describe('capitals', () => {
	const graph = makeMenuGraph({
		categories: [
			{ id: 'mains' },
			{ id: 'hiddenCat', availabilityStatus: 'hidden' },
		],
		items: [
			{ id: 'a', displayName: 'Chicken Wrap' },
			{ id: 'b', displayName: 'Beef Burger' },
			{ id: 'c', displayName: 'grilled fish' },
			{ id: 'd', displayName: 'LAMB CHOPS' },
			{ id: 'e', displayName: 'BBQ chicken wings' },
			{ id: 'f', displayName: 'Combo 12 Pieces' },
			{ id: 'g', displayName: 'برجر دجاج' },
			{ id: 'h', displayName: 'bad hidden', availabilityStatus: 'hidden' },
			{ id: 'pos', displayName: 'pos dish' },
			{ id: 'i', displayName: 'Fish of the Day' },
		],
		itemCategories: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'pos', 'i'].map(
			(itemId) => ({ categoryId: 'mains', itemId }),
		),
		posLinks: [{ entityType: 'item', localId: 'pos' }],
	})

	it('lists off-style dishes per category, offering the styles', () => {
		const drafts = detect('capitals', graph)
		expect(drafts).toHaveLength(1)
		const [draft] = drafts
		expect(draft!.primary).toEqual({ type: 'category', id: 'mains' })
		expect(draft!.params.itemIds).toEqual(['c', 'd', 'e'])
		expect(draft!.options?.map((option) => option.code)).toEqual([
			'title',
			'sentence',
			'upper',
		])
		expect(draft!.defaultOptionId).toBe('title')
		expect(draft!.preview.after[0]?.rows.map((row) => row.text)).toEqual([
			'Grilled Fish',
			'Lamb Chops',
			'BBQ Chicken Wings',
		])
	})

	it('rewrites the listed names in the chosen style', () => {
		const [draft] = detect('capitals', graph)
		const names = (ops: MenuCardOp[]) =>
			ops.map((op) =>
				op.op === 'update' && op.entity === 'item'
					? (JSON.parse(op.set.displayName!) as { en: string }).en
					: null,
			)
		expect(names(okOps(graph, draft!))).toEqual([
			'Grilled Fish',
			'Lamb Chops',
			'BBQ Chicken Wings',
		])
		expect(names(okOps(graph, draft!, { optionId: 'sentence' }))).toEqual([
			'Grilled fish',
			'Lamb chops',
		])
		expect(names(okOps(graph, draft!, { optionId: 'upper' }))).toEqual([
			'GRILLED FISH',
			'BBQ CHICKEN WINGS',
		])
		expect(planOf(graph, draft!, { optionId: 'weird' })).toMatchObject({
			ok: false,
			error: 'invalid_input',
		})
	})

	it('uses the saved style without options', () => {
		const settings = { ...ctx, settings: { capitalStyle: 'sentence' as const } }
		const [draft] = detect('capitals', graph, settings)
		expect(draft!.options).toBeUndefined()
		expect(draft!.params.itemIds).toEqual(['a', 'b', 'c', 'd', 'f', 'i'])
		const ops = okOps(graph, draft!, {}, settings)
		expect(ops).toHaveLength(6)
	})

	it('finds nothing when names agree, are Arabic or are POS-owned', () => {
		const fine = makeMenuGraph({
			categories: [{ id: 'c' }],
			items: [
				{ id: 'a', displayName: 'Chicken Wrap' },
				{ id: 'b', displayName: 'Beef Burger' },
				{ id: 'p', displayName: 'pos dish' },
				{ id: 'ar', displayName: 'برجر' },
			],
			itemCategories: ['a', 'b', 'p', 'ar'].map((itemId) => ({
				categoryId: 'c',
				itemId,
			})),
			posLinks: [{ entityType: 'item', localId: 'p' }],
		})
		expect(detect('capitals', fine)).toEqual([])
	})

	it('caps a card at 30 dishes', () => {
		const many = makeMenuGraph({
			categories: [{ id: 'c' }],
			items: [
				{ id: 'ok1', displayName: 'Chicken Wrap' },
				{ id: 'ok2', displayName: 'Beef Burger' },
				{ id: 'ok3', displayName: 'Fish Pie' },
				...Array.from({ length: 40 }, (_, i) => ({
					id: `x${i}`,
					displayName: `lower dish ${i}x`,
				})),
			],
			itemCategories: [
				'ok1',
				'ok2',
				'ok3',
				...Array.from({ length: 40 }, (_, i) => `x${i}`),
			].map((itemId) => ({ categoryId: 'c', itemId })),
		})
		const [draft] = detect('capitals', many)
		expect(draft!.params.itemIds as string[]).toHaveLength(30)
	})
})

// --- missing_choice -------------------------------------------------------------

describe('missing_choice', () => {
	const graph = makeMenuGraph({
		locales: ['en', 'ar'],
		items: [
			{
				id: 'pasta',
				displayName: 'Pasta',
				description: 'Pasta. Your choice of side.',
			},
			{
				id: 'salad',
				displayName: 'Salad',
				description: 'Choose your dressing',
			},
			{
				id: 'soup',
				displayName: 'Soup',
				description: 'A choice of tomato or lentil',
			},
			{
				id: 'hid',
				displayName: 'Hidden',
				description: 'Pick your sauce',
				availabilityStatus: 'hidden',
			},
			{
				id: 'posdish',
				displayName: 'Pos',
				description: 'Pick your sauce',
			},
			{
				id: 'ar',
				displayName: 'Arabic',
				description: JSON.stringify({ en: 'Tasty', ar: 'اختر صلصتك' }),
			},
			{ id: 'plain', displayName: 'Plain', description: 'Served hot' },
		],
		groups: [
			{ id: 'sides', name: 'Sides' },
			{ id: 'dressings', name: 'Dressings' },
			{ id: 'hiddenSides', name: 'Side choice', availabilityStatus: 'hidden' },
		],
		itemGroups: [{ itemId: 'salad', modifierGroupId: 'dressings' }],
		posLinks: [{ entityType: 'item', localId: 'posdish' }],
	})

	it('extracts the phrase', () => {
		expect(extractChoicePhrase('with a choice of fries', 'en')).toBe('fries')
		expect(extractChoicePhrase('Pick your sauce.', 'en')).toBe('sauce')
		expect(extractChoicePhrase('choice of fries or salad', 'en')).toBeNull()
		expect(extractChoicePhrase('choice of fries, salad', 'en')).toBeNull()
		expect(extractChoicePhrase('اختر صلصتك', 'ar')).toBe('صلصتك')
		expect(extractChoicePhrase('x'.repeat(10), 'en')).toBeNull()
	})

	it('offers attaching a matching group, or creating one', () => {
		const drafts = detect('missing_choice', graph)
		expect(drafts.map((d) => d.primary.id).sort()).toEqual(['ar', 'pasta'])
		const pasta = drafts.find((d) => d.primary.id === 'pasta')!
		expect(pasta.options?.map((o) => o.id)).toEqual(['attach:sides', 'create'])
		expect(pasta.defaultOptionId).toBe('attach:sides')
		expect(pasta.options?.[1]?.warnings).toEqual(['empty_group'])
		expect(pasta.preview.after[0]?.rows.at(-1)).toMatchObject({
			text: 'Sides',
			change: 'added',
		})
		const arabic = drafts.find((d) => d.primary.id === 'ar')!
		expect(arabic.options?.map((o) => o.id)).toEqual(['create'])
		expect(arabic.params).toMatchObject({ locale: 'ar', phrase: 'صلصتك' })
	})

	it('plans an attach and a create', () => {
		const pasta = detect('missing_choice', graph).find(
			(d) => d.primary.id === 'pasta',
		)!
		expect(okOps(graph, pasta)).toEqual([
			{
				op: 'assign',
				link: 'item_modifier_group',
				parentId: 'pasta',
				childId: 'sides',
				position: 0,
			},
		])
		const create = okOps(graph, pasta, { optionId: 'create' })
		expect(create[0]).toMatchObject({
			op: 'insert',
			entity: 'modifier_group',
			values: {
				name: 'Side',
				selectionType: 'single',
				minSelections: 1,
				maxSelections: 1,
			},
		})
		expect(
			planOf(graph, pasta, { optionId: 'attach:dressings' }),
		).toMatchObject({ ok: false, error: 'invalid_input' })
		expect(
			planOf(graph, pasta, { params: { ...pasta.params, phrase: 'drink' } }),
		).toMatchObject({ ok: false })
	})
})

// --- selection_limits ------------------------------------------------------------

describe('selection_limits', () => {
	const graph = makeMenuGraph({
		groups: [
			{
				id: 'toppings',
				name: 'Toppings',
				selectionType: 'single',
				maxSelections: 3,
			},
			{ id: 'size', name: 'Size', selectionType: 'multiple', maxSelections: 1 },
			{ id: 'fine', selectionType: 'single', maxSelections: 1 },
			{ id: 'open', selectionType: 'single', maxSelections: null },
			{
				id: 'hid',
				selectionType: 'single',
				maxSelections: 4,
				availabilityStatus: 'hidden',
			},
			{ id: 'pos', selectionType: 'single', maxSelections: 4 },
		],
		options: [{ id: 'o1', displayName: 'Cheese', price: 2 }],
		groupOptions: [{ modifierGroupId: 'toppings', optionId: 'o1' }],
		posLinks: [{ entityType: 'modifier_group', localId: 'pos' }],
	})

	it('detects contradictions per group', () => {
		const drafts = detect('selection_limits', graph)
		expect(drafts.map((d) => d.primary.id)).toEqual(['toppings', 'size'])
		const toppings = drafts[0]!
		expect(toppings.options?.map((o) => o.id)).toEqual([
			'make_multiple',
			'max_one',
		])
		expect(toppings.defaultOptionId).toBe('make_multiple')
		expect(toppings.preview.before[0]?.rows[0]).toMatchObject({
			text: 'Cheese',
			price: 2,
		})
		expect(drafts[1]!.options?.map((o) => o.id)).toEqual(['make_single'])
	})

	it('plans each fix', () => {
		const [toppings, size] = detect('selection_limits', graph)
		expect(okOps(graph, toppings!)).toEqual([
			{
				op: 'update',
				entity: 'modifier_group',
				id: 'toppings',
				set: { selectionType: 'multiple' },
			},
		])
		expect(okOps(graph, toppings!, { optionId: 'max_one' })).toEqual([
			{
				op: 'update',
				entity: 'modifier_group',
				id: 'toppings',
				set: { maxSelections: 1 },
			},
		])
		expect(okOps(graph, size!)).toEqual([
			{
				op: 'update',
				entity: 'modifier_group',
				id: 'size',
				set: { selectionType: 'single', maxSelections: null },
			},
		])
		expect(planOf(graph, size!, { optionId: 'max_one' })).toMatchObject({
			ok: false,
		})
	})

	it('a forged POS group id is refused by the engine', () => {
		const [toppings] = detect('selection_limits', graph)
		const plan = planOf(graph, toppings!, { params: { groupId: 'pos' } })
		expect(plan.ok).toBe(true)
		if (plan.ok) {
			expect(
				validateCardPlan(
					graph,
					[{ type: 'modifier_group', id: 'pos' }],
					plan.ops,
				),
			).toBe('pos_owned')
		}
	})
})

// --- required_first ----------------------------------------------------------------

describe('required_first', () => {
	const graph = makeMenuGraph({
		items: [
			{ id: 'burger' },
			{ id: 'fine' },
			{ id: 'posdish' },
			{ id: 'hidd', availabilityStatus: 'hidden' },
		],
		groups: [
			{ id: 'extras', minSelections: 0 },
			{ id: 'size', minSelections: 1 },
			{ id: 'sauce', minSelections: 0 },
			{ id: 'cook', minSelections: 1 },
		],
		itemGroups: [
			{ itemId: 'burger', modifierGroupId: 'extras', position: 0 },
			{ itemId: 'burger', modifierGroupId: 'size', position: 1 },
			{ itemId: 'burger', modifierGroupId: 'sauce', position: 2 },
			{ itemId: 'burger', modifierGroupId: 'cook', position: 3 },
			{ itemId: 'fine', modifierGroupId: 'size', position: 0 },
			{ itemId: 'fine', modifierGroupId: 'extras', position: 1 },
			{ itemId: 'posdish', modifierGroupId: 'extras', position: 0 },
			{ itemId: 'posdish', modifierGroupId: 'size', position: 1 },
			{ itemId: 'hidd', modifierGroupId: 'extras', position: 0 },
			{ itemId: 'hidd', modifierGroupId: 'size', position: 1 },
		],
		posLinks: [{ entityType: 'item', localId: 'posdish' }],
	})

	it('moves required groups first, otherwise stable', () => {
		const drafts = detect('required_first', graph)
		expect(drafts.map((d) => d.primary.id)).toEqual(['burger'])
		expect(drafts[0]!.preview.after[0]?.rows.map((r) => r.text)).toEqual([
			'size',
			'cook',
			'extras',
			'sauce',
		])
		const ops = okOps(graph, drafts[0]!)
		expect(
			ops.map((op) => (op.op === 'assign' ? [op.childId, op.position] : null)),
		).toEqual([
			['size', 0],
			['cook', 1],
			['extras', 2],
			['sauce', 3],
		])
	})

	it('refuses a POS dish whose group links the POS owns', () => {
		const [draft] = detect('required_first', graph)
		const plan = planOf(graph, draft!, { params: { itemId: 'posdish' } })
		expect(plan.ok).toBe(true)
		if (plan.ok) {
			const refs = [
				{ type: 'item' as const, id: 'posdish' },
				{ type: 'modifier_group' as const, id: 'extras' },
				{ type: 'modifier_group' as const, id: 'size' },
			]
			expect(validateCardPlan(graph, refs, plan.ops)).toBe('pos_owned')
		}
	})
})

// --- option_order -------------------------------------------------------------------

describe('option_order', () => {
	const graph = makeMenuGraph({
		groups: [
			{ id: 'size' },
			{ id: 'heat' },
			{ id: 'ordered' },
			{ id: 'mixed' },
			{ id: 'arabic' },
			{ id: 'posgroup' },
			{ id: 'withhidden' },
		],
		options: [
			{ id: 'sL', displayName: 'Large' },
			{ id: 'sS', displayName: 'Small' },
			{ id: 'sM', displayName: 'Medium' },
			{ id: 'hH', displayName: 'Hot' },
			{ id: 'hM', displayName: 'Mild' },
			{ id: 'hE', displayName: 'Extra Hot' },
			{ id: 'oS', displayName: 'Small' },
			{ id: 'oL', displayName: 'Large' },
			{ id: 'mS', displayName: 'Small' },
			{ id: 'mC', displayName: 'Cheese' },
			{ id: 'aL', displayName: 'كبير' },
			{ id: 'aS', displayName: 'صغير' },
			{ id: 'aM', displayName: 'وسط' },
			{ id: 'pL', displayName: 'Large' },
			{ id: 'pS', displayName: 'Small' },
			{ id: 'wL', displayName: 'Large' },
			{ id: 'wX', displayName: 'Extra Large', availabilityStatus: 'hidden' },
			{ id: 'wS', displayName: 'Small' },
		],
		groupOptions: [
			{ modifierGroupId: 'size', optionId: 'sL', position: 0 },
			{ modifierGroupId: 'size', optionId: 'sS', position: 1 },
			{ modifierGroupId: 'size', optionId: 'sM', position: 2 },
			{ modifierGroupId: 'heat', optionId: 'hH', position: 0 },
			{ modifierGroupId: 'heat', optionId: 'hM', position: 1 },
			{ modifierGroupId: 'heat', optionId: 'hE', position: 2 },
			{ modifierGroupId: 'ordered', optionId: 'oS', position: 0 },
			{ modifierGroupId: 'ordered', optionId: 'oL', position: 1 },
			{ modifierGroupId: 'mixed', optionId: 'mS', position: 0 },
			{ modifierGroupId: 'mixed', optionId: 'mC', position: 1 },
			{ modifierGroupId: 'arabic', optionId: 'aL', position: 0 },
			{ modifierGroupId: 'arabic', optionId: 'aS', position: 1 },
			{ modifierGroupId: 'arabic', optionId: 'aM', position: 2 },
			{ modifierGroupId: 'posgroup', optionId: 'pL', position: 0 },
			{ modifierGroupId: 'posgroup', optionId: 'pS', position: 1 },
			{ modifierGroupId: 'withhidden', optionId: 'wL', position: 0 },
			{ modifierGroupId: 'withhidden', optionId: 'wX', position: 1 },
			{ modifierGroupId: 'withhidden', optionId: 'wS', position: 2 },
		],
		posLinks: [{ entityType: 'modifier_group', localId: 'posgroup' }],
	})

	it('sorts options of a known scale', () => {
		const drafts = detect('option_order', graph)
		expect(drafts.map((d) => d.primary.id)).toEqual([
			'size',
			'heat',
			'arabic',
			'withhidden',
		])
		const order = (id: string) =>
			okOps(
				graph,
				drafts.find((d) => d.primary.id === id)!,
			).map((op) => (op.op === 'assign' ? [op.childId, op.position] : null))
		expect(order('size')).toEqual([
			['sS', 0],
			['sM', 1],
			['sL', 2],
		])
		expect(order('heat')).toEqual([
			['hM', 0],
			['hH', 1],
			['hE', 2],
		])
		expect(order('arabic')).toEqual([
			['aS', 0],
			['aM', 1],
			['aL', 2],
		])
		// The hidden option keeps its slot.
		expect(order('withhidden')).toEqual([
			['wS', 0],
			['wX', 1],
			['wL', 2],
		])
		expect(drafts[0]!.preview.after[0]?.rows.map((r) => r.text)).toEqual([
			'Small',
			'Medium',
			'Large',
		])
	})

	it('leaves ordered, mixed and POS groups alone', () => {
		const ids = detect('option_order', graph).map((d) => d.primary.id)
		expect(ids).not.toContain('ordered')
		expect(ids).not.toContain('mixed')
		expect(ids).not.toContain('posgroup')
	})
})

// --- no_option_style ---------------------------------------------------------------------

describe('no_option_style', () => {
	const graph = makeMenuGraph({
		options: [
			{ id: 'a', displayName: 'No onions' },
			{ id: 'b', displayName: 'No tomato' },
			{ id: 'c', displayName: 'Without pickles' },
			{ id: 'd', displayName: 'Hold the mayo' },
			{ id: 'e', displayName: 'Without cheese', availabilityStatus: 'hidden' },
			{ id: 'pos', displayName: 'Without ice' },
		],
		posLinks: [{ entityType: 'modifier_option', localId: 'pos' }],
	})

	it('renames the minority styles to the majority prefix', () => {
		const drafts = detect('no_option_style', graph)
		expect(drafts).toHaveLength(1)
		const [draft] = drafts
		expect(draft!.primary.id).toBe('c')
		expect(draft!.params).toMatchObject({ optionIds: ['c', 'd'], prefix: 'no' })
		expect(draft!.preview.after[0]?.rows.map((r) => r.text)).toEqual([
			'No pickles',
			'No mayo',
		])
		const ops = okOps(graph, draft!)
		expect(ops).toEqual([
			{
				op: 'update',
				entity: 'option',
				id: 'c',
				set: { displayName: 'No pickles' },
			},
			{
				op: 'update',
				entity: 'option',
				id: 'd',
				set: { displayName: 'No mayo' },
			},
		])
	})

	it('finds nothing with one style, and POS options are never renamed', () => {
		const one = makeMenuGraph({
			options: [
				{ id: 'a', displayName: 'No onions' },
				{ id: 'b', displayName: 'No tomato' },
			],
		})
		expect(detect('no_option_style', one)).toEqual([])
		const [draft] = detect('no_option_style', graph)
		const plan = planOf(graph, draft!, {
			params: { optionIds: ['pos'], prefix: 'no' },
		})
		expect(plan.ok).toBe(true)
		if (plan.ok) {
			expect(
				validateCardPlan(graph, [{ type: 'option', id: 'pos' }], plan.ops),
			).toBe('pos_owned')
		}
	})
})

// --- free_dish -----------------------------------------------------------------------------

describe('free_dish', () => {
	const graph = makeMenuGraph({
		items: [
			{ id: 'free', displayName: 'Build your bowl', price: 0 },
			{ id: 'other', displayName: 'Other', price: 5 },
			{ id: 'paid', displayName: 'Paid', price: 4 },
			{ id: 'hiddenFree', price: 0, availabilityStatus: 'hidden' },
			{ id: 'posFree', price: 0 },
			{ id: 'reqPaid', price: 0 },
			{ id: 'allFree', price: 0 },
			{
				id: 'variants',
				price: 0,
				variations: JSON.stringify({
					groups: [],
					variants: [{ id: 'v', price: 5 }],
				}),
			},
		],
		groups: [
			{ id: 'extras', name: 'Extras', minSelections: 0 },
			{ id: 'sizes', name: 'Sizes', minSelections: 1 },
			{ id: 'freeOpts', name: 'Free opts', minSelections: 0 },
		],
		options: [
			{ id: 'cheese', displayName: 'Cheese', price: 2 },
			{ id: 'big', displayName: 'Big', price: 3 },
			{ id: 'plain', displayName: 'Plain', price: 0 },
		],
		groupOptions: [
			{ modifierGroupId: 'extras', optionId: 'cheese' },
			{ modifierGroupId: 'sizes', optionId: 'big' },
			{ modifierGroupId: 'freeOpts', optionId: 'plain' },
		],
		itemGroups: [
			{ itemId: 'free', modifierGroupId: 'extras' },
			{ itemId: 'other', modifierGroupId: 'extras' },
			{ itemId: 'hiddenFree', modifierGroupId: 'extras' },
			{ itemId: 'posFree', modifierGroupId: 'extras' },
			{ itemId: 'reqPaid', modifierGroupId: 'sizes' },
			{ itemId: 'reqPaid', modifierGroupId: 'extras' },
			{ itemId: 'allFree', modifierGroupId: 'freeOpts' },
			{ itemId: 'paid', modifierGroupId: 'extras' },
		],
		posLinks: [{ entityType: 'item', localId: 'posFree' }],
	})

	it('flags a free dish whose paid options are all optional', () => {
		const drafts = detect('free_dish', graph)
		expect(drafts.map((d) => d.primary.id)).toEqual(['free'])
		const [draft] = drafts
		expect(draft!.options?.map((o) => o.id)).toEqual([
			'set_price',
			'require:extras',
			'attach:sizes',
			'add_group',
		])
		expect(draft!.defaultOptionId).toBe('set_price')
		expect(draft!.options?.[0]?.input).toBe('price')
		expect(draft!.options?.[1]?.warnings).toEqual(['shared_group'])
		expect(draft!.preview.before[0]?.rows[0]).toMatchObject({ price: 0 })
	})

	it('plans each fix', () => {
		const [draft] = detect('free_dish', graph)
		expect(planOf(graph, draft!)).toMatchObject({
			ok: false,
			error: 'invalid_input',
		})
		for (const input of ['-1', 'abc', '9.999', '', 'NaN', 'Infinity']) {
			expect(planOf(graph, draft!, { input })).toMatchObject({ ok: false })
		}
		expect(okOps(graph, draft!, { input: '9.5' })).toEqual([
			{ op: 'update', entity: 'item', id: 'free', set: { price: 9.5 } },
		])
		expect(okOps(graph, draft!, { optionId: 'require:extras' })).toEqual([
			{
				op: 'update',
				entity: 'modifier_group',
				id: 'extras',
				set: { minSelections: 1 },
			},
		])
		expect(okOps(graph, draft!, { optionId: 'attach:sizes' })).toEqual([
			{
				op: 'assign',
				link: 'item_modifier_group',
				parentId: 'free',
				childId: 'sizes',
				position: 1,
			},
		])
		const add = okOps(graph, draft!, { optionId: 'add_group', input: '12' })
		expect(add).toHaveLength(4)
		expect(add[0]).toMatchObject({
			entity: 'modifier_group',
			values: { name: 'Size', minSelections: 1, maxSelections: 1 },
		})
		expect(add[1]).toMatchObject({
			entity: 'option',
			values: { displayName: 'Regular', price: 12 },
		})
		expect(planOf(graph, draft!, { optionId: 'add_group' })).toMatchObject({
			ok: false,
		})
		expect(planOf(graph, draft!, { optionId: 'require:sizes' })).toMatchObject({
			ok: false,
		})
	})

	it('writes the menu language word for Size', () => {
		const arabic = makeMenuGraph({
			defaultLocale: 'ar',
			locales: ['ar'],
			items: [{ id: 'free', price: 0 }],
			groups: [{ id: 'extras' }],
			options: [{ id: 'cheese', price: 2 }],
			groupOptions: [{ modifierGroupId: 'extras', optionId: 'cheese' }],
			itemGroups: [{ itemId: 'free', modifierGroupId: 'extras' }],
		})
		const arabicCtx = { ...ctx, defaultLocale: 'ar' as const }
		const [draft] = detect('free_dish', arabic, arabicCtx)
		const ops = okOps(
			arabic,
			draft!,
			{ optionId: 'add_group', input: '5' },
			arabicCtx,
		)
		expect(ops[0]).toMatchObject({ values: { name: 'الحجم' } })
		expect(ops[1]).toMatchObject({ values: { displayName: 'عادي' } })
	})
})

// --- category_order ------------------------------------------------------------------------

describe('category_order', () => {
	const graph = makeMenuGraph({
		menus: [{ id: 'main' }, { id: 'fine' }, { id: 'few' }, { id: 'ar' }],
		categories: [
			{ id: 'drinks', displayName: 'Hot Drinks' },
			{ id: 'specials', displayName: 'Chef Specials' },
			{ id: 'starters', displayName: 'Starters' },
			{ id: 'desserts', displayName: 'Desserts' },
			{ id: 'mains', displayName: 'Burgers' },
			{ id: 'arDrinks', displayName: 'مشروبات' },
			{ id: 'arStart', displayName: 'مقبلات' },
			{ id: 'arSweet', displayName: 'الحلويات' },
		],
		menuCategories: [
			{ menuId: 'main', categoryId: 'drinks' },
			{ menuId: 'main', categoryId: 'specials' },
			{ menuId: 'main', categoryId: 'starters' },
			{ menuId: 'main', categoryId: 'desserts' },
			{ menuId: 'main', categoryId: 'mains' },
			{ menuId: 'fine', categoryId: 'starters' },
			{ menuId: 'fine', categoryId: 'mains' },
			{ menuId: 'fine', categoryId: 'desserts' },
			{ menuId: 'few', categoryId: 'drinks' },
			{ menuId: 'few', categoryId: 'starters' },
			{ menuId: 'ar', categoryId: 'arDrinks' },
			{ menuId: 'ar', categoryId: 'arStart' },
			{ menuId: 'ar', categoryId: 'arSweet' },
		],
	})

	it('sorts the classified categories into the slots they hold', () => {
		const drafts = detect('category_order', graph)
		expect(drafts.map((d) => d.primary.id)).toEqual(['main', 'ar'])
		const [main, arabic] = drafts
		expect(main!.preview.after[0]?.rows.map((r) => r.text)).toEqual([
			'Starters',
			'Chef Specials',
			'Burgers',
			'Desserts',
			'Hot Drinks',
		])
		const positions = (draft: MenuCardDraft) =>
			okOps(graph, draft).map((op) =>
				op.op === 'assign' ? [op.childId, op.position] : null,
			)
		expect(positions(main!)).toEqual([
			['starters', 0],
			['specials', 1],
			['mains', 2],
			['desserts', 3],
			['drinks', 4],
		])
		expect(positions(arabic!)).toEqual([
			['arStart', 0],
			['arSweet', 1],
			['arDrinks', 2],
		])
	})

	it('takes an optional explanation and never an AI-made order', () => {
		const impl = POLISH_CARD_KINDS_IMPL.category_order
		expect(impl.ai?.required).toBe(false)
		const [draft] = detect('category_order', graph)
		const next = impl.ai!.apply(draft!, {
			explanation: '<i>Guests read starters first.</i>',
		})
		expect(next?.explanation).toBe('Guests read starters first.')
		expect(next?.params).toEqual(draft!.params)
		expect(impl.ai!.apply(draft!, { explanation: '  ' })).toEqual(draft)
	})
})
