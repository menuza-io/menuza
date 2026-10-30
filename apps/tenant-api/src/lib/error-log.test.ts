import { describe, expect, it } from 'vitest'
import { errorLogFields } from './error-log.ts'

class FakeQueryError extends Error {
	query = 'update loyalty_ledger set note = ? where id = ?'
	params = ['Called Zainab about her allergy', 'l_1']
	constructor(cause: Error) {
		super(
			'Failed query: update loyalty_ledger set note = ? where id = ?\nparams: Called Zainab about her allergy,l_1',
			{ cause },
		)
		this.name = 'DrizzleQueryError'
	}
}

describe('errorLogFields', () => {
	it('keeps names, codes and frames but never the message or bound values', () => {
		const cause = Object.assign(new Error('UNIQUE failed: Zainab'), {
			name: 'SqliteError',
			code: 'SQLITE_CONSTRAINT_UNIQUE',
		})
		const fields = errorLogFields(new FakeQueryError(cause))
		expect(fields).toMatchObject({
			errorName: 'DrizzleQueryError',
			errorCode: 'SQLITE_CONSTRAINT_UNIQUE',
			causeName: 'SqliteError',
		})
		expect(fields.stack).toMatch(/^\s+at /)
		expect(JSON.stringify(fields)).not.toMatch(/Zainab|allergy|Failed query/)
	})

	it('describes a thrown non-error by its type only', () => {
		expect(errorLogFields('+966501234567')).toEqual({ errorName: 'string' })
	})
})
