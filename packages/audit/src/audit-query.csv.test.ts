import { describe, expect, it, vi } from 'vitest'
import { AuditLogQuery } from './audit-query.ts'

describe('audit CSV export', () => {
	it('quotes every field and neutralizes formulas', async () => {
		const query = new AuditLogQuery()
		vi.spyOn(query, 'query').mockResolvedValue({
			logs: [
				{
					createdAt: new Date('2026-01-01T00:00:00Z'),
					id: 'a1',
					action: 'login',
					severity: 'info',
					userId: 'u1',
					user: { name: 'Doe, "J"\n=1+1', email: '@evil.example' },
					details: '=cmd|calc',
					ipAddress: '127.0.0.1',
					userAgent: '+1+1',
				},
			],
		} as never)
		const csv = await (query as AuditLogQuery).exportCSV({} as never)
		const [, row] = csv.split(/\n(?=")/)
		expect(row).toContain('"Doe, ""J""\n=1+1"')
		expect(row).toContain(`"'@evil.example"`)
		expect(row).toContain(`"'=cmd|calc"`)
		expect(row).toContain(`"'+1+1"`)
		expect(row!.startsWith('"2026-01-01T00:00:00.000Z"')).toBe(true)
	})
})
