import { runReport, getCatalog, FIGURES, monthlyAsOf } from '@repo/reports'
import { describe, expect, it, vi } from 'vitest'
import { fetchMonthlyFigures } from './monthly-client.ts'

function sale(day: string, over: Record<string, unknown> = {}) {
	return {
		occurredAt: new Date(`${day}T15:00:00Z`),
		locationTimeZone: 'America/Chicago',
		currency: 'USD',
		channel: 'online_menu',
		customerType: 'new',
		entry: 'sale',
		netSales: 100,
		saleCount: 1,
		...over,
	}
}

/** A fake region that runs the real engine over fixed records, like /analytics/query. */
function region(grants: string[]) {
	const records = [
		sale('2026-10-10'),
		sale('2026-10-11', { currency: 'SAR', netSales: 375, locationTimeZone: 'Asia/Riyadh' }),
		sale('2026-09-10', { netSales: 60 }),
	]
	const calls: Array<{ url: string; body: any }> = []
	const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === '/acme/reports/token') {
			return Response.json({ token: 'jwt' })
		}
		const body = JSON.parse(String(init!.body))
		calls.push({ url, body })
		const subject = body.definition.subject as string
		if (!grants.includes(subject)) return new Response('{}', { status: 403 })
		const result = runReport(
			getCatalog('organization'),
			body.definition,
			records as never,
			new Date(body.asOf),
			{ timeZone: body.timeZone },
		)
		return Response.json(result)
	})
	return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

describe('browser-direct monthly figures (#221)', () => {
	it('asks the region for the month and the month before, per figure, and splits currencies', async () => {
		const { fetchImpl, calls } = region(['sales'])
		const figures = await fetchMonthlyFigures({
			tokenUrl: '/acme/reports/token',
			tenantApiUrl: 'https://tenant.example.test/',
			month: '2026-10',
			ids: ['directSales', 'directOrders'],
			timeZone: 'America/Chicago',
			fetchImpl,
		})
		const by = Object.fromEntries(figures.map((f) => [f.id, f]))
		expect(by.directSales!.entries).toEqual([
			{ currency: 'SAR', value: 375 },
			{ currency: 'USD', value: 100 },
		])
		expect(by.directSales!.previous).toEqual([{ currency: 'USD', value: 60 }])
		expect(by.directOrders!.entries).toEqual([{ currency: null, value: 2 }])
		// Two runs per figure, at the month's two instants, all to the region.
		expect(calls).toHaveLength(4)
		expect(calls.every((c) => c.url === 'https://tenant.example.test/analytics/query')).toBe(true)
		const asOfs = new Set(calls.map((c) => c.body.asOf))
		expect(asOfs).toEqual(
			new Set([monthlyAsOf('2026-10').current.toISOString(), monthlyAsOf('2026-10').previous.toISOString()]),
		)
		// The figure is exactly the report the engine runs for the same definition.
		const direct = runReport(
			getCatalog('organization'),
			FIGURES.directOrders.definition('last_complete_month'),
			[sale('2026-10-10'), sale('2026-10-11', { locationTimeZone: 'Asia/Riyadh' })] as never,
			monthlyAsOf('2026-10').current,
			{ timeZone: 'America/Chicago' },
		)
		expect('total' in direct && direct.total).toBe(2)
	})

	it('leaves out a figure the token does not cover (hidden, not zero)', async () => {
		const { fetchImpl } = region([])
		const figures = await fetchMonthlyFigures({
			tokenUrl: '/acme/reports/token',
			tenantApiUrl: 'https://tenant.example.test',
			month: '2026-10',
			ids: ['directSales'],
			timeZone: 'UTC',
			fetchImpl,
		})
		expect(figures).toEqual([])
	})

	it('fails when the token cannot be minted', async () => {
		await expect(
			fetchMonthlyFigures({
				tokenUrl: '/acme/reports/token',
				tenantApiUrl: 'https://t.example.test',
				month: '2026-10',
				ids: ['directSales'],
				timeZone: 'UTC',
				fetchImpl: (async () => new Response('no', { status: 403 })) as never,
			}),
		).rejects.toThrow('monthly_token_failed')
	})
})
