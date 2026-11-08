// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKioskQueue } from '#app/utils/kiosk/kiosk-queue.ts'
import type * as kioskQueue from '#app/utils/kiosk/kiosk-queue.ts'
import { useKioskRuntime } from './use-kiosk-runtime.ts'

const HOUR = 60 * 60 * 1000

/** Holds every `expire` on the runtime's queue until the test lets it go. */
const expireGate = vi.hoisted(() => ({
	hold: null as Promise<void> | null,
}))
vi.mock('#app/utils/kiosk/kiosk-queue.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof kioskQueue>()
	return {
		...actual,
		createKioskQueue: () => {
			const queue = actual.createKioskQueue()
			const expire = queue.expire.bind(queue)
			queue.expire = async (at) => {
				if (expireGate.hold) await expireGate.hold
				return expire(at)
			}
			return queue
		},
	}
})

describe('useKioskRuntime', () => {
	beforeEach(() => {
		localStorage.setItem(
			'kiosk.device.v1',
			JSON.stringify({
				deviceSecret: 'a'.repeat(32),
				tenantApiUrl: 'https://tenant.example.com',
				config: {
					device: {
						id: 'd1',
						name: 'Front',
						scopeId: 'main',
						identifyMode: 'pin',
						showNextShifts: false,
					},
					scope: { name: null, timeZone: null },
				},
			}),
		)
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('Failed to fetch')
			}),
		)
	})

	afterEach(() => {
		localStorage.clear()
		vi.unstubAllGlobals()
	})

	it('sets aside stale queued punches (and their PINs) even when offline', async () => {
		const queue = createKioskQueue()
		await queue.enqueue({
			id: 'stale-1',
			kind: 'clock_in',
			clientAt: Date.now() - 50 * HOUR,
			pin: '4821',
		})
		const { unmount } = renderHook(() =>
			useKioskRuntime({
				us: 'https://us.example.com',
				ksa: 'https://ksa.example.com',
			}),
		)
		await waitFor(async () => {
			const failed = await queue.failed()
			expect(failed).toHaveLength(1)
			expect(failed[0]).toMatchObject({
				id: 'stale-1',
				failure: 'punch_too_old',
				pin: null,
			})
		})
		unmount()
	})

	it('never sends a punch that a slower expiry run is setting aside', async () => {
		const queue = createKioskQueue()
		await queue.enqueue({
			id: 'stale-2',
			kind: 'clock_in',
			clientAt: Date.now() - 50 * HOUR,
			pin: '4821',
		})
		let release!: () => void
		expireGate.hold = new Promise<void>((resolve) => {
			release = resolve
		})
		const paths: string[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const path = new URL(String(input)).pathname
				paths.push(path)
				if (path === '/kiosk/config') {
					return Response.json({
						device: {
							id: 'd1',
							name: 'Front',
							scopeId: 'main',
							identifyMode: 'pin',
							showNextShifts: false,
						},
						scope: { name: null, timeZone: null },
						serverNow: Date.now(),
					})
				}
				return Response.json({ status: 'ok' })
			}),
		)

		const { unmount } = renderHook(() =>
			useKioskRuntime({
				us: 'https://us.example.com',
				ksa: 'https://ksa.example.com',
			}),
		)
		// The heartbeat is not held up by the slow expiry.
		await waitFor(() => expect(paths).toContain('/kiosk/config'))
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(paths).not.toContain('/kiosk/punch')

		release()
		await waitFor(async () => {
			expect(
				(await queue.failed()).find((punch) => punch.id === 'stale-2'),
			).toMatchObject({ failure: 'punch_too_old', pin: null })
		})
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(paths).not.toContain('/kiosk/punch')
		expireGate.hold = null
		unmount()
	})
})
