import { describe, expect, it } from 'vitest'
import { faqForScope, type FaqEntry } from './faq.ts'
import { resolvePhrase } from './phrases.ts'
import {
	DEFAULT_PHONE_AGENT_SETTINGS,
	PhoneAgentSettingsSchema,
	unsupportedPhoneFields,
} from './settings.ts'

describe('PhoneAgentSettingsSchema', () => {
	it('fills defaults for settings saved before the newer fields existed', () => {
		const {
			faq: ignoredFaq,
			contacts: ignoredContacts,
			transfers: ignoredTransfers,
			tags: ignoredTags,
			csatEnabled: ignoredCsat,
			...older
		} = DEFAULT_PHONE_AGENT_SETTINGS
		const parsed = PhoneAgentSettingsSchema.parse(older)
		expect(parsed.faq).toEqual([])
		expect(parsed.contacts).toEqual([])
		expect(parsed.transfers.pressZeroForStaff).toBe(true)
		expect(parsed.tags.map((tag) => tag.id)).toEqual(['vip', 'complaint'])
		expect(parsed.csatEnabled).toBe(false)
		expect(parsed.vertical).toEqual({})
		expect(parsed.business.hours).toEqual([])
		expect(parsed.transfers.hours).toBe('business_hours')
	})

	it('drops stored overrides of the required notices', () => {
		const parsed = PhoneAgentSettingsSchema.parse({
			...DEFAULT_PHONE_AGENT_SETTINGS,
			phrases: [
				{ key: 'disclosure', language: 'en', text: "Welcome to Joe's!" },
				{ key: 'recording_notice', language: 'en', text: 'Hi!' },
				{ key: 'hold', language: 'en', text: 'One moment.' },
			],
		})
		expect(parsed.phrases.map((phrase) => phrase.key)).toEqual(['hold'])
		expect(
			resolvePhrase('disclosure', 'en', [
				{ key: 'disclosure', language: 'en', text: "Welcome to Joe's!" },
			]),
		).toBe("You've reached {business}'s automated phone assistant.")
	})

	it('accepts the defaults as-is', () => {
		expect(
			PhoneAgentSettingsSchema.safeParse(DEFAULT_PHONE_AGENT_SETTINGS).success,
		).toBe(true)
	})

	it('still loads stored numbers outside the US and Canada', () => {
		expect(
			PhoneAgentSettingsSchema.safeParse({
				...DEFAULT_PHONE_AGENT_SETTINGS,
				escalationPhone: '+442071234567',
			}).success,
		).toBe(true)
	})
})

describe('unsupportedPhoneFields', () => {
	it('lists numbers the agent would dial or text outside the US and Canada', () => {
		expect(
			unsupportedPhoneFields({
				escalationPhone: '+442071234567',
				contacts: [
					{ id: 'chef', name: 'Chef', phone: '+12025550123' },
					{ id: 'owner', name: 'Owner', phone: '+18765550123' },
				],
				notifications: {
					...DEFAULT_PHONE_AGENT_SETTINGS.notifications,
					smsNumbers: ['+14165550123', '+19005550123'],
				},
			}),
		).toEqual([
			'escalationPhone',
			'contacts.1.phone',
			'notifications.smsNumbers.1',
		])
	})

	it('accepts US and Canada numbers and an empty staff phone', () => {
		expect(
			unsupportedPhoneFields({
				...DEFAULT_PHONE_AGENT_SETTINGS,
				escalationPhone: null,
				contacts: [{ id: 'chef', name: 'Chef', phone: '+14165550123' }],
			}),
		).toEqual([])
	})
})

describe('faqForScope', () => {
	const entries: FaqEntry[] = [
		{
			id: 'parking',
			category: 'general',
			question: 'Parking?',
			answer: 'Lot behind us.',
		},
		{
			id: 'parking',
			category: 'general',
			question: 'Parking?',
			answer: 'Street only.',
			scopeId: 'loc_2',
		},
		{ id: 'wifi', category: 'general', question: 'Wi-Fi?', answer: '' },
		{
			id: 'dogs',
			category: 'general',
			question: 'Dogs?',
			answer: 'Patio only.',
			scopeId: 'loc_3',
		},
	]

	it('drops unanswered questions and other scopes', () => {
		expect(faqForScope(entries, 'loc_1').map((entry) => entry.answer)).toEqual([
			'Lot behind us.',
		])
		expect(faqForScope(entries, null).map((entry) => entry.answer)).toEqual([
			'Lot behind us.',
		])
	})

	it('prefers the scoped answer', () => {
		expect(faqForScope(entries, 'loc_2').map((entry) => entry.answer)).toEqual([
			'Street only.',
		])
	})
})

describe('resolvePhrase', () => {
	it('uses the override for the language, else the default', () => {
		const overrides = [
			{ key: 'hold' as const, language: 'en' as const, text: 'One moment.' },
		]
		expect(resolvePhrase('hold', 'en', overrides)).toBe('One moment.')
		expect(resolvePhrase('hold', 'es', overrides)).toContain('espere')
	})

	it('uses the vertical default before the built-in one', () => {
		const vertical = {
			text_link_sent: { defaults: { en: 'Here is your booking link.' } },
			disclosure: { defaults: { en: 'Hi from the bot.' } },
		}
		expect(resolvePhrase('text_link_sent', 'en', [], vertical)).toBe(
			'Here is your booking link.',
		)
		expect(resolvePhrase('text_link_sent', 'ar', [], vertical)).toContain(
			'رابط',
		)
		expect(
			resolvePhrase(
				'text_link_sent',
				'en',
				[{ key: 'text_link_sent', language: 'en', text: 'Owner text.' }],
				vertical,
			),
		).toBe('Owner text.')
		expect(resolvePhrase('disclosure', 'en', [], vertical)).toContain(
			'automated phone assistant',
		)
	})
})
