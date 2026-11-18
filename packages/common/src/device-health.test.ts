import { describe, expect, it } from 'vitest'
import {
	dayStrip,
	heartbeatSchema,
	inferOutages,
	presenceIntervals,
	totalOutageMinutes,
} from './device-health.ts'

const M = 60_000
const T0 = Date.UTC(2026, 10, 16, 0, 0)
const at = (hours: number, minutes = 0) => T0 + hours * 60 * M + minutes * M
const open = (from: number, to: number) => ({
	startMs: at(from),
	endMs: at(to),
})
const beats = (fromMin: number, toMin: number) =>
	Array.from({ length: toMin - fromMin }, (_, i) => T0 + (fromMin + i) * M)

describe('presenceIntervals', () => {
	it('merges consecutive minutes and bridges a gap shorter than the grace', () => {
		const presence = presenceIntervals([...beats(0, 10), ...beats(12, 20)])
		expect(presence).toEqual([{ startMs: T0, endMs: T0 + 20 * M }])
	})
	it('keeps a gap of the grace or longer apart', () => {
		const presence = presenceIntervals([...beats(0, 10), ...beats(13, 20)])
		expect(presence).toHaveLength(2)
	})
})

describe('inferOutages', () => {
	const base = {
		fromMs: at(0),
		toMs: at(24),
		nowMs: at(24),
		firstSeenAt: at(0),
	}
	it('reports a gap during opening hours with its length ("Offline 14:02 to 14:19")', () => {
		const presence = presenceIntervals([
			...beats(12 * 60, 14 * 60 + 2),
			...beats(14 * 60 + 19, 18 * 60),
		])
		const outages = inferOutages({
			...base,
			presence,
			openIntervals: [open(12, 18)],
		})
		expect(outages).toEqual([
			{
				startMs: at(14, 2),
				endMs: at(14, 19),
				minutes: 17,
				ongoing: false,
			},
		])
		expect(totalOutageMinutes(outages)).toBe(17)
	})

	it('never reports time the location was closed, so a tablet switched off overnight is not offline', () => {
		const presence = presenceIntervals(beats(9 * 60, 22 * 60))
		expect(
			inferOutages({ ...base, presence, openIntervals: [open(9, 22)] }),
		).toEqual([])
	})

	it('infers nothing when opening hours are unknown, or before the terminal existed', () => {
		expect(
			inferOutages({ ...base, presence: [], openIntervals: null }),
		).toEqual([])
		expect(
			inferOutages({
				...base,
				presence: [],
				openIntervals: [open(9, 22)],
				firstSeenAt: at(21),
			}),
		).toEqual([{ startMs: at(21), endMs: at(22), minutes: 60, ongoing: false }])
		expect(
			inferOutages({
				...base,
				presence: [],
				openIntervals: [open(9, 22)],
				firstSeenAt: null,
			}),
		).toEqual([])
	})

	it('flags an outage that is still going and does not look past now', () => {
		const outages = inferOutages({
			...base,
			nowMs: at(15),
			presence: presenceIntervals(beats(12 * 60, 14 * 60)),
			openIntervals: [open(12, 18)],
		})
		expect(outages).toEqual([
			{ startMs: at(14), endMs: at(15), minutes: 60, ongoing: true },
		])
	})

	it('ignores a short blip under the grace', () => {
		const presence = presenceIntervals([
			...beats(12 * 60, 13 * 60),
			...beats(13 * 60 + 2, 14 * 60),
		])
		expect(
			inferOutages({ ...base, presence, openIntervals: [open(12, 14)] }),
		).toEqual([])
	})
})

describe('dayStrip', () => {
	it('colours a day: closed, online, offline, unknown before the first check-in, future', () => {
		const presence = presenceIntervals([
			...beats(10 * 60, 12 * 60),
			...beats(13 * 60, 14 * 60),
		])
		const openIntervals = [open(10, 14)]
		const nowMs = at(16)
		const outages = inferOutages({
			presence,
			openIntervals,
			fromMs: at(0),
			toMs: at(24),
			nowMs,
			firstSeenAt: at(8),
		})
		const cells = dayStrip({
			dayStartMs: at(0),
			dayEndMs: at(24),
			presence,
			openIntervals,
			outages,
			nowMs,
			firstSeenAt: at(8),
		})
		expect(cells).toHaveLength(96)
		expect(cells[0]).toBe('unknown') // before the terminal existed
		expect(cells[8 * 4]).toBe('closed') // 08:00, shut, quiet
		expect(cells[10 * 4]).toBe('online')
		expect(cells[12 * 4 + 2]).toBe('offline') // 12:30, open and silent
		expect(cells[13 * 4]).toBe('online')
		expect(cells[15 * 4]).toBe('closed')
		expect(cells[20 * 4]).toBe('future')
	})
})

describe('heartbeatSchema', () => {
	it('accepts a heartbeat with technical facts only and refuses anything else', () => {
		expect(
			heartbeatSchema.safeParse({
				appVersion: '1.2.3',
				batteryPct: 80,
				pendingUploads: 2,
				lastUploadAt: 1,
			}).success,
		).toBe(true)
		for (const extra of [
			{ staffName: 'Sam' },
			{ orders: [] },
			{ batteryPct: 101 },
			{ printerState: 'on fire' },
		])
			expect(heartbeatSchema.safeParse(extra).success).toBe(false)
	})
})
