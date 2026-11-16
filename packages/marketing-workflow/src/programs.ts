import { type EmailBlock } from '@repo/common/email-blocks'

/**
 * Ready-made automation programs (#100): templates as versioned data. "Turn
 * on" in the App builds a journey from one with `buildProgramJourney`, in the
 * organization's language, and publishes it. The journey is a copy: a later
 * change to a template never rewrites a journey already created (the journey
 * keeps `program_id` and `program_version`).
 *
 * Copy is written in the organization's default site language (English and
 * Arabic here; any other language falls back to English). Per-recipient
 * language is a later step (#102): a message is built once, in one language.
 *
 * This module is pure data and pure functions: no I/O, no rendering. The App
 * renders each email's blocks to HTML (in the organization's branding) and
 * fills `bodyHtml` before saving.
 */

export const PROGRAM_IDS = [
	'welcome_series',
	'first_order_thank_you',
	'second_order',
	'win_back',
	'loyalty_reward',
	'after_visit',
	'no_show_follow_up',
	'birthday_treat',
	'cart_reminder',
] as const
export type ProgramId = (typeof PROGRAM_IDS)[number]

/** What a program needs before it is offered: a template only appears when its trigger is available. */
export type ProgramRequirement =
	| 'ordering'
	| 'reservations'
	| 'loyalty'
	| 'birthdays'
	| 'cart'
	| 'review_link'

export type ProgramCapabilities = {
	/** Restaurant ordering is available (flag `marketing.order_automations`). */
	ordering: boolean
	reservations: boolean
	loyalty: boolean
	/** Flag `marketing.birthdays`. */
	birthdays: boolean
	/** Flag `marketing.cart_reminders` (needs ordering automations too). */
	cart: boolean
	/**
	 * Where a review request points. `connected`: the organization's Google
	 * review page is known. `ask`: the owner pastes the link when turning the
	 * program on (no listing is stored yet). `none`: the program is left out.
	 */
	reviewLink: 'connected' | 'ask' | 'none'
}

export const PROGRAM_LANGUAGES = ['en', 'ar'] as const
export type ProgramLanguage = (typeof PROGRAM_LANGUAGES)[number]

type Copy = Record<ProgramLanguage, string>

type ProgramMessage = {
	/** Email subject. */
	subject: Copy
	heading: Copy
	/** Paragraphs, with merge tags like `{{firstName|there}}`. */
	paragraphs: Copy[]
	/** Added after the paragraphs when the step carries a coupon (it uses `{{couponCode}}`). */
	couponLine?: Copy
	button?: {
		label: Copy
		/** Where it goes: the menu, the review page, the cart link tag, the site. */
		target: 'menu' | 'review' | 'cart' | 'site'
	}
	/** The text-message version (the opt-out footer is added when it is sent). */
	sms: Copy
	/** The text-message version when the step carries a coupon. */
	smsCoupon?: Copy
	/** Whether the coupon (when chosen) goes on this step. */
	coupon?: boolean
}

type ProgramStep =
	| { kind: 'message'; id: string; message: ProgramMessage }
	| {
			kind: 'delay'
			id: string
			duration: number
			unit: 'minutes' | 'hours' | 'days'
	  }

export type ProgramTemplate = {
	id: ProgramId
	/** Bumped whenever the template changes; a created journey keeps the one it came from. */
	version: number
	triggerType: string
	triggerConfig: Record<string, unknown>
	/** "Stop when the guest places an order". */
	goal: 'order' | null
	requires: ProgramRequirement[]
	/** Channels a message may use. */
	channels: Array<'email' | 'sms'>
	/** `optional`: the owner may attach a coupon; `none`: this program has no coupon step. */
	coupon: 'optional' | 'none'
	name: Copy
	summary: Copy
	steps: ProgramStep[]
}

const c = (en: string, ar: string): Copy => ({ en, ar })

export const PROGRAM_TEMPLATES: readonly ProgramTemplate[] = [
	{
		id: 'welcome_series',
		version: 1,
		triggerType: 'phone_verified',
		triggerConfig: {},
		goal: null,
		requires: [],
		channels: ['email', 'sms'],
		coupon: 'none',
		name: c('Welcome series', 'سلسلة الترحيب'),
		summary: c(
			'Two friendly messages for a new guest: a welcome now and a nudge to order two days later.',
			'رسالتان ودّيتان للضيف الجديد: ترحيب الآن وتذكير بالطلب بعد يومين.',
		),
		steps: [
			{
				kind: 'message',
				id: 'welcome',
				message: {
					subject: c('Welcome to {{organizationName}}', 'أهلاً بك في {{organizationName}}'),
					heading: c('Welcome, {{firstName|friend}}!', 'أهلاً {{firstName|بك}}!'),
					paragraphs: [
						c(
							"We're glad you're here. Have a look at the menu whenever you're hungry.",
							'يسعدنا انضمامك. تصفّح قائمتنا متى ما شعرت بالجوع.',
						),
					],
					button: { label: c('See the menu', 'شاهد القائمة'), target: 'menu' },
					sms: c(
						'Welcome to {{organizationName}}! See our menu any time.',
						'أهلاً بك في {{organizationName}}! تصفّح قائمتنا في أي وقت.',
					),
				},
			},
			{ kind: 'delay', id: 'wait', duration: 2, unit: 'days' },
			{
				kind: 'message',
				id: 'nudge',
				message: {
					subject: c('Hungry, {{firstName|friend}}?', 'جائع يا {{firstName|صديقي}}؟'),
					heading: c('Your next meal is a tap away', 'وجبتك التالية على بعد نقرة'),
					paragraphs: [
						c(
							'Order pickup or delivery in a minute. We will have it ready.',
							'اطلب للاستلام أو التوصيل في دقيقة. سنجهّزه لك.',
						),
					],
					button: { label: c('Order now', 'اطلب الآن'), target: 'menu' },
					sms: c(
						'Hungry? Order from {{organizationName}} in a minute.',
						'جائع؟ اطلب من {{organizationName}} في دقيقة.',
					),
				},
			},
		],
	},
	{
		id: 'first_order_thank_you',
		version: 1,
		triggerType: 'order_first_placed',
		triggerConfig: {},
		goal: null,
		requires: ['ordering'],
		channels: ['email', 'sms'],
		coupon: 'none',
		name: c('First order thank-you', 'شكراً على أول طلب'),
		summary: c(
			'A warm thank-you an hour after a guest places their first order.',
			'رسالة شكر دافئة بعد ساعة من أول طلب للضيف.',
		),
		steps: [
			{ kind: 'delay', id: 'wait', duration: 1, unit: 'hours' },
			{
				kind: 'message',
				id: 'thanks',
				message: {
					subject: c('Thank you for your order', 'شكراً على طلبك'),
					heading: c('Thanks for ordering, {{firstName|friend}}', 'شكراً لطلبك يا {{firstName|صديقي}}'),
					paragraphs: [
						c(
							'It was our pleasure to cook for you. We hope you enjoyed every bite.',
							'سعدنا بتحضير طلبك. نتمنى أن تكون قد استمتعت به.',
						),
					],
					button: { label: c('Order again', 'اطلب مجدداً'), target: 'menu' },
					sms: c(
						'Thanks for your first order from {{organizationName}}!',
						'شكراً على أول طلب من {{organizationName}}!',
					),
				},
			},
		],
	},
	{
		id: 'second_order',
		version: 1,
		triggerType: 'order_first_placed',
		triggerConfig: {},
		goal: 'order',
		requires: ['ordering'],
		channels: ['email', 'sms'],
		coupon: 'optional',
		name: c('Come back for a 2nd order', 'عُد لطلبك الثاني'),
		summary: c(
			'A week after a first order, invite the guest back. Stops as soon as they order again.',
			'بعد أسبوع من أول طلب، ادعُ الضيف للعودة. يتوقف بمجرد أن يطلب مجدداً.',
		),
		steps: [
			{ kind: 'delay', id: 'wait', duration: 7, unit: 'days' },
			{
				kind: 'message',
				id: 'invite',
				message: {
					coupon: true,
					subject: c('We would love to see you again', 'يسعدنا أن نراك مجدداً'),
					heading: c('Ready for round two, {{firstName|friend}}?', 'جاهز للطلب الثاني يا {{firstName|صديقي}}؟'),
					paragraphs: [
						c(
							'It has been a week since your first order. Your favourites are waiting.',
							'مرّ أسبوع على أول طلب. أطباقك المفضلة بانتظارك.',
						),
					],
					couponLine: c('Use code {{couponCode}} on your next order.', 'استخدم الرمز {{couponCode}} في طلبك القادم.'),
					button: { label: c('Order now', 'اطلب الآن'), target: 'menu' },
					sms: c(
						'Come back to {{organizationName}}! Your favourites are waiting.',
						'عُد إلى {{organizationName}}! أطباقك المفضلة بانتظارك.',
					),
					smsCoupon: c(
						'Come back to {{organizationName}}! Use {{couponCode}} on your next order.',
						'عُد إلى {{organizationName}}! استخدم {{couponCode}} في طلبك القادم.',
					),
				},
			},
		],
	},
	{
		id: 'win_back',
		version: 1,
		triggerType: 'guest_lapsed',
		triggerConfig: { days: 60 },
		goal: 'order',
		requires: ['ordering'],
		channels: ['email', 'sms'],
		coupon: 'optional',
		name: c('Win-back (lapsed 60 days)', 'استعادة الضيوف (60 يوماً)'),
		summary: c(
			'When a guest has not ordered for 60 days, invite them back, with a coupon if you like.',
			'عندما لا يطلب الضيف لمدة 60 يوماً، ادعُه للعودة، مع قسيمة إن رغبت.',
		),
		steps: [
			{
				kind: 'message',
				id: 'miss-you',
				message: {
					coupon: true,
					subject: c('We miss you, {{firstName|friend}}', 'نفتقدك يا {{firstName|صديقي}}'),
					heading: c('It has been a while', 'مضى وقت طويل'),
					paragraphs: [
						c(
							'We would love to feed you again. Come back and order your favourites.',
							'نود أن نراك مجدداً. عُد واطلب أطباقك المفضلة.',
						),
					],
					couponLine: c('Here is a little something: use code {{couponCode}}.', 'هدية صغيرة لك: استخدم الرمز {{couponCode}}.'),
					button: { label: c('Order now', 'اطلب الآن'), target: 'menu' },
					sms: c(
						'We miss you at {{organizationName}}! Come back and order your favourites.',
						'نفتقدك في {{organizationName}}! عُد واطلب أطباقك المفضلة.',
					),
					smsCoupon: c(
						'We miss you at {{organizationName}}! Use {{couponCode}} on your next order.',
						'نفتقدك في {{organizationName}}! استخدم {{couponCode}} في طلبك القادم.',
					),
				},
			},
		],
	},
	{
		id: 'loyalty_reward',
		version: 1,
		triggerType: 'loyalty_reward_available',
		triggerConfig: {},
		goal: null,
		requires: ['loyalty'],
		channels: ['email', 'sms'],
		coupon: 'none',
		name: c('Loyalty: reward available', 'الولاء: مكافأة متاحة'),
		summary: c(
			'Tell a member the moment their points reach a reward.',
			'أخبر العضو لحظة وصول نقاطه إلى مكافأة.',
		),
		steps: [
			{
				kind: 'message',
				id: 'reward',
				message: {
					subject: c('You have a reward waiting', 'لديك مكافأة بانتظارك'),
					heading: c('A reward is yours, {{firstName|friend}}', 'مكافأة بانتظارك يا {{firstName|صديقي}}'),
					paragraphs: [
						c(
							'Your points reached {{rewardName|a reward}}. Claim it on your next order.',
							'وصلت نقاطك إلى {{rewardName|مكافأة}}. استبدلها في طلبك القادم.',
						),
					],
					button: { label: c('Order now', 'اطلب الآن'), target: 'menu' },
					sms: c(
						'You have {{rewardName|a reward}} waiting at {{organizationName}}!',
						'لديك {{rewardName|مكافأة}} بانتظارك في {{organizationName}}!',
					),
				},
			},
		],
	},
	{
		id: 'after_visit',
		version: 1,
		triggerType: 'reservation_completed',
		triggerConfig: {},
		goal: null,
		requires: ['reservations', 'review_link'],
		channels: ['email'],
		coupon: 'none',
		name: c('After your visit', 'بعد زيارتك'),
		summary: c(
			'Two hours after a visit, ask the guest for a review on your Google page.',
			'بعد ساعتين من الزيارة، اطلب من الضيف تقييماً على صفحتك في Google.',
		),
		steps: [
			{ kind: 'delay', id: 'wait', duration: 2, unit: 'hours' },
			{
				kind: 'message',
				id: 'review',
				message: {
					subject: c('How was your visit?', 'كيف كانت زيارتك؟'),
					heading: c('Thank you for visiting, {{firstName|friend}}', 'شكراً لزيارتك يا {{firstName|صديقي}}'),
					paragraphs: [
						c(
							'If you enjoyed your meal, a short review helps other guests find us.',
							'إذا أعجبتك وجبتك، فإن تقييماً قصيراً يساعد الآخرين على اكتشافنا.',
						),
					],
					button: { label: c('Leave a review', 'اكتب تقييماً'), target: 'review' },
					sms: c('', ''),
				},
			},
		],
	},
	{
		id: 'no_show_follow_up',
		version: 1,
		triggerType: 'reservation_no_show',
		triggerConfig: {},
		goal: null,
		requires: ['reservations'],
		channels: ['email', 'sms'],
		coupon: 'none',
		name: c('No-show follow-up', 'متابعة عدم الحضور'),
		summary: c(
			'A kind note an hour after a missed booking, with a way to book again.',
			'رسالة لطيفة بعد ساعة من حجز فائت، مع طريقة للحجز مجدداً.',
		),
		steps: [
			{ kind: 'delay', id: 'wait', duration: 1, unit: 'hours' },
			{
				kind: 'message',
				id: 'missed',
				message: {
					subject: c('We missed you', 'افتقدناك'),
					heading: c('We missed you, {{firstName|friend}}', 'افتقدناك يا {{firstName|صديقي}}'),
					paragraphs: [
						c(
							'Plans change. Whenever you are ready, we would love to host you.',
							'الخطط تتغير. متى ما كنت جاهزاً يسعدنا استضافتك.',
						),
					],
					button: { label: c('Book a table', 'احجز طاولة'), target: 'site' },
					sms: c(
						'We missed you at {{organizationName}}. Book again any time.',
						'افتقدناك في {{organizationName}}. احجز مجدداً في أي وقت.',
					),
				},
			},
		],
	},
	{
		id: 'birthday_treat',
		version: 1,
		triggerType: 'birthday_coming_up',
		triggerConfig: { daysBefore: 7 },
		goal: null,
		requires: ['birthdays'],
		channels: ['email', 'sms'],
		coupon: 'optional',
		name: c('Birthday treat', 'هدية عيد الميلاد'),
		summary: c(
			'A week before a guest’s birthday, send a treat (a single-use coupon valid 14 days is a good fit).',
			'قبل أسبوع من عيد ميلاد الضيف، أرسل هدية (قسيمة لمرة واحدة صالحة 14 يوماً مناسبة).',
		),
		steps: [
			{
				kind: 'message',
				id: 'treat',
				message: {
					coupon: true,
					subject: c('A birthday treat from {{organizationName}}', 'هدية عيد ميلاد من {{organizationName}}'),
					heading: c('Happy early birthday, {{firstName|friend}}!', 'عيد ميلاد سعيد مبكراً يا {{firstName|صديقي}}!'),
					paragraphs: [
						c(
							'Your birthday is coming up, and we would like to celebrate with you.',
							'عيد ميلادك يقترب ونود الاحتفال معك.',
						),
					],
					couponLine: c('Use code {{couponCode}} for a birthday treat.', 'استخدم الرمز {{couponCode}} لهدية عيد الميلاد.'),
					button: { label: c('Order now', 'اطلب الآن'), target: 'menu' },
					sms: c(
						'Happy early birthday from {{organizationName}}!',
						'عيد ميلاد سعيد مبكراً من {{organizationName}}!',
					),
					smsCoupon: c(
						'Happy early birthday from {{organizationName}}! Use {{couponCode}} for a treat.',
						'عيد ميلاد سعيد مبكراً من {{organizationName}}! استخدم {{couponCode}} لهدية.',
					),
				},
			},
		],
	},
	{
		id: 'cart_reminder',
		version: 1,
		triggerType: 'cart_left_behind',
		triggerConfig: {},
		goal: 'order',
		requires: ['ordering', 'cart'],
		channels: ['email', 'sms'],
		coupon: 'optional',
		name: c('Cart reminder', 'تذكير بسلة الطلب'),
		summary: c(
			'An hour after a guest leaves a cart, remind them; a day later, add a coupon if you like. Stops when they order.',
			'بعد ساعة من ترك السلة، ذكّر الضيف؛ وبعد يوم أضف قسيمة إن رغبت. يتوقف عند الطلب.',
		),
		steps: [
			{
				kind: 'message',
				id: 'reminder',
				message: {
					subject: c('You left something behind', 'نسيت شيئاً في سلتك'),
					heading: c('Your order is waiting, {{firstName|friend}}', 'طلبك بانتظارك يا {{firstName|صديقي}}'),
					paragraphs: [
						c(
							'You left items in your cart. Pick up where you left off.',
							'تركت أصنافاً في سلتك. أكمل من حيث توقفت.',
						),
					],
					button: { label: c('Back to your order', 'العودة إلى طلبك'), target: 'cart' },
					sms: c(
						'You left something in your cart at {{organizationName}}: {{cartLink}}',
						'تركت شيئاً في سلتك في {{organizationName}}: {{cartLink}}',
					),
				},
			},
			{ kind: 'delay', id: 'wait', duration: 1, unit: 'days' },
			{
				kind: 'message',
				id: 'last-call',
				message: {
					coupon: true,
					subject: c('Still thinking it over?', 'لا تزال تفكر؟'),
					heading: c('A little nudge', 'تذكير لطيف'),
					paragraphs: [
						c(
							'Your cart is still saved. Finish your order whenever you like.',
							'سلتك لا تزال محفوظة. أنهِ طلبك متى شئت.',
						),
					],
					couponLine: c('Use code {{couponCode}} to make it sweeter.', 'استخدم الرمز {{couponCode}} لتجعله أحلى.'),
					button: { label: c('Back to your order', 'العودة إلى طلبك'), target: 'cart' },
					sms: c(
						'Your cart is still saved: {{cartLink}}',
						'سلتك لا تزال محفوظة: {{cartLink}}',
					),
					smsCoupon: c(
						'Your cart is still saved. Use {{couponCode}}: {{cartLink}}',
						'سلتك لا تزال محفوظة. استخدم {{couponCode}}: {{cartLink}}',
					),
				},
			},
		],
	},
]

export function getProgramTemplate(id: string): ProgramTemplate | undefined {
	return PROGRAM_TEMPLATES.find((template) => template.id === id)
}

export function isProgramId(value: unknown): value is ProgramId {
	return (PROGRAM_IDS as readonly unknown[]).includes(value)
}

/** The language a program is written in: the organization's, or English. */
export function programLanguage(locale: string | null | undefined): ProgramLanguage {
	const base = (locale ?? 'en').toLowerCase().split(/[-_]/)[0]
	return (PROGRAM_LANGUAGES as readonly string[]).includes(base ?? '')
		? (base as ProgramLanguage)
		: 'en'
}

/** Whether a template can be offered here: its trigger (and the pieces it needs) are available. */
export function programAvailable(
	template: ProgramTemplate,
	capabilities: ProgramCapabilities,
): boolean {
	return template.requires.every((requirement) => {
		switch (requirement) {
			case 'ordering':
				return capabilities.ordering
			case 'reservations':
				return capabilities.reservations
			case 'loyalty':
				return capabilities.loyalty
			case 'birthdays':
				return capabilities.birthdays
			case 'cart':
				return capabilities.cart && capabilities.ordering
			case 'review_link':
				return capabilities.reviewLink !== 'none'
		}
	})
}

export type BuildProgramInput = {
	organizationName: string
	/** The organization's public site origin (the menu lives at `/menu`). */
	siteOrigin: string | null
	reviewUrl: string | null
	language: ProgramLanguage
	channel: 'email' | 'sms'
	/** A coupon is attached to the steps that take one. */
	withCoupon: boolean
	/** The organization's time zone, for "10:00 local time" when a guest has none. */
	timeZone?: string | null
}

export type ProgramJourneyNode = {
	id: string
	type: 'trigger' | 'delay' | 'action_email' | 'action_sms'
	data: Record<string, unknown>
	position: { x: number; y: number }
}

export type ProgramJourney = {
	name: string
	programId: ProgramId
	programVersion: number
	triggerType: string
	triggerConfig: Record<string, unknown>
	goal: 'order' | null
	nodes: ProgramJourneyNode[]
	edges: Array<{
		id: string
		source: string
		target: string
		sourceHandle: string
		targetHandle: string
	}>
	/** Node ids of email steps whose blocks the App renders into `bodyHtml`. */
	emailNodeIds: string[]
	/** Node ids of steps that carry the coupon. */
	couponNodeIds: string[]
}

function targetUrl(
	target: 'menu' | 'review' | 'cart' | 'site',
	input: BuildProgramInput,
): string {
	if (target === 'cart') return '{{cartLink}}'
	if (target === 'review') return input.reviewUrl ?? ''
	if (!input.siteOrigin) return ''
	try {
		const origin = new URL(input.siteOrigin)
		return target === 'menu'
			? new URL('/menu', origin.origin).toString()
			: origin.origin
	} catch {
		return ''
	}
}

function blocksFor(
	stepId: string,
	message: ProgramMessage,
	input: BuildProgramInput,
	withCoupon: boolean,
): EmailBlock[] {
	const lang = input.language
	const blocks: EmailBlock[] = [
		{
			id: `${stepId}-heading`,
			type: 'heading',
			config: { text: message.heading[lang], level: 'h2', align: 'left' },
		},
	]
	message.paragraphs.forEach((paragraph, index) => {
		blocks.push({
			id: `${stepId}-text-${index + 1}`,
			type: 'paragraph',
			config: { text: paragraph[lang], align: 'left' },
		})
	})
	if (withCoupon && message.couponLine) {
		blocks.push({
			id: `${stepId}-coupon-line`,
			type: 'paragraph',
			config: { text: message.couponLine[lang], align: 'left' },
		})
	}
	if (message.button) {
		const url = targetUrl(message.button.target, input)
		if (url) {
			blocks.push({
				id: `${stepId}-button`,
				type: 'button',
				config: {
					label: message.button.label[lang],
					url,
					variant: 'primary',
					width: 'auto',
					align: 'left',
				},
			})
		}
	}
	return blocks
}

/** Replaces the organization's name; every other tag is filled when the message is sent. */
function withOrganization(text: string, input: BuildProgramInput): string {
	return text.replaceAll('{{organizationName}}', input.organizationName)
}

/**
 * Builds the journey a program stands for: a linear graph from the trigger
 * through the template's steps. The result still needs two things from the
 * App: each email step's `bodyHtml` (rendered from its blocks, in the
 * organization's branding) and, for steps in `couponNodeIds`, the chosen
 * coupon as `discountOffer`.
 */
export function buildProgramJourney(
	template: ProgramTemplate,
	input: BuildProgramInput,
): ProgramJourney {
	const channel = template.channels.includes(input.channel)
		? input.channel
		: (template.channels[0] ?? 'email')
	const withCoupon = input.withCoupon && template.coupon === 'optional'
	const lang = input.language

	const triggerConfig: Record<string, unknown> = { ...template.triggerConfig }
	if (template.triggerType === 'birthday_coming_up' && input.timeZone) {
		triggerConfig.timeZone = input.timeZone
	}

	const nodes: ProgramJourneyNode[] = [
		{
			id: 'trigger',
			type: 'trigger',
			data: { triggerType: template.triggerType, config: triggerConfig },
			position: { x: 250, y: 0 },
		},
	]
	const emailNodeIds: string[] = []
	const couponNodeIds: string[] = []
	let y = 140
	for (const step of template.steps) {
		if (step.kind === 'delay') {
			nodes.push({
				id: step.id,
				type: 'delay',
				data: { duration: step.duration, unit: step.unit },
				position: { x: 250, y },
			})
		} else {
			const carriesCoupon = withCoupon && step.message.coupon === true
			if (carriesCoupon) couponNodeIds.push(step.id)
			if (channel === 'sms' && step.message.sms[lang].trim()) {
				nodes.push({
					id: step.id,
					type: 'action_sms',
					data: {
						messageText: withOrganization(
							carriesCoupon && step.message.smsCoupon
								? step.message.smsCoupon[lang]
								: step.message.sms[lang],
							input,
						),
					},
					position: { x: 250, y },
				})
			} else {
				emailNodeIds.push(step.id)
				nodes.push({
					id: step.id,
					type: 'action_email',
					data: {
						subject: withOrganization(step.message.subject[lang], input),
						emailFormat: 'designed',
						blocks: blocksFor(step.id, step.message, input, carriesCoupon).map(
							(block) =>
								block.type === 'heading' || block.type === 'paragraph'
									? {
											...block,
											config: {
												...block.config,
												text: withOrganization(block.config.text, input),
											},
										}
									: block,
						),
						bodyHtml: '',
					},
					position: { x: 250, y },
				})
			}
		}
		y += 140
	}

	const edges = nodes.slice(1).map((node, index) => ({
		id: `edge-${nodes[index]!.id}-${node.id}`,
		source: nodes[index]!.id,
		target: node.id,
		sourceHandle: 'output',
		targetHandle: 'input',
	}))

	return {
		name: template.name[lang],
		programId: template.id,
		programVersion: template.version,
		triggerType: template.triggerType,
		triggerConfig,
		goal: template.goal,
		nodes,
		edges,
		emailNodeIds,
		couponNodeIds,
	}
}
