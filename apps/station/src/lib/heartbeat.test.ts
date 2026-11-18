import { heartbeatSchema } from '@repo/common/device-health'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PosSettings } from './config.ts'
import {
	browserLabel,
	buildHeartbeat,
	sendHeartbeat,
	startHeartbeat,
} from './heartbeat.ts'

vi.mock('./outbox.ts', () => ({
	LAST_UPLOAD_KEY: 'lastUploadAt',
	pendingCount: vi.fn(async () => 2),
}))
vi.mock('./shifts.ts', () => ({ openShift: vi.fn(async () => undefined) }))
vi.mock('./db.ts', () => ({ getMeta: vi.fn(async () => undefined) }))

const settings = (over: Partial<PosSettings> = {}) =>
	({
		tenantApiUrl: 'https://api.test/',
		deviceToken: 'tok',
		demo: false,
		...over,
	}) as PosSettings

describe('browserLabel', () => {
	it('names the browser family and major version, and nothing else', () => {
		expect(
			browserLabel(
				'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/130.0.6723.58 Mobile Safari/537.36',
			),
		).toBe('Chrome 130')
		expect(
			browserLabel(
				'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
			),
		).toBe('Safari 17')
		expect(
			browserLabel(
				'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/131.0',
			),
		).toBe('Firefox 131')
		expect(
			browserLabel(
				'Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0',
			),
		).toBe('Edge 130')
		expect(browserLabel('curl/8')).toBeNull()
	})
})

describe('buildHeartbeat', () => {
	it('reports only what the browser can read, in the contract’s shape', () => {
		const body = buildHeartbeat({
			appVersion: '1.2.3',
			userAgent: 'Chrome/130.0',
			battery: { level: 0.644, charging: true },
			storage: { usage: 120 * 1024 * 1024, quota: 4000 * 1024 * 1024 },
			pendingUploads: 3,
			lastUploadAt: 1000,
			openShiftId: 'shift-1',
		})
		expect(heartbeatSchema.safeParse(body).success).toBe(true)
		expect(body).toMatchObject({
			batteryPct: 64,
			charging: true,
			storageUsedMb: 120,
			storageQuotaMb: 4000,
			pendingUploads: 3,
			drawerShiftId: 'shift-1',
		})
		// No signal for these exists in a browser, so none is invented.
		expect(body).not.toHaveProperty('printerState')
		expect(body).not.toHaveProperty('drawerOpenedAt')
	})

	it('leaves out what the browser does not report', () => {
		const body = buildHeartbeat({
			appVersion: null,
			userAgent: 'x',
			battery: null,
			storage: null,
			pendingUploads: 0,
			lastUploadAt: null,
			openShiftId: null,
		})
		expect(body.batteryPct).toBeNull()
		expect(body.storageUsedMb).toBeNull()
		expect(heartbeatSchema.safeParse(body).success).toBe(true)
	})
})

describe('sendHeartbeat', () => {
	it('posts to the terminal’s region with the device secret and says whether history is collected', async () => {
		const fetchImpl = vi.fn(async () => Response.json({ enabled: true }))
		const result = await sendHeartbeat(
			settings(),
			{ appVersion: '1' },
			fetchImpl,
		)
		expect(result).toEqual({ enabled: true })
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe('https://api.test/pos/heartbeat')
		expect((init.headers as Record<string, string>).Authorization).toBe(
			'Bearer tok',
		)
		expect(
			await sendHeartbeat(
				settings(),
				{},
				vi.fn(async () => Response.json({ enabled: false })),
			),
		).toEqual({ enabled: false })
	})

	it('does nothing unpaired, and never throws on a network failure', async () => {
		const fetchImpl = vi.fn()
		expect(
			await sendHeartbeat(settings({ deviceToken: null }), {}, fetchImpl),
		).toBeNull()
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(
			await sendHeartbeat(
				settings(),
				{},
				vi.fn(async () => {
					throw new Error('offline')
				}),
			),
		).toBeNull()
		expect(
			await sendHeartbeat(
				settings(),
				{},
				vi.fn(async () => new Response('no', { status: 500 })),
			),
		).toBeNull()
	})
})

describe('startHeartbeat', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('sends at most once a minute while the app is open', async () => {
		const send = vi.fn(async () => ({ enabled: true }))
		const stop = startHeartbeat(() => settings(), {
			isTraining: () => false,
			send,
			now: () => Date.now(),
		})
		await vi.advanceTimersByTimeAsync(5_000)
		expect(send).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(send).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(send).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(5 * 60_000)
		expect(send.mock.calls.length).toBeLessThanOrEqual(7)
		stop()
		const calls = send.mock.calls.length
		await vi.advanceTimersByTimeAsync(5 * 60_000)
		expect(send).toHaveBeenCalledTimes(calls)
	})

	it('backs off to every ten minutes while the organization does not collect history', async () => {
		const send = vi.fn(async () => ({ enabled: false }))
		const stop = startHeartbeat(() => settings(), {
			isTraining: () => false,
			send,
		})
		await vi.advanceTimersByTimeAsync(5_000)
		expect(send).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(9 * 60_000)
		expect(send).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(2 * 60_000)
		expect(send).toHaveBeenCalledTimes(2)
		stop()
	})

	it('sends nothing in training mode, in demo mode, or when unpaired', async () => {
		const send = vi.fn(async () => ({ enabled: true }))
		let training = true
		const stop = startHeartbeat(() => settings({ demo: false }), {
			isTraining: () => training,
			send,
		})
		await vi.advanceTimersByTimeAsync(3 * 60_000)
		expect(send).not.toHaveBeenCalled()
		stop()
		const demo = startHeartbeat(() => settings({ demo: true }), {
			isTraining: () => false,
			send,
		})
		const unpaired = startHeartbeat(() => settings({ deviceToken: null }), {
			isTraining: () => false,
			send,
		})
		await vi.advanceTimersByTimeAsync(3 * 60_000)
		expect(send).not.toHaveBeenCalled()
		demo()
		unpaired()
		training = false
	})
})
