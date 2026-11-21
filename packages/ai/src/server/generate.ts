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

export const GENERATE_OBJECT_FILE_MEDIA_TYPES = [
	'application/pdf',
	'image/jpeg',
	'image/png',
	'image/webp',
] as const

export type GenerateObjectFileMediaType =
	(typeof GENERATE_OBJECT_FILE_MEDIA_TYPES)[number]

export type GenerateObjectFilePart = {
	data: Uint8Array | ArrayBuffer | string
	mediaType: GenerateObjectFileMediaType
	filename?: string
}

export type GenerateObjectRunner = <OBJECT>(
	options: GenerateStructuredOptions<OBJECT>,
) => Promise<OBJECT>

export type GenerateStructuredOptions<OBJECT> = {
	schema: FlexibleSchema<OBJECT>
	system?: string
	prompt: string
	files?: readonly GenerateObjectFilePart[]
	modelName?: string
	abortSignal?: AbortSignal
	/** Optional per-call generator override (for testing or custom providers). */
	generator?: GenerateObjectRunner
	/** Optional fixture returned when `MOCKS=true`. */
	mockOutput?: OBJECT
}

let customGenerateObject: GenerateObjectRunner | null = null
let customGenerateText: typeof generateText | null = null

/**
 * Registers a test/mock implementation for `generateObject`. Pass `null` to
 * restore the default behavior.
 */
export function setGenerateObjectImplementation(
	impl: GenerateObjectRunner | null,
) {
	customGenerateObject = impl
}

/**
 * Registers a test implementation for the underlying `generateText` call.
 * Pass `null` to restore the default `ai` SDK `generateText`.
 */
export function setGenerateTextImplementation(
	impl: typeof generateText | null,
) {
	customGenerateText = impl
}

function isLocalHostname(hostname: string): boolean {
	const host = hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
	return (
		host === 'localhost' ||
		host === '127.0.0.1' ||
		host === '::1' ||
		host.endsWith('.localhost') ||
		host.endsWith('.test')
	)
}

function isLocalUrl(value: string | null | undefined): boolean {
	if (!value) return false
	try {
		return isLocalHostname(new URL(value).hostname)
	} catch {
		return false
	}
}

function isMockAllowed(): boolean {
	if (process.env.MOCKS !== 'true') return false
	const baseUrl = process.env.BASE_URL?.trim()
	if (baseUrl && baseUrl !== '/') {
		return isLocalUrl(baseUrl)
	}
	return (
		process.env.NODE_ENV === 'test' ||
		process.env.NODE_ENV === 'development' ||
		process.env.VITEST === 'true'
	)
}

function assertSupportedFileParts(files: readonly GenerateObjectFilePart[]) {
	for (const file of files) {
		if (
			!(GENERATE_OBJECT_FILE_MEDIA_TYPES as readonly string[]).includes(
				file.mediaType,
			)
		) {
			throw new Error(
				`Unsupported generateObject file mediaType: ${String(file.mediaType)}`,
			)
		}
		if (file.data instanceof URL) {
			throw new Error(
				'Unsupported generateObject file data: URL is not allowed',
			)
		}
	}
}

/**
 * Generates one object that matches a schema (Zod). Supports optional
 * multimodal file parts (PDF, JPEG, PNG, WebP), per-call or module-level
 * generator injection, and `MOCKS=true` fixture responses. The caller still
 * validates the result again: a model can return something that parses but is
 * unsafe to use (links, claims), so this is only the first gate.
 */
export async function generateObject<OBJECT>(
	options: GenerateStructuredOptions<OBJECT>,
): Promise<OBJECT> {
	const {
		schema,
		system,
		prompt,
		files,
		modelName = 'models/gemini-2.5-flash',
		abortSignal,
		generator,
		mockOutput,
	} = options

	if (files?.length) {
		assertSupportedFileParts(files)
	}

	if (generator) {
		return generator(options)
	}

	if (customGenerateObject) {
		return customGenerateObject(options)
	}

	if (isMockAllowed()) {
		return (mockOutput !== undefined ? mockOutput : {}) as OBJECT
	}

	const runGenerateText = customGenerateText ?? generateText
	const output = Output.object({ schema })

	if (files?.length) {
		const result = await runGenerateText({
			model: google(modelName),
			output,
			system,
			abortSignal,
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: prompt },
						...files.map((file) => ({
							type: 'file' as const,
							data: file.data,
							mediaType: file.mediaType,
							...(file.filename ? { filename: file.filename } : {}),
						})),
					],
				},
			],
		})
		return result.output as OBJECT
	}

	const result = await runGenerateText({
		model: google(modelName),
		output,
		system,
		abortSignal,
		prompt,
	})
	return result.output as OBJECT
}
