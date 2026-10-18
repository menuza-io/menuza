import { requireUserId } from '@repo/auth'
import { isSiteContentLocale } from '@repo/common/site-locales'
import { getClientIp } from '@repo/security'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { sanitizeWebsiteContent } from '#app/utils/content-sanitization.server.ts'
import { ENV } from '#app/utils/env.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { checkRateLimit } from '#app/utils/rate-limit.server.ts'

const translateSchema = z.object({
	orgSlug: z.string().min(1),
	text: z.union([
		z.string().min(1).max(2000, 'String is too long for translation'),
		z
			.array(z.string().max(2000))
			.min(1)
			.max(50, 'Too many strings to translate at once'),
	]),
	sourceLang: z
		.string()
		.refine(isSiteContentLocale, 'Unsupported source language'),
	targetLang: z
		.string()
		.refine(isSiteContentLocale, 'Unsupported target language'),
	allowHtml: z.union([z.boolean(), z.array(z.boolean())]).optional(),
})

// The server-level rate limiter (apps/app/server/index.ts) doesn't give this
// endpoint a dedicated tier, so replicate the 30-requests-per-minute window
// Arcjet used to enforce here with the same DB-backed limiter used elsewhere
// in this app (see #app/utils/rate-limit.server.ts).
const isDev = process.env.NODE_ENV !== 'production'
const TRANSLATE_RATE_LIMIT = {
	scope: 'api-translate',
	maxRequests: isDev ? 1000 : 30,
	windowMs: 60 * 1000, // 60 seconds
}

export async function action({ request }: ActionFunctionArgs) {
	await requireUserId(request)

	if (request.method !== 'POST') {
		return Response.json({ error: 'Method not allowed' }, { status: 405 })
	}

	const clientIp = getClientIp(request)
	const rateLimitCheck = await checkRateLimit(
		{ type: 'ip', value: clientIp },
		TRANSLATE_RATE_LIMIT,
	)
	if (!rateLimitCheck.allowed) {
		return Response.json(
			{ error: 'Too many translation requests. Please try again later.' },
			{ status: 429 },
		)
	}

	try {
		const json = await request.json()
		const parsed = translateSchema.safeParse(json)

		if (!parsed.success) {
			return Response.json(
				{ error: 'Invalid input', details: parsed.error.flatten() },
				{ status: 400 },
			)
		}

		const { orgSlug, text, sourceLang, targetLang, allowHtml } = parsed.data
		const organization = await requireUserOrganization(request, orgSlug, {
			id: true,
		})
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
		)

		const apiKey = ENV.GOOGLE_API_KEY
		if (!apiKey) {
			return Response.json(
				{ error: 'Translation is not configured.' },
				{ status: 503 },
			)
		}

		const texts = Array.isArray(text) ? text : [text]
		const allowHtmlFlags = Array.isArray(allowHtml)
			? allowHtml
			: texts.map(() => allowHtml ?? false)

		if (allowHtmlFlags.length !== texts.length) {
			return Response.json(
				{ error: 'Invalid input', details: 'allowHtml must match text length' },
				{ status: 400 },
			)
		}

		const translateTexts = async (format: 'html' | 'text') => {
			const response = await fetch(
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
				payload.data?.translations?.map((item) => item.translatedText ?? '') ??
				[]

			if (translated.length !== texts.length) {
				throw new Error('Failed to translate text.')
			}

			return translated
		}

		const hasHtml = allowHtmlFlags.some(Boolean)
		const hasPlain = allowHtmlFlags.some((flag) => !flag)

		const htmlTranslations = hasHtml ? await translateTexts('html') : []
		const plainTranslations = hasPlain ? await translateTexts('text') : []

		const translations = texts.map((_, index) => {
			const translated = allowHtmlFlags[index]
				? (htmlTranslations[index] ?? '')
				: (plainTranslations[index] ?? '')
			return sanitizeWebsiteContent(translated, allowHtmlFlags[index] ?? false)
		})

		return Response.json({
			translation: Array.isArray(text) ? translations : translations[0],
		})
	} catch (error) {
		// Membership and permission failures are 404/403 responses, not 500s.
		if (error instanceof Response) throw error
		console.error('Translation error:', error)
		return Response.json(
			{ error: 'Failed to translate text.' },
			{ status: 500 },
		)
	}
}
