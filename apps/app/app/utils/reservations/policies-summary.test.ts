import { describe, expect, it } from 'vitest'
import { emptyPolicyForm, summarizePolicyForm } from './policies-view.ts'

const t = (d: {
	message?: string
	id?: string
	values?: Record<string, unknown>
}) =>
	(d.message ?? d.id ?? '').replace(/\{(\w+)\}/g, (_, k) =>
		String(d.values?.[k]),
	)

describe('summarizePolicyForm', () => {
	it('is null for an empty deposit', () => {
		expect(
			summarizePolicyForm(
				{ ...emptyPolicyForm(), kind: 'deposit' },
				'USD',
				'en',
				t as never,
			),
		).toBeNull()
	})
	it('describes a per-guest deposit with free cancellation', () => {
		const text = summarizePolicyForm(
			{
				...emptyPolicyForm(),
				kind: 'deposit',
				amount: '10',
				perCover: true,
				freeCancelHours: '24',
				refundRule: 'full_before_window',
			},
			'USD',
			'en',
			t as never,
		)
		expect(text).toContain('per guest')
		expect(text).toContain('24 h')
	})
	it('says nothing is charged for a card guarantee', () => {
		expect(
			summarizePolicyForm(
				{ ...emptyPolicyForm(), kind: 'card_guarantee' },
				'USD',
				'en',
				t as never,
			),
		).toContain('Nothing is charged')
	})
})
