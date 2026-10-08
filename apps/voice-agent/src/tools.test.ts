import { DEFAULT_PHONE_AGENT_SETTINGS, resolvePhrase } from '@repo/phone-agent'
import { describe, expect, it, vi } from 'vitest'
import { setupTools, testConfig } from './test-fixtures.ts'

const CORE_TOOLS = [
	'end_call',
	'get_business_info',
	'record_request',
	'set_call_purpose',
	'tag_call',
]

describe('tag_call', () => {
	it("applies only the business's tags", async () => {
		const { run, state } = setupTools()
		const tagId = DEFAULT_PHONE_AGENT_SETTINGS.tags[0]!.id
		await expect(run('tag_call', { tagId })).resolves.toEqual({ tagged: true })
		await expect(run('tag_call', { tagId: 'made_up' })).resolves.toMatchObject({
			error: expect.any(String),
		})
		expect([...state.tags]).toEqual([tagId])
	})
})

describe('transfer tools', () => {
	it('are left out when transfers are turned off', () => {
		const { tools } = setupTools({
			settings: {
				escalationPhone: '+15556667777',
				safety: { callingDisabled: false, transfersDisabled: true },
			},
		})
		expect(tools.transfer_to_staff).toBeUndefined()
		expect(tools.transfer_to_contact).toBeUndefined()
	})

	it('offers transfer_to_contact for active cases', () => {
		const { tools } = setupTools({
			settings: {
				contacts: [{ id: 'sam', name: 'Sam', phone: '+15558889999' }],
				transferCases: [
					{
						id: 'billing',
						contactId: 'sam',
						when: 'Billing questions',
						hours: 'always',
						retries: 0,
						isActive: true,
					},
				],
			},
		})
		expect(tools.transfer_to_contact).toBeDefined()
		expect(tools.transfer_to_staff).toBeUndefined()
	})
})

describe('switch_language', () => {
	it('is only offered when the agent speaks more than one language', () => {
		expect(setupTools().tools.switch_language).toBeUndefined()
		expect(
			setupTools({ settings: { languages: ['en', 'ar'] } }).tools
				.switch_language,
		).toBeDefined()
	})

	it('moves speech and the voice to the language and records it', async () => {
		const setLanguage = vi.fn()
		const { run, state, controller } = setupTools({
			settings: { languages: ['en', 'ar'] },
			speech: { setLanguage },
		})
		await expect(run('switch_language', { language: 'ar' })).resolves.toEqual({
			switched: true,
			note: 'Reply in Arabic from now on.',
		})
		expect(setLanguage).toHaveBeenCalledWith('ar')
		expect(controller.language).toBe('ar')
		expect(state.language).toBe('ar')
		expect(controller.phrase('hold')).toBe(
			resolvePhrase('hold', 'ar').replace('{business}', 'Acme'),
		)
	})

	it('keeps the current language when the switch fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const { run, state, controller } = setupTools({
			settings: { languages: ['en', 'es'] },
			speech: {
				setLanguage: () => {
					throw new Error('socket closed')
				},
			},
		})
		await expect(run('switch_language', { language: 'es' })).resolves.toEqual({
			error: 'Could not switch to Spanish. Keep speaking English.',
		})
		expect(controller.language).toBe('en')
		expect(state.language).toBeNull()
		vi.restoreAllMocks()
	})
})

describe('general vertical', () => {
	const general = () => setupTools()

	it('offers only the core tools', () => {
		expect(Object.keys(general().tools).sort()).toEqual(CORE_TOOLS)
	})

	it('records the base request types and purposes', async () => {
		const { run, state, services } = general()
		await run('record_request', {
			type: 'complaint',
			details: [{ field: 'message', value: 'Too loud' }],
		})
		expect(services.createRequest).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'complaint' }),
		)
		await run('set_call_purpose', { purpose: 'business_information' })
		expect(state.declaredPurpose).toBe('business_information')
	})

	it('answers business questions from the business profile', async () => {
		const { run, state } = setupTools({
			config: testConfig({
				business: {
					...DEFAULT_PHONE_AGENT_SETTINGS.business,
					address: '1 Main St',
				},
			}),
		})
		await expect(run('get_business_info')).resolves.toMatchObject({
			openNow: true,
			details: 'Address: 1 Main St',
		})
		expect(state.toolsUsed.has('get_business_info')).toBe(true)
	})

	it('builds a prompt without business-type tools', () => {
		const instructions = general().controller.aiInstructions()
		expect(instructions).toContain('Acme')
		expect(instructions).toContain('get_business_info')
		expect(instructions).not.toMatch(/send_order_link|search_menu/i)
	})
})
