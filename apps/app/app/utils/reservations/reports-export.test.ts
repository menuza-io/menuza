import { describe, expect, it } from 'vitest'
import { type ReportByKind } from './reports-api.ts'
import { reportCsv, reportTable } from './reports-export.ts'

const translate = (d: { message?: string }) => d.message ?? ''

describe('report export', () => {
	it('turns a report into rows with a translated header', () => {
		const report = {
			range: { from: '2026-04-14', to: '2026-04-20', serviceId: null },
			services: [],
			total: 1,
			covers: 2,
			rate: 1,
			byService: [],
			byPartySize: [],
			rows: [
				{
					reservationId: 'r1',
					businessDate: '2026-04-15',
					time: '19:00',
					service: 'Dinner',
					partySize: 2,
					channel: 'online',
				},
			],
		} as unknown as ReportByKind['no-shows']
		const csv = reportCsv(reportTable('no-shows', report), translate)
		expect(csv).toBe(
			'Date,Time,Service,Party,Source\r\n2026-04-15,19:00,Dinner,2,online\r\n',
		)
	})

	it('quotes commas and guards text that a spreadsheet would run as a formula', () => {
		const csv = reportCsv(
			{
				header: [],
				rows: [['=SUM(A1)', 'Lunch, late', 'say "hi"', null, -3]],
			},
			translate,
		)
		expect(csv).toContain(`'=SUM(A1),"Lunch, late","say ""hi""",,-3`)
	})
})
