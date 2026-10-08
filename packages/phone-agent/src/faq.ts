import { z } from 'zod'
import { DEFINITION_ID_PATTERN } from './constants.ts'

/** Categories every vertical has. `custom` holds the owner's own questions. */
export const BASE_FAQ_CATEGORIES = ['general', 'policies', 'custom'] as const
/** One of `faqCategoryIds(vertical)`. */
export type FaqCategory = string

export type FaqBankQuestion = {
	/** Stable id stored with the answer, so wording can change later. */
	id: string
	/** Any FAQ category except `custom`. */
	category: FaqCategory
	question: string
}

/**
 * Questions most businesses get by phone. Owners answer the ones that apply;
 * unanswered questions are left out of the prompt. A vertical adds its own
 * with `faqQuestions` and may reword or recategorize these by reusing an id.
 */
export const BASE_FAQ_BANK: readonly FaqBankQuestion[] = [
	{
		id: 'parking',
		category: 'general',
		question: 'Where is the closest parking?',
	},
	{
		id: 'transit',
		category: 'general',
		question: 'What public transportation is nearby?',
	},
	{
		id: 'wheelchair',
		category: 'general',
		question: 'Are you wheelchair accessible?',
	},
	{ id: 'dogs', category: 'general', question: 'Can I bring my dog?' },
	{ id: 'wifi', category: 'general', question: 'Do you have Wi-Fi?' },
	{
		id: 'restrooms',
		category: 'general',
		question: 'Do you have public restrooms?',
	},
	{ id: 'hiring', category: 'general', question: 'Are you hiring?' },
	{
		id: 'gift_cards',
		category: 'policies',
		question: 'Do you sell gift cards?',
	},
	{
		id: 'payment_methods',
		category: 'policies',
		question: 'What forms of payment do you accept?',
	},
]

export const FAQ_ANSWER_MAX = 1000
export const FAQ_QUESTION_MAX = 200
export const FAQ_MAX_ENTRIES = 150

export const FaqEntrySchema = z.object({
	/** A FAQ bank id, or `custom_<random>` for the owner's own questions. */
	id: z
		.string()
		.trim()
		.regex(/^[a-z0-9_]{1,60}$/u),
	category: z.string().trim().regex(DEFINITION_ID_PATTERN),
	question: z.string().trim().min(1).max(FAQ_QUESTION_MAX),
	answer: z.string().trim().max(FAQ_ANSWER_MAX),
	scopeId: z.string().trim().min(1).max(64).nullable().optional(),
})
export type FaqEntry = z.infer<typeof FaqEntrySchema>

/**
 * Answered entries that apply to the scope, scoped answers replacing
 * org-wide ones with the same id.
 */
export function faqForScope(
	entries: readonly FaqEntry[],
	scopeId: string | null,
): FaqEntry[] {
	const byId = new Map<string, FaqEntry>()
	for (const entry of entries) {
		if (!entry.answer.trim()) continue
		if (entry.scopeId && entry.scopeId !== scopeId) continue
		const existing = byId.get(entry.id)
		if (!existing || (entry.scopeId && !existing.scopeId)) {
			byId.set(entry.id, entry)
		}
	}
	return [...byId.values()]
}

function describeFaqEntry(entry: FaqEntry) {
	return `Q: ${entry.question}\nA: ${entry.answer}`
}

export function describeFaq(entries: readonly FaqEntry[]) {
	return entries.map(describeFaqEntry).join('\n\n')
}

export type FaqWithinBudget = {
	entries: FaqEntry[]
	droppedIds: string[]
}

/**
 * The entries that fit in `charBudget` characters of prompt text. Scoped
 * answers come first; the rest keep the owner's sequence. Entries that don't
 * fit are skipped so shorter ones after them still fit.
 */
export function fitFaqToBudget(
	entries: readonly FaqEntry[],
	charBudget: number,
): FaqWithinBudget {
	const sorted = [
		...entries.filter((entry) => entry.scopeId),
		...entries.filter((entry) => !entry.scopeId),
	]
	const kept: FaqEntry[] = []
	const droppedIds: string[] = []
	let used = 0
	for (const entry of sorted) {
		// +2 for the blank line between entries.
		const size = describeFaqEntry(entry).length + 2
		if (used + size <= charBudget) {
			kept.push(entry)
			used += size
		} else {
			droppedIds.push(entry.id)
		}
	}
	return { entries: kept, droppedIds }
}
