import { brand } from '@repo/config/brand'
import { type DeclineTemplate, type InterviewMode } from '@repo/staffing'
import {
	formatDay,
	formatMinutes,
	formatTime,
	layout,
	normalizeStaffLocale,
	type StaffEmailLocale,
} from './staff-email.ts'

/**
 * Email to an applicant: an interview invitation (and its cancellation) and the
 * templated decline. Operational mail about one person's own application, sent
 * without marketing headers. Plain HTML strings for the same reasons as staff
 * mail (no React inside a Durable Object, no CSS variables in mail clients).
 *
 * What is in a message: the job title they applied for, the organization's name,
 * and for an interview the time (in the scope's zone), the length and the
 * details the manager typed for the applicant. Nothing from the screener, the
 * notes or the score ever appears. Every dynamic value is escaped by the layout.
 */

export type ApplicantEmailInput = {
	kind: 'interview_invite' | 'interview_cancelled' | 'decline'
	locale: StaffEmailLocale
	firstName: string
	organizationName: string | null
	postingTitle: string
	scopeName: string | null
	timeZone: string | null
	template?: Exclude<DeclineTemplate, 'none'>
	interview?: {
		scheduledAt: number
		durationMinutes: number
		mode: InterviewMode
		details: string | null
		rescheduled: boolean
	}
}

export type RenderedApplicantEmail = {
	subject: string
	text: string
	html: string
}

export { normalizeStaffLocale as normalizeApplicantLocale }

const MODE_LABEL: Record<InterviewMode, Record<StaffEmailLocale, string>> = {
	in_person: { en: 'In person', ar: 'حضوريًا' },
	phone: { en: 'By phone', ar: 'عبر الهاتف' },
	video: { en: 'By video call', ar: 'عبر مكالمة فيديو' },
}

function footer(locale: StaffEmailLocale, who: string): string {
	return locale === 'ar'
		? `أُرسلت هذه الرسالة نيابةً عن ${who} بخصوص طلبك عبر ${brand.shortName}.`
		: `Sent on behalf of ${who} about your application, through ${brand.shortName}.`
}

/** Subjects and greetings are one line: a line break never reaches a header. */
function oneLine(value: string): string {
	return Array.from(value, (char) => {
		const code = char.codePointAt(0)!
		return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029
			? ' '
			: char
	})
		.join('')
		.replace(/ {2,}/g, ' ')
		.trim()
}

export function renderApplicantEmail(
	input: ApplicantEmailInput,
): RenderedApplicantEmail {
	const { locale, kind } = input
	const name = oneLine(input.firstName)
	const who =
		oneLine(input.organizationName ?? '') ||
		(locale === 'ar' ? 'فريق التوظيف' : 'the hiring team')
	const job = oneLine(input.postingTitle)
	const hello = locale === 'ar' ? `مرحبًا ${name}،` : `Hi ${name},`

	let subject: string
	let lines: string[]

	if (kind === 'decline') {
		const template = input.template ?? 'thanks'
		if (locale === 'ar') {
			subject = `بخصوص طلبك لوظيفة ${job}`
			lines = [
				`${hello} شكرًا لاهتمامك بالعمل مع ${who} وللوقت الذي خصصته لتقديم طلبك لوظيفة ${job}.`,
				template === 'position_filled'
					? 'لقد شغلنا هذه الوظيفة بالفعل، لذلك لن نتمكن من المتابعة مع طلبك.'
					: 'بعد دراسة الطلبات، قررنا عدم المتابعة مع طلبك في الوقت الحالي.',
				...(template === 'keep_on_file'
					? [
							'سنحتفظ بطلبك للفترة المحددة في إشعار الخصوصية، وقد نتواصل معك إذا توفرت وظيفة مناسبة.',
						]
					: []),
				'نتمنى لك التوفيق.',
			]
		} else {
			subject = `Your application for ${job}`
			lines = [
				`${hello} thank you for your interest in working with ${who} and for the time you took to apply for ${job}.`,
				template === 'position_filled'
					? 'We have filled this position, so we will not be moving forward with your application.'
					: 'After reviewing applications, we have decided not to move forward with yours at this time.',
				...(template === 'keep_on_file'
					? [
							'We will keep your application on file for the period in the privacy notice, and may contact you if a suitable role opens up.',
						]
					: []),
				'We wish you all the best.',
			]
		}
		const rendered = layout(locale, subject, lines, null, footer(locale, who))
		return { subject, ...rendered }
	}

	const interview = input.interview
	const tz = input.timeZone
	const where = input.scopeName?.trim() || null
	if (!interview) {
		// A message with nothing to say is a bug upstream; stay generic and safe.
		subject =
			locale === 'ar' ? 'تحديث بخصوص طلبك' : 'An update on your application'
		lines = [
			locale === 'ar'
				? `${hello} لدينا تحديث بخصوص طلبك لوظيفة ${job}.`
				: `${hello} we have an update about your application for ${job}.`,
		]
		const rendered = layout(locale, subject, lines, null, footer(locale, who))
		return { subject, ...rendered }
	}

	const day = formatDay(interview.scheduledAt, tz, locale)
	const time = formatTime(interview.scheduledAt, tz, locale)
	const length = formatMinutes(interview.durationMinutes, locale)
	const mode = MODE_LABEL[interview.mode][locale]

	if (kind === 'interview_cancelled') {
		subject =
			locale === 'ar'
				? `تم إلغاء المقابلة لوظيفة ${job}`
				: `Your interview for ${job} was cancelled`
		lines =
			locale === 'ar'
				? [
						`${hello} تم إلغاء المقابلة المقررة يوم ${day} الساعة ${time}.`,
						'سنتواصل معك إذا تحدد موعد جديد.',
					]
				: [
						`${hello} the interview planned for ${day} at ${time} has been cancelled.`,
						'We will get in touch if a new time is set.',
					]
		const rendered = layout(locale, subject, lines, null, footer(locale, who))
		return { subject, ...rendered }
	}

	if (locale === 'ar') {
		subject = interview.rescheduled
			? `تغيّر موعد مقابلتك لوظيفة ${job}`
			: `مقابلة لوظيفة ${job}`
		lines = [
			interview.rescheduled
				? `${hello} تم تغيير موعد مقابلتك لوظيفة ${job}.`
				: `${hello} يسعدنا أن ندعوك إلى مقابلة لوظيفة ${job} مع ${who}.`,
			`الموعد: ${day} الساعة ${time}`,
			`المدة: ${length}`,
			`الطريقة: ${mode}${where ? ` (${where})` : ''}`,
			...(interview.details ? [interview.details] : []),
			'إذا لم يناسبك الموعد، يرجى التواصل معنا مباشرةً لترتيب موعد آخر.',
		]
	} else {
		subject = interview.rescheduled
			? `Your interview for ${job} has moved`
			: `Interview for ${job}`
		lines = [
			interview.rescheduled
				? `${hello} the time of your interview for ${job} has changed.`
				: `${hello} we would like to invite you to interview for ${job} with ${who}.`,
			`When: ${day} at ${time}`,
			`Length: ${length}`,
			`How: ${mode}${where ? ` (${where})` : ''}`,
			...(interview.details ? [interview.details] : []),
			'If this time does not work for you, please contact us directly to arrange another.',
		]
	}
	const rendered = layout(locale, subject, lines, null, footer(locale, who))
	return { subject, ...rendered }
}
