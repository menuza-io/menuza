import {
	INVENTORY_PERMISSIONS,
	locationQuerySchema,
	VOICE_AUDIO_MAX_BYTES,
	voiceCapabilitySchema,
	voiceParseSchema,
	voiceProposalSchema,
	voiceProposeQuerySchema,
} from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { Hono, type Context } from 'hono'
import { readCappedRequestBytes } from '../lib/http.ts'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import { inventoryDeny, inventoryErrorResponse } from '../lib/inventory-http.ts'
import {
	inventoryCaller,
	parseBody,
	parseQuery,
	respond,
} from '../lib/inventory-route.ts'
import {
	proposeFromAudio,
	proposeFromText,
	voiceCountsAvailable,
} from '../services/inventory-voice-count-service.ts'

/**
 * Counting by voice under `/operator/inventory` (#488). Everything here only
 * proposes lines; a count entry is written by the ordinary entries route once a
 * person confirms. See `contract/voice.ts`.
 */
export const operatorInventoryVoiceRoutes = new Hono()

const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY

/** The recording of a request, read in memory with a size cap (never stored). */
async function readAudio(c: Context) {
	// Read as a stream and cut off at the cap, so it stays safe whatever the
	// header says and wherever this route is mounted.
	const bytes = await readCappedRequestBytes(c.req.raw, VOICE_AUDIO_MAX_BYTES)
	if (!bytes) return null
	return {
		bytes,
		contentType: c.req.header('content-type') ?? 'application/octet-stream',
	}
}

/** `GET /voice`: whether to show the microphone. A node with no speech model in its region says no. */
operatorInventoryVoiceRoutes.get(
	'/voice',
	inventoryGuard({
		scope: ['read', 'write'],
		grant: INVENTORY_PERMISSIONS.READ_INVENTORY,
	}),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, locationQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				voiceCapabilitySchema.parse({
					available: voiceCountsAvailable(inventoryCaller(ctx)),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryVoiceRoutes.post(
	'/voice/propose',
	inventoryGuard({ scope: 'write', grant: UPDATE, feature: 'voiceCounts' }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, voiceProposeQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			const audio = await readAudio(c)
			if (!audio)
				return inventoryDeny(413, 'invalid_request', {
					reason: 'audio_too_large',
				})
			return respond(
				ctx,
				voiceProposalSchema.parse(
					await proposeFromAudio(await getTenantDb(ctx.orgId), {
						caller: inventoryCaller(ctx),
						locationId: location.locationId,
						audio,
						language: query.data.language,
					}),
				),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryVoiceRoutes.post(
	'/voice/parse',
	inventoryGuard({ scope: 'write', grant: UPDATE, feature: 'voiceCounts' }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, voiceParseSchema)
			if ('error' in body) return body.error
			const location = requireInventoryLocation(ctx, body.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				voiceProposalSchema.parse(
					await proposeFromText(await getTenantDb(ctx.orgId), {
						caller: inventoryCaller(ctx),
						locationId: location.locationId,
						transcript: body.data.transcript,
					}),
				),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)
