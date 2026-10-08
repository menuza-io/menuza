import { randomUUID } from 'node:crypto'
import {
	PHONE_AGENT_DISPATCH_NAME,
	type TestCallMetadata,
} from '@repo/phone-agent'
import {
	AccessToken,
	RoomAgentDispatch,
	RoomConfiguration,
} from 'livekit-server-sdk'
import { ENV } from 'varlock/env'

export function getLiveKitConfig() {
	const url = ENV.LIVEKIT_URL
	const apiKey = ENV.LIVEKIT_API_KEY
	const apiSecret = ENV.LIVEKIT_API_SECRET
	if (!url || !apiKey || !apiSecret) return null
	return { url, apiKey, apiSecret }
}

/**
 * Mints a short-lived token for an owner's browser test call. The agent is
 * dispatched by the room configuration in the token, and the dispatch
 * metadata is signed with the API secret, so the worker can trust it.
 */
export async function createTestCallToken({
	orgId,
	scopeId,
	flow,
	userId,
	displayName,
}: {
	orgId: string
	scopeId: string | null
	flow: 'draft' | 'published'
	userId: string
	displayName: string
}) {
	const config = getLiveKitConfig()
	if (!config) throw new Error('LiveKit is not configured')

	const roomName = `test_${orgId}_${randomUUID()}`
	const metadata: TestCallMetadata = {
		channel: 'web_test',
		orgId,
		scopeId,
		flow,
	}
	const token = new AccessToken(config.apiKey, config.apiSecret, {
		identity: `operator_${userId}`,
		name: displayName,
		ttl: '15m',
	})
	token.addGrant({
		room: roomName,
		roomJoin: true,
		canPublish: true,
		canSubscribe: true,
		canPublishData: true,
	})
	token.roomConfig = new RoomConfiguration({
		emptyTimeout: 60,
		maxParticipants: 3,
		agents: [
			new RoomAgentDispatch({
				agentName: PHONE_AGENT_DISPATCH_NAME,
				metadata: JSON.stringify(metadata),
			}),
		],
	})
	return {
		serverUrl: config.url,
		roomName,
		participantToken: await token.toJwt(),
	}
}
