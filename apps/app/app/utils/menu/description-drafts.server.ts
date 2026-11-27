import { generateContent } from '@repo/ai/server'
import {
	buildDescriptionDraftPrompt,
	parseDescriptionDraftReply,
	type DescriptionDraft,
	type DescriptionDraftDish,
} from './description-drafts.ts'

export async function draftDishDescriptions(
	dishes: readonly DescriptionDraftDish[],
	generate: (options: { prompt: string }) => Promise<string> = generateContent,
): Promise<DescriptionDraft[]> {
	if (dishes.length === 0) return []
	const prompt = buildDescriptionDraftPrompt(dishes)
	const reply = await generate({ prompt })
	return parseDescriptionDraftReply(reply, dishes)
}
