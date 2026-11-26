import { describe, expect, it } from 'vitest'
import {
	applyDescriptionDrafts,
	buildDescriptionDraftPrompt,
	parseDescriptionDraftReply,
	type DescriptionDraftDish,
} from './description-drafts.ts'

function dishes(count: number, withDescription = 0): DescriptionDraftDish[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `dish-${index + 1}`,
		name: `Dish ${index + 1}`,
		category: 'Mains',
		ingredients: index === 0 ? ['Whole milk'] : [],
		allergens: index === 0 ? ['dairy'] : [],
		description:
			index < withDescription
				? JSON.stringify({ en: 'Already written', ar: 'مكتوب' })
				: null,
	}))
}

describe('description drafts', () => {
	it('drafts 10 empty dishes in English and Arabic', () => {
		const input = dishes(10)
		const prompt = buildDescriptionDraftPrompt(input)
		expect(prompt).not.toMatch(/guest|phone|email|@/i)
		expect(prompt).toContain('Do not invent allergens')
		const reply = JSON.stringify({
			dishes: input.map((dish) => ({
				id: dish.id,
				en: `English ${dish.name}`,
				ar: `عربي ${dish.name}`,
				unsure: false,
				allergens: ['peanuts'],
			})),
		})
		const drafts = parseDescriptionDraftReply(reply, input)
		expect(drafts).toHaveLength(10)
		expect(drafts.every((draft) => draft.en && draft.ar && !draft.unsure)).toBe(
			true,
		)
		const updates = applyDescriptionDrafts({
			dishes: input,
			drafts,
			selectedIds: input.map((dish) => dish.id),
		})
		expect(updates).toHaveLength(10)
		for (const update of updates) {
			expect(update.description).not.toContain('peanuts')
			expect(JSON.parse(update.description)).toMatchObject({
				en: expect.stringContaining('English'),
				ar: expect.stringContaining('عربي'),
			})
		}
	})

	it('leaves an existing description untouched and flags an unsure dish', () => {
		const input = dishes(2, 1)
		const drafts = parseDescriptionDraftReply(
			JSON.stringify({
				dishes: [
					{ id: 'dish-1', en: 'New', ar: 'جديد', unsure: false },
					{ id: 'dish-2', en: '', ar: '', unsure: true },
				],
			}),
			input,
		)
		expect(drafts[0]?.kept).toEqual(['en', 'ar'])
		const updates = applyDescriptionDrafts({
			dishes: input,
			drafts,
			selectedIds: ['dish-1', 'dish-2'],
		})
		expect(updates).toEqual([])
		expect(drafts[1]?.unsure).toBe(true)
	})
})
