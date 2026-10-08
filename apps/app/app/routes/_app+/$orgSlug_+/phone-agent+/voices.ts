import { SUPPORTED_AGENT_LANGUAGES } from '@repo/phone-agent'
import { data } from 'react-router'
import { z } from 'zod'
import { requirePhoneAgentAccess } from '#app/utils/phone-agent/access.server.ts'
import {
	cartesiaConfigured,
	getVoice,
	searchVoices,
	VOICE_GENDERS,
	VoiceIdSchema,
	type VoiceSummary,
} from '#app/utils/phone-agent/voices.server.ts'
import { type Route } from './+types/voices.ts'

export type VoiceListResult =
	| {
			ok: true
			configured: boolean
			voices: VoiceSummary[]
			nextCursor: string | null
	  }
	| { ok: false; error: string }

const SearchSchema = z.object({
	id: VoiceIdSchema.optional(),
	q: z.string().trim().max(100).optional(),
	language: z.enum(SUPPORTED_AGENT_LANGUAGES).optional(),
	gender: z.enum(VOICE_GENDERS).optional(),
	cursor: VoiceIdSchema.optional(),
})

/** Searches Cartesia's voice library for the Setup page's voice picker. */
export async function loader({ request, params }: Route.LoaderArgs) {
	await requirePhoneAgentAccess(request, params.orgSlug)
	const headers = { 'Cache-Control': 'private, max-age=300' }
	if (!cartesiaConfigured()) {
		return data<VoiceListResult>(
			{ ok: true, configured: false, voices: [], nextCursor: null },
			{ headers },
		)
	}
	const url = new URL(request.url)
	const parsed = SearchSchema.safeParse(
		Object.fromEntries(
			[...url.searchParams.entries()].filter(([, value]) => value !== ''),
		),
	)
	if (!parsed.success) {
		return data<VoiceListResult>(
			{ ok: false, error: 'Invalid voice search.' },
			{ status: 400 },
		)
	}
	try {
		if (parsed.data.id) {
			const voice = await getVoice(parsed.data.id)
			return data<VoiceListResult>(
				{
					ok: true,
					configured: true,
					voices: voice ? [voice] : [],
					nextCursor: null,
				},
				{ headers },
			)
		}
		const result = await searchVoices({
			query: parsed.data.q,
			language: parsed.data.language,
			gender: parsed.data.gender,
			cursor: parsed.data.cursor,
		})
		return data<VoiceListResult>(
			{ ok: true, configured: true, ...result },
			{ headers },
		)
	} catch (error) {
		console.error('Voice search failed', error)
		return data<VoiceListResult>(
			{ ok: false, error: "Couldn't load voices. Try again." },
			{ status: 502 },
		)
	}
}
