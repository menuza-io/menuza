/**
 * Bulk description drafts (#401). Nothing is saved here. The model sees the
 * dish name, category and known ingredients and allergens only. Allergens in
 * a reply are dropped. An existing description is never replaced.
 */

import { parseLocalizedString } from '@repo/common/site-locales'
import { z } from 'zod'

export type DescriptionDraftDish = {
	id: string
	name: string
	category: string | null
	ingredients: readonly string[]
	allergens: readonly string[]
	/** Localized description JSON, or plain text. */
	description: string | null
}

export type DescriptionDraft = {
	itemId: string
	name: string
	en: string
	ar: string
	unsure: boolean
	/** A locale that already had text and was left alone. */
	kept: Array<'en' | 'ar'>
}

const replySchema = z.object({
	dishes: z.array(
		z.object({
			id: z.string(),
			en: z.string().optional(),
			ar: z.string().optional(),
			unsure: z.boolean().optional(),
		}),
	),
})

export function descriptionIsEmpty(
	description: string | null,
	locale: 'en' | 'ar',
): boolean {
	if (!description) return true
	const parsed = parseLocalizedString(description, 'en')
	const value = (parsed[locale] ?? '').trim()
	if (value) return false
	if (!description.trim().startsWith('{') && locale === 'en') {
		return description.trim().length === 0
	}
	return true
}

/** Prompt for the existing generateContent adapter. No guest data. */
export function buildDescriptionDraftPrompt(
	dishes: readonly DescriptionDraftDish[],
): string {
	const body = dishes.map((dish) => ({
		id: dish.id,
		name: dish.name,
		category: dish.category,
		ingredients: dish.ingredients,
		allergens: dish.allergens,
	}))
	return [
		'Write a short menu description for each dish in English (en) and Arabic (ar).',
		'Use only the name, category, ingredients and allergens given.',
		'Do not invent allergens or ingredients. Do not add an allergens field.',
		'If you are unsure, set unsure to true and leave en and ar empty.',
		'Reply with JSON only: {"dishes":[{"id":"","en":"","ar":"","unsure":false}]}',
		JSON.stringify({ dishes: body }),
	].join('\n')
}

export function parseDescriptionDraftReply(
	text: string,
	dishes: readonly DescriptionDraftDish[],
): DescriptionDraft[] {
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	let rows: z.infer<typeof replySchema>['dishes'] = []
	if (start >= 0 && end > start) {
		try {
			const parsed = replySchema.safeParse(
				JSON.parse(text.slice(start, end + 1)),
			)
			if (parsed.success) rows = parsed.data.dishes
		} catch {
			rows = []
		}
	}
	const byId = new Map(rows.map((row) => [row.id, row]))
	return dishes.map((dish) => {
		const row = byId.get(dish.id)
		const kept: Array<'en' | 'ar'> = []
		let en = clean(row?.en)
		let ar = clean(row?.ar)
		if (!descriptionIsEmpty(dish.description, 'en')) {
			en = ''
			kept.push('en')
		}
		if (!descriptionIsEmpty(dish.description, 'ar')) {
			ar = ''
			kept.push('ar')
		}
		const unsure =
			row?.unsure === true || (en === '' && ar === '' && kept.length === 0)
		return { itemId: dish.id, name: dish.name, en, ar, unsure, kept }
	})
}

function clean(value: string | undefined): string {
	if (!value) return ''
	return value.replace(/\s+/g, ' ').trim().slice(0, 300)
}

export type DescriptionUpdate = {
	itemId: string
	description: string
}

/**
 * Applies selected drafts onto empty locales only. Allergen lists are not
 * part of the write.
 */
export function applyDescriptionDrafts(input: {
	dishes: readonly DescriptionDraftDish[]
	drafts: readonly DescriptionDraft[]
	selectedIds: readonly string[]
}): DescriptionUpdate[] {
	const selected = new Set(input.selectedIds)
	const drafts = new Map(input.drafts.map((draft) => [draft.itemId, draft]))
	const updates: DescriptionUpdate[] = []
	for (const dish of input.dishes) {
		if (!selected.has(dish.id)) continue
		const draft = drafts.get(dish.id)
		if (!draft || draft.unsure) continue
		const current = parseLocalizedString(dish.description, 'en')
		const next = { ...current }
		let changed = false
		if (
			descriptionIsEmpty(dish.description, 'en') &&
			draft.en &&
			!draft.kept.includes('en')
		) {
			next.en = draft.en
			changed = true
		}
		if (
			descriptionIsEmpty(dish.description, 'ar') &&
			draft.ar &&
			!draft.kept.includes('ar')
		) {
			next.ar = draft.ar
			changed = true
		}
		if (changed) {
			updates.push({ itemId: dish.id, description: JSON.stringify(next) })
		}
	}
	return updates
}
