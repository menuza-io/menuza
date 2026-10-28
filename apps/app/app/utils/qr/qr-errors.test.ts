import { i18n } from '@lingui/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { QR_ERROR_MESSAGES, qrErrorMessage } from './qr-errors.ts'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const translate = i18n._.bind(i18n)

describe('qrErrorMessage', () => {
	it('picks the translated sentence for a known code, never the region text', () => {
		const cause = new OperatorRequestError(
			'Region English that must not show',
			'table_label_taken',
			409,
		)
		const text = qrErrorMessage(cause, translate)
		expect(text).toBe(
			'A table with this label already exists at this location.',
		)
		expect(text).not.toContain('Region English')
	})

	it('has a sentence for every code the tabs, tables and settings screens act on', () => {
		for (const code of [
			'stale_tab',
			'tab_closed',
			'tab_not_found',
			'tab_open',
			'payment_pending',
			'payment_review',
			'table_label_taken',
			'table_limit',
			'table_not_found',
		]) {
			expect(QR_ERROR_MESSAGES[code]).toBeDefined()
		}
	})

	it('falls back to the status, then to a generic line', () => {
		expect(
			qrErrorMessage(
				new OperatorRequestError('Nope', 'Missing QR scope', 403),
				translate,
			),
		).toBe('You do not have permission to do that.')
		expect(
			qrErrorMessage(
				new OperatorRequestError('Boom', 'weird_code', 500),
				translate,
			),
		).toBe('That did not work. Try again.')
		expect(qrErrorMessage(new Error('network'), translate)).toBe(
			'That did not work. Try again.',
		)
	})
})
