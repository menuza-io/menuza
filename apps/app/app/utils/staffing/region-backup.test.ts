// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	fetchStaffBackup,
	saveTextFile,
	staffBackupFilename,
} from './region-backup.ts'

afterEach(() => {
	vi.restoreAllMocks()
})

describe('staffBackupFilename', () => {
	it('is dated and sanitized', () => {
		const now = new Date('2026-10-11T12:00:00Z')
		expect(staffBackupFilename('Acme-Co', now)).toBe(
			'staff-backup-acme-co-2026-10-11.json',
		)
		expect(staffBackupFilename('../../etc/passwd', now)).toBe(
			'staff-backup-------etc-passwd-2026-10-11.json',
		)
		expect(staffBackupFilename('', now)).toBe(
			'staff-backup-organization-2026-10-11.json',
		)
	})
})

describe('fetchStaffBackup', () => {
	it('asks the regional export route and returns the file text', async () => {
		const request = vi.fn().mockResolvedValue({
			format: 'staff-export/v1',
			exportedAt: 1,
			orgId: 'o1',
			region: 'us',
			includes: { pay: false, private: false },
			staff: [{ id: 's1' }],
		})
		const text = await fetchStaffBackup({ request })
		expect(request).toHaveBeenCalledWith('/export')
		expect(JSON.parse(text)).toMatchObject({ staff: [{ id: 's1' }] })
	})

	it('refuses a response that is not an export', async () => {
		await expect(
			fetchStaffBackup({ request: vi.fn().mockResolvedValue({ staff: [] }) }),
		).rejects.toThrow('malformed_export')
		await expect(
			fetchStaffBackup({ request: vi.fn().mockResolvedValue(null) }),
		).rejects.toThrow('malformed_export')
	})

	it('passes request failures through (flag off, no permission, region down)', async () => {
		const failure = new Error('token_unavailable')
		await expect(
			fetchStaffBackup({ request: vi.fn().mockRejectedValue(failure) }),
		).rejects.toBe(failure)
	})
})

describe('saveTextFile', () => {
	it('downloads through a temporary link and releases the object URL', async () => {
		const createObjectURL = vi.fn().mockReturnValue('blob:test')
		const revokeObjectURL = vi.fn()
		vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, 'click')
			.mockImplementation(() => {})

		saveTextFile('backup.json', '{"a":1}')

		expect(createObjectURL).toHaveBeenCalledTimes(1)
		const blob = createObjectURL.mock.calls[0]![0] as Blob
		expect(blob.type).toBe('application/json')
		expect(blob.size).toBe('{"a":1}'.length)
		expect(click).toHaveBeenCalledTimes(1)
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:test')
		expect(document.querySelector('a[download]')).toBeNull()
		vi.unstubAllGlobals()
	})
})
