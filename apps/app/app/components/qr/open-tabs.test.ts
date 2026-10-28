import { i18n } from '@lingui/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { type QrTab } from '#app/utils/qr/qr-model.ts'
import { describeTabChanges, parseTip, parseTipCents } from './open-tabs.tsx'

describe('parseTip', () => {
	it('reads Latin and Arabic digits and comma decimals', () => {
		expect(parseTipCents('5')).toBe(500)
		expect(parseTipCents('5,50')).toBe(550)
		expect(parseTipCents('٥٫٥')).toBe(550)
		expect(parseTipCents('۲')).toBe(200)
		expect(parseTip('')).toEqual({ cents: 0, valid: true })
	})

	it('refuses anything it would have to guess at', () => {
		for (const raw of ['abc', '-3', '1,000', '5 000', '1.234', '1.5.0']) {
			expect(parseTip(raw)).toEqual({ cents: 0, valid: false })
		}
	})
})

describe('describeTabChanges', () => {
	const translate = i18n._.bind(i18n)
	const tab = (id: string, label: string, rounds = 1) =>
		({
			id,
			table: { label },
			rounds: Array.from({ length: rounds }, (_, index) => ({
				id: `${id}-${index}`,
			})),
			guestName: 'Lina Haddad',
			guestPhone: '+15552223333',
		}) as unknown as QrTab

	beforeAll(() => {
		i18n.load('en', {})
		i18n.activate('en')
	})

	it('says nothing when the poll changed nothing a listener needs', () => {
		expect(
			describeTabChanges([tab('a', 'T1')], [tab('a', 'T1')], translate),
		).toBeNull()
	})

	it('announces the count and each opened, grown or gone tab by table only', () => {
		const text = describeTabChanges(
			[tab('a', 'T1'), tab('b', 'T2')],
			[tab('a', 'T1', 2), tab('c', 'T3')],
			translate,
		)
		expect(text).toBe(
			'2 open tabs. New round at table T1. New tab at table T3. Tab at table T2 is no longer open.',
		)
		expect(text).not.toContain('Lina')
		expect(text).not.toContain('555')
		expect(describeTabChanges([tab('a', 'T1')], [], translate)).toBe(
			'0 open tabs. Tab at table T1 is no longer open.',
		)
	})
})
