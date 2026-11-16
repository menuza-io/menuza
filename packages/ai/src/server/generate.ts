import { google } from '@ai-sdk/google'
import { generateText, Output, type FlexibleSchema } from 'ai'

export type GenerateContentOptions = {
	prompt: string
	modelName?: string
}

/**
 * Generates text content using Google's Gemini model
 * @param options - Configuration options for content generation
 * @returns Generated text content
 */
export async function generateContent(options: GenerateContentOptions) {
	const { prompt, modelName = 'models/gemini-2.5-flash' } = options

	const { text } = await generateText({
		model: google(modelName),
		prompt,
	})

	return text
}

/**
 * Generates note content based on a title
 * @param title - The note title to generate content for
 * @param modelName - Optional model name override
 * @returns Generated markdown content
 */
export async function generateNoteContent(title: string, modelName?: string) {
	const prompt = `Based on the title "${title}", generate a comprehensive and well-structured note content. The content should be informative, engaging, and relevant to the title. Format it as clean Markdown with proper paragraph tags, headings (h2, h3), lists, and other semantic elements as appropriate. Make sure it has line breaks after each section. Keep it between 100-200 words. Do not include any HTML document structure (no html, head, body tags), just the content markup using markdown.`

	return generateContent({ prompt, modelName })
}

export type GenerateStructuredOptions<OBJECT> = {
	schema: FlexibleSchema<OBJECT>
	system?: string
	prompt: string
	modelName?: string
}

/**
 * Generates one object that matches a schema (Zod). The caller still validates
 * the result again: a model can return something that parses but is unsafe to
 * use (links, claims), so this is only the first gate.
 */
export async function generateObject<OBJECT>(
	options: GenerateStructuredOptions<OBJECT>,
): Promise<OBJECT> {
	const { schema, system, prompt, modelName = 'models/gemini-2.5-flash' } =
		options
	const result = await generateText({
		model: google(modelName),
		output: Output.object({ schema }),
		system,
		prompt,
	})
	return result.output as OBJECT
}
