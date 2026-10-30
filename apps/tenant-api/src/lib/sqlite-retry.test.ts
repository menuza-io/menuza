import { describe, expect, it } from 'vitest'
import { isSqliteBusyError, retryOnSqliteBusy } from './sqlite-retry.ts'

describe('isSqliteBusyError', () => {
	it('matches the driver error itself', () => {
		expect(
			isSqliteBusyError(new Error('SQLITE_BUSY: database is locked')),
		).toBe(true)
		expect(
			isSqliteBusyError(
				Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
			),
		).toBe(true)
	})

	it('matches a busy error wrapped by drizzle in `cause`', () => {
		const driver = Object.assign(new Error('database is locked'), {
			code: 'SQLITE_BUSY',
		})
		const wrapped = new Error('Failed query: insert into ... params: ...', {
			cause: driver,
		})
		expect(isSqliteBusyError(wrapped)).toBe(true)
		const deeper = new Error('outer', {
			cause: new Error('middle', {
				cause: new Error('SQLITE_BUSY: database is locked'),
			}),
		})
		expect(isSqliteBusyError(deeper)).toBe(true)
	})

	it('does not match other errors, or a cause cycle', () => {
		expect(isSqliteBusyError(new Error('UNIQUE constraint failed'))).toBe(false)
		expect(isSqliteBusyError('SQLITE_BUSY')).toBe(false)
		const cyclic = new Error('a') as Error & { cause?: unknown }
		cyclic.cause = cyclic
		expect(isSqliteBusyError(cyclic)).toBe(false)
	})
})

describe('retryOnSqliteBusy', () => {
	it('retries an operation whose busy error is wrapped in `cause`', async () => {
		let attempts = 0
		const result = await retryOnSqliteBusy(async () => {
			attempts += 1
			if (attempts < 3) {
				throw new Error('Failed query', {
					cause: Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' }),
				})
			}
			return 'ok'
		})
		expect(result).toBe('ok')
		expect(attempts).toBe(3)
	})

	it('does not retry other errors', async () => {
		let attempts = 0
		await expect(
			retryOnSqliteBusy(async () => {
				attempts += 1
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')
		expect(attempts).toBe(1)
	})
})
