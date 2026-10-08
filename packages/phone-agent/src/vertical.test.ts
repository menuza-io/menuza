import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type PhoneAgentRuntimeConfig } from './config.ts'
import { createDefaultFlowGraph } from './flow.ts'
import { DEFAULT_PHONE_AGENT_SETTINGS } from './settings.ts'
import {
	callPurposeIds,
	callPurposeSchema,
	callRequestTypeIds,
	classifyCallPurpose,
	createVerticalContext,
	defaultFlowFor,
	defaultSettingsFor,
	faqBankFor,
	faqCategoryIds,
	generalVertical,
	LinkHandoffSchema,
	linkMessageFor,
	mergeDefinitions,
	messageVariablesFor,
	type PhoneAgentVertical,
	phraseDefinitionsFor,
	type PurposeSignals,
	trainingRuleCategoryIds,
	verticalSettingsOf,
	websitePathFor,
} from './vertical.ts'

type ClinicSettings = { newPatients: boolean }

const clinic: PhoneAgentVertical<{ doctor: string }, ClinicSettings> = {
	id: 'clinic',
	label: 'Clinic',
	scope: { label: 'Office', pluralLabel: 'Offices' },
	callPurposes: [{ id: 'appointment', label: 'Appointment' }],
	callRequestTypes: [{ id: 'refill', label: 'Prescription refill' }],
	trainingRuleCategories: [{ id: 'intake', label: 'Intake' }],
	faqCategories: [{ id: 'insurance', label: 'Insurance' }],
	faqQuestions: [
		{ id: 'insurers', category: 'insurance', question: 'Which insurers?' },
		{ id: 'parking', category: 'general', question: 'Is there a garage?' },
	],
	phraseDefaults: { text_link_sent: { label: 'Intake form sent' } },
	settings: {
		schema: z.object({ newPatients: z.boolean().default(true) }),
		defaults: { newPatients: true },
	},
	defaultSettings: { agentName: 'Front desk' },
	data: { parse: (value) => z.object({ doctor: z.string() }).parse(value) },
	messageVariables: ({ data }) => ({ doctor: data.doctor }),
	links: {
		websitePath: (scopeId) => (scopeId ? `/offices/${scopeId}` : '/offices'),
		websiteMessage: '{business}: book here {url}',
	},
	inferPurpose: (text) => (/appoint/i.test(text) ? 'appointment' : null),
	classifyPurpose: (signals) =>
		signals.requests.includes('refill') ? 'appointment' : null,
}

function config(
	overrides: Partial<PhoneAgentRuntimeConfig> = {},
): PhoneAgentRuntimeConfig {
	return {
		organization: { id: 'org', name: 'Clinic Co', slug: 'c', currency: 'USD' },
		scopeId: 'office_1',
		business: {
			name: 'Clinic Co',
			phone: null,
			timezone: 'America/Chicago',
			address: null,
			hours: [],
			specialHours: [],
		},
		availability: { isOpen: true, nextOpen: null },
		settings: DEFAULT_PHONE_AGENT_SETTINGS,
		flow: { versionId: null, graph: createDefaultFlowGraph() },
		rules: [],
		fallbackPhone: null,
		callsUrl: null,
		agentLines: [],
		vertical: { id: 'clinic', data: { doctor: 'Dr. Lee' } },
		...overrides,
	}
}

function signals(overrides: Partial<PurposeSignals> = {}): PurposeSignals {
	return {
		declaredPurpose: null,
		requests: [],
		toolsUsed: new Set(),
		linkSent: false,
		menuChoices: [],
		state: undefined,
		...overrides,
	}
}

describe('definition lists', () => {
	it('puts vertical entries first, then the base ones', () => {
		expect(callPurposeIds(clinic)).toEqual([
			'appointment',
			'business_information',
			'other',
		])
		expect(callRequestTypeIds(clinic)).toEqual([
			'refill',
			'callback',
			'complaint',
		])
		expect(trainingRuleCategoryIds(clinic)).toEqual([
			'intake',
			'escalation',
			'error_handling',
		])
		expect(faqCategoryIds(clinic)).toEqual([
			'insurance',
			'general',
			'policies',
			'custom',
		])
	})

	it('lets a vertical reuse a base id to move or reword it', () => {
		expect(
			mergeDefinitions(
				[{ id: 'a' }, { id: 'b' }, { id: 'c' }],
				[{ id: 'x' }, { id: 'b' }],
			).map((entry) => entry.id),
		).toEqual(['x', 'b', 'a', 'c'])
		const bank = faqBankFor(clinic)
		expect(bank.filter((entry) => entry.id === 'parking')).toEqual([
			{ id: 'parking', category: 'general', question: 'Is there a garage?' },
		])
		expect(bank[0]?.id).toBe('insurers')
	})

	it('gives the general vertical the base lists plus a general category', () => {
		expect(callPurposeIds(generalVertical)).toEqual([
			'business_information',
			'other',
		])
		expect(callRequestTypeIds(null)).toEqual(['callback', 'complaint'])
		expect(trainingRuleCategoryIds(generalVertical)).toEqual([
			'general',
			'escalation',
			'error_handling',
		])
	})

	it('validates ids against the vertical list', () => {
		expect(callPurposeSchema(clinic).safeParse('appointment').success).toBe(
			true,
		)
		expect(callPurposeSchema(null).safeParse('appointment').success).toBe(false)
		expect(callPurposeSchema(clinic).safeParse('Bad Id').success).toBe(false)
	})

	it('relabels phrases', () => {
		const definition = phraseDefinitionsFor(clinic).find(
			(entry) => entry.key === 'text_link_sent',
		)
		expect(definition?.label).toBe('Intake form sent')
		expect(definition?.defaults.en).toContain('our website')
	})
})

describe('settings and defaults', () => {
	it('starts new organizations with the vertical defaults', () => {
		const settings = defaultSettingsFor(clinic)
		expect(settings.agentName).toBe('Front desk')
		expect(settings.vertical).toEqual({ newPatients: true })
		expect(defaultSettingsFor(generalVertical)).toEqual(
			DEFAULT_PHONE_AGENT_SETTINGS,
		)
	})

	it('parses vertical settings and falls back on bad values', () => {
		expect(
			verticalSettingsOf(clinic, { vertical: { newPatients: false } }),
		).toEqual({ newPatients: false })
		expect(
			verticalSettingsOf(clinic, { vertical: { newPatients: 'x' } }),
		).toEqual({ newPatients: true })
		expect(verticalSettingsOf(clinic, { vertical: {} })).toEqual({
			newPatients: true,
		})
	})

	it('uses the vertical default flow, else the neutral one', () => {
		expect(defaultFlowFor(generalVertical)).toEqual(createDefaultFlowGraph())
		expect(
			defaultFlowFor({ defaultFlow: () => ({ nodes: [], edges: [] }) }),
		).toEqual({ nodes: [], edges: [] })
	})
})

describe('call context', () => {
	it('parses the vertical data and fills message variables', () => {
		const context = createVerticalContext(clinic, config())
		expect(context.data).toEqual({ doctor: 'Dr. Lee' })
		expect(context.verticalSettings).toEqual({ newPatients: true })
		expect(messageVariablesFor(clinic, context)).toEqual({
			doctor: 'Dr. Lee',
			business: 'Clinic Co',
		})
	})

	it('refuses a config built for another vertical', () => {
		expect(() =>
			createVerticalContext(
				generalVertical,
				config({ vertical: { id: 'clinic', data: null } }),
			),
		).toThrow(/clinic/)
	})
})

describe('classifyCallPurpose', () => {
	it('prefers the declared purpose, then the vertical, then core guesses', () => {
		expect(
			classifyCallPurpose(clinic, signals({ declaredPurpose: 'other' })),
		).toBe('other')
		expect(classifyCallPurpose(clinic, signals({ requests: ['refill'] }))).toBe(
			'appointment',
		)
		expect(
			classifyCallPurpose(
				clinic,
				signals({ toolsUsed: new Set(['get_business_info']) }),
			),
		).toBe('business_information')
		expect(
			classifyCallPurpose(
				clinic,
				signals({ menuChoices: ['Book an appointment'] }),
			),
		).toBe('appointment')
		expect(
			classifyCallPurpose(
				null,
				signals({ menuChoices: ['Hours and address'] }),
			),
		).toBe('business_information')
		expect(classifyCallPurpose(null, signals())).toBe('other')
	})
})

describe('links', () => {
	it('builds website paths and messages', () => {
		expect(websitePathFor(generalVertical, 'x')).toBe('/')
		expect(websitePathFor(clinic, 'office_1')).toBe('/offices/office_1')
		expect(
			linkMessageFor(clinic, 'website', { business: 'Clinic Co', url: 'u' }),
		).toBe('Clinic Co: book here u')
		expect(
			linkMessageFor(null, 'handoff', { business: 'Clinic Co', url: 'u' }),
		).toBe("Clinic Co: here's the link from our call: u")
	})

	it('accepts site paths and bounded JSON payloads only', () => {
		expect(
			LinkHandoffSchema.safeParse({ path: '/book?x=1', payload: { a: 1 } })
				.success,
		).toBe(true)
		for (const path of ['//evil.test', 'https://x.test', '/a b', '/a#b']) {
			expect(LinkHandoffSchema.safeParse({ path, payload: {} }).success).toBe(
				false,
			)
		}
		expect(
			LinkHandoffSchema.safeParse({
				path: '/',
				payload: 'x'.repeat(40_000),
			}).success,
		).toBe(false)
		expect(LinkHandoffSchema.safeParse({ path: '/' }).success).toBe(false)
	})
})
