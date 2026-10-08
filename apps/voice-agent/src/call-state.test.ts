import { CallFinishExtrasSchema, generalVertical } from '@repo/phone-agent'
import { describe, expect, it } from 'vitest'
import {
	buildFinishExtras,
	buildFinishInput,
	buildSummary,
	CallState,
	classifyPurpose,
	MAX_TAGS_PER_CALL,
	MAX_TEXTS_PER_CALL,
	resolveOutcome,
} from './call-state.ts'
import {
	dialRefusal,
	isAgentLine,
	normalizeE164,
	normalizeUsPhone,
	parseTestMetadata,
	phoneTail,
	priceFormatter,
} from './job-metadata.ts'
import { testConfig } from './test-fixtures.ts'

const formatPrice = priceFormatter('USD')
const vertical = generalVertical
const summaryOptions = { vertical, formatPrice }

describe('CallState transcript', () => {
	it('records turns with seconds since the call started', () => {
		const state = new CallState(1_000)
		state.addTurn('agent', '  Hello  ', 1_000)
		state.addTurn('caller', '', 2_000)
		state.addTurn('caller', 'Hi there', 4_600)
		expect(state.transcript).toEqual([
			{ role: 'agent', text: 'Hello', at: 0 },
			{ role: 'caller', text: 'Hi there', at: 4 },
		])
		expect(state.callerSpoke()).toBe(true)
	})
})

describe('classifyPurpose', () => {
	it('prefers the purpose the model declared', () => {
		const state = new CallState()
		state.toolsUsed.add('get_business_info')
		state.declaredPurpose = 'other'
		expect(classifyPurpose(state, vertical)).toBe('other')
	})

	it('falls back to the phone menu choices', () => {
		const booking = new CallState()
		booking.menuChoices.push('Book a table')
		expect(classifyPurpose(booking, vertical)).toBe('other')

		const hours = new CallState()
		hours.menuChoices.push('Hear our hours')
		expect(classifyPurpose(hours, vertical)).toBe('business_information')
	})

	it('infers business info and other', () => {
		const business = new CallState()
		business.toolsUsed.add('get_business_info')
		expect(classifyPurpose(business, vertical)).toBe('business_information')

		expect(classifyPurpose(new CallState(), vertical)).toBe('other')
	})
})

describe('resolveOutcome and summary', () => {
	it('reports an abandoned call when the caller never spoke', () => {
		const state = new CallState()
		state.addTurn('agent', 'Hello')
		expect(resolveOutcome(state)).toBe('abandoned')
	})

	it('summarizes a link and requests with the general wording', () => {
		const state = new CallState()
		state.link = { url: 'https://x.test/', smsSent: false }
		state.requests.push('callback')
		expect(buildSummary(state, summaryOptions)).toBe(
			'Link sent. The text message with the link could not be sent. Logged: callback request.',
		)
	})

	it("labels the vertical's request types", () => {
		const state = new CallState()
		state.requests.push('callback', 'complaint')
		expect(buildSummary(state, summaryOptions)).toBe(
			'Request recorded for staff follow-up. Logged: callback request, complaint.',
		)
	})

	it('escalation wins over other outcomes', () => {
		const state = new CallState()
		state.requests.push('callback')
		state.escalated = true
		expect(resolveOutcome(state)).toBe('escalated')
	})

	it('notes when the call moved to another language', () => {
		const state = new CallState()
		state.addTurn('caller', 'مرحبا')
		state.language = 'ar'
		expect(buildSummary(state, summaryOptions)).toBe(
			'Caller was helped by the agent. The call continued in Arabic.',
		)
	})

	it('tells a business-line call apart from a transfer loop', () => {
		const state = new CallState()
		state.loopBlocked = true
		state.fromBusinessLine = true
		expect(buildSummary(state, summaryOptions)).toContain(
			"business's own lines",
		)
	})
})

describe('dialRefusal', () => {
	it('allows US and Canadian numbers however they are written', () => {
		expect(dialRefusal('+15553334444', [])).toBeNull()
		expect(dialRefusal('(416) 555-0123', [])).toBeNull()
		// Puerto Rico is a US territory.
		expect(dialRefusal('+17875550123', [])).toBeNull()
	})

	it('refuses foreign, Caribbean, and premium numbers', () => {
		expect(dialRefusal('+447700900123', [])).toBe('not_us_or_canada')
		expect(dialRefusal('+18765550123', [])).toBe('not_us_or_canada')
		expect(dialRefusal('+19005550123', [])).toBe('not_us_or_canada')
	})

	it('refuses agent lines and unreadable numbers', () => {
		expect(dialRefusal('+15552001111', ['+15552001111'])).toBe('agent_line')
		expect(dialRefusal('front desk', [])).toBe('invalid')
		expect(dialRefusal(null, [])).toBe('invalid')
	})

	it('logs only the last four digits', () => {
		expect(phoneTail('+15553334444')).toBe('***4444')
		expect(phoneTail(null)).toBeNull()
	})
})

describe('job metadata helpers', () => {
	it('normalizes US phone numbers', () => {
		expect(normalizeUsPhone('(555) 234-5678')).toBe('+15552345678')
		expect(normalizeUsPhone('1 555 234 5678')).toBe('+15552345678')
		expect(normalizeUsPhone('+1.555.234.5678')).toBe('+15552345678')
		expect(normalizeUsPhone('+15552345678')).toBe('+15552345678')
		expect(
			normalizeUsPhone('five five five two three four five six seven eight'),
		).toBe('+15552345678')
	})

	it('rejects numbers that are not valid NANP lines', () => {
		expect(normalizeUsPhone('+447700900123')).toBeNull()
		expect(normalizeUsPhone('(555) 123-4567')).toBeNull()
		expect(normalizeUsPhone('(155) 234-5678')).toBeNull()
		expect(normalizeUsPhone('(055) 234-5678')).toBeNull()
		expect(normalizeUsPhone('911 234 5678')).toBeNull()
		expect(normalizeUsPhone('2 555 234 5678')).toBeNull()
		expect(normalizeUsPhone('555 234 5678 ext 2')).toBeNull()
		expect(normalizeUsPhone('12345')).toBeNull()
		expect(normalizeUsPhone(undefined)).toBeNull()
	})

	it('keeps international caller numbers', () => {
		expect(normalizeE164('+447700900123')).toBe('+447700900123')
		expect(normalizeE164('(555) 234-5678')).toBe('+15552345678')
		expect(normalizeE164('anonymous')).toBeNull()
	})

	it('caps texts per call', () => {
		const state = new CallState()
		expect(state.canText()).toBe(true)
		state.textsSent = MAX_TEXTS_PER_CALL
		expect(state.canText()).toBe(false)
	})

	it('accepts only well-formed test call metadata', () => {
		expect(
			parseTestMetadata(
				JSON.stringify({
					channel: 'web_test',
					orgId: 'o1',
					scopeId: 'l1',
					flow: 'draft',
				}),
			),
		).toEqual({
			channel: 'web_test',
			orgId: 'o1',
			scopeId: 'l1',
			flow: 'draft',
		})
		expect(
			parseTestMetadata(
				JSON.stringify({ channel: 'web_test', orgId: 'o1', flow: 'draft' }),
			),
		).toMatchObject({ scopeId: null })
		expect(parseTestMetadata('{"channel":"phone"}')).toBeNull()
		expect(parseTestMetadata('not json')).toBeNull()
		expect(parseTestMetadata(undefined)).toBeNull()
	})
})

describe('isAgentLine', () => {
	it('matches agent lines however the number is written', () => {
		const lines = ['+15552001111']
		expect(isAgentLine('+15552001111', lines)).toBe(true)
		expect(isAgentLine('(555) 200-1111', lines)).toBe(true)
		expect(isAgentLine('+15552001112', lines)).toBe(false)
		expect(isAgentLine(null, lines)).toBe(false)
		expect(isAgentLine('+15552001111', undefined)).toBe(false)
	})
})

describe('buildFinishInput', () => {
	it('builds the finish body tenant-api expects', () => {
		const config = testConfig()
		const state = new CallState(1_000)
		state.addTurn('caller', 'Hi', 2_000)
		const input = buildFinishInput(state, config, {
			...summaryOptions,
			now: 31_000,
		})
		expect(input).toMatchObject({
			orgId: 'org_1',
			outcome: 'resolved',
			purpose: 'other',
			durationSeconds: 30,
			recordingKey: null,
			recordingRetentionDays: config.settings.recordingRetentionDays,
			transferResult: 'none',
		})
		expect(CallFinishExtrasSchema.parse(input)).toMatchObject({
			transferResult: 'none',
		})
	})

	it('records a call hung up as a transfer loop as failed, with the reason', () => {
		const state = new CallState()
		state.failed = true
		state.loopBlocked = true
		const input = buildFinishInput(state, testConfig(), summaryOptions)
		expect(input.outcome).toBe('failed')
		expect(input.summary).toContain('transfer loop')
	})

	it('does not claim a cold transfer was answered', () => {
		const state = new CallState()
		state.escalated = true
		state.transferResult = 'referred'
		const input = buildFinishInput(state, testConfig(), summaryOptions)
		expect(input.outcome).toBe('escalated')
		expect(input.transferResult).toBe('referred')
		expect(input.summary).toBe(
			'Transferred to staff. The call was handed off without a way to tell whether staff answered.',
		)
	})
})

describe('buildFinishExtras', () => {
	it('sends what tenant-api needs for follow-up, in its schema', () => {
		const config = testConfig()
		const state = new CallState()
		const tagId = config.settings.tags[0]!.id
		state.addTag(tagId)
		state.rating = 4
		state.transferResult = 'no_answer'
		state.voicemail = true
		const extras = buildFinishExtras(state, config)
		expect(CallFinishExtrasSchema.parse(extras)).toEqual(extras)
		expect(extras).toMatchObject({
			tags: [tagId],
			rating: 4,
			transferResult: 'no_answer',
			voicemail: true,
			calledWhileOpen: true,
			callsUrl: config.callsUrl,
		})
		expect(extras.tagNames[tagId]).toBe(config.settings.tags[0]!.name)
	})

	it('caps tags per call', () => {
		const state = new CallState()
		for (let index = 0; index < MAX_TAGS_PER_CALL; index++) {
			expect(state.addTag(`tag_${index}`)).toBe(true)
		}
		expect(state.addTag('one_more')).toBe(false)
		expect(state.addTag('tag_0')).toBe(true)
	})
})
