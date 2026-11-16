import { emailBlocksSchema } from '@repo/common/email-blocks'
import {
	JOURNEY_TRIGGER_TYPES,
	validateWorkflowDAG,
} from '@repo/tenant-db/types/journey'
import { describe, expect, it } from 'vitest'
import {
	buildProgramJourney,
	getProgramTemplate,
	PROGRAM_IDS,
	PROGRAM_TEMPLATES,
	programAvailable,
	programLanguage,
	type BuildProgramInput,
	type ProgramCapabilities,
} from './programs.ts'

const input: BuildProgramInput = {
	organizationName: 'Olive & Co',
	siteOrigin: 'https://olive.example.com',
	reviewUrl: 'https://g.page/r/olive/review',
	language: 'en',
	channel: 'email',
	withCoupon: false,
	timeZone: 'Asia/Riyadh',
}

const everything: ProgramCapabilities = {
	ordering: true,
	reservations: true,
	loyalty: true,
	birthdays: true,
	cart: true,
	reviewUrl: 'https://g.page/r/olive/review',
}

/** The App renders each email's blocks to HTML before saving: stand-in for it. */
function withHtml(nodes: ReturnType<typeof buildProgramJourney>['nodes']) {
	return nodes.map((node) =>
		node.type === 'action_email'
			? { ...node, data: { ...node.data, bodyHtml: '<p>rendered</p>' } }
			: node,
	)
}

describe('ready-made programs (#100)', () => {
	it('has a template for every program id, each with a known trigger and a version', () => {
		expect(PROGRAM_TEMPLATES.map((t) => t.id).sort()).toEqual([...PROGRAM_IDS].sort())
		for (const template of PROGRAM_TEMPLATES) {
			expect((JOURNEY_TRIGGER_TYPES as readonly string[]).includes(template.triggerType)).toBe(true)
			expect(template.version).toBeGreaterThanOrEqual(1)
		}
	})

	it.each(PROGRAM_TEMPLATES.map((t) => [t.id, t] as const))(
		'%s passes the journey validator in both languages, by email and by text',
		(_id, template) => {
			for (const language of ['en', 'ar'] as const) {
				for (const channel of ['email', 'sms'] as const) {
					for (const withCoupon of [false, true]) {
						const journey = buildProgramJourney(template, {
							...input,
							language,
							channel,
							withCoupon,
						})
						const result = validateWorkflowDAG({
							nodes: withHtml(journey.nodes),
							edges: journey.edges,
						})
						expect(result.errors, `${template.id} ${language} ${channel}`).toEqual([])
						expect(result.valid).toBe(true)
						expect(result.hasCycles).toBe(false)
						// Every email step carries blocks the designer accepts.
						for (const id of journey.emailNodeIds) {
							const node = journey.nodes.find((n) => n.id === id)!
							expect(emailBlocksSchema.safeParse(node.data.blocks).success).toBe(true)
						}
					}
				}
			}
		},
	)

	it('only the programs that stop on an order carry the goal', () => {
		expect(
			PROGRAM_TEMPLATES.filter((t) => t.goal === 'order').map((t) => t.id).sort(),
		).toEqual(['cart_reminder', 'second_order', 'win_back'])
	})

	it('a template appears only when its trigger is available', () => {
		const available = (caps: Partial<ProgramCapabilities>) =>
			PROGRAM_TEMPLATES.filter((t) =>
				programAvailable(t, { ...everything, ...caps }),
			).map((t) => t.id)
		expect(available({})).toHaveLength(9)
		expect(available({ ordering: false })).not.toContain('first_order_thank_you')
		expect(available({ ordering: false })).not.toContain('cart_reminder')
		expect(available({ cart: false })).not.toContain('cart_reminder')
		expect(available({ birthdays: false })).not.toContain('birthday_treat')
		expect(available({ loyalty: false })).not.toContain('loyalty_reward')
		expect(available({ reservations: false })).not.toContain('no_show_follow_up')
		// The review request is left out when no Google listing is connected.
		expect(available({ reviewUrl: null })).not.toContain('after_visit')
		expect(available({ reviewUrl: null })).toContain('no_show_follow_up')
	})

	it('wires the coupon only on the steps that take one, and only when chosen', () => {
		const template = getProgramTemplate('cart_reminder')!
		const without = buildProgramJourney(template, { ...input, withCoupon: false })
		expect(without.couponNodeIds).toEqual([])
		const withCoupon = buildProgramJourney(template, { ...input, withCoupon: true })
		expect(withCoupon.couponNodeIds).toEqual(['last-call'])
		const text = JSON.stringify(withCoupon.nodes)
		expect(text).toContain('{{couponCode}}')
		expect(JSON.stringify(without.nodes)).not.toContain('{{couponCode}}')
		// A program with no coupon step never takes one.
		const welcome = buildProgramJourney(getProgramTemplate('welcome_series')!, {
			...input,
			withCoupon: true,
		})
		expect(welcome.couponNodeIds).toEqual([])
	})

	it('puts the organization name, links and the cart tag in the copy', () => {
		const cart = buildProgramJourney(getProgramTemplate('cart_reminder')!, input)
		const button = (cart.nodes[1]!.data.blocks as Array<{ type: string; config: { url?: string } }>).find(
			(block) => block.type === 'button',
		)
		expect(button?.config.url).toBe('{{cartLink}}')
		const welcome = buildProgramJourney(getProgramTemplate('welcome_series')!, input)
		expect(JSON.stringify(welcome.nodes)).toContain('Welcome to Olive & Co')
		expect(JSON.stringify(welcome.nodes)).toContain('https://olive.example.com/menu')
		const review = buildProgramJourney(getProgramTemplate('after_visit')!, input)
		expect(JSON.stringify(review.nodes)).toContain('https://g.page/r/olive/review')
	})

	it('writes in the organization language, falling back to English', () => {
		expect(programLanguage('ar-SA')).toBe('ar')
		expect(programLanguage('fr')).toBe('en')
		expect(programLanguage(null)).toBe('en')
		const ar = buildProgramJourney(getProgramTemplate('welcome_series')!, { ...input, language: 'ar' })
		expect(ar.name).toBe('سلسلة الترحيب')
	})

	it('the birthday program carries the organization time zone, and every template is plain data', () => {
		const birthday = buildProgramJourney(getProgramTemplate('birthday_treat')!, input)
		expect(birthday.triggerConfig).toEqual({ daysBefore: 7, timeZone: 'Asia/Riyadh' })
		// Versioned data: it survives a JSON round trip, so a stored journey never depends on code.
		expect(JSON.parse(JSON.stringify(birthday))).toEqual(birthday)
		expect(birthday.programVersion).toBe(1)
	})
})
