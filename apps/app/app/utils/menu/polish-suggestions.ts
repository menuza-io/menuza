import { MenuVariationsSchema } from '@repo/common/menu-types'
import {
	parseLocalizedString,
	serializeLocalizedString,
} from '@repo/common/site-locales'
import { z } from 'zod'
import {
	type MenuCardDraft,
	type MenuCardKindImpl,
	type MenuCardPlanResult,
} from './menu-card-kinds.ts'
import {
	CAPITAL_STYLES,
	menuCardFingerprint,
	menuCardId,
	newRecordRef,
	type CapitalStyle,
	type MenuCardEntityType,
	type MenuCardOp,
	type MenuCardOption,
	type MenuCardPreview,
	type MenuCardPreviewBlock,
	type MenuCardPreviewRow,
	type MenuCardRef,
	type MenuPolishCardKind,
} from './menu-cards.ts'
import {
	indexMenuGraph,
	isVisible,
	localizedValues,
	sourceText,
	type GraphGroup,
	type GraphItem,
	type GraphOption,
	type MenuGraph,
	type MenuGraphIndex,
} from './menu-graph.ts'
import { nameIsAllCaps } from './menu-health.ts'
import { isPosLinked } from './menu-pos-owned.ts'
import {
	MENU_SUGGESTION_LIMITS,
	sanitizeSuggestionText,
} from './menu-suggestions.ts'
import {
	containsWholeWord,
	editDistance,
	extractChoicePhrase,
	findTypoSuspects,
	isCasedName,
	isKnownMenuWord,
	matchCase,
	matchingCapitalStyles,
	namesOverlap,
	normalizeName,
	replaceWholeWord,
	sortIntoSlots,
	titleCaseWords,
	toCapitalStyle,
	TYPO_MAX_FIXES,
	typoLimit,
	TYPO_MIN_LETTERS,
	type TypoSuspect,
} from './polish-text.ts'
import { CATEGORY_CLASSES, OPTION_SCALES, SIZE_WORDS } from './polish-words.ts'

/**
 * Polish cards (#234): one pure detector and plan per kind, no flag. Read
 * the contract in `menu-card-kinds.ts`. Word lists live in `polish-words.ts`,
 * text rules in `polish-text.ts`.
 *
 * Every plan re-derives what it writes from the current graph and treats
 * `params`, `optionId` and `input` as untrusted. No plan writes allergens,
 * calories or dietary flags, and none deletes.
 */

type Index = MenuGraphIndex
type Draft = MenuCardDraft
type PlanResult = MenuCardPlanResult

const NAME_MAX = MENU_SUGGESTION_LIMITS.name
const CAPITALS_PER_CARD = 30
const NO_STYLE_PER_CARD = 40
const MAX_REFS = 70

const refOf = (
	type: MenuCardEntityType,
	record: { id: string; updatedAt: string },
): MenuCardRef => ({ type, id: record.id, updatedAt: record.updatedAt })

function uniqueRefs(refs: MenuCardRef[]): MenuCardRef[] {
	const seen = new Set<string>()
	return refs.filter((ref) => {
		const key = `${ref.type}:${ref.id}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

const clean = (text: string) => sanitizeSuggestionText(text, NAME_MAX)
const nameOf = (graph: MenuGraph, raw: string | null | undefined) =>
	clean(sourceText(graph, raw))

const ok = (ops: MenuCardOp[]): PlanResult =>
	ops.length > 0 ? { ok: true, ops } : { ok: false, error: 'not_applicable' }
const fail = (
	error: Extract<PlanResult, { ok: false }>['error'],
): PlanResult => ({
	ok: false,
	error,
})

const block = (
	entity: MenuCardEntityType,
	title: string,
	rows: MenuCardPreviewRow[],
	note?: string,
): MenuCardPreviewBlock => ({ entity, title, rows, ...(note ? { note } : {}) })

const preview = (
	before: MenuCardPreviewBlock[],
	after: MenuCardPreviewBlock[],
): MenuCardPreview => ({ before, after })

function visibleOptionsOfGroup(
	graph: MenuGraph,
	index: Index,
	groupId: string,
): Array<{ option: GraphOption; link: MenuGraph['groupOptions'][number] }> {
	void graph
	const out: Array<{
		option: GraphOption
		link: MenuGraph['groupOptions'][number]
	}> = []
	for (const link of index.optionsOfGroup(groupId)) {
		const option = index.option.get(link.optionId)
		if (option && isVisible(option)) out.push({ option, link })
	}
	return out
}

function visibleGroupsOfItem(index: Index, itemId: string): GraphGroup[] {
	const out: GraphGroup[] = []
	for (const link of index.groupsOfItem(itemId)) {
		const group = index.group.get(link.modifierGroupId)
		if (group && isVisible(group)) out.push(group)
	}
	return out
}

function isPaid(
	option: GraphOption,
	link: { priceOverride: number | null },
): boolean {
	return option.price > 0 || (link.priceOverride ?? 0) > 0
}

function groupHasPaidOption(graph: MenuGraph, index: Index, groupId: string) {
	return visibleOptionsOfGroup(graph, index, groupId).some(({ option, link }) =>
		isPaid(option, link),
	)
}

function readParams<T extends z.ZodType>(
	schema: T,
	params: Record<string, unknown>,
): z.infer<T> | null {
	const parsed = schema.safeParse(params)
	return parsed.success ? parsed.data : null
}

const IdSchema = z.string().min(1).max(72)

// ============================================================================
// 1. typo (AI-confirmed only)
// ============================================================================

const TYPO_FIELDS = ['displayName', 'description'] as const
type TypoField = (typeof TYPO_FIELDS)[number]

const TypoParamsSchema = z.object({
	itemId: IdSchema,
	field: z.enum(TYPO_FIELDS),
	locale: z.string().min(2).max(10),
	fixes: z
		.array(
			z.object({
				from: z.string().min(1).max(40),
				to: z.string().min(1).max(40),
			}),
		)
		.min(1)
		.max(TYPO_MAX_FIXES),
})

function typoText(
	graph: MenuGraph,
	item: GraphItem,
	field: TypoField,
	locale: string,
) {
	const raw = field === 'displayName' ? item.displayName : item.description
	const map = parseLocalizedString(raw, graph.defaultLocale)
	return { map, text: map[locale] ?? '' }
}

/** A fix is small: a different word, within the detector's edit distance. */
function isSmallEdit(from: string, to: string): boolean {
	if (!/^[\p{L}'’-]+$/u.test(to)) return false
	const a = from.toLowerCase()
	const b = to.toLowerCase()
	if (a === b) return false
	return editDistance(a, b) <= typoLimit(a)
}

function typoPreview(
	item: GraphItem,
	graph: MenuGraph,
	field: TypoField,
	text: string,
	fixes: TypoSuspect[],
): MenuCardPreview {
	let fixed = text
	for (const fix of fixes) fixed = replaceWholeWord(fixed, fix.from, fix.to)
	const title = nameOf(graph, item.displayName)
	const note = field === 'displayName' ? 'name' : 'description'
	return preview(
		[block('item', title, [{ text: clean(text), change: 'changed' }], note)],
		[block('item', title, [{ text: clean(fixed), change: 'changed' }], note)],
	)
}

function buildTypoDraft(
	graph: MenuGraph,
	item: GraphItem,
	field: TypoField,
	locale: string,
	text: string,
	fixes: TypoSuspect[],
): Draft {
	const refs = [refOf('item', item)]
	const subject = nameOf(graph, item.displayName)
	return {
		kind: 'typo',
		id: menuCardId('typo', item.id),
		primary: { type: 'item', id: item.id },
		subject,
		refs,
		fingerprint: menuCardFingerprint(refs, { field, locale, fixes }),
		params: { itemId: item.id, field, locale, fixes },
		preview: typoPreview(item, graph, field, text, fixes),
		aiData: {
			field,
			locale,
			name: subject,
			description: clean(typoText(graph, item, 'description', locale).text),
			suspects: fixes.map((fix) => fix.from),
		},
		ai: false,
	} as Draft
}

const TypoAnswerSchema = z.object({
	fixes: z
		.array(z.object({ from: z.string(), to: z.string() }))
		.max(TYPO_MAX_FIXES),
})

const typoKind: MenuCardKindImpl = {
	kind: 'typo',
	detect(graph) {
		// The word list is English: other source languages are never judged.
		const locale = graph.defaultLocale
		if (locale !== 'en') return []
		const drafts: Draft[] = []
		for (const item of graph.items) {
			if (!isVisible(item) || isPosLinked(graph, 'item', item.id)) continue
			for (const field of TYPO_FIELDS) {
				const { text } = typoText(graph, item, field, locale)
				if (!text) continue
				const fixes = findTypoSuspects(text)
				if (fixes.length === 0) continue
				drafts.push(buildTypoDraft(graph, item, field, locale, text, fixes))
				break
			}
		}
		return drafts
	},
	ai: {
		required: true,
		instruction:
			'Confirm which suspected misspellings are real typos in this menu text and give the corrected word; a dish or brand name in another language or a transliteration is not a typo.',
		answer: TypoAnswerSchema,
		apply(draft, answer: z.infer<typeof TypoAnswerSchema>) {
			const params = readParams(TypoParamsSchema, draft.params)
			if (!params) return null
			const suspects = new Map(
				params.fixes.map((fix) => [fix.from.toLowerCase(), fix.from]),
			)
			const kept = new Map<string, TypoSuspect>()
			for (const fix of answer.fixes) {
				const from = suspects.get(fix.from.trim().toLowerCase())
				if (!from) continue
				const to = sanitizeSuggestionText(fix.to, 40)
				if (!to || !isSmallEdit(from, to)) continue
				kept.set(from.toLowerCase(), { from, to: matchCase(from, to) })
			}
			if (kept.size === 0) return null
			const fixes = [...kept.values()]
			const original = draft.preview.before[0]?.rows[0]?.text ?? ''
			let fixed = original
			for (const fix of fixes) fixed = replaceWholeWord(fixed, fix.from, fix.to)
			const after = draft.preview.after.map((entry, i) =>
				i === 0
					? {
							...entry,
							rows: [{ text: clean(fixed), change: 'changed' as const }],
						}
					: entry,
			)
			return {
				...draft,
				params: { ...draft.params, fixes },
				preview: { before: draft.preview.before, after },
				fingerprint: menuCardFingerprint(draft.refs, {
					field: params.field,
					locale: params.locale,
					fixes,
				}),
			}
		},
	},
	plan(graph, request) {
		const params = readParams(TypoParamsSchema, request.params)
		if (!params) return fail('invalid_input')
		const item = indexMenuGraph(graph).item.get(params.itemId)
		if (!item || !isVisible(item)) return fail('stale_suggestion')
		const { map, text } = typoText(graph, item, params.field, params.locale)
		if (!text) return fail('not_applicable')
		let next = text
		for (const fix of params.fixes) {
			const to = sanitizeSuggestionText(fix.to, 40)
			if (
				fix.from.length < TYPO_MIN_LETTERS ||
				isKnownMenuWord(fix.from) ||
				!to ||
				!isSmallEdit(fix.from, to) ||
				!containsWholeWord(next, fix.from)
			) {
				return fail('invalid_input')
			}
			next = replaceWholeWord(next, fix.from, to)
		}
		if (next === text) return fail('not_applicable')
		const value = serializeLocalizedString({ ...map, [params.locale]: next })
		return ok([
			{
				op: 'update',
				entity: 'item',
				id: item.id,
				set:
					params.field === 'displayName'
						? { displayName: value }
						: { description: value },
			},
		])
	},
}

// ============================================================================
// 2. capitals
// ============================================================================

const CapitalsParamsSchema = z.object({
	categoryId: IdSchema,
	itemIds: z.array(IdSchema).min(1).max(CAPITALS_PER_CARD),
})

function sourceNameOf(graph: MenuGraph, item: GraphItem) {
	const map = parseLocalizedString(item.displayName, graph.defaultLocale)
	const name = map[graph.defaultLocale]
	return { map, name: typeof name === 'string' ? name : null }
}

/**
 * `upper` is never offered or chosen: an all-caps name is flagged by the
 * `name_all_caps` health check, so accepting it would lower the grade. A
 * stored `upper` setting counts as no setting.
 */
const OFFERED_STYLES: readonly CapitalStyle[] = CAPITAL_STYLES.filter(
	(style) => style !== 'upper',
)

function savedCapitalStyle(ctx: {
	settings: { capitalStyle?: CapitalStyle | null }
}): CapitalStyle | null {
	const style = ctx.settings.capitalStyle
	return style && style !== 'upper' ? style : null
}

function majorityCapitalStyle(graph: MenuGraph): CapitalStyle | null {
	const votes: Record<CapitalStyle, number> = {
		title: 0,
		sentence: 0,
		upper: 0,
	}
	let any = false
	for (const item of graph.items) {
		if (!isVisible(item)) continue
		const { name } = sourceNameOf(graph, item)
		if (!name || !isCasedName(name)) continue
		const styles = matchingCapitalStyles(name)
		if (styles.length !== 1) continue
		if (styles[0] === 'upper') continue
		votes[styles[0]!] += 1
		any = true
	}
	if (!any) return null
	return OFFERED_STYLES.reduce((best, style) =>
		votes[style] > votes[best] ? style : best,
	)
}

function capitalsPreview(
	title: string,
	changes: Array<{ from: string; to: string }>,
): MenuCardPreview {
	return preview(
		[
			block(
				'category',
				title,
				changes.map((change) => ({
					text: clean(change.from),
					change: 'changed' as const,
				})),
			),
		],
		[
			block(
				'category',
				title,
				changes.map((change) => ({
					text: clean(change.to),
					change: 'changed' as const,
				})),
			),
		],
	)
}

const capitalsKind: MenuCardKindImpl = {
	kind: 'capitals',
	detect(graph, ctx) {
		const index = indexMenuGraph(graph)
		const saved = savedCapitalStyle(ctx)
		const target = saved ?? majorityCapitalStyle(graph)
		if (!target) return []
		const claimed = new Set<string>()
		const drafts: Draft[] = []
		for (const category of graph.categories) {
			if (!isVisible(category)) continue
			const dishes: GraphItem[] = []
			for (const link of index.itemsOfCategory(category.id)) {
				const item = index.item.get(link.itemId)
				if (!item || !isVisible(item) || claimed.has(item.id)) continue
				const { name } = sourceNameOf(graph, item)
				if (!name || !isCasedName(name)) continue
				const next = toCapitalStyle(name, target)
				if (next === name || nameIsAllCaps(next)) continue
				if (isPosLinked(graph, 'item', item.id)) continue
				dishes.push(item)
				if (dishes.length >= CAPITALS_PER_CARD) break
			}
			if (dishes.length === 0) continue
			for (const item of dishes) claimed.add(item.id)
			const refs = uniqueRefs([
				refOf('category', category),
				...dishes.map((item) => refOf('item', item)),
			])
			const title = nameOf(graph, category.displayName)
			const changesFor = (style: CapitalStyle) =>
				dishes.map((item) => {
					const name = sourceNameOf(graph, item).name ?? ''
					return { from: name, to: toCapitalStyle(name, style) }
				})
			const options: MenuCardOption[] | undefined = saved
				? undefined
				: OFFERED_STYLES.map((style) => ({
						id: style,
						code: style,
						preview: capitalsPreview(title, changesFor(style)),
					}))
			drafts.push({
				kind: 'capitals',
				id: menuCardId('capitals', category.id),
				primary: { type: 'category', id: category.id },
				subject: title,
				refs,
				fingerprint: menuCardFingerprint(refs, {
					target,
					itemIds: dishes.map((item) => item.id),
				}),
				params: {
					categoryId: category.id,
					itemIds: dishes.map((item) => item.id),
				},
				preview: capitalsPreview(title, changesFor(target)),
				...(options ? { options, defaultOptionId: target } : {}),
				ai: false,
			} as Draft)
		}
		return drafts
	},
	plan(graph, request, ctx) {
		const params = readParams(CapitalsParamsSchema, request.params)
		if (!params) return fail('invalid_input')
		const index = indexMenuGraph(graph)
		const category = index.category.get(params.categoryId)
		if (!category || !isVisible(category)) return fail('stale_suggestion')
		const style =
			savedCapitalStyle(ctx) ??
			OFFERED_STYLES.find((candidate) => candidate === request.optionId)
		if (!style) return fail('invalid_input')
		const inCategory = new Set(
			index.itemsOfCategory(category.id).map((link) => link.itemId),
		)
		const ops: MenuCardOp[] = []
		for (const id of new Set(params.itemIds)) {
			const item = index.item.get(id)
			if (!item || !isVisible(item) || !inCategory.has(id)) {
				return fail('stale_suggestion')
			}
			const { map, name } = sourceNameOf(graph, item)
			if (!name || !isCasedName(name)) continue
			const next = toCapitalStyle(name, style)
			if (next === name || nameIsAllCaps(next)) continue
			ops.push({
				op: 'update',
				entity: 'item',
				id,
				set: {
					displayName: serializeLocalizedString({
						...map,
						[graph.defaultLocale]: next,
					}),
				},
			})
		}
		return ok(ops)
	},
}

// ============================================================================
// 3. missing_choice
// ============================================================================

const MissingChoiceParamsSchema = z.object({
	itemId: IdSchema,
	locale: z.string().min(2).max(10),
	phrase: z.string().min(1).max(40),
})

/** The first locale (source first) whose description names a choice. */
function choiceOfItem(
	graph: MenuGraph,
	item: GraphItem,
): { locale: string; phrase: string } | null {
	const values = localizedValues(graph, item.description)
	const locales = [
		graph.defaultLocale,
		...graph.locales.filter((locale) => locale !== graph.defaultLocale),
	]
	for (const locale of locales) {
		const text = values[locale]
		if (!text) continue
		const phrase = extractChoicePhrase(text, locale)
		if (phrase) return { locale, phrase }
	}
	return null
}

function choiceCandidates(
	graph: MenuGraph,
	index: Index,
	item: GraphItem,
	phrase: string,
) {
	const onItem = new Set(
		index.groupsOfItem(item.id).map((link) => link.modifierGroupId),
	)
	return graph.groups.filter(
		(group) =>
			isVisible(group) &&
			!onItem.has(group.id) &&
			namesOverlap(sourceText(graph, group.name), phrase),
	)
}

function dishGroupRows(
	index: Index,
	item: GraphItem,
	graph: MenuGraph,
): MenuCardPreviewRow[] {
	return visibleGroupsOfItem(index, item.id).map((group) => ({
		text: nameOf(graph, group.name),
		detail: group.minSelections >= 1 ? 'required' : 'optional',
	}))
}

function choicePreview(
	graph: MenuGraph,
	index: Index,
	item: GraphItem,
	added: { text: string; detail: string },
): MenuCardPreview {
	const title = nameOf(graph, item.displayName)
	const rows = dishGroupRows(index, item, graph)
	return preview(
		[block('item', title, rows)],
		[block('item', title, [...rows, { ...added, change: 'added' }])],
	)
}

function nextPosition(index: Index, itemId: string): number {
	return index
		.groupsOfItem(itemId)
		.reduce((max, link) => Math.max(max, link.position + 1), 0)
}

const missingChoiceKind: MenuCardKindImpl = {
	kind: 'missing_choice',
	detect(graph) {
		const index = indexMenuGraph(graph)
		const drafts: Draft[] = []
		for (const item of graph.items) {
			if (!isVisible(item) || isPosLinked(graph, 'item', item.id)) continue
			const choice = choiceOfItem(graph, item)
			if (!choice) continue
			const phrase = clean(choice.phrase)
			if (!phrase) continue
			const has = visibleGroupsOfItem(index, item.id).some((group) =>
				namesOverlap(sourceText(graph, group.name), phrase),
			)
			if (has) continue
			const candidates = choiceCandidates(graph, index, item, phrase)
			const groupName = titleCaseWords(phrase)
			const refs = uniqueRefs([
				refOf('item', item),
				...candidates.map((group) => refOf('modifier_group', group)),
			])
			const options: MenuCardOption[] = [
				...candidates.map((group) => ({
					id: `attach:${group.id}`,
					code: 'attach',
					subject: nameOf(graph, group.name),
					preview: choicePreview(graph, index, item, {
						text: nameOf(graph, group.name),
						detail: group.minSelections >= 1 ? 'required' : 'optional',
					}),
				})),
				{
					id: 'create',
					code: 'create',
					subject: groupName,
					warnings: ['empty_group'],
					preview: choicePreview(graph, index, item, {
						text: groupName,
						detail: 'hidden',
					}),
				},
			]
			const defaultOption = options[0]!
			drafts.push({
				kind: 'missing_choice',
				id: menuCardId('missing_choice', item.id),
				primary: { type: 'item', id: item.id },
				subject: nameOf(graph, item.displayName),
				refs,
				fingerprint: menuCardFingerprint(refs, {
					locale: choice.locale,
					phrase,
				}),
				params: { itemId: item.id, locale: choice.locale, phrase },
				preview: defaultOption.preview!,
				options,
				defaultOptionId: defaultOption.id,
				...(defaultOption.warnings ? { warnings: defaultOption.warnings } : {}),
				ai: false,
			} as Draft)
		}
		return drafts
	},
	plan(graph, request) {
		const params = readParams(MissingChoiceParamsSchema, request.params)
		if (!params) return fail('invalid_input')
		const index = indexMenuGraph(graph)
		const item = index.item.get(params.itemId)
		if (!item || !isVisible(item)) return fail('stale_suggestion')
		const phrase = clean(params.phrase)
		const current = extractChoicePhrase(
			localizedValues(graph, item.description)[params.locale] ?? '',
			params.locale,
		)
		if (!phrase || !current || clean(current) !== phrase) {
			return fail('not_applicable')
		}
		const present = visibleGroupsOfItem(index, item.id).some((group) =>
			namesOverlap(sourceText(graph, group.name), phrase),
		)
		if (present) return fail('not_applicable')
		const position = nextPosition(index, item.id)
		const optionId = request.optionId ?? ''
		if (optionId === 'create') {
			const name = titleCaseWords(phrase)
			return ok([
				{
					op: 'insert',
					entity: 'modifier_group',
					tempId: 'choice',
					values: {
						name,
						selectionType: 'single',
						// Optional and hidden until it has options: a visible
						// required group with none makes the dish impossible to order.
						minSelections: 0,
						maxSelections: 1,
						availabilityStatus: 'hidden',
					},
				},
				{
					op: 'assign',
					link: 'item_modifier_group',
					parentId: item.id,
					childId: newRecordRef('choice'),
					position,
				},
			])
		}
		if (optionId.startsWith('attach:')) {
			const group = choiceCandidates(graph, index, item, phrase).find(
				(candidate) => candidate.id === optionId.slice('attach:'.length),
			)
			if (!group) return fail('invalid_input')
			return ok([
				{
					op: 'assign',
					link: 'item_modifier_group',
					parentId: item.id,
					childId: group.id,
					position,
				},
			])
		}
		return fail('invalid_input')
	},
}

// ============================================================================
// 4. selection_limits
// ============================================================================

const GroupParamsSchema = z.object({ groupId: IdSchema })

type LimitFix = 'make_multiple' | 'max_one' | 'make_single'

function limitFixes(group: GraphGroup): LimitFix[] {
	if (
		group.selectionType === 'single' &&
		group.maxSelections !== null &&
		group.maxSelections > 1
	) {
		return ['make_multiple', 'max_one']
	}
	if (group.selectionType === 'multiple' && group.maxSelections === 1) {
		return ['make_single']
	}
	return []
}

function limitSet(fix: LimitFix) {
	switch (fix) {
		case 'make_multiple':
			return { selectionType: 'multiple' as const }
		case 'max_one':
			return { maxSelections: 1 }
		case 'make_single':
			return { selectionType: 'single' as const, maxSelections: null }
	}
}

function limitsPreview(
	graph: MenuGraph,
	index: Index,
	group: GraphGroup,
	fix: LimitFix,
): MenuCardPreview {
	const title = nameOf(graph, group.name)
	const rows = visibleOptionsOfGroup(graph, index, group.id).map(
		({ option, link }) => ({
			text: nameOf(graph, option.displayName),
			price: link.priceOverride ?? option.price,
		}),
	)
	const set = { ...group, ...limitSet(fix) }
	const describe = (g: {
		selectionType: string
		maxSelections: number | null
	}) =>
		g.maxSelections === null
			? g.selectionType
			: `${g.selectionType} max ${g.maxSelections}`
	return preview(
		[block('modifier_group', title, rows, describe(group))],
		[block('modifier_group', title, rows, describe(set))],
	)
}

const selectionLimitsKind: MenuCardKindImpl = {
	kind: 'selection_limits',
	detect(graph) {
		const index = indexMenuGraph(graph)
		const drafts: Draft[] = []
		for (const group of graph.groups) {
			if (!isVisible(group) || isPosLinked(graph, 'modifier_group', group.id)) {
				continue
			}
			const fixes = limitFixes(group)
			if (fixes.length === 0) continue
			const refs = [refOf('modifier_group', group)]
			drafts.push({
				kind: 'selection_limits',
				id: menuCardId('selection_limits', group.id),
				primary: { type: 'modifier_group', id: group.id },
				subject: nameOf(graph, group.name),
				refs,
				fingerprint: menuCardFingerprint(refs, {
					type: group.selectionType,
					max: group.maxSelections,
				}),
				params: { groupId: group.id },
				preview: limitsPreview(graph, index, group, fixes[0]!),
				options: fixes.map((fix) => ({
					id: fix,
					code: fix,
					preview: limitsPreview(graph, index, group, fix),
				})),
				defaultOptionId: fixes[0],
				ai: false,
			} as Draft)
		}
		return drafts
	},
	plan(graph, request) {
		const params = readParams(GroupParamsSchema, request.params)
		if (!params) return fail('invalid_input')
		const group = indexMenuGraph(graph).group.get(params.groupId)
		if (!group || !isVisible(group)) return fail('stale_suggestion')
		const fixes = limitFixes(group)
		if (fixes.length === 0) return fail('not_applicable')
		const fix = fixes.find((candidate) => candidate === request.optionId)
		if (!fix) return fail('invalid_input')
		return ok([
			{
				op: 'update',
				entity: 'modifier_group',
				id: group.id,
				set: limitSet(fix),
			},
		])
	},
}

// ============================================================================
// 5. required_first
// ============================================================================

const ItemParamsSchema = z.object({ itemId: IdSchema })

/** Links of a dish by position, required visible groups first, else stable. */
function requiredFirstOrder(index: Index, itemId: string) {
	const links = index.groupsOfItem(itemId)
	const isRequired = (link: (typeof links)[number]) => {
		const group = index.group.get(link.modifierGroupId)
		return Boolean(group && isVisible(group) && group.minSelections >= 1)
	}
	const sorted = [
		...links.filter((link) => isRequired(link)),
		...links.filter((link) => !isRequired(link)),
	]
	const broken = sorted.some((link, i) => link !== links[i])
	return { links, sorted, broken, isRequired }
}

const requiredFirstKind: MenuCardKindImpl = {
	kind: 'required_first',
	detect(graph) {
		const index = indexMenuGraph(graph)
		const drafts: Draft[] = []
		for (const item of graph.items) {
			if (!isVisible(item) || isPosLinked(graph, 'item', item.id)) continue
			const { links, sorted, broken, isRequired } = requiredFirstOrder(
				index,
				item.id,
			)
			if (!broken || links.length < 2 || links.length > MAX_REFS) continue
			const refs = uniqueRefs([
				refOf('item', item),
				...links.flatMap((link) => {
					const group = index.group.get(link.modifierGroupId)
					return group ? [refOf('modifier_group', group)] : []
				}),
			])
			const row = (
				link: (typeof links)[number],
				moved: boolean,
			): MenuCardPreviewRow => ({
				text: nameOf(graph, index.group.get(link.modifierGroupId)?.name),
				detail: isRequired(link) ? 'required' : 'optional',
				...(moved ? { change: 'moved' as const } : {}),
			})
			const title = nameOf(graph, item.displayName)
			drafts.push({
				kind: 'required_first',
				id: menuCardId('required_first', item.id),
				primary: { type: 'item', id: item.id },
				subject: title,
				refs,
				fingerprint: menuCardFingerprint(refs, {
					order: links.map((link) => link.modifierGroupId),
				}),
				params: { itemId: item.id },
				preview: preview(
					[
						block(
							'item',
							title,
							links.map((link) => row(link, false)),
						),
					],
					[
						block(
							'item',
							title,
							sorted.map((link, i) => row(link, link !== links[i])),
						),
					],
				),
				ai: false,
			} as Draft)
		}
		return drafts
	},
	plan(graph, request) {
		const params = readParams(ItemParamsSchema, request.params)
		if (!params) return fail('invalid_input')
		const index = indexMenuGraph(graph)
		const item = index.item.get(params.itemId)
		if (!item || !isVisible(item)) return fail('stale_suggestion')
		const { sorted, broken } = requiredFirstOrder(index, item.id)
		if (!broken) return fail('not_applicable')
		return ok(
			sorted.map((link, position) => ({
				op: 'assign' as const,
				link: 'item_modifier_group' as const,
				parentId: item.id,
				childId: link.modifierGroupId,
				position,
			})),
		)
	},
}

// ============================================================================
// 6. option_order
// ============================================================================

/** The scale every name belongs to, with a rank per name, or null. */
function scaleRanks(names: string[]): number[] | null {
	for (const scale of OPTION_SCALES) {
		const ranks: number[] = []
		for (const name of names) {
			const rank = scale.steps.findIndex((step) =>
				step.some((word) => normalizeName(word) === name),
			)
			if (rank === -1) break
			ranks.push(rank)
		}
		if (ranks.length === names.length) return ranks
	}
	return null
}

function optionOrder(graph: MenuGraph, index: Index, groupId: string) {
	const links = index.optionsOfGroup(groupId)
	const visible = links.filter((link) => {
		const option = index.option.get(link.optionId)
		return Boolean(option && isVisible(option))
	})
	if (visible.length < 2) return null
	const names = visible.map((link) =>
		normalizeName(nameOf(graph, index.option.get(link.optionId)?.displayName)),
	)
	const ranks = scaleRanks(names)
	if (!ranks) return null
	const rankOf = new Map(visible.map((link, i) => [link, ranks[i]!]))
	const sorted = sortIntoSlots(links, (link) => rankOf.get(link) ?? null)
	const broken = sorted.some((link, i) => link !== links[i])
	return broken ? { links, sorted } : null
}

const optionOrderKind: MenuCardKindImpl = {
	kind: 'option_order',
	detect(graph) {
		const index = indexMenuGraph(graph)
		const drafts: Draft[] = []
		for (const group of graph.groups) {
			if (!isVisible(group) || isPosLinked(graph, 'modifier_group', group.id)) {
				continue
			}
			const order = optionOrder(graph, index, group.id)
			if (!order || order.links.length > MAX_REFS) continue
			const refs = uniqueRefs([
				refOf('modifier_group', group),
				...order.links.flatMap((link) => {
					const option = index.option.get(link.optionId)
					return option ? [refOf('option', option)] : []
				}),
			])
			const row = (
				link: (typeof order.links)[number],
				moved: boolean,
			): MenuCardPreviewRow => {
				const option = index.option.get(link.optionId)
				return {
					text: nameOf(graph, option?.displayName),
					price: link.priceOverride ?? option?.price ?? 0,
					...(moved ? { change: 'moved' as const } : {}),
				}
			}
			const title = nameOf(graph, group.name)
			drafts.push({
				kind: 'option_order',
				id: menuCardId('option_order', group.id),
				primary: { type: 'modifier_group', id: group.id },
				subject: title,
				refs,
				fingerprint: menuCardFingerprint(refs, {
					order: order.links.map((link) => link.optionId),
				}),
				params: { groupId: group.id },
				preview: preview(
					[
						block(
							'modifier_group',
							title,
							order.links.map((link) => row(link, false)),
						),
					],
					[
						block(
							'modifier_group',
							title,
							order.sorted.map((link, i) => row(link, link !== order.links[i])),
						),
					],
				),
				ai: false,
			} as Draft)
		}
		return drafts
	},
	plan(graph, request) {
		const params = readParams(GroupParamsSchema, request.params)
		if (!params) return fail('invalid_input')
		const index = indexMenuGraph(graph)
		const group = index.group.get(params.groupId)
		if (!group || !isVisible(group)) return fail('stale_suggestion')
		const order = optionOrder(graph, index, group.id)
		if (!order) return fail('not_applicable')
		return ok(
			order.sorted.map((link, position) => ({
				op: 'assign' as const,
				link: 'group_option' as const,
				parentId: group.id,
				childId: link.optionId,
				position,
			})),
		)
	},
}

// ============================================================================
// 7. no_option_style
// ============================================================================

const NO_STYLES = ['no', 'without', 'hold'] as const
type NoStyle = (typeof NO_STYLES)[number]
const NO_PATTERN = /^(no|without|hold)\s+(\S.*)$/i

function noParts(name: string): { style: NoStyle; rest: string } | null {
	const match = NO_PATTERN.exec(name.trim())
	if (!match) return null
	return { style: match[1]!.toLowerCase() as NoStyle, rest: match[2]!.trim() }
}

function restyleNo(name: string, target: NoStyle): string | null {
	const parts = noParts(name)
	if (!parts || parts.style === target) return null
	let rest = parts.rest
	if (target === 'no') rest = rest.replace(/^(?:the|any)\s+/i, '')
	const capital = name.trim()[0] !== name.trim()[0]!.toLowerCase()
	const prefix = capital
		? target.charAt(0).toUpperCase() + target.slice(1)
		: target
	const next = clean(`${prefix} ${rest}`)
	return next && next !== name.trim() ? next : null
}

function optionRename(
	graph: MenuGraph,
	option: GraphOption,
	next: string,
): string {
	if (!option.displayName.trim().startsWith('{')) return next
	const map = parseLocalizedString(option.displayName, graph.defaultLocale)
	return serializeLocalizedString({ ...map, [graph.defaultLocale]: next })
}

/** The option's name in the default locale only, never a fallback. */
function sourceOptionName(
	graph: MenuGraph,
	option: GraphOption,
): string | null {
	const map = parseLocalizedString(option.displayName, graph.defaultLocale)
	const name = map[graph.defaultLocale]
	return typeof name === 'string' && name.trim() ? name : null
}

function noStyleFacts(graph: MenuGraph) {
	const counts: Record<NoStyle, number> = { no: 0, without: 0, hold: 0 }
	const entries: Array<{ option: GraphOption; name: string; style: NoStyle }> =
		[]
	for (const option of graph.options) {
		if (!isVisible(option)) continue
		const name = sourceOptionName(graph, option)
		if (!name) continue
		const parts = noParts(name)
		if (!parts) continue
		counts[parts.style] += 1
		entries.push({ option, name, style: parts.style })
	}
	const used = NO_STYLES.filter((style) => counts[style] > 0)
	if (used.length < 2) return null
	const majority = NO_STYLES.reduce((best, style) =>
		counts[style] > counts[best] ? style : best,
	)
	return { entries, majority }
}

const NoStyleParamsSchema = z.object({
	optionIds: z.array(IdSchema).min(1).max(NO_STYLE_PER_CARD),
	prefix: z.enum(NO_STYLES),
})

const noOptionStyleKind: MenuCardKindImpl = {
	kind: 'no_option_style',
	detect(graph, ctx) {
		// The prefixes are English words: other languages are never judged.
		if (ctx.defaultLocale !== 'en' || graph.defaultLocale !== 'en') return []
		const facts = noStyleFacts(graph)
		if (!facts) return []
		const minority = facts.entries
			.filter(
				(entry) =>
					entry.style !== facts.majority &&
					!isPosLinked(graph, 'option', entry.option.id),
			)
			.slice(0, NO_STYLE_PER_CARD)
		if (minority.length === 0) return []
		const changes = minority.flatMap((entry) => {
			const to = restyleNo(entry.name, facts.majority)
			return to ? [{ entry, to }] : []
		})
		if (changes.length === 0) return []
		const refs = uniqueRefs(
			changes.map(({ entry }) => refOf('option', entry.option)),
		)
		const primary = changes[0]!.entry.option
		return [
			{
				kind: 'no_option_style',
				id: menuCardId(
					'no_option_style',
					primary.id,
					changes.slice(1).map(({ entry }) => entry.option.id),
				),
				primary: { type: 'option', id: primary.id },
				subject: changes[0]!.entry.name,
				refs,
				fingerprint: menuCardFingerprint(refs, {
					prefix: facts.majority,
					names: changes.map(({ entry }) => entry.name),
				}),
				params: {
					optionIds: changes.map(({ entry }) => entry.option.id),
					prefix: facts.majority,
				},
				preview: preview(
					[
						block(
							'option',
							facts.majority,
							changes.map(({ entry }) => ({
								text: entry.name,
								change: 'changed' as const,
							})),
						),
					],
					[
						block(
							'option',
							facts.majority,
							changes.map(({ to }) => ({
								text: to,
								change: 'changed' as const,
							})),
						),
					],
				),
				ai: false,
			} as Draft,
		]
	},
	plan(graph, request, ctx) {
		const params = readParams(NoStyleParamsSchema, request.params)
		if (!params) return fail('invalid_input')
		if (ctx.defaultLocale !== 'en' || graph.defaultLocale !== 'en') {
			return fail('not_applicable')
		}
		const index = indexMenuGraph(graph)
		const ops: MenuCardOp[] = []
		for (const id of new Set(params.optionIds)) {
			const option = index.option.get(id)
			if (!option || !isVisible(option)) return fail('stale_suggestion')
			const name = sourceOptionName(graph, option)
			if (!name) continue
			const next = restyleNo(name, params.prefix)
			if (!next) continue
			ops.push({
				op: 'update',
				entity: 'option',
				id,
				set: { displayName: optionRename(graph, option, next) },
			})
		}
		return ok(ops)
	},
}

// ============================================================================
// 8. free_dish
// ============================================================================

function variantPricesAreZero(item: GraphItem): boolean {
	try {
		const parsed: unknown = JSON.parse(item.variations || '{}')
		const variants =
			parsed && typeof parsed === 'object' && 'variants' in parsed
				? (parsed as { variants: unknown }).variants
				: []
		if (!Array.isArray(variants)) return true
		return variants.every((variant) => {
			const price = (variant as { price?: unknown } | null)?.price
			return typeof price !== 'number' || price === 0
		})
	} catch {
		return true
	}
}

function freeDishFacts(graph: MenuGraph, index: Index, item: GraphItem) {
	if (item.price !== 0 || !variantPricesAreZero(item)) return null
	const groups = visibleGroupsOfItem(index, item.id)
	const paid = groups.filter((group) =>
		groupHasPaidOption(graph, index, group.id),
	)
	// A required group with a paid option means the dish is never free.
	if (paid.some((group) => group.minSelections >= 1)) return null
	const optionalPaid = paid.filter(
		(group) => group.minSelections < 1 && group.maxSelections !== 0,
	)
	if (paid.length === 0) return null
	const onDish = new Set(
		index.groupsOfItem(item.id).map((link) => link.modifierGroupId),
	)
	const attachable = graph.groups
		.filter(
			(group) =>
				isVisible(group) &&
				group.minSelections >= 1 &&
				!onDish.has(group.id) &&
				groupHasPaidOption(graph, index, group.id),
		)
		.slice(0, 5)
	return { groups, paid, optionalPaid, attachable }
}

function sharedGroup(index: Index, groupId: string, itemId: string): boolean {
	return index.itemsOfGroup(groupId).some((link) => {
		if (link.itemId === itemId) return false
		const other = index.item.get(link.itemId)
		return Boolean(other && isVisible(other))
	})
}

/**
 * The variations JSON with every size priced `price`, everything else kept.
 * `null` when it cannot be rewritten into a valid `MenuVariations`.
 */
function pricedVariations(item: GraphItem, price: number): string | null | '' {
	let parsed: unknown
	try {
		parsed = JSON.parse(item.variations || '{}')
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== 'object') return ''
	const record = parsed as { variants?: unknown }
	if (!Array.isArray(record.variants) || record.variants.length === 0) return ''
	const next = {
		...record,
		variants: record.variants.map((variant: unknown) =>
			variant && typeof variant === 'object' ? { ...variant, price } : variant,
		),
	}
	if (!MenuVariationsSchema.safeParse(next).success) return null
	return JSON.stringify(next)
}

function parsePrice(input: string | undefined): number | null {
	if (typeof input !== 'string') return null
	const text = input.trim().replace(/,/g, '.')
	if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null
	const value = Number(text)
	// Zero is refused: it would leave the dish free.
	return Number.isFinite(value) && value > 0 && value <= 1_000_000
		? value
		: null
}

function sizeWords(graph: MenuGraph) {
	return SIZE_WORDS[graph.defaultLocale] ?? SIZE_WORDS.en!
}

const freeDishKind: MenuCardKindImpl = {
	kind: 'free_dish',
	detect(graph) {
		const index = indexMenuGraph(graph)
		const drafts: Draft[] = []
		for (const item of graph.items) {
			// The default fix writes the price, which a POS owns.
			if (!isVisible(item) || isPosLinked(graph, 'item', item.id)) continue
			const facts = freeDishFacts(graph, index, item)
			if (!facts) continue
			const title = nameOf(graph, item.displayName)
			const groupRow = (
				group: GraphGroup | { name: string },
				detail: string,
				change?: 'added' | 'changed',
			) => ({
				text: nameOf(graph, group.name),
				detail,
				...(change ? { change } : {}),
			})
			const baseRows: MenuCardPreviewRow[] = [
				{ text: title, price: 0 },
				...facts.groups.map((group) =>
					groupRow(group, group.minSelections >= 1 ? 'required' : 'optional'),
				),
			]
			const before = [block('item', title, baseRows)]
			const options: MenuCardOption[] = [
				{
					id: 'set_price',
					code: 'set_price',
					input: 'price',
					preview: preview(before, [
						block('item', title, [
							{ text: title, price: null, change: 'changed' },
							...baseRows.slice(1),
						]),
					]),
				},
				...facts.optionalPaid
					.filter((group) => !isPosLinked(graph, 'modifier_group', group.id))
					.map((group) => ({
						id: `require:${group.id}`,
						code: 'require',
						subject: nameOf(graph, group.name),
						...(sharedGroup(index, group.id, item.id)
							? { warnings: ['shared_group'] }
							: {}),
						preview: preview(before, [
							block('item', title, [
								baseRows[0]!,
								...facts.groups.map((g) =>
									g.id === group.id
										? groupRow(g, 'required', 'changed')
										: groupRow(
												g,
												g.minSelections >= 1 ? 'required' : 'optional',
											),
								),
							]),
						]),
					})),
				...facts.attachable.map((group) => ({
					id: `attach:${group.id}`,
					code: 'attach',
					subject: nameOf(graph, group.name),
					preview: preview(before, [
						block('item', title, [
							...baseRows,
							groupRow(group, 'required', 'added'),
						]),
					]),
				})),
				{
					id: 'add_group',
					code: 'add_group',
					input: 'price',
					subject: sizeWords(graph).size,
					preview: preview(before, [
						block('item', title, [
							...baseRows,
							groupRow({ name: sizeWords(graph).size }, 'required', 'added'),
							{ text: sizeWords(graph).regular, price: null, change: 'added' },
						]),
					]),
				},
			]
			const refs = uniqueRefs([
				refOf('item', item),
				...facts.optionalPaid.map((group) => refOf('modifier_group', group)),
				...facts.attachable.map((group) => refOf('modifier_group', group)),
			])
			drafts.push({
				kind: 'free_dish',
				id: menuCardId('free_dish', item.id),
				primary: { type: 'item', id: item.id },
				subject: title,
				refs,
				fingerprint: menuCardFingerprint(refs, {
					groups: facts.groups.map((group) => [group.id, group.minSelections]),
				}),
				params: { itemId: item.id },
				preview: options[0]!.preview!,
				options,
				defaultOptionId: 'set_price',
				ai: false,
			} as Draft)
		}
		return drafts
	},
	plan(graph, request) {
		const params = readParams(ItemParamsSchema, request.params)
		if (!params) return fail('invalid_input')
		const index = indexMenuGraph(graph)
		const item = index.item.get(params.itemId)
		if (!item || !isVisible(item)) return fail('stale_suggestion')
		const facts = freeDishFacts(graph, index, item)
		if (!facts) return fail('not_applicable')
		const optionId = request.optionId ?? ''
		if (optionId === 'set_price') {
			const price = parsePrice(request.input)
			if (price === null) return fail('invalid_input')
			// Orders charge the size's own price, so every size gets it too.
			const variations = pricedVariations(item, price)
			if (variations === null) return fail('not_applicable')
			return ok([
				{
					op: 'update',
					entity: 'item',
					id: item.id,
					set: variations ? { price, variations } : { price },
				},
			])
		}
		if (optionId.startsWith('require:')) {
			const group = facts.optionalPaid.find(
				(candidate) => candidate.id === optionId.slice('require:'.length),
			)
			if (!group) return fail('invalid_input')
			return ok([
				{
					op: 'update',
					entity: 'modifier_group',
					id: group.id,
					set: { minSelections: 1 },
				},
			])
		}
		if (optionId.startsWith('attach:')) {
			const group = facts.attachable.find(
				(candidate) => candidate.id === optionId.slice('attach:'.length),
			)
			if (!group) return fail('invalid_input')
			return ok([
				{
					op: 'assign',
					link: 'item_modifier_group',
					parentId: item.id,
					childId: group.id,
					position: nextPosition(index, item.id),
				},
			])
		}
		if (optionId === 'add_group') {
			const price = parsePrice(request.input)
			if (price === null) return fail('invalid_input')
			const words = sizeWords(graph)
			return ok([
				{
					op: 'insert',
					entity: 'modifier_group',
					tempId: 'size',
					values: {
						name: words.size,
						selectionType: 'single',
						minSelections: 1,
						maxSelections: 1,
					},
				},
				{
					op: 'insert',
					entity: 'option',
					tempId: 'regular',
					values: { displayName: words.regular, price },
				},
				{
					op: 'assign',
					link: 'group_option',
					parentId: newRecordRef('size'),
					childId: newRecordRef('regular'),
					position: 0,
				},
				{
					op: 'assign',
					link: 'item_modifier_group',
					parentId: item.id,
					childId: newRecordRef('size'),
					position: nextPosition(index, item.id),
				},
			])
		}
		return fail('invalid_input')
	},
}

// ============================================================================
// 9. category_order
// ============================================================================

function classifyCategory(name: string): number | null {
	const normalized = normalizeName(name)
	if (!normalized) return null
	for (const entry of CATEGORY_CLASSES) {
		if (entry.english.test(normalized)) return entry.rank
		if (entry.arabic.some((word) => normalized.includes(normalizeName(word)))) {
			return entry.rank
		}
	}
	return null
}

function categoryOrder(graph: MenuGraph, index: Index, menuId: string) {
	const links = index.categoriesOfMenu(menuId)
	const ranks = new Map<(typeof links)[number], number>()
	for (const link of links) {
		const category = index.category.get(link.categoryId)
		if (!category || !isVisible(category)) continue
		const rank = classifyCategory(nameOf(graph, category.displayName))
		if (rank !== null) ranks.set(link, rank)
	}
	if (ranks.size < 3) return null
	const sorted = sortIntoSlots(links, (link) => ranks.get(link) ?? null)
	const broken = sorted.some((link, i) => link !== links[i])
	return broken ? { links, sorted } : null
}

const CategoryAnswerSchema = z.object({ explanation: z.string().max(400) })

const categoryOrderKind: MenuCardKindImpl = {
	kind: 'category_order',
	detect(graph) {
		const index = indexMenuGraph(graph)
		const drafts: Draft[] = []
		for (const menu of graph.menus) {
			const order = categoryOrder(graph, index, menu.id)
			if (!order || order.links.length > MAX_REFS) continue
			const refs = uniqueRefs([
				refOf('menu', menu),
				...order.links.flatMap((link) => {
					const category = index.category.get(link.categoryId)
					return category ? [refOf('category', category)] : []
				}),
			])
			const row = (
				link: (typeof order.links)[number],
				moved: boolean,
			): MenuCardPreviewRow => ({
				text: nameOf(graph, index.category.get(link.categoryId)?.displayName),
				...(moved ? { change: 'moved' as const } : {}),
			})
			const title = nameOf(graph, menu.displayName)
			drafts.push({
				kind: 'category_order',
				id: menuCardId('category_order', menu.id),
				primary: { type: 'menu', id: menu.id },
				subject: title,
				refs,
				fingerprint: menuCardFingerprint(refs, {
					order: order.links.map((link) => link.categoryId),
				}),
				params: { menuId: menu.id },
				preview: preview(
					[
						block(
							'menu',
							title,
							order.links.map((link) => row(link, false)),
						),
					],
					[
						block(
							'menu',
							title,
							order.sorted.map((link, i) => row(link, link !== order.links[i])),
						),
					],
				),
				aiData: {
					menu: title,
					current: order.links.map((link) =>
						nameOf(graph, index.category.get(link.categoryId)?.displayName),
					),
					proposed: order.sorted.map((link) =>
						nameOf(graph, index.category.get(link.categoryId)?.displayName),
					),
				},
				ai: false,
			} as Draft)
		}
		return drafts
	},
	ai: {
		required: false,
		instruction:
			'In one short sentence, in the language of the menu, explain why the proposed order of these menu sections reads better. Do not change the order.',
		answer: CategoryAnswerSchema,
		apply(draft, answer: z.infer<typeof CategoryAnswerSchema>) {
			const explanation = sanitizeSuggestionText(answer.explanation, 300)
			return explanation ? { ...draft, explanation } : draft
		},
	},
	plan(graph, request) {
		const params = readParams(z.object({ menuId: IdSchema }), request.params)
		if (!params) return fail('invalid_input')
		const index = indexMenuGraph(graph)
		if (!index.menu.has(params.menuId)) return fail('stale_suggestion')
		const order = categoryOrder(graph, index, params.menuId)
		if (!order) return fail('not_applicable')
		return ok(
			order.sorted.map((link, position) => ({
				op: 'assign' as const,
				link: 'menu_category' as const,
				parentId: params.menuId,
				childId: link.categoryId,
				position,
			})),
		)
	},
}

// ============================================================================

export const POLISH_CARD_KINDS_IMPL: Record<
	MenuPolishCardKind,
	MenuCardKindImpl
> = {
	typo: typoKind,
	capitals: capitalsKind,
	missing_choice: missingChoiceKind,
	selection_limits: selectionLimitsKind,
	required_first: requiredFirstKind,
	option_order: optionOrderKind,
	no_option_style: noOptionStyleKind,
	free_dish: freeDishKind,
	category_order: categoryOrderKind,
}
