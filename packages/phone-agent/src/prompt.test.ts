import { describe, expect, it } from 'vitest'
import { type PhoneAgentRuntimeConfig } from './config.ts'
import { type FaqEntry, fitFaqToBudget } from './faq.ts'
import {
	buildAgentInstructions,
	DEFAULT_KNOWLEDGE_CHAR_BUDGET,
	type PromptContext,
} from './prompt.ts'
import { type TrainingRule } from './rules.ts'
import { DEFAULT_PHONE_AGENT_SETTINGS } from './settings.ts'
import {
	createVerticalContext,
	generalVertical,
	promptContextFor,
} from './vertical.ts'

function faqEntry(
	id: string,
	answer: string,
	scopeId: string | null = null,
): FaqEntry {
	return {
		id,
		category: 'custom',
		question: `Question ${id}?`,
		answer,
		scopeId,
	}
}

function promptWith(
	overrides: Partial<PromptContext> & { faq?: FaqEntry[] },
): string {
	const { faq = [], ...rest } = overrides
	return buildAgentInstructions({
		businessName: 'Bright Smiles',
		settings: { ...DEFAULT_PHONE_AGENT_SETTINGS, faq },
		rules: [],
		scopeId: 'loc',
		isOpen: true,
		businessDetails: '',
		now: new Date('2026-03-02T18:00:00Z'),
		timezone: 'America/New_York',
		...rest,
	})
}

describe('fitFaqToBudget', () => {
	it('keeps scoped answers first and skips what does not fit', () => {
		const result = fitFaqToBudget(
			[
				faqEntry('org_long', 'x'.repeat(200)),
				faqEntry('org_short', 'Yes.'),
				faqEntry('local', 'Free lot.', 'loc'),
			],
			80,
		)
		expect(result.entries.map((entry) => entry.id)).toEqual([
			'local',
			'org_short',
		])
		expect(result.droppedIds).toEqual(['org_long'])
	})

	it('keeps everything within budget', () => {
		const entries = [faqEntry('a', 'One.'), faqEntry('b', 'Two.')]
		expect(fitFaqToBudget(entries, 1000)).toEqual({
			entries,
			droppedIds: [],
		})
	})
})

describe('buildAgentInstructions knowledge budget', () => {
	it('caps the FAQ at the default budget and notes the truncation', () => {
		const faq = Array.from({ length: 150 }, (ignoredValue, index) =>
			faqEntry(`q${index}`, 'a'.repeat(900)),
		)
		const text = promptWith({ faq })
		expect(text).toContain('Some saved answers were left out')
		expect(text).toContain('Q: Question q0?')
		expect(text).not.toContain('Q: Question q149?')
		const faqStart = text.indexOf('Q: Question q0?')
		const faqText = text.slice(faqStart, text.lastIndexOf('a'.repeat(900)))
		expect(faqText.length).toBeLessThanOrEqual(DEFAULT_KNOWLEDGE_CHAR_BUDGET)
	})

	it('does not note truncation when everything fits', () => {
		const text = promptWith({ faq: [faqEntry('parking', 'Free lot.')] })
		expect(text).toContain('Q: Question parking?\nA: Free lot.')
		expect(text).not.toContain('Some saved answers were left out')
	})

	it('shares one budget between training rules and the FAQ', () => {
		const rules: TrainingRule[] = [
			{
				id: 'r1',
				category: 'escalation',
				title: 'Always confirm',
				description: 'c'.repeat(400),
				priority: 'high',
				isActive: true,
			},
		]
		const faq = [
			faqEntry('first', 'f'.repeat(300)),
			faqEntry('second', 's'.repeat(300)),
		]
		const withoutRules = promptWith({ faq, knowledgeCharBudget: 1000 })
		expect(withoutRules).toContain('Q: Question second?')

		const withRules = promptWith({ faq, rules, knowledgeCharBudget: 1000 })
		expect(withRules).toContain('Always confirm (must follow)')
		expect(withRules).toContain('Q: Question first?')
		expect(withRules).not.toContain('Q: Question second?')
		expect(withRules).toContain('Some saved answers were left out')
	})

	it('prefers scoped answers when the budget is tight', () => {
		const text = promptWith({
			faq: [
				faqEntry('org', 'o'.repeat(300)),
				faqEntry('here', 'h'.repeat(300), 'loc'),
			],
			knowledgeCharBudget: 400,
		})
		expect(text).toContain('Q: Question here?')
		expect(text).not.toContain('Q: Question org?')
	})
})

function generalConfig(
	overrides: Partial<PhoneAgentRuntimeConfig> = {},
): PhoneAgentRuntimeConfig {
	return {
		organization: {
			id: 'org',
			name: 'Bright Smiles',
			slug: 'bright',
			currency: 'USD',
		},
		scopeId: null,
		business: {
			name: 'Bright Smiles',
			phone: '+15555550100',
			timezone: 'America/New_York',
			address: '1 Main St',
			hours: [
				{
					day: 'monday',
					isOpen: true,
					slots: [{ start: '09:00', end: '17:00' }],
				},
			],
			specialHours: [],
		},
		availability: { isOpen: true, nextOpen: null },
		settings: { ...DEFAULT_PHONE_AGENT_SETTINGS, languages: ['en', 'es'] },
		flow: { versionId: null, graph: { nodes: [], edges: [] } },
		rules: [
			{
				id: 'r1',
				category: 'escalation',
				title: 'Complaints',
				description: 'Offer a manager for any complaint.',
				priority: 'high',
				isActive: true,
			},
		],
		fallbackPhone: null,
		callsUrl: null,
		agentLines: [],
		vertical: { id: 'general', data: null },
		...overrides,
	}
}

describe('buildAgentInstructions', () => {
	it('includes persona, tasks, the menu choice, and rules', () => {
		const context = createVerticalContext(generalVertical, generalConfig(), {
			now: new Date('2026-03-02T18:00:00Z'),
		})
		const text = buildAgentInstructions(
			promptContextFor(generalVertical, context, {
				menuChoice: 'Get help from the AI assistant',
			}),
		)
		expect(text).toContain(
			'You are Assistant, the AI phone assistant for Bright Smiles. ',
		)
		expect(text).toContain('If the caller speaks Spanish')
		expect(text).toContain('choosing "Get help from the AI assistant"')
		expect(text).toContain('get_business_info')
		expect(text).toContain('Business rules.')
		expect(text).toContain('Escalation:\n- Complaints (must follow)')
		expect(text).toContain('Address: 1 Main St')
		expect(text).toContain('Monday: 9am to 5pm')
		expect(text).toContain('Live transfer is turned off')
		expect(text).not.toContain('send_order_link')
	})

	it('adds the scope name and the after-hours line', () => {
		const text = promptWith({
			scopeName: 'Uptown',
			isOpen: false,
			nextOpen: 'Opens today at 9:00 AM',
			settings: {
				...DEFAULT_PHONE_AGENT_SETTINGS,
				afterHoursMode: 'take_message',
			},
		})
		expect(text).toContain('for Bright Smiles (Uptown).')
		expect(text).toContain('closed right now. Opens today at 9:00 AM.')
		expect(text).toContain('offer to take a message')
	})

	it('lets the vertical add tasks and sections and replace lines', () => {
		const text = promptWith({
			isOpen: false,
			settings: {
				...DEFAULT_PHONE_AGENT_SETTINGS,
				afterHoursMode: 'answer_only',
			},
			rules: [
				{
					id: 'kept',
					category: 'intake',
					title: 'Insurance',
					description: 'Ask for the insurer.',
					priority: 'medium',
					isActive: true,
				},
				{
					id: 'dropped',
					category: 'billing',
					title: 'Billing',
					description: 'Never quote prices.',
					priority: 'medium',
					isActive: true,
				},
			],
			ruleCategories: [{ id: 'intake', label: 'Intake' }],
			vertical: {
				style: ['Never give medical advice.'],
				tasks: ['Appointments: collect a name and a time.'],
				businessQuestions: 'Clinic questions: use the clinic details.',
				sections: ['New patients are welcome.'],
				afterHours: 'The clinic is closed.',
				rulesTitle: 'Clinic rules',
				includeRule: (rule) => rule.category !== 'billing',
			},
		})
		expect(text).toContain('Never give medical advice.')
		expect(text).toContain(
			'What you can do:\nAppointments: collect a name and a time.\nClinic questions: use the clinic details.\nMessages and callbacks',
		)
		expect(text).not.toContain('get_business_info')
		expect(text).toContain('New patients are welcome.')
		expect(text).toContain('The clinic is closed.')
		expect(text).not.toContain('answer questions, and tell the caller')
		expect(text).toContain('Clinic rules.')
		expect(text).toContain('Intake:\n- Insurance')
		expect(text).not.toContain('Billing')
	})

	it('lets the vertical word the payment rule, status line, and details', () => {
		const text = promptWith({
			isOpen: false,
			nextOpen: 'Opens today at 9:00 AM',
			businessDetails: 'Address: 1 Main St',
			vertical: {
				paymentNote: 'Copays are collected at the front desk.',
				status: ({ isOpen, nextOpen }) =>
					`The clinic is ${isOpen ? 'seeing' : 'not seeing'} patients. ${nextOpen}.`,
				detailsHeading: 'Clinic details',
				tasks: ['Clinic questions: use the clinic details.'],
				businessQuestions: null,
			},
		})
		expect(text).toContain(
			'payment details. Copays are collected at the front desk.\n',
		)
		expect(text).toContain(
			'The clinic is not seeing patients. Opens today at 9:00 AM.',
		)
		expect(text).not.toContain('local time')
		expect(text).toContain('Clinic details:\nAddress: 1 Main St')
		expect(text).not.toContain('Business questions:')
	})

	it('adds answered FAQ, transfer cases, and auto tags', () => {
		const text = promptWith({
			settings: {
				...DEFAULT_PHONE_AGENT_SETTINGS,
				faq: [
					{
						id: 'parking',
						category: 'general',
						question: 'Where is parking?',
						answer: 'Free lot behind us.',
					},
					{ id: 'wifi', category: 'general', question: 'Wi-Fi?', answer: '' },
				],
				contacts: [
					{
						id: 'billing',
						name: 'Maria',
						phone: '+15555550123',
						role: 'Office manager',
					},
				],
				transferCases: [
					{
						id: 'billing',
						contactId: 'billing',
						when: 'Billing questions',
						hours: 'always',
						retries: 0,
						isActive: true,
					},
				],
			},
		})
		expect(text).toContain('Q: Where is parking?\nA: Free lot behind us.')
		expect(text).not.toContain('Wi-Fi?')
		expect(text).toContain(
			'- billing: Billing questions (goes to Maria, Office manager)',
		)
		expect(text).toContain('- complaint:')
	})

	it('says transfers are unavailable when turned off', () => {
		const text = promptWith({
			settings: {
				...DEFAULT_PHONE_AGENT_SETTINGS,
				escalationPhone: '+15555550100',
				safety: { callingDisabled: false, transfersDisabled: true },
			},
		})
		expect(text).toContain("Live transfer isn't available right now")
		expect(text).not.toContain('transfer_to_staff')
	})
})
