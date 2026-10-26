import { describe, expect, it } from 'vitest'
import { connectionOf } from './connection.ts'
import { type HostStandState } from './useHostStand.ts'

const ready = (over: Partial<Extract<HostStandState, { status: 'ready' }>>) =>
	({
		status: 'ready',
		feed: {},
		feedDate: null,
		today: '2026-01-16',
		waitlist: [],
		grant: {},
		stale: false,
		readAt: 1_000,
		dayFailed: null,
		...over,
	}) as unknown as HostStandState

describe('whether the book can be trusted', () => {
	it('is fine when online and the last look worked', () => {
		expect(connectionOf(true, ready({}))).toEqual({ kind: 'ok' })
		expect(connectionOf(true, { status: 'loading' })).toEqual({ kind: 'ok' })
	})
	it('is offline when the tablet is, with the last good read, and writes wait', () => {
		expect(connectionOf(false, ready({ readAt: 5_000 }))).toEqual({
			kind: 'offline',
			readAt: 5_000,
			blocksWrites: true,
		})
		expect(connectionOf(false, { status: 'loading' })).toMatchObject({
			kind: 'offline',
			readAt: null,
		})
	})
	it('is not up to date after a failed look, and writes wait for it', () => {
		const state = ready({ stale: true, dayFailed: { date: null } })
		expect(connectionOf(true, state)).toEqual({
			kind: 'stale',
			readAt: 1_000,
			blocksWrites: true,
		})
	})
	it('lets writes go when only the waitlist failed to load (the day did)', () => {
		expect(connectionOf(true, ready({ stale: true }))).toMatchObject({
			kind: 'stale',
			blocksWrites: false,
		})
	})
	it('does not block today because another day failed to open', () => {
		const state = ready({ stale: true, dayFailed: { date: '2026-01-17' } })
		expect(connectionOf(true, state, null)).toMatchObject({
			blocksWrites: false,
		})
		expect(connectionOf(true, state, '2026-01-17')).toMatchObject({
			blocksWrites: true,
		})
	})
})
