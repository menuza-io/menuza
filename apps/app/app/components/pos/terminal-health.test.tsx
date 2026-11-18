// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	OfflineThisWeek,
	TerminalHealthPanel,
	type HealthSummaryDevice,
	type HealthWindows,
} from './terminal-health.tsx'

afterEach(() => cleanup())

const M = 60_000
const at = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h, m)
const NOW = at(18, 18)

const days = Array.from({ length: 7 }, (_, i) => ({
	date: `2026-11-${String(12 + i)}`,
	startMs: at(12 + i, 0),
	endMs: at(13 + i, 0),
}))
const openEveryDay = days.map((d) => ({
	startMs: d.startMs + 9 * 60 * M,
	endMs: d.startMs + 22 * 60 * M,
}))
const windows = (open: HealthWindows['none']['open']): HealthWindows => ({
	none: { timeZone: 'UTC', days, open },
	'loc-1': { timeZone: 'UTC', days, open },
})

/** Online 09:00-14:02 and from 14:19 to 18:00 on the 18th. */
const presence = [
	{ startMs: at(18, 9), endMs: at(18, 14, 2) },
	{ startMs: at(18, 14, 19), endMs: at(18, 18) },
]

describe('OfflineThisWeek', () => {
	const device = { id: 'd1', locationId: 'loc-1' }
	const summary = (entry: Partial<HealthSummaryDevice>) => ({
		now: NOW,
		devices: new Map([
			[
				'd1',
				{
					id: 'd1',
					locationId: 'loc-1',
					revokedAt: null,
					firstSeenAt: at(18, 9),
					presence,
					...entry,
				},
			],
		]),
	})

	it('adds up the outages during opening hours', () => {
		renderStaff(
			<OfflineThisWeek
				device={device}
				summary={summary({})}
				windows={windows(openEveryDay)}
			/>,
		)
		expect(screen.getByText('Offline time this week:')).toBeTruthy()
		expect(screen.getByText('17 min')).toBeTruthy()
	})

	it('says so when there is no history', () => {
		renderStaff(
			<OfflineThisWeek
				device={device}
				summary={summary({ firstSeenAt: null, presence: [] })}
				windows={windows(openEveryDay)}
			/>,
		)
		expect(screen.getByText('No history yet')).toBeTruthy()
	})

	it('does not guess an outage without opening hours', () => {
		renderStaff(
			<OfflineThisWeek
				device={device}
				summary={summary({})}
				windows={windows(null)}
			/>,
		)
		expect(
			screen.getByText('Set the opening hours to see offline time'),
		).toBeTruthy()
	})

	it('shows nothing before the history has loaded', () => {
		const { container } = renderStaff(
			<OfflineThisWeek
				device={device}
				summary={null}
				windows={windows(openEveryDay)}
			/>,
		)
		expect(container.textContent).toBe('')
	})
})

describe('TerminalHealthPanel', () => {
	const latest = (over: Record<string, unknown> = {}) => ({
		at: at(18, 17, 59),
		appVersion: '1.4.2',
		browser: 'Chrome 130',
		batteryPct: 64,
		charging: false,
		storageUsedMb: 120,
		storageQuotaMb: 4000,
		pendingUploads: 3,
		lastUploadAt: at(18, 17, 40),
		printerState: null,
		drawerOpenedAt: null,
		drawerShiftId: null,
		...over,
	})
	const detail = (over: Record<string, unknown> = {}) => ({
		enabled: true,
		now: NOW,
		firstSeenAt: at(18, 9),
		presence,
		latest: latest(),
		lastShiftOpened: { id: 's1', openedAt: at(18, 9, 5) },
		...over,
	})
	const open = async (body: unknown) => {
		const request = vi.fn(async () => body)
		renderStaff(
			<TerminalHealthPanel
				device={{ id: 'd1', label: 'Front counter', locationId: 'loc-1' }}
				windows={windows(openEveryDay)}
				request={request}
			/>,
		)
		fireEvent.click(
			screen.getByRole('button', { name: 'Health of Front counter' }),
		)
		await waitFor(() => expect(request).toHaveBeenCalledWith('/health/d1'))
		return request
	}

	it('draws a strip for each of the 7 days and lists the outage with its length', async () => {
		await open(detail())
		await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(7))
		const item = screen.getByText(/Offline .*02:02 PM to 02:19 PM, 17 min/)
		expect(item).toBeTruthy()
		// The day with the outage is labelled for a screen reader.
		expect(
			screen.getByRole('img', { name: /Wed, Nov 18: 1 outages/ }),
		).toBeTruthy()
	})

	it('shows version, battery, storage, uploads and the last shift opened', async () => {
		await open(detail())
		await screen.findByText('App version')
		expect(screen.getByText('1.4.2')).toBeTruthy()
		expect(screen.getByText('64%')).toBeTruthy()
		expect(screen.getByText('120 MB of 4000 MB')).toBeTruthy()
		expect(screen.getByText('Waiting to upload')).toBeTruthy()
		expect(screen.getByText('Last cash drawer shift opened')).toBeTruthy()
	})

	it('shows the printer and the cash drawer only when the till reported them', async () => {
		await open(detail())
		await screen.findByText('App version')
		expect(screen.queryByText('Receipt printer')).toBeNull()
		expect(screen.queryByText('Cash drawer last opened')).toBeNull()
		cleanup()
		await open(
			detail({
				latest: latest({
					printerState: 'out_of_paper',
					drawerOpenedAt: at(18, 17, 30),
					drawerShiftId: 's1',
				}),
			}),
		)
		await screen.findByText('Receipt printer')
		expect(screen.getByText('Out of paper')).toBeTruthy()
		expect(screen.getByText('Cash drawer last opened')).toBeTruthy()
	})

	it('reports no outage when the location has no opening hours', async () => {
		const request = vi.fn(async () => detail())
		renderStaff(
			<TerminalHealthPanel
				device={{ id: 'd1', label: 'Front counter', locationId: 'loc-1' }}
				windows={windows(null)}
				request={request}
			/>,
		)
		fireEvent.click(
			screen.getByRole('button', { name: 'Health of Front counter' }),
		)
		await screen.findByText(/no opening hours/)
		expect(screen.queryByText('Outages during opening hours')).toBeNull()
	})

	it('says there is no history yet for a terminal that never checked in', async () => {
		await open(detail({ firstSeenAt: null, presence: [], latest: null }))
		await screen.findByText(/No history yet/)
		expect(screen.queryAllByRole('img')).toHaveLength(0)
	})
})
