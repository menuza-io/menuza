import { randomUUID } from 'node:crypto'
import { getTenantDb, voiceCallActions, voiceCalls } from '@repo/tenant-db'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import {
	type VoiceActionResult,
	getVoiceAction,
} from '../services/voice-actions.ts'
import {
	regionalOrganization,
	regionUnavailable,
	requireVoiceAgent,
} from './voice.ts'

/**
 * `POST /api/voice/actions/:name`: runs an action the business registered for
 * a live phone-agent call. Authenticated with `VOICE_AGENT_TOKEN`; the
 * organization is resolved from the body `orgId` by the router and re-checked
 * here (never from anything the model could say), and the call, its channel
 * and its location scope come from the call row.
 */
export const voiceActionRoutes = new Hono()

voiceActionRoutes.use(
	'*',
	bodyLimit({
		maxSize: 64 * 1024,
		onError: (c) => c.json({ error: 'Payload too large' }, 413),
	}),
)

const bodySchema = z.object({
	orgId: z.string().min(1).max(64),
	callId: z.string().uuid(),
	scopeId: z.string().max(64).nullable().optional(),
	// Informational: the call row decides whether a call is a test.
	channel: z.enum(['phone', 'web_test']).optional(),
	input: z.unknown(),
})

const REFUSED_OUTCOMES = new Set(['not_enabled', 'invalid', 'conflict'])

voiceActionRoutes.post('/:name', requireVoiceAgent, async (c) => {
	const parsed = bodySchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) {
		return c.json(
			{ ok: false, reason: 'invalid', explanation: 'Invalid request.' },
			400,
		)
	}
	const body = parsed.data

	const organization = await regionalOrganization(body.orgId)
	// The phone agent is US only: a KSA organization looks the same on both
	// nodes as an organization that does not exist.
	if (
		!organization ||
		organization.dataRegion !== 'us' ||
		!organization.hasProvisionedDb
	) {
		return regionUnavailable(c)
	}

	const name = c.req.param('name') ?? ''
	const action = getVoiceAction(name)
	if (!action) return c.json({ error: 'Unknown action' }, 404)

	const db = await getTenantDb(organization.id)
	const call = await db
		.select({
			id: voiceCalls.id,
			channel: voiceCalls.channel,
			callerPhone: voiceCalls.callerPhone,
			scopeId: voiceCalls.scopeId,
			endedAt: voiceCalls.endedAt,
		})
		.from(voiceCalls)
		.where(eq(voiceCalls.id, body.callId))
		.get()
	if (!call) return c.json({ error: 'Call not found' }, 404)
	if (call.endedAt) {
		return c.json(
			{
				ok: false,
				reason: 'conflict',
				explanation: 'The call has already ended.',
			},
			409,
		)
	}

	const input = action.schema.safeParse(body.input)
	if (!input.success) {
		// Only which fields were wrong, never the values.
		return c.json(
			{
				ok: false,
				reason: 'invalid',
				explanation: 'Some details are missing or not valid.',
				fields: [...new Set(input.error.issues.map((i) => i.path.join('.')))],
			},
			400,
		)
	}

	const dryRun = call.channel === 'web_test'
	// One statement under SQLite's write lock: two concurrent requests cannot
	// both take the last slot of the cap.
	const rowId = randomUUID()
	const [reserved] = await db
		.insert(voiceCallActions)
		.select(
			sql`select ${rowId}, ${call.id}, ${name}, 'pending', ${dryRun ? 1 : 0}, strftime('%s', 'now') where (select count(*) from ${voiceCallActions} where ${voiceCallActions.callId} = ${call.id} and ${voiceCallActions.action} = ${name}) < ${action.maxPerCall}`,
		)
		.returning({ id: voiceCallActions.id })
	if (!reserved) {
		return c.json(
			{
				ok: false,
				reason: 'rate_limited',
				explanation: "I've done as much of that as I can on this call.",
			},
			429,
		)
	}

	let result: VoiceActionResult
	try {
		result = await action.run(
			{
				orgId: organization.id,
				organization,
				db,
				call: {
					id: call.id,
					channel: call.channel,
					callerPhone: call.callerPhone,
					// The call row's scope is authoritative; the body's only fills
					// a call that has none.
					scopeId: call.scopeId ?? body.scopeId ?? null,
				},
				dryRun,
				now: Date.now(),
			},
			input.data,
		)
	} catch (error) {
		console.error(
			`Voice action ${name} failed`,
			error instanceof Error ? error.name : 'error',
		)
		result = {
			ok: false,
			reason: 'unavailable',
			explanation: "I can't do that right now.",
		}
	}
	await db
		.update(voiceCallActions)
		.set({
			outcome: result.ok
				? 'ok'
				: REFUSED_OUTCOMES.has(result.reason)
					? 'refused'
					: 'failed',
		})
		.where(eq(voiceCallActions.id, rowId))
		.catch(() => undefined)
	return c.json(result, 200)
})
