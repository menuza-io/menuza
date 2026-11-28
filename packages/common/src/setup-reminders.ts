/**
 * Setup reminder emails (#271): the plain words for the next unfinished launch
 * step, in English and Arabic. Pure: the App decides who gets one and when;
 * this only words it. Each email names ONE step with its time, shows progress
 * ("4 of 7 done") and has one button to the exact screen. It never names a
 * guest, a person or a figure.
 */

export const SETUP_REMINDER_DAYS = [1, 3, 7] as const
export type SetupReminderDay = (typeof SETUP_REMINDER_DAYS)[number]

export type SetupReminderLocale = 'en' | 'ar'

/** The notification workflow an owner turns off to stop these emails. */
export const SETUP_REMINDER_WORKFLOW = 'setup-reminder-workflow'
/** The organization flag that turns the automatic sequence on (default off). */
export const SETUP_REMINDERS_FLAG = 'launch.reminders'
/** An organization flag that marks a test or demo account: never emailed. */
export const TEST_ACCOUNT_FLAG = 'account.test'

type StepCopy = { en: string; ar: string; minutes: number }

/** The required launch steps, in checklist order, with how long each takes. */
export const SETUP_STEP_COPY: Record<string, StepCopy> = {
	launch_location_details: {
		en: 'Add your address and opening hours',
		ar: 'أضف عنوانك وساعات عملك',
		minutes: 3,
	},
	launch_menu: {
		en: 'Add your menu with at least five priced dishes',
		ar: 'أضف قائمتك مع خمسة أطباق على الأقل بأسعارها',
		minutes: 15,
	},
	launch_branding: {
		en: 'Add your logo and pick a look for your site',
		ar: 'أضف شعارك واختر شكل موقعك',
		minutes: 5,
	},
	launch_payments: {
		en: 'Connect online payments, or choose pay at pickup',
		ar: 'اربط الدفع عبر الإنترنت، أو اختر الدفع عند الاستلام',
		minutes: 5,
	},
	launch_fulfillment: {
		en: 'Choose pickup or delivery and set your prep time',
		ar: 'اختر الاستلام أو التوصيل وحدّد وقت التحضير',
		minutes: 2,
	},
	launch_go_live: {
		en: 'Publish your site and turn on ordering',
		ar: 'انشر موقعك وفعّل الطلب',
		minutes: 1,
	},
}

export function isSetupReminderLocale(
	value: unknown,
): value is SetupReminderLocale {
	return value === 'en' || value === 'ar'
}

/** Arabic when the organization's default language is Arabic, else English. */
export function setupReminderLocale(
	defaultLocale: string | null | undefined,
): SetupReminderLocale {
	return (defaultLocale ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en'
}

function minutesText(minutes: number, locale: SetupReminderLocale): string {
	if (locale === 'ar') {
		if (minutes === 1) return 'نحو دقيقة'
		if (minutes === 2) return 'نحو دقيقتين'
		if (minutes <= 10) return `نحو ${minutes} دقائق`
		return `نحو ${minutes} دقيقة`
	}
	return minutes === 1 ? 'about 1 minute' : `about ${minutes} minutes`
}

export type SetupReminderCopy = {
	locale: SetupReminderLocale
	dir: 'ltr' | 'rtl'
	subject: string
	preview: string
	eyebrow: string
	/** "Add your opening hours, about 2 minutes". */
	heading: string
	intro: string
	/** "4 of 7 done". */
	progress: string
	actionLabel: string
	unsubscribeLabel: string
	footer: string
}

export function setupReminderCopy(input: {
	locale: SetupReminderLocale
	organizationName: string
	stepKey: string
	done: number
	total: number
}): SetupReminderCopy {
	const { locale, organizationName: org } = input
	const step = SETUP_STEP_COPY[input.stepKey] ?? {
		en: 'Finish your setup',
		ar: 'أكمل إعدادك',
		minutes: 5,
	}
	const title = step[locale]
	const time = minutesText(step.minutes, locale)
	if (locale === 'ar') {
		return {
			locale,
			dir: 'rtl',
			subject: `الخطوة التالية لـ ${org}: ${title}`,
			preview: `${title}، ${time}.`,
			eyebrow: 'إعداد مطعمك',
			heading: `${title}، ${time}`,
			intro: `بدأت إعداد ${org} وبقيت خطوة واحدة تالية. بعدها تقترب من استقبال أول طلب.`,
			progress: `${input.done} من ${input.total} مكتملة`,
			actionLabel: 'أكمل الإعداد',
			unsubscribeLabel: 'إيقاف هذه التذكيرات',
			footer: 'نرسل لك ما يصل إلى ثلاثة تذكيرات قصيرة، ثم نتوقف.',
		}
	}
	return {
		locale,
		dir: 'ltr',
		subject: `Next step for ${org}: ${title}`,
		preview: `${title}, ${time}.`,
		eyebrow: 'Setting up your restaurant',
		heading: `${title}, ${time}`,
		intro: `You started setting up ${org} and one step is next. After it you are closer to your first order.`,
		progress: `${input.done} of ${input.total} done`,
		actionLabel: 'Continue setup',
		unsubscribeLabel: 'Turn off these reminders',
		footer: 'We send up to three short reminders, then stop.',
	}
}
