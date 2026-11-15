import {
	MenuVariationsSchema,
	parseMenuVariations,
} from '@repo/common/menu-types'
import { serializeLocalizedString } from '@repo/common/site-locales'
import { z } from 'zod'
import {
	type MenuCardContext,
	type MenuCardDraft,
	type MenuCardKindImpl,
	type MenuCardPlanRequest,
	type MenuCardPlanResult,
} from './menu-card-kinds.ts'
import {
	MENU_CARD_LIMITS,
	menuCardFingerprint,
	menuCardId,
	newRecordRef,
	recordsTouchedByOps,
	type MenuCardOp,
	type MenuCardOption,
	type MenuCardPreviewBlock,
	type MenuCardPreviewRow,
	type MenuCardRef,
	type MenuStructureCardKind,
} from './menu-cards.ts'
import {
	graphRecord,
	indexMenuGraph,
	isVisible,
	localizedValues,
	sourceText,
	type GraphGroup,
	type GraphGroupOption,
	type GraphItem,
	type MenuGraph,
} from './menu-graph.ts'
import { normalizeMenuName } from './menu-health.ts'
import { isPosLinked, posOwnedViolation } from './menu-pos-owned.ts'
import {
	MENU_SUGGESTION_LIMITS,
	sanitizeSuggestionText,
} from './menu-suggestions.ts'

/**
 * Structure cards (#92), behind `menu.structure_suggestions`: one pure
 * detector and plan per kind. Read the contract in `menu-card-kinds.ts`.
 *
 * Every detector builds the default plan first and derives `refs` from the
 * ops (`recordsTouchedByOps`), so the refs always cover every record the plan
 * writes or copies from. A card whose plan would touch a POS-owned field, or
 * needs more refs than Accept takes, is not made.
 */

// --- Shared helpers ----------------------------------------------------------

const NAME_MAX = MENU_SUGGESTION_LIMITS.name
const MAX_IDS = 20

type Ctx = MenuCardContext

function cleanName(graph: MenuGraph, raw: string | null | undefined): string {
	return sanitizeSuggestionText(sourceText(graph, raw), NAME_MAX)
}

function refOf(
	graph: MenuGraph,
	type: MenuCardRef['type'],
	id: string,
): MenuCardRef | null {
	const record = graphRecord(graph, type, id)
	return record ? { type, id, updatedAt: record.updatedAt } : null
}

/** The refs for every record the ops touch, or null when one is missing or too many. */
function refsFromOps(
	graph: MenuGraph,
	ops: readonly MenuCardOp[],
): MenuCardRef[] | null {
	const { touched, copiedFrom } = recordsTouchedByOps(ops)
	const refs = new Map<string, MenuCardRef>()
	for (const key of [...touched, ...copiedFrom]) {
		const ref = refOf(graph, key.type, key.id)
		if (!ref) return null
		refs.set(`${key.type}:${key.id}`, ref)
	}
	if (refs.size > MENU_CARD_LIMITS.refs) return null
	return [...refs.values()].sort((a, b) =>
		`${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`),
	)
}

function parseIds(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null
	const out: string[] = []
	for (const entry of value) {
		if (typeof entry !== 'string' || !entry || entry.length > 64) return null
		if (!out.includes(entry)) out.push(entry)
	}
	return out.length > MAX_IDS ? null : out
}

function priceRow(
	graph: MenuGraph,
	item: GraphItem,
	change?: MenuCardPreviewRow['change'],
): MenuCardPreviewRow {
	return {
		text: cleanName(graph, item.displayName),
		price: item.price,
		...(change ? { change } : {}),
	}
}

function variantPrices(item: GraphItem): number[] {
	return parseMenuVariations(item.variations)
		.variants.map((variant) => variant.price)
		.sort((a, b) => a - b)
}

/** Words in the menu's language, with English as the fallback. */
function wordFor(
	words: Record<string, string>,
	locale: string | undefined,
): string {
	return words[(locale ?? 'en').split('-')[0] ?? 'en'] ?? words.en!
}

/** A localized JSON name with the word in each of the menu's locales. */
function localizedWord(graph: MenuGraph, words: Record<string, string>) {
	const map: Record<string, string> = {}
	for (const locale of new Set([graph.defaultLocale, ...graph.locales])) {
		map[locale] = wordFor(words, locale)
	}
	return serializeLocalizedString(map)
}

const SIZE_NAME_WORDS: Record<string, string> = {
	en: 'Size',
	ar: 'الحجم',
	es: 'Tamaño',
	fr: 'Taille',
	de: 'Größe',
	zh: '尺寸',
}
const REMOVE_NAME_WORDS: Record<string, string> = {
	en: 'Remove',
	ar: 'إزالة',
	es: 'Quitar',
	fr: 'Retirer',
	de: 'Ohne',
	zh: '去掉',
}

const NOT_ALPHANUM = '(?![\\p{L}\\p{N}])'
const NOT_PRECEDED = '(?<![\\p{L}\\p{N}])'

// --- Size words (make_sizes, check_price) -------------------------------------

type SizeInfo = { unit: string; value: number }

const SIZE_WORD_RANK: Record<string, number> = {
	mini: 0,
	kid: 1,
	kids: 1,
	small: 2,
	s: 2,
	صغير: 2,
	single: 2,
	half: 2,
	regular: 3,
	medium: 3,
	m: 3,
	وسط: 3,
	متوسط: 3,
	large: 4,
	l: 4,
	كبير: 4,
	full: 4,
	double: 4,
	family: 5,
	عائلي: 5,
	xl: 5,
	xxl: 6,
}

const SIZE_UNITS = String.raw`(?:["”″]|''|inch(?:es)?|in|oz|ml)`
const SIZE_NUMBER = String.raw`\d+(?:\.\d+)?\s*${SIZE_UNITS}`
const SIZE_WORDS = Object.keys(SIZE_WORD_RANK)
	.sort((a, b) => b.length - a.length)
	.join('|')
const SIZE_TOKEN = `(?:${SIZE_NUMBER}|${SIZE_WORDS})`

const SIZE_AT_END = new RegExp(
	String.raw`^(.*?\S)[\s\-–—,:(]+(${SIZE_TOKEN})[)\s]*$`,
	'iu',
)
const SIZE_AT_START = new RegExp(
	String.raw`^[(\s]*(${SIZE_TOKEN})[)\s\-–—,:]+(\S.*)$`,
	'iu',
)
const SIZE_NUMBER_WHOLE = new RegExp(
	String.raw`^(\d+(?:\.\d+)?)\s*(${SIZE_UNITS})$`,
	'iu',
)

/** A size word as a sortable value, or null when the text is not one. */
function parseSizeToken(raw: string): SizeInfo | null {
	const text = raw.normalize('NFKC').trim().toLowerCase()
	const rank = SIZE_WORD_RANK[text]
	if (rank !== undefined) return { unit: '', value: rank }
	const match = SIZE_NUMBER_WHOLE.exec(text)
	if (!match) return null
	const unit = match[2]!
	const normalizedUnit = ['"', '”', '″', "''", 'in', 'inch', 'inches'].includes(
		unit,
	)
		? 'in'
		: unit
	return { unit: normalizedUnit, value: Number(match[1]) }
}

/** small < medium < large < xl; words first, then numbers by unit and value. */
function compareSize(a: SizeInfo, b: SizeInfo): number {
	if (a.unit !== b.unit) {
		if (a.unit === '') return -1
		if (b.unit === '') return 1
		return a.unit.localeCompare(b.unit)
	}
	return a.value - b.value
}

type SplitName = {
	base: string
	baseKey: string
	token: string
	tokenKey: string
	info: SizeInfo
}

function stripEdges(text: string): string {
	return text.replace(/^[\s\-–—,:()]+|[\s\-–—,:()]+$/gu, '')
}

/** "Large Latte" -> base "Latte", size "Large". Null when no size word. */
function splitSizeName(name: string): SplitName | null {
	const end = SIZE_AT_END.exec(name)
	const start = end ? null : SIZE_AT_START.exec(name)
	const token = end ? end[2] : start ? start[1] : null
	const rest = end ? end[1] : start ? start[2] : null
	if (!token || !rest) return null
	const info = parseSizeToken(token)
	const base = stripEdges(rest)
	const baseKey = normalizeMenuName(base)
	if (!info || !baseKey) return null
	return {
		base,
		baseKey,
		token: token.trim(),
		tokenKey: token.normalize('NFKC').trim().toLowerCase(),
		info,
	}
}

// --- 1. merge_duplicates -------------------------------------------------------

function mergeKeepOrder(
	index: ReturnType<typeof indexMenuGraph>,
	a: GraphItem,
	b: GraphItem,
): number {
	const photo = Number(Boolean(b.imageUrl)) - Number(Boolean(a.imageUrl))
	if (photo) return photo
	const links =
		index.categoriesOfItem(b.id).length - index.categoriesOfItem(a.id).length
	if (links) return links
	return a.position - b.position || a.id.localeCompare(b.id)
}

function buildMergeOps(
	graph: MenuGraph,
	itemIds: readonly string[],
	keepId: string,
): MenuCardOp[] {
	const index = indexMenuGraph(graph)
	const ops: MenuCardOp[] = []
	const keepCategories = new Set(
		index.categoriesOfItem(keepId).map((link) => link.categoryId),
	)
	const keepGroups = new Set(
		index.groupsOfItem(keepId).map((link) => link.modifierGroupId),
	)
	const assigns: MenuCardOp[] = []
	for (const id of itemIds) {
		if (id === keepId) continue
		ops.push({
			op: 'update',
			entity: 'item',
			id,
			set: { availabilityStatus: 'hidden' },
		})
		for (const link of index.categoriesOfItem(id)) {
			if (keepCategories.has(link.categoryId)) continue
			if (!index.category.has(link.categoryId)) continue
			keepCategories.add(link.categoryId)
			assigns.push({
				op: 'assign',
				link: 'item_category',
				parentId: link.categoryId,
				childId: keepId,
				position: link.position,
			})
		}
		for (const link of index.groupsOfItem(id)) {
			if (keepGroups.has(link.modifierGroupId)) continue
			if (!index.group.has(link.modifierGroupId)) continue
			keepGroups.add(link.modifierGroupId)
			assigns.push({
				op: 'assign',
				link: 'item_modifier_group',
				parentId: keepId,
				childId: link.modifierGroupId,
				position: link.position,
			})
		}
	}
	return [...ops, ...assigns]
}

function detectMergeDuplicates(graph: MenuGraph, ctx: Ctx): MenuCardDraft[] {
	void ctx
	const index = indexMenuGraph(graph)
	const buckets = new Map<string, GraphItem[]>()
	for (const item of graph.items) {
		if (!isVisible(item)) continue
		const key = normalizeMenuName(sourceText(graph, item.displayName))
		if (!key) continue
		const list = buckets.get(key)
		if (list) list.push(item)
		else buckets.set(key, [item])
	}
	const drafts: MenuCardDraft[] = []
	for (const items of buckets.values()) {
		if (items.length < 2 || items.length > 12) continue
		const sorted = [...items].sort((a, b) => mergeKeepOrder(index, a, b))
		const keep = sorted[0]!
		const ids = sorted.map((item) => item.id)
		const ops = buildMergeOps(graph, ids, keep.id)
		if (posOwnedViolation(graph, ops)) continue
		const refs = refsFromOps(graph, ops)
		if (!refs) continue
		const signature = (item: GraphItem) =>
			[item.price, ...variantPrices(item)].join(',')
		const pricesDiffer = new Set(items.map(signature)).size > 1
		const categoryName = (id: string) =>
			cleanName(graph, index.category.get(id)?.displayName)
		const groupName = (id: string) =>
			cleanName(graph, index.group.get(id)?.name)
		const added: MenuCardPreviewRow[] = ops.flatMap((op) => {
			if (op.op !== 'assign') return []
			return op.link === 'item_category'
				? [{ text: categoryName(op.parentId), change: 'added' as const }]
				: [{ text: groupName(op.childId), change: 'added' as const }]
		})
		const losers = sorted.slice(1)
		drafts.push({
			kind: 'merge_duplicates',
			id: menuCardId(
				'merge_duplicates',
				keep.id,
				losers.map((item) => item.id),
			),
			primary: { type: 'item', id: keep.id },
			subject: cleanName(graph, keep.displayName),
			refs,
			fingerprint: menuCardFingerprint(refs, {
				ids: [...ids].sort(),
				keep: keep.id,
			}),
			params: { itemIds: ids, keepId: keep.id },
			preview: {
				before: sorted.map((item) => ({
					entity: 'item' as const,
					title: cleanName(graph, item.displayName),
					rows: [priceRow(graph, item)],
				})),
				after: [
					{
						entity: 'item',
						title: cleanName(graph, keep.displayName),
						note: 'keep',
						rows: [priceRow(graph, keep), ...added],
					},
					...losers.map((item) => ({
						entity: 'item' as const,
						title: cleanName(graph, item.displayName),
						note: 'hidden',
						rows: [priceRow(graph, item, 'hidden')],
					})),
				],
			},
			options: sorted.map((item): MenuCardOption => ({
				id: `keep:${item.id}`,
				code: 'keep',
				subject: cleanName(graph, item.displayName),
			})),
			defaultOptionId: `keep:${keep.id}`,
			...(pricesDiffer ? { warnings: ['prices_differ'] } : {}),
		})
	}
	return drafts
}

function planMergeDuplicates(
	graph: MenuGraph,
	request: MenuCardPlanRequest,
): MenuCardPlanResult {
	const index = indexMenuGraph(graph)
	const ids = parseIds(request.params.itemIds)
	if (!ids) return { ok: false, error: 'not_applicable' }
	const existing = ids.filter((id) => {
		const item = index.item.get(id)
		return item && isVisible(item)
	})
	if (existing.length < 2) return { ok: false, error: 'too_few_records' }
	let keepId = request.params.keepId
	if (request.optionId !== undefined) {
		if (!request.optionId.startsWith('keep:'))
			return { ok: false, error: 'invalid_keep' }
		keepId = request.optionId.slice('keep:'.length)
	}
	if (typeof keepId !== 'string' || !existing.includes(keepId))
		return { ok: false, error: 'invalid_keep' }
	const ops = buildMergeOps(graph, existing, keepId)
	if (posOwnedViolation(graph, ops)) return { ok: false, error: 'pos_owned' }
	return { ok: true, ops }
}

// --- 2. make_sizes -------------------------------------------------------------

type SizeEntry = { item: GraphItem; split: SplitName; groupKey: string }

function sizeEntry(graph: MenuGraph, item: GraphItem): SizeEntry | null {
	if (parseMenuVariations(item.variations).groups.length > 0) return null
	const split = splitSizeName(sourceText(graph, item.displayName))
	if (!split) return null
	const index = indexMenuGraph(graph)
	const groupKey = index
		.groupsOfItem(item.id)
		.map((link) => link.modifierGroupId)
		.sort()
		.join('|')
	return { item, split, groupKey }
}

function compareEntries(a: SizeEntry, b: SizeEntry): number {
	return (
		compareSize(a.split.info, b.split.info) ||
		a.item.position - b.item.position ||
		a.item.id.localeCompare(b.item.id)
	)
}

function buildSizesOps(
	graph: MenuGraph,
	entries: readonly SizeEntry[],
	custom: { name?: string; labels?: string[] },
): MenuCardOp[] | null {
	const index = indexMenuGraph(graph)
	const first = entries[0]!
	const baseName =
		custom.name || sanitizeSuggestionText(first.split.base, NAME_MAX)
	if (!baseName) return null
	const labels = entries.map(
		(entry, i) =>
			custom.labels?.[i] ?? sanitizeSuggestionText(entry.split.token, 80),
	)
	if (labels.some((label) => !label)) return null
	const variations = {
		groups: [
			{
				id: 'size',
				name: wordFor(SIZE_NAME_WORDS, graph.defaultLocale),
				values: labels.map((label, i) => ({
					id: `size-${i + 1}`,
					name: label,
				})),
			},
		],
		variants: entries.map((entry, i) => ({
			id: `variant-${i + 1}`,
			valueIds: [`size-${i + 1}`],
			price: entry.item.price,
			imageKey: null,
			excludeFromDiscounts: false,
			availabilityStatus: 'available',
			unavailableUntil: null,
		})),
	}
	if (!MenuVariationsSchema.safeParse(variations).success) return null

	// The name in every locale: the size word is cut out where it is found,
	// and a locale without one is dropped (it would keep the size word).
	const nameMap: Record<string, string> = {}
	for (const [locale, value] of Object.entries(
		localizedValues(graph, first.item.displayName),
	)) {
		if (locale === graph.defaultLocale) continue
		const stripped = splitSizeName(value)
		const text = stripped ? sanitizeSuggestionText(stripped.base, NAME_MAX) : ''
		if (text) nameMap[locale] = text
	}
	nameMap[graph.defaultLocale] = baseName

	const ops: MenuCardOp[] = [
		{
			op: 'insert',
			entity: 'item',
			tempId: 'merged',
			copyFrom: first.item.id,
			values: {
				displayName: serializeLocalizedString(nameMap),
				price: entries[0]!.item.price,
				variations: JSON.stringify(variations),
			},
		},
	]
	const categories = new Map<string, number>()
	for (const entry of entries) {
		for (const link of index.categoriesOfItem(entry.item.id)) {
			if (!index.category.has(link.categoryId)) continue
			if (!categories.has(link.categoryId))
				categories.set(link.categoryId, link.position)
		}
	}
	for (const [categoryId, position] of categories) {
		ops.push({
			op: 'assign',
			link: 'item_category',
			parentId: categoryId,
			childId: newRecordRef('merged'),
			position,
		})
	}
	for (const link of index.groupsOfItem(first.item.id)) {
		if (!index.group.has(link.modifierGroupId)) continue
		ops.push({
			op: 'assign',
			link: 'item_modifier_group',
			parentId: newRecordRef('merged'),
			childId: link.modifierGroupId,
			position: link.position,
		})
	}
	for (const entry of entries) {
		ops.push({
			op: 'update',
			entity: 'item',
			id: entry.item.id,
			set: { availabilityStatus: 'hidden' },
		})
	}
	return ops
}

function detectMakeSizes(graph: MenuGraph, ctx: Ctx): MenuCardDraft[] {
	void ctx
	const buckets = new Map<string, SizeEntry[]>()
	for (const item of graph.items) {
		if (!isVisible(item)) continue
		const entry = sizeEntry(graph, item)
		if (!entry) continue
		const list = buckets.get(entry.split.baseKey)
		if (list) list.push(entry)
		else buckets.set(entry.split.baseKey, [entry])
	}
	const drafts: MenuCardDraft[] = []
	for (const bucket of buckets.values()) {
		if (bucket.length < 2 || bucket.length > 10) continue
		if (
			new Set(bucket.map((entry) => entry.split.tokenKey)).size !==
			bucket.length
		)
			continue
		if (new Set(bucket.map((entry) => entry.groupKey)).size !== 1) continue
		const entries = [...bucket].sort(compareEntries)
		const ops = buildSizesOps(graph, entries, {})
		if (!ops || posOwnedViolation(graph, ops)) continue
		const refs = refsFromOps(graph, ops)
		if (!refs) continue
		const first = entries[0]!
		const base = sanitizeSuggestionText(first.split.base, NAME_MAX)
		const ids = entries.map((entry) => entry.item.id)
		drafts.push({
			kind: 'make_sizes',
			id: menuCardId('make_sizes', first.item.id, ids.slice(1)),
			primary: { type: 'item', id: first.item.id },
			subject: base,
			refs,
			fingerprint: menuCardFingerprint(refs, { ids: [...ids].sort() }),
			params: { itemIds: ids },
			preview: {
				before: entries.map((entry) => ({
					entity: 'item' as const,
					title: cleanName(graph, entry.item.displayName),
					rows: [priceRow(graph, entry.item)],
				})),
				after: [
					{
						entity: 'item',
						title: base,
						note: 'new',
						rows: entries.map((entry) => ({
							text: sanitizeSuggestionText(entry.split.token, 80),
							price: entry.item.price,
							change: 'added' as const,
						})),
					},
					...entries.map((entry) => ({
						entity: 'item' as const,
						title: cleanName(graph, entry.item.displayName),
						note: 'hidden',
						rows: [priceRow(graph, entry.item, 'hidden')],
					})),
				],
			},
			aiData: {
				names: entries.map((entry) => cleanName(graph, entry.item.displayName)),
				sizes: entries.map((entry) => entry.split.token),
			},
		})
	}
	return drafts
}

function planMakeSizes(
	graph: MenuGraph,
	request: MenuCardPlanRequest,
): MenuCardPlanResult {
	const index = indexMenuGraph(graph)
	const ids = parseIds(request.params.itemIds)
	if (!ids) return { ok: false, error: 'not_applicable' }
	const items = ids.flatMap((id) => {
		const item = index.item.get(id)
		return item && isVisible(item) ? [item] : []
	})
	if (items.length < 2) return { ok: false, error: 'too_few_records' }
	const entries: SizeEntry[] = []
	for (const item of items) {
		const entry = sizeEntry(graph, item)
		if (!entry) return { ok: false, error: 'not_applicable' }
		entries.push(entry)
	}
	if (new Set(entries.map((entry) => entry.split.baseKey)).size !== 1)
		return { ok: false, error: 'not_applicable' }
	if (
		new Set(entries.map((entry) => entry.split.tokenKey)).size !==
		entries.length
	)
		return { ok: false, error: 'not_applicable' }
	if (new Set(entries.map((entry) => entry.groupKey)).size !== 1)
		return { ok: false, error: 'groups_differ' }
	entries.sort(compareEntries)

	const name = sanitizeSuggestionText(request.params.name, NAME_MAX)
	let labels: string[] | undefined
	if (Array.isArray(request.params.sizeLabels)) {
		const cleaned = request.params.sizeLabels.map((label) =>
			sanitizeSuggestionText(label, 80),
		)
		const unique = new Set(cleaned.map((label) => label.toLowerCase()))
		if (
			cleaned.length === entries.length &&
			cleaned.every(Boolean) &&
			unique.size === cleaned.length
		)
			labels = cleaned
	}
	const ops = buildSizesOps(graph, entries, { name: name || undefined, labels })
	if (!ops) return { ok: false, error: 'invalid_input' }
	if (posOwnedViolation(graph, ops)) return { ok: false, error: 'pos_owned' }
	return { ok: true, ops }
}

const MakeSizesAnswer = z.object({
	name: z.string().optional(),
	sizeLabels: z.array(z.string()).optional(),
})

// --- 3. merge_categories -------------------------------------------------------

function singular(key: string): string {
	return key.length > 3 && key.endsWith('s') && !key.endsWith('ss')
		? key.slice(0, -1)
		: key
}

function containsWords(outer: string, inner: string): boolean {
	return outer !== inner && ` ${outer} `.includes(` ${inner} `)
}

function buildCategoryMergeOps(
	graph: MenuGraph,
	categoryIds: readonly string[],
	keepId: string,
): MenuCardOp[] {
	const index = indexMenuGraph(graph)
	const keepItems = new Set(
		index.itemsOfCategory(keepId).map((link) => link.itemId),
	)
	let next =
		Math.max(
			-1,
			...index.itemsOfCategory(keepId).map((link) => link.position),
		) + 1
	const ops: MenuCardOp[] = []
	for (const id of categoryIds) {
		if (id === keepId) continue
		for (const link of index.itemsOfCategory(id)) {
			if (keepItems.has(link.itemId) || !index.item.has(link.itemId)) continue
			keepItems.add(link.itemId)
			ops.push({
				op: 'assign',
				link: 'item_category',
				parentId: keepId,
				childId: link.itemId,
				position: next++,
			})
		}
	}
	for (const id of categoryIds) {
		if (id === keepId) continue
		ops.push({
			op: 'update',
			entity: 'category',
			id,
			set: { availabilityStatus: 'hidden' },
		})
	}
	return ops
}

function detectMergeCategories(graph: MenuGraph, ctx: Ctx): MenuCardDraft[] {
	void ctx
	const index = indexMenuGraph(graph)
	const visible = graph.categories.filter(isVisible)
	const hasChildren = new Set(
		graph.categories.flatMap((category) =>
			category.parentId && isVisible(category) ? [category.parentId] : [],
		),
	)
	const candidates = visible.filter((category) => !hasChildren.has(category.id))
	const dishCount = new Map<string, number>()
	for (const category of candidates) {
		dishCount.set(
			category.id,
			index.itemsOfCategory(category.id).filter((link) => {
				const item = index.item.get(link.itemId)
				return item && isVisible(item)
			}).length,
		)
	}
	const keys = new Map(
		candidates.map((category) => [
			category.id,
			normalizeMenuName(sourceText(graph, category.displayName)),
		]),
	)
	// Union the categories that look like one.
	const parent = new Map(candidates.map((c) => [c.id, c.id]))
	const find = (id: string): string => {
		let root = id
		while (parent.get(root) !== root) root = parent.get(root)!
		return root
	}
	const union = (a: string, b: string) => {
		const ra = find(a)
		const rb = find(b)
		if (ra !== rb) parent.set(rb, ra)
	}
	const bySingular = new Map<string, string>()
	for (const category of candidates) {
		const key = keys.get(category.id)!
		if (!key) continue
		const norm = singular(key)
		const seen = bySingular.get(norm)
		if (seen) union(seen, category.id)
		else bySingular.set(norm, category.id)
	}
	for (const small of candidates) {
		if ((dishCount.get(small.id) ?? 0) > 2) continue
		const inner = keys.get(small.id)!
		if (inner.length < 3) continue
		for (const other of candidates) {
			if (other.id === small.id) continue
			if (containsWords(keys.get(other.id)!, inner)) union(small.id, other.id)
		}
	}
	const clusters = new Map<string, typeof candidates>()
	for (const category of candidates) {
		if (!keys.get(category.id)) continue
		const root = find(category.id)
		const list = clusters.get(root)
		if (list) list.push(category)
		else clusters.set(root, [category])
	}
	const drafts: MenuCardDraft[] = []
	for (const cluster of clusters.values()) {
		if (cluster.length < 2 || cluster.length > 8) continue
		const sorted = [...cluster].sort(
			(a, b) =>
				(dishCount.get(b.id) ?? 0) - (dishCount.get(a.id) ?? 0) ||
				a.position - b.position ||
				a.id.localeCompare(b.id),
		)
		const keep = sorted[0]!
		const ids = sorted.map((category) => category.id)
		const ops = buildCategoryMergeOps(graph, ids, keep.id)
		if (posOwnedViolation(graph, ops)) continue
		const refs = refsFromOps(graph, ops)
		if (!refs) continue
		const keepMenus = new Set(
			index.menusOfCategory(keep.id).map((link) => link.menuId),
		)
		const menusDiffer = sorted
			.slice(1)
			.some((category) =>
				index
					.menusOfCategory(category.id)
					.some((link) => !keepMenus.has(link.menuId)),
			)
		const dishRows = (categoryId: string) =>
			index.itemsOfCategory(categoryId).flatMap((link) => {
				const item = index.item.get(link.itemId)
				return item && isVisible(item) ? [priceRow(graph, item)] : []
			})
		const moved = new Set(
			ops.flatMap((op) =>
				op.op === 'assign' && op.link === 'item_category' ? [op.childId] : [],
			),
		)
		drafts.push({
			kind: 'merge_categories',
			id: menuCardId('merge_categories', keep.id, ids.slice(1)),
			primary: { type: 'category', id: keep.id },
			subject: cleanName(graph, keep.displayName),
			refs,
			fingerprint: menuCardFingerprint(refs, { ids: [...ids].sort() }),
			params: { categoryIds: ids, keepId: keep.id },
			preview: {
				before: sorted.map((category) => ({
					entity: 'category' as const,
					title: cleanName(graph, category.displayName),
					rows: dishRows(category.id),
				})),
				after: [
					{
						entity: 'category',
						title: cleanName(graph, keep.displayName),
						note: 'keep',
						rows: [
							...dishRows(keep.id),
							...[...moved].flatMap((itemId) => {
								const item = index.item.get(itemId)
								return item ? [priceRow(graph, item, 'moved')] : []
							}),
						],
					},
					...sorted.slice(1).map((category) => ({
						entity: 'category' as const,
						title: cleanName(graph, category.displayName),
						note: 'hidden',
						rows: [],
					})),
				],
			},
			options: sorted.map((category): MenuCardOption => ({
				id: `keep:${category.id}`,
				code: 'keep',
				subject: cleanName(graph, category.displayName),
			})),
			defaultOptionId: `keep:${keep.id}`,
			...(menusDiffer ? { warnings: ['menus_differ'] } : {}),
		})
	}
	return drafts
}

function planMergeCategories(
	graph: MenuGraph,
	request: MenuCardPlanRequest,
): MenuCardPlanResult {
	const index = indexMenuGraph(graph)
	const ids = parseIds(request.params.categoryIds)
	if (!ids) return { ok: false, error: 'not_applicable' }
	const existing = ids.filter((id) => {
		const category = index.category.get(id)
		return category && isVisible(category)
	})
	if (existing.length < 2) return { ok: false, error: 'too_few_records' }
	let keepId = request.params.keepId
	if (request.optionId !== undefined) {
		if (!request.optionId.startsWith('keep:'))
			return { ok: false, error: 'invalid_keep' }
		keepId = request.optionId.slice('keep:'.length)
	}
	if (typeof keepId !== 'string' || !existing.includes(keepId))
		return { ok: false, error: 'invalid_keep' }
	// A parent and its child do not merge.
	const set = new Set(existing)
	if (
		existing.some((id) => {
			const parentId = index.category.get(id)?.parentId
			return parentId ? set.has(parentId) : false
		})
	)
		return { ok: false, error: 'not_applicable' }
	const ops = buildCategoryMergeOps(graph, existing, keepId)
	if (posOwnedViolation(graph, ops)) return { ok: false, error: 'pos_owned' }
	return { ok: true, ops }
}

// --- 4. split_add_remove ---------------------------------------------------------

const REMOVAL = new RegExp(
	`^(?:no|without|hold|remove|minus)${NOT_ALPHANUM}|^(?:بدون|بلا)${NOT_ALPHANUM}`,
	'iu',
)
const ADDITION = new RegExp(
	`^(?:add|extra|plus|with)${NOT_ALPHANUM}|^(?:إضافة|اضافة|زيادة|مع)${NOT_ALPHANUM}`,
	'iu',
)

// A name that starts as one and also holds the other's word ("No onions,
// add pickles") is both: the card is refused rather than guessed.
const ADDITION_WORD = new RegExp(
	`${NOT_PRECEDED}(?:add|extra|plus|with|إضافة|اضافة|زيادة|مع)${NOT_ALPHANUM}`,
	'iu',
)
const REMOVAL_WORD = new RegExp(
	`${NOT_PRECEDED}(?:no|without|hold|remove|minus|بدون|بلا)${NOT_ALPHANUM}`,
	'iu',
)

type SplitFacts = {
	removal: GraphGroupOption[]
	addition: GraphGroupOption[]
	both: boolean
}

function splitFacts(graph: MenuGraph, group: GraphGroup): SplitFacts {
	const index = indexMenuGraph(graph)
	const facts: SplitFacts = { removal: [], addition: [], both: false }
	for (const link of index.optionsOfGroup(group.id)) {
		const option = index.option.get(link.optionId)
		if (!option || !isVisible(option)) continue
		const name = sourceText(graph, option.displayName).normalize('NFKC').trim()
		const removal = REMOVAL.test(name)
		const addition = ADDITION.test(name)
		if (
			(removal && (addition || ADDITION_WORD.test(name))) ||
			(addition && REMOVAL_WORD.test(name))
		)
			facts.both = true
		else if (removal) facts.removal.push(link)
		else if (addition) facts.addition.push(link)
	}
	return facts
}

function buildSplitOps(
	graph: MenuGraph,
	group: GraphGroup,
	facts: SplitFacts,
): MenuCardOp[] {
	const index = indexMenuGraph(graph)
	const ops: MenuCardOp[] = [
		{
			op: 'insert',
			entity: 'modifier_group',
			tempId: 'remove',
			values: {
				name: localizedWord(graph, REMOVE_NAME_WORDS),
				selectionType: 'multiple',
				minSelections: 0,
				maxSelections: null,
			},
		},
	]
	facts.removal.forEach((link, position) => {
		ops.push({
			op: 'unassign',
			link: 'group_option',
			parentId: group.id,
			childId: link.optionId,
		})
		ops.push({
			op: 'assign',
			link: 'group_option',
			parentId: newRecordRef('remove'),
			childId: link.optionId,
			position,
			priceOverride: link.priceOverride,
			priceWholeOverride: link.priceWholeOverride,
			priceLeftOverride: link.priceLeftOverride,
			priceRightOverride: link.priceRightOverride,
			isDefault: link.isDefault,
		})
	})
	for (const link of index.itemsOfGroup(group.id)) {
		if (!index.item.has(link.itemId)) continue
		ops.push({
			op: 'assign',
			link: 'item_modifier_group',
			parentId: link.itemId,
			childId: newRecordRef('remove'),
			position: link.position + 1,
		})
	}
	return ops
}

function splitApplies(graph: MenuGraph, group: GraphGroup): SplitFacts | null {
	if (!isVisible(group) || group.minSelections !== 0) return null
	const facts = splitFacts(graph, group)
	if (facts.both || facts.removal.length === 0 || facts.addition.length === 0)
		return null
	return facts
}

function detectSplitAddRemove(graph: MenuGraph, ctx: Ctx): MenuCardDraft[] {
	void ctx
	const index = indexMenuGraph(graph)
	const drafts: MenuCardDraft[] = []
	for (const group of graph.groups) {
		const facts = splitApplies(graph, group)
		if (!facts) continue
		if (index.itemsOfGroup(group.id).length === 0) continue
		const ops = buildSplitOps(graph, group, facts)
		if (posOwnedViolation(graph, ops)) continue
		const refs = refsFromOps(graph, ops)
		if (!refs) continue
		const optionRow = (
			link: GraphGroupOption,
			change?: MenuCardPreviewRow['change'],
		): MenuCardPreviewRow => {
			const option = index.option.get(link.optionId)!
			return {
				text: cleanName(graph, option.displayName),
				price: link.priceOverride ?? option.price,
				...(change ? { change } : {}),
			}
		}
		const moved = new Set(facts.removal.map((link) => link.optionId))
		const groupLinks = index.optionsOfGroup(group.id).filter((link) => {
			const option = index.option.get(link.optionId)
			return option && isVisible(option)
		})
		const title = cleanName(graph, group.name)
		drafts.push({
			kind: 'split_add_remove',
			id: menuCardId('split_add_remove', group.id),
			primary: { type: 'modifier_group', id: group.id },
			subject: title,
			refs,
			fingerprint: menuCardFingerprint(refs, {
				removal: facts.removal.map((link) => link.optionId),
				addition: facts.addition.map((link) => link.optionId),
			}),
			params: { groupId: group.id },
			preview: {
				before: [
					{
						entity: 'modifier_group',
						title,
						note: 'optional',
						rows: groupLinks.map((link) => optionRow(link)),
					},
				],
				after: [
					{
						entity: 'modifier_group',
						title,
						rows: groupLinks
							.filter((link) => !moved.has(link.optionId))
							.map((link) => optionRow(link)),
					},
					{
						entity: 'modifier_group',
						title: cleanName(graph, localizedWord(graph, REMOVE_NAME_WORDS)),
						note: 'new',
						rows: facts.removal.map((link) => optionRow(link, 'moved')),
					},
				],
			},
		})
	}
	return drafts
}

function planSplitAddRemove(
	graph: MenuGraph,
	request: MenuCardPlanRequest,
): MenuCardPlanResult {
	const index = indexMenuGraph(graph)
	const groupId = request.params.groupId
	const group =
		typeof groupId === 'string' ? index.group.get(groupId) : undefined
	if (!group || !isVisible(group) || group.minSelections !== 0)
		return { ok: false, error: 'not_applicable' }
	const facts = splitFacts(graph, group)
	if (facts.both) return { ok: false, error: 'option_in_both' }
	if (facts.removal.length === 0 || facts.addition.length === 0)
		return { ok: false, error: 'not_applicable' }
	const ops = buildSplitOps(graph, group, facts)
	if (posOwnedViolation(graph, ops)) return { ok: false, error: 'pos_owned' }
	return { ok: true, ops }
}

// --- 5. make_required --------------------------------------------------------------

const MUST_PICK = new RegExp(
	`${NOT_PRECEDED}(?:sizes?|sauces?|doneness|temperature|cook(?:ed|ing)?|how would you like|choose|choices?|pick|select|base|bread|milk|crust|الحجم|الصوص|اختر|اختيار)${NOT_ALPHANUM}`,
	'iu',
)
const NOT_MUST_PICK = new RegExp(
	`${NOT_PRECEDED}(?:extra|add|optional|اضافي|إضافي)${NOT_ALPHANUM}`,
	'iu',
)
const NONE_OPTION = new RegExp(
	`^(?:none|nothing|no|without)${NOT_ALPHANUM}|^(?:بدون|بلا)${NOT_ALPHANUM}`,
	'iu',
)

function visibleOptionLinks(graph: MenuGraph, groupId: string) {
	const index = indexMenuGraph(graph)
	return index.optionsOfGroup(groupId).filter((link) => {
		const option = index.option.get(link.optionId)
		return option && isVisible(option)
	})
}

function requiredApplies(graph: MenuGraph, group: GraphGroup): boolean {
	if (!isVisible(group) || group.selectionType !== 'single') return false
	if (group.minSelections !== 0) return false
	const links = visibleOptionLinks(graph, group.id)
	if (links.length < 2) return false
	const index = indexMenuGraph(graph)
	for (const link of links) {
		const name = sourceText(graph, index.option.get(link.optionId)!.displayName)
			.normalize('NFKC')
			.trim()
		if (NONE_OPTION.test(name)) return false
	}
	const name = sourceText(graph, group.name).normalize('NFKC')
	return MUST_PICK.test(name) && !NOT_MUST_PICK.test(name)
}

function buildRequiredOps(group: GraphGroup): MenuCardOp[] {
	return [
		{
			op: 'update',
			entity: 'modifier_group',
			id: group.id,
			set: { minSelections: 1 },
		},
	]
}

function detectMakeRequired(graph: MenuGraph, ctx: Ctx): MenuCardDraft[] {
	void ctx
	const index = indexMenuGraph(graph)
	const drafts: MenuCardDraft[] = []
	for (const group of graph.groups) {
		if (!requiredApplies(graph, group)) continue
		const ops = buildRequiredOps(group)
		if (posOwnedViolation(graph, ops)) continue
		const refs = refsFromOps(graph, ops)
		if (!refs) continue
		const title = cleanName(graph, group.name)
		const rows = visibleOptionLinks(graph, group.id).map(
			(link): MenuCardPreviewRow => {
				const option = index.option.get(link.optionId)!
				return {
					text: cleanName(graph, option.displayName),
					price: link.priceOverride ?? option.price,
				}
			},
		)
		drafts.push({
			kind: 'make_required',
			id: menuCardId('make_required', group.id),
			primary: { type: 'modifier_group', id: group.id },
			subject: title,
			refs,
			fingerprint: menuCardFingerprint(refs, {
				min: group.minSelections,
				options: rows.length,
			}),
			params: { groupId: group.id },
			preview: {
				before: [{ entity: 'modifier_group', title, note: 'optional', rows }],
				after: [
					{
						entity: 'modifier_group',
						title,
						note: 'required',
						rows,
					},
				],
			},
		})
	}
	return drafts
}

function planMakeRequired(
	graph: MenuGraph,
	request: MenuCardPlanRequest,
): MenuCardPlanResult {
	const index = indexMenuGraph(graph)
	const groupId = request.params.groupId
	const group =
		typeof groupId === 'string' ? index.group.get(groupId) : undefined
	if (!group || !requiredApplies(graph, group))
		return { ok: false, error: 'not_applicable' }
	const ops = buildRequiredOps(group)
	if (posOwnedViolation(graph, ops)) return { ok: false, error: 'pos_owned' }
	return { ok: true, ops }
}

// --- 6. half_whole_toppings -----------------------------------------------------------

const PIZZA = /pizza|بيتزا/iu
const TOPPING_NAME = new RegExp(
	`${NOT_PRECEDED}(?:toppings?|extras?|add|إضافات)${NOT_ALPHANUM}`,
	'iu',
)

function halfPrice(price: number): number {
	return Math.round((price / 2) * 100) / 100
}

function pizzaApplies(graph: MenuGraph, group: GraphGroup): boolean {
	if (!isVisible(group) || group.selectionType !== 'multiple') return false
	const index = indexMenuGraph(graph)
	const offeredOnPizza = index.itemsOfGroup(group.id).some((link) => {
		const item = index.item.get(link.itemId)
		if (!item || !isVisible(item)) return false
		if (PIZZA.test(sourceText(graph, item.displayName))) return true
		return index.categoriesOfItem(item.id).some((categoryLink) => {
			const category = index.category.get(categoryLink.categoryId)
			return category && PIZZA.test(sourceText(graph, category.displayName))
		})
	})
	if (!offeredOnPizza) return false
	if (TOPPING_NAME.test(sourceText(graph, group.name))) return true
	const links = visibleOptionLinks(graph, group.id)
	if (links.length === 0) return false
	const toppings = links.filter(
		(link) => index.option.get(link.optionId)!.isTopping,
	).length
	return toppings * 2 > links.length
}

function buildPizzaOps(graph: MenuGraph, group: GraphGroup): MenuCardOp[] {
	const index = indexMenuGraph(graph)
	const ops: MenuCardOp[] = [
		{
			op: 'update',
			entity: 'modifier_group',
			id: group.id,
			set: { selectionType: 'pizza' },
		},
	]
	for (const link of index.optionsOfGroup(group.id)) {
		const option = index.option.get(link.optionId)
		if (!option) continue
		if (
			option.priceWhole !== null ||
			option.priceLeft !== null ||
			option.priceRight !== null
		)
			continue
		const half = halfPrice(option.price)
		ops.push({
			op: 'update',
			entity: 'option',
			id: option.id,
			set: { priceWhole: option.price, priceLeft: half, priceRight: half },
		})
	}
	return ops
}

function detectHalfWhole(graph: MenuGraph, ctx: Ctx): MenuCardDraft[] {
	void ctx
	const index = indexMenuGraph(graph)
	const drafts: MenuCardDraft[] = []
	for (const group of graph.groups) {
		if (!pizzaApplies(graph, group)) continue
		const ops = buildPizzaOps(graph, group)
		if (posOwnedViolation(graph, ops)) continue
		const refs = refsFromOps(graph, ops)
		if (!refs) continue
		const title = cleanName(graph, group.name)
		const links = visibleOptionLinks(graph, group.id)
		const changed = new Set(
			ops.flatMap((op) =>
				op.op === 'update' && op.entity === 'option' ? [op.id] : [],
			),
		)
		drafts.push({
			kind: 'half_whole_toppings',
			id: menuCardId('half_whole_toppings', group.id),
			primary: { type: 'modifier_group', id: group.id },
			subject: title,
			refs,
			fingerprint: menuCardFingerprint(refs, { options: links.length }),
			params: { groupId: group.id },
			preview: {
				before: [
					{
						entity: 'modifier_group',
						title,
						note: 'multiple',
						rows: links.map((link) => {
							const option = index.option.get(link.optionId)!
							return {
								text: cleanName(graph, option.displayName),
								price: option.price,
							}
						}),
					},
				],
				after: [
					{
						entity: 'modifier_group',
						title,
						note: 'pizza',
						rows: links.map((link) => {
							const option = index.option.get(link.optionId)!
							const set = changed.has(option.id)
							const whole = set
								? option.price
								: (option.priceWhole ?? option.price)
							const half = set
								? halfPrice(option.price)
								: (option.priceLeft ?? halfPrice(option.price))
							return {
								text: cleanName(graph, option.displayName),
								price: whole,
								detail: `${whole}/${half}`,
								...(set ? { change: 'changed' as const } : {}),
							}
						}),
					},
				],
			},
		})
	}
	return drafts
}

function planHalfWhole(
	graph: MenuGraph,
	request: MenuCardPlanRequest,
): MenuCardPlanResult {
	const index = indexMenuGraph(graph)
	const groupId = request.params.groupId
	const group =
		typeof groupId === 'string' ? index.group.get(groupId) : undefined
	if (!group || !pizzaApplies(graph, group))
		return { ok: false, error: 'not_applicable' }
	const ops = buildPizzaOps(graph, group)
	if (posOwnedViolation(graph, ops)) return { ok: false, error: 'pos_owned' }
	return { ok: true, ops }
}

// --- 7. check_price --------------------------------------------------------------------

type PriceFlag =
	| { case: 'category'; itemId: string; categoryId: string; median: number }
	| { case: 'variant'; itemId: string; variantId: string }

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2
		? sorted[mid]!
		: (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** A larger size priced below a smaller one: the larger variant's id. */
function variantInversion(item: GraphItem): string | null {
	const variations = parseMenuVariations(item.variations)
	for (const [position, group] of variations.groups.entries()) {
		const sizes = group.values.map((value) => ({
			id: value.id,
			info: parseSizeToken(value.name),
		}))
		if (sizes.length < 2 || sizes.some((size) => !size.info)) continue
		const ranked = sizes
			.map((size) => ({ id: size.id, info: size.info! }))
			.sort((a, b) => compareSize(a.info, b.info))
		if (new Set(ranked.map((size) => size.info.unit)).size !== 1) continue
		for (let i = 1; i < ranked.length; i++) {
			const smaller = ranked[i - 1]!
			const larger = ranked[i]!
			if (smaller.info.value === larger.info.value) continue
			for (const variant of variations.variants) {
				if (variant.valueIds[position] !== larger.id) continue
				const partner = variations.variants.find(
					(other) =>
						other.valueIds[position] === smaller.id &&
						other.valueIds.every(
							(id, at) => at === position || id === variant.valueIds[at],
						),
				)
				if (partner && variant.price < partner.price) return variant.id
			}
		}
	}
	return null
}

function priceFlags(graph: MenuGraph): Map<string, PriceFlag> {
	const index = indexMenuGraph(graph)
	const flags = new Map<string, PriceFlag>()
	for (const category of graph.categories) {
		if (!isVisible(category)) continue
		const dishes = index.itemsOfCategory(category.id).flatMap((link) => {
			const item = index.item.get(link.itemId)
			return item && isVisible(item) && item.price > 0 ? [item] : []
		})
		if (dishes.length < 5) continue
		const mid = median(dishes.map((item) => item.price))
		for (const item of dishes) {
			if (flags.has(item.id)) continue
			if (item.price > mid * 4 || item.price < mid / 4)
				flags.set(item.id, {
					case: 'category',
					itemId: item.id,
					categoryId: category.id,
					median: mid,
				})
		}
	}
	for (const item of graph.items) {
		if (!isVisible(item) || flags.has(item.id)) continue
		const variantId = variantInversion(item)
		if (variantId)
			flags.set(item.id, { case: 'variant', itemId: item.id, variantId })
	}
	return flags
}

function detectCheckPrice(graph: MenuGraph, ctx: Ctx): MenuCardDraft[] {
	void ctx
	const index = indexMenuGraph(graph)
	const drafts: MenuCardDraft[] = []
	for (const flag of priceFlags(graph).values()) {
		const item = index.item.get(flag.itemId)!
		// The price and the sizes are a POS dish's own; the import would undo it.
		if (isPosLinked(graph, 'item', item.id)) continue
		const ref = refOf(graph, 'item', item.id)!
		const refs = [ref]
		const title = cleanName(graph, item.displayName)
		const params: Record<string, unknown> =
			flag.case === 'category'
				? { case: 'category', itemId: item.id, categoryId: flag.categoryId }
				: { case: 'variant', itemId: item.id, variantId: flag.variantId }
		const rows: MenuCardPreviewRow[] = [priceRow(graph, item)]
		if (flag.case === 'variant') {
			const variations = parseMenuVariations(item.variations)
			const names = new Map(
				variations.groups.flatMap((group) =>
					group.values.map((value) => [value.id, value.name] as const),
				),
			)
			rows.length = 0
			for (const variant of variations.variants) {
				rows.push({
					text: sanitizeSuggestionText(
						variant.valueIds.map((id) => names.get(id) ?? '').join(' '),
						80,
					),
					price: variant.price,
					...(variant.id === flag.variantId
						? { change: 'changed' as const }
						: {}),
				})
			}
		}
		const before: MenuCardPreviewBlock = { entity: 'item', title, rows }
		drafts.push({
			kind: 'check_price',
			id: menuCardId('check_price', item.id),
			primary: { type: 'item', id: item.id },
			subject: title,
			refs,
			fingerprint: menuCardFingerprint(refs, {
				case: flag.case,
				price: item.price,
				...(flag.case === 'category'
					? { category: flag.categoryId, median: flag.median }
					: { variant: flag.variantId }),
			}),
			params,
			preview: {
				before: [before],
				after: [
					{
						...before,
						rows: rows.map((row) =>
							row.change === 'changed' || flag.case === 'category'
								? { ...row, price: null, change: 'changed' as const }
								: row,
						),
					},
				],
			},
			options: [{ id: 'set_price', code: 'set_price', input: 'price' }],
			defaultOptionId: 'set_price',
		})
	}
	return drafts
}

function parsePriceInput(input: string | undefined): number | null {
	if (typeof input !== 'string') return null
	const text = input.trim()
	if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(text)) return null
	const value = Number(text)
	return Number.isFinite(value) && value >= 0 ? value : null
}

function planCheckPrice(
	graph: MenuGraph,
	request: MenuCardPlanRequest,
): MenuCardPlanResult {
	if (request.optionId !== undefined && request.optionId !== 'set_price')
		return { ok: false, error: 'not_applicable' }
	const index = indexMenuGraph(graph)
	const itemId = request.params.itemId
	const item = typeof itemId === 'string' ? index.item.get(itemId) : undefined
	if (!item || !isVisible(item)) return { ok: false, error: 'not_applicable' }
	const price = parsePriceInput(request.input)
	if (price === null) return { ok: false, error: 'invalid_input' }
	const flag = priceFlags(graph).get(item.id)
	if (!flag || flag.case !== request.params.case)
		return { ok: false, error: 'not_applicable' }
	let ops: MenuCardOp[]
	if (flag.case === 'category') {
		ops = [{ op: 'update', entity: 'item', id: item.id, set: { price } }]
	} else {
		if (request.params.variantId !== flag.variantId)
			return { ok: false, error: 'not_applicable' }
		let raw: { variants?: Array<Record<string, unknown>> }
		try {
			raw = JSON.parse(item.variations) as typeof raw
		} catch {
			return { ok: false, error: 'not_applicable' }
		}
		const variants = (raw.variants ?? []).map((variant) =>
			variant.id === flag.variantId ? { ...variant, price } : variant,
		)
		const next = JSON.stringify({ ...raw, variants })
		if (!MenuVariationsSchema.safeParse(JSON.parse(next)).success)
			return { ok: false, error: 'invalid_input' }
		ops = [
			{ op: 'update', entity: 'item', id: item.id, set: { variations: next } },
		]
	}
	if (posOwnedViolation(graph, ops)) return { ok: false, error: 'pos_owned' }
	return { ok: true, ops }
}

// --- Registry ---------------------------------------------------------------------------

export const STRUCTURE_CARD_KINDS_IMPL: Record<
	MenuStructureCardKind,
	MenuCardKindImpl
> = {
	merge_duplicates: {
		kind: 'merge_duplicates',
		detect: detectMergeDuplicates,
		plan: (graph, request) => planMergeDuplicates(graph, request),
	},
	make_sizes: {
		kind: 'make_sizes',
		detect: detectMakeSizes,
		plan: (graph, request) => planMakeSizes(graph, request),
		ai: {
			instruction:
				'For each group of dishes that differ only by a size word, you may propose a cleaner base name for the merged dish and one short size label per dish, in the same order and the same language as the menu. Names and labels only, no prices or claims.',
			answer: MakeSizesAnswer,
			apply: (draft, answer: z.infer<typeof MakeSizesAnswer>) => {
				const ids = parseIds(draft.params.itemIds) ?? []
				const name = sanitizeSuggestionText(answer.name, NAME_MAX)
				let labels: string[] | null = null
				if (answer.sizeLabels && answer.sizeLabels.length === ids.length) {
					const cleaned = answer.sizeLabels.map((label) =>
						sanitizeSuggestionText(label, 80),
					)
					const unique = new Set(cleaned.map((label) => label.toLowerCase()))
					if (cleaned.every(Boolean) && unique.size === cleaned.length)
						labels = cleaned
				}
				if (!name && !labels) return draft
				const created = draft.preview.after[0]
				return {
					...draft,
					params: {
						...draft.params,
						...(name ? { name } : {}),
						...(labels ? { sizeLabels: labels } : {}),
					},
					subject: name || draft.subject,
					preview: {
						...draft.preview,
						after: created
							? [
									{
										...created,
										title: name || created.title,
										rows: created.rows.map((row, i) => ({
											...row,
											text: labels?.[i] ?? row.text,
										})),
									},
									...draft.preview.after.slice(1),
								]
							: draft.preview.after,
					},
				}
			},
		},
	},
	merge_categories: {
		kind: 'merge_categories',
		detect: detectMergeCategories,
		plan: (graph, request) => planMergeCategories(graph, request),
	},
	split_add_remove: {
		kind: 'split_add_remove',
		detect: detectSplitAddRemove,
		plan: (graph, request) => planSplitAddRemove(graph, request),
	},
	make_required: {
		kind: 'make_required',
		detect: detectMakeRequired,
		plan: (graph, request) => planMakeRequired(graph, request),
	},
	half_whole_toppings: {
		kind: 'half_whole_toppings',
		detect: detectHalfWhole,
		plan: (graph, request) => planHalfWhole(graph, request),
	},
	check_price: {
		kind: 'check_price',
		detect: detectCheckPrice,
		plan: (graph, request) => planCheckPrice(graph, request),
	},
}
