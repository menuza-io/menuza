import { SUPPORTED_AGENT_LANGUAGES } from '@repo/phone-agent'
import { z } from 'zod'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { requirePhoneAgentAccess } from '#app/utils/phone-agent/access.server.ts'
import {
	cartesiaConfigured,
	getVoicePreview,
	previewTranscript,
	VoiceIdSchema,
} from '#app/utils/phone-agent/voices.server.ts'
import { type Route } from './+types/voice-preview.ts'

const PreviewSchema = z.object({
	voiceId: VoiceIdSchema,
	language: z.enum(SUPPORTED_AGENT_LANGUAGES).default('en'),
	agentName: z.string().max(60).default(''),
	greeting: z.string().max(400).default(''),
})

/**
 * Audio for the voice picker: the agent's greeting in the chosen voice, or
 * Cartesia's sample clip. Served from App because the page's CSP only allows
 * same-origin media.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	// Greeting previews are billed, so only editors (who pick voices) get them.
	const { orgId, userId, orgName } = await requirePhoneAgentAccess(
		request,
		params.orgSlug,
		ORG_PERMISSIONS.UPDATE_PHONE_AGENT_ANY,
	)
	if (!cartesiaConfigured()) {
		return new Response('Voice previews are not configured.', { status: 503 })
	}
	const url = new URL(request.url)
	const parsed = PreviewSchema.safeParse(Object.fromEntries(url.searchParams))
	if (!parsed.success) {
		return new Response('Invalid preview request.', { status: 400 })
	}
	const preview = await getVoicePreview({
		organizationId: orgId,
		userId,
		voiceId: parsed.data.voiceId,
		language: parsed.data.language,
		transcript: previewTranscript({
			orgName,
			agentName: parsed.data.agentName,
			greeting: parsed.data.greeting,
		}),
	})
	if (!preview) {
		return new Response('No preview is available for this voice.', {
			status: 404,
		})
	}
	return new Response(preview.body, {
		headers: {
			'Content-Type': preview.contentType,
			'Content-Length': String(preview.body.byteLength),
			// Same voice and wording replays from the browser cache, not Cartesia.
			'Cache-Control':
				preview.kind === 'greeting'
					? 'private, max-age=86400'
					: 'private, max-age=3600',
			'X-Voice-Preview': preview.kind,
		},
	})
}
