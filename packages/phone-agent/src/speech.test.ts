import { describe, expect, it } from 'vitest'
import { DEFAULT_PHONE_AGENT_SETTINGS } from './settings.ts'
import { applyPronunciations, buildKeyterms, MAX_KEYTERMS } from './speech.ts'
import { resolveTransfer, transferAvailability } from './transfers.ts'

describe('applyPronunciations', () => {
	it('replaces whole words, case-insensitively, longest first', () => {
		const text = applyPronunciations('Try our gnocchi or Gnocchi Sorrentina.', [
			{ term: 'gnocchi', sayAs: 'nyoh-kee' },
			{ term: 'gnocchi sorrentina', sayAs: 'nyoh-kee sor-en-tee-nah' },
		])
		expect(text).toBe('Try our nyoh-kee or nyoh-kee sor-en-tee-nah.')
	})

	it('leaves partial words alone', () => {
		expect(
			applyPronunciations('Pho and phone', [{ term: 'pho', sayAs: 'fuh' }]),
		).toBe('fuh and phone')
	})
})

describe('buildKeyterms', () => {
	it('puts owner terms first, dedupes, and caps the list', () => {
		const terms = buildKeyterms({
			settings: {
				keyterms: ['Banh Mi', 'banh mi'],
				pronunciations: [{ term: 'Pho', sayAs: 'fuh' }],
			},
			businessName: 'Saigon House',
			extraTerms: ['Spring Rolls', 'pho'],
		})
		expect(terms).toEqual(['Banh Mi', 'Pho', 'Saigon House', 'Spring Rolls'])
		const many = buildKeyterms({
			settings: {
				keyterms: Array.from(
					{ length: 150 },
					(ignoredValue, index) => `term ${index}`,
				),
				pronunciations: [],
			},
			businessName: 'X',
		})
		expect(many).toHaveLength(MAX_KEYTERMS)
	})
})

describe('transferAvailability', () => {
	const settings = {
		...DEFAULT_PHONE_AGENT_SETTINGS,
		escalationPhone: '+15551230000',
		contacts: [{ id: 'billing', name: 'Sam', phone: '+15551239999' }],
		transferCases: [
			{
				id: 'big_accounts',
				contactId: 'billing',
				when: 'Billing questions',
				hours: 'always' as const,
				retries: 1,
				isActive: true,
			},
		],
	}

	it('respects business hours for general transfers', () => {
		expect(transferAvailability(settings, true).transfersAvailable).toBe(true)
		expect(transferAvailability(settings, false)).toEqual({
			transfersAvailable: false,
			availableTransferCaseIds: ['big_accounts'],
		})
	})

	it('turns everything off with the safety switch', () => {
		expect(
			transferAvailability(
				{
					...settings,
					safety: { callingDisabled: false, transfersDisabled: true },
				},
				true,
			),
		).toEqual({ transfersAvailable: false, availableTransferCaseIds: [] })
	})

	it('resolves a case to its contact', () => {
		expect(resolveTransfer(settings, false, 'big_accounts')).toMatchObject({
			phone: '+15551239999',
			retries: 1,
		})
		expect(resolveTransfer(settings, false)).toBeNull()
		expect(resolveTransfer(settings, true, 'unknown')).toBeNull()
	})
})
