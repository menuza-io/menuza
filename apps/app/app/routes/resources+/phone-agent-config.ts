import { E164Schema } from '@repo/phone-agent'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { buildRuntimeConfig } from '#app/utils/phone-agent/runtime-config.server.ts'
import { requireVoiceAgentAuth } from '#app/utils/phone-agent/voice-agent-auth.server.ts'

const querySchema = z.union([
	z.object({ number: E164Schema }),
	z.object({
		orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
		scopeId: z
			.string()
			.max(64)
			.optional()
			.transform((value) => value || null),
		flow: z.enum(['draft', 'published']).default('published'),
	}),
])

/**
 * Voice worker → App. Returns agent settings, flow, rules, and the business
 * data for the called number (or a browser test room). Never includes callers.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	requireVoiceAgentAuth(request)
	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid lookup' }, { status: 400 })
	}
	const result = await buildRuntimeConfig(
		'number' in parsed.data
			? { kind: 'number', calledNumber: parsed.data.number }
			: { kind: 'test', ...parsed.data },
	)
	const headers = { 'Cache-Control': 'private, no-store' }
	return result.ok
		? Response.json(result.config, { headers })
		: Response.json(result.passthrough ?? { error: result.error }, {
				status: result.status,
				headers,
			})
}
