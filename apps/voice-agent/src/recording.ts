import {
	EgressClient,
	EncodedFileOutput,
	EncodedFileType,
	S3Upload,
} from 'livekit-server-sdk'
import { ENV } from 'varlock/env'

/** How long call start waits for Egress before going on without a recording. */
export const RECORDING_START_TIMEOUT_MS = 10_000

export function recordingStorageConfigured() {
	return Boolean(
		ENV.RECORDING_S3_BUCKET &&
		ENV.RECORDING_S3_ACCESS_KEY &&
		ENV.RECORDING_S3_SECRET,
	)
}

export function recordingKey(orgId: string, callId: string) {
	return `voice-recordings/${orgId}/${callId}.ogg`
}

export type EgressApi = {
	/** Starts recording the room to `key`; resolves with the egress id. */
	start(roomName: string, key: string): Promise<string>
	stop(egressId: string): Promise<void>
}

/** Audio-only room composite recordings uploaded to our storage. */
export function liveKitEgress(): EgressApi {
	const client = new EgressClient(
		ENV.LIVEKIT_URL,
		ENV.LIVEKIT_API_KEY,
		ENV.LIVEKIT_API_SECRET,
		{ requestTimeout: RECORDING_START_TIMEOUT_MS / 1000 },
	)
	return {
		async start(roomName, key) {
			const info = await client.startRoomCompositeEgress(
				roomName,
				new EncodedFileOutput({
					fileType: EncodedFileType.OGG,
					filepath: key,
					output: {
						case: 's3',
						value: new S3Upload({
							bucket: ENV.RECORDING_S3_BUCKET!,
							region: ENV.RECORDING_S3_REGION ?? '',
							endpoint: ENV.RECORDING_S3_ENDPOINT ?? '',
							accessKey: ENV.RECORDING_S3_ACCESS_KEY!,
							secret: ENV.RECORDING_S3_SECRET!,
							forcePathStyle: Boolean(ENV.RECORDING_S3_ENDPOINT),
						}),
					},
				}),
				{ audioOnly: true },
			)
			return info.egressId
		},
		async stop(egressId) {
			await client.stopEgress(egressId)
		},
	}
}

export type CallRecording = {
	/**
	 * Starts the recording. Resolves with the object key, or null when
	 * storage is not configured, Egress fails, or it doesn't answer within
	 * the timeout; a failed recording must never drop or hold up the call.
	 */
	start(): Promise<string | null>
	/**
	 * Stops the recording now, or as soon as a slow start completes, so no
	 * egress outlives the part of the call the caller was told about. Never
	 * rejects.
	 */
	stop(): Promise<void>
}

/**
 * An audio-only room recording through LiveKit Egress. If Egress starts after
 * the timeout, `onLateStart` still gets the key so the call log can point at
 * the recording; an egress that starts after stop() is stopped right away.
 */
export function createCallRecording({
	roomName,
	orgId,
	callId,
	onLateStart,
	egress = liveKitEgress,
	timeoutMs = RECORDING_START_TIMEOUT_MS,
}: {
	roomName: string
	orgId: string
	callId: string
	onLateStart?: (key: string) => void
	egress?: () => EgressApi
	timeoutMs?: number
}): CallRecording {
	const key = recordingKey(orgId, callId)
	let api: EgressApi | null = null
	let egressId: string | null = null
	let startCalled = false
	let stopped = false
	let stopping: Promise<void> | null = null

	const stopEgress = () => {
		if (!api || !egressId) return Promise.resolve()
		const id = egressId
		const client = api
		stopping ??= client.stop(id).catch((error: unknown) => {
			// Egress also ends by itself when the room closes.
			console.warn('Could not stop the call recording', error)
		})
		return stopping
	}

	return {
		async start() {
			if (startCalled || stopped) return null
			startCalled = true
			if (!recordingStorageConfigured()) {
				console.warn(
					'Call recording is on but RECORDING_S3_* is not configured',
				)
				return null
			}
			let timedOut = false
			let timer: ReturnType<typeof setTimeout> | undefined
			const started = Promise.resolve()
				.then(() => {
					api = egress()
					return api.start(roomName, key)
				})
				.then(
					(id) => {
						egressId = id
						if (stopped) {
							console.warn(
								'Recording started after the call moved on; stopping it',
							)
							void stopEgress()
						}
						if (timedOut) onLateStart?.(key)
						return key
					},
					(error: unknown) => {
						console.error('Failed to start call recording', error)
						return null
					},
				)
			const timeout = new Promise<null>((resolve) => {
				timer = setTimeout(() => {
					timedOut = true
					console.error('Timed out starting call recording')
					resolve(null)
				}, timeoutMs)
			})
			try {
				return await Promise.race([started, timeout])
			} finally {
				clearTimeout(timer)
			}
		},
		stop() {
			stopped = true
			return stopEgress()
		},
	}
}
