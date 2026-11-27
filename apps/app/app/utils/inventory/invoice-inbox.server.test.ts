import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
	update: vi.fn(),
	location: { code: null as string | null },
}))

vi.mock('@repo/database', async (importOriginal) => ({
	...(await importOriginal<typeof import('@repo/database')>()),
	db: {
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => [{ code: state.location.code }] }),
			}),
		}),
		update: () => ({
			set: () => ({ where: () => ({ returning: state.update }) }),
		}),
	},
}))

import {
	ensureInvoiceInboxCode,
	generateInvoiceInboxCode,
	INVOICE_CODE_LENGTH,
} from './invoice-inbox.server.ts'

describe('generateInvoiceInboxCode', () => {
	it('is the right length, from the readable alphabet only', () => {
		const code = generateInvoiceInboxCode()
		expect(code).toHaveLength(INVOICE_CODE_LENGTH)
		expect(code).toMatch(/^[a-hj-km-np-z2-9]+$/)
	})

	it('redraws bytes that would favour some letters (no modulo bias)', () => {
		// 248 is the first byte at or above the largest multiple of 31 that fits (31 x 8).
		const bytes = [
			255, 248, 250, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
		]
		const random = {
			getRandomValues: (array: Uint8Array) => {
				array.set(bytes.slice(0, array.length))
				return array
			},
		} as unknown as Crypto
		const code = generateInvoiceInboxCode(random)
		// The first three bytes were skipped, so the code starts at byte 0 -> 'a'.
		expect(code.startsWith('abcdefgh')).toBe(true)
	})
})

describe('ensureInvoiceInboxCode', () => {
	beforeEach(() => {
		state.update.mockReset()
		state.location.code = null
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	it('returns the code a location already has, writing nothing', async () => {
		state.location.code = 'abcdefghjkmn'
		expect(
			await ensureInvoiceInboxCode({ organizationId: 'o', locationId: 'l' }),
		).toBe('abcdefghjkmn')
		expect(state.update).not.toHaveBeenCalled()
	})

	it('tries another code after a unique-index collision', async () => {
		state.update
			.mockRejectedValueOnce(new Error('UNIQUE constraint failed: code'))
			.mockResolvedValueOnce([{ code: 'zzzzzzzzzzzz' }])
		expect(
			await ensureInvoiceInboxCode({ organizationId: 'o', locationId: 'l' }),
		).toBe('zzzzzzzzzzzz')
		expect(state.update).toHaveBeenCalledTimes(2)
	})

	it('does not hide a real failure as "not found": an outage is rethrown and logged by ids only', async () => {
		state.update.mockRejectedValue(
			new Error('D1_ERROR: network connection lost'),
		)
		await expect(
			ensureInvoiceInboxCode({ organizationId: 'org_1', locationId: 'loc_1' }),
		).rejects.toThrow('network connection lost')
		expect(state.update).toHaveBeenCalledTimes(1)
		const logged = JSON.stringify(vi.mocked(console.error).mock.calls)
		expect(logged).toContain('loc_1')
		expect(logged).not.toMatch(/[a-hj-km-np-z2-9]{12}/)
	})
})
