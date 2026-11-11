import { ENV } from '#app/utils/env.server.ts'

export class TranslationUnavailableError extends Error {
	constructor(message = 'Translation is not configured.') {
		super(message)
		this.name = 'TranslationUnavailableError'
	}
}

export function isTranslationConfigured(): boolean {
	return Boolean(ENV.GOOGLE_API_KEY)
}

/**
 * Machine translation through the Google Cloud Translation API, shared by the
 * website editor's `/api/translate` and the menu's review suggestions.
 * Callers check permissions and rate limits first and clean the output
 * before they show or save it: the answer is untrusted text.
 */
export async function translateTexts({
	texts,
	sourceLang,
	targetLang,
	format,
	fetchImpl = fetch,
}: {
	texts: string[]
	sourceLang: string
	targetLang: string
	format: 'html' | 'text'
	fetchImpl?: typeof fetch
}): Promise<string[]> {
	const apiKey = ENV.GOOGLE_API_KEY
	if (!apiKey) throw new TranslationUnavailableError()
	if (texts.length === 0) return []

	const response = await fetchImpl(
		`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				q: texts,
				source: sourceLang,
				target: targetLang,
				format,
			}),
		},
	)

	if (!response.ok) {
		console.error('Translation API error:', response.status)
		throw new Error('Failed to translate text.')
	}

	const payload = (await response.json()) as {
		data?: { translations?: Array<{ translatedText?: string }> }
	}
	const translated =
		payload.data?.translations?.map((item) => item.translatedText ?? '') ?? []

	if (translated.length !== texts.length) {
		throw new Error('Failed to translate text.')
	}

	return translated
}
