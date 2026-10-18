import { msg } from '@lingui/core/macro'
import { describe, expect, it } from 'vitest'
import { hostErrorMessage, hostLoadErrorMessage } from './host-errors.ts'

const tx = (d: { message?: string }) => d.message ?? ''
const fallback = msg`Fallback`

describe('host errors', () => {
	it('maps a known code to translated copy and never prints the server message', () => {
		const err = Object.assign(new Error('Raw SQLITE_CONSTRAINT boom'), {
			status: 409,
			body: { error: 'table_conflict' },
		})
		const text = hostErrorMessage(err, tx, fallback)
		expect(text).toContain('table')
		expect(text).not.toContain('SQLITE')
	})

	it('falls back to the status, then to the fallback', () => {
		expect(
			hostErrorMessage(
				Object.assign(new Error('x'), { status: 403 }),
				tx,
				fallback,
			),
		).toContain('permission')
		expect(hostErrorMessage(new Error('x'), tx, fallback)).toBe('Fallback')
	})

	it('calls out access problems when the day cannot load', () => {
		expect(hostLoadErrorMessage({ status: 403, code: null }, tx)).toContain(
			'access',
		)
		expect(hostLoadErrorMessage({ status: 401, code: null }, tx)).toContain(
			'session',
		)
		expect(hostLoadErrorMessage({ status: 500, code: null }, tx)).toContain(
			'could not be loaded',
		)
	})
})
