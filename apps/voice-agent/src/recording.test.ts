import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createCallRecording,
	type EgressApi,
	RECORDING_START_TIMEOUT_MS,
	recordingKey,
} from './recording.ts'

const env = vi.hoisted(() => ({
	ENV: {
		LIVEKIT_URL: 'wss://livekit.test',
		LIVEKIT_API_KEY: 'key',
		LIVEKIT_API_SECRET: 'secret',
		RECORDING_S3_BUCKET: 'recordings' as string | undefined,
		RECORDING_S3_ACCESS_KEY: 'access',
		RECORDING_S3_SECRET: 'secret',
	},
}))
vi.mock('varlock/env', () => env)

const call = { roomName: 'room_1', orgId: 'org_1', callId: 'call_1' }
const key = recordingKey('org_1', 'call_1')

function fakeEgress(start: EgressApi['start'] = async () => 'egress_1') {
	const api = {
		start: vi.fn(start),
		stop: vi.fn<EgressApi['stop']>(async () => undefined),
	}
	return { api, egress: () => api }
}

describe('createCallRecording', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		env.ENV.RECORDING_S3_BUCKET = 'recordings'
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('starts Egress for the room and returns the object key', async () => {
		const { api, egress } = fakeEgress()
		const recording = createCallRecording({ ...call, egress })
		await expect(recording.start()).resolves.toBe(key)
		expect(api.start).toHaveBeenCalledWith('room_1', key)
		expect(key).toBe('voice-recordings/org_1/call_1.ogg')
	})

	it('stops the running egress once', async () => {
		const { api, egress } = fakeEgress()
		const recording = createCallRecording({ ...call, egress })
		await recording.start()
		await recording.stop()
		await recording.stop()
		expect(api.stop).toHaveBeenCalledTimes(1)
		expect(api.stop).toHaveBeenCalledWith('egress_1')
	})

	it('does nothing on stop when recording never started', async () => {
		const { api, egress } = fakeEgress()
		const recording = createCallRecording({ ...call, egress })
		await recording.stop()
		await expect(recording.start()).resolves.toBeNull()
		expect(api.start).not.toHaveBeenCalled()
		expect(api.stop).not.toHaveBeenCalled()
	})

	it('goes on without a recording when storage is not configured', async () => {
		env.ENV.RECORDING_S3_BUCKET = undefined
		const { api, egress } = fakeEgress()
		const recording = createCallRecording({ ...call, egress })
		await expect(recording.start()).resolves.toBeNull()
		expect(api.start).not.toHaveBeenCalled()
	})

	it('goes on without a recording when Egress fails', async () => {
		const { egress } = fakeEgress(async () => {
			throw new Error('egress down')
		})
		const recording = createCallRecording({ ...call, egress })
		await expect(recording.start()).resolves.toBeNull()
		await expect(recording.stop()).resolves.toBeUndefined()
	})

	it('stops waiting for a hung Egress call and reports a late start', async () => {
		let started!: (id: string) => void
		const { api, egress } = fakeEgress(
			() => new Promise<string>((resolve) => (started = resolve)),
		)
		const onLateStart = vi.fn()
		const recording = createCallRecording({ ...call, egress, onLateStart })
		const result = recording.start()
		await vi.advanceTimersByTimeAsync(RECORDING_START_TIMEOUT_MS)
		await expect(result).resolves.toBeNull()
		expect(onLateStart).not.toHaveBeenCalled()
		started('egress_late')
		await vi.advanceTimersByTimeAsync(0)
		expect(onLateStart).toHaveBeenCalledWith(key)
		expect(api.stop).not.toHaveBeenCalled()
	})

	it('stops an egress that starts after the call is over, still reporting the key', async () => {
		let started!: (id: string) => void
		const { api, egress } = fakeEgress(
			() => new Promise<string>((resolve) => (started = resolve)),
		)
		const onLateStart = vi.fn()
		const recording = createCallRecording({ ...call, egress, onLateStart })
		const result = recording.start()
		await vi.advanceTimersByTimeAsync(RECORDING_START_TIMEOUT_MS)
		await expect(result).resolves.toBeNull()
		await recording.stop()
		expect(api.stop).not.toHaveBeenCalled()
		started('egress_late')
		await vi.advanceTimersByTimeAsync(0)
		expect(api.stop).toHaveBeenCalledWith('egress_late')
		expect(onLateStart).toHaveBeenCalledWith(key)
	})

	it('stops an egress that starts after a hand-off within the timeout', async () => {
		let started!: (id: string) => void
		const { api, egress } = fakeEgress(
			() => new Promise<string>((resolve) => (started = resolve)),
		)
		const recording = createCallRecording({ ...call, egress })
		const result = recording.start()
		await vi.advanceTimersByTimeAsync(0)
		void recording.stop()
		started('egress_2')
		await expect(result).resolves.toBe(key)
		expect(api.stop).toHaveBeenCalledWith('egress_2')
	})

	it('does not throw when stopping Egress fails', async () => {
		const { api, egress } = fakeEgress()
		api.stop.mockRejectedValueOnce(new Error('already ended'))
		const recording = createCallRecording({ ...call, egress })
		await recording.start()
		await expect(recording.stop()).resolves.toBeUndefined()
	})

	it('does not throw when Egress throws synchronously', async () => {
		const recording = createCallRecording({
			...call,
			egress: () => {
				throw new Error('bad config')
			},
		})
		await expect(recording.start()).resolves.toBeNull()
		expect(vi.getTimerCount()).toBe(0)
	})
})
