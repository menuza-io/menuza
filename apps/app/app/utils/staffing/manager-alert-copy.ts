import { type ManagerAlertKind } from '@repo/staffing'

/**
 * Plain-English wording of a manager alert, for the email. (The in-app
 * notification translates its own copy with Lingui.) An alert is a kind, a
 * count and a place; nothing about a person is known here, so none can be said.
 */

export type ManagerAlertCopy = {
	eyebrow: string
	subject: string
	headline: string
	detail: string
	actionLabel: string
}

function people(count: number): string {
	return count === 1 ? '1 person' : `${count} people`
}

export function describeManagerAlert(input: {
	kind: ManagerAlertKind
	count: number
	scopeName: string | null
}): ManagerAlertCopy {
	const { kind, count } = input
	const place = input.scopeName ? ` at ${input.scopeName}` : ''
	switch (kind) {
		case 'no_clock_in':
			return {
				eyebrow: 'Attendance',
				subject: `${people(count)} ${count === 1 ? 'has' : 'have'} not clocked in${place}`,
				headline: `${people(count)} ${count === 1 ? 'has' : 'have'} not clocked in`,
				detail: `${people(count)} scheduled${place} ${count === 1 ? 'has' : 'have'} not clocked in yet.`,
				actionLabel: 'Open the time clock',
			}
		case 'missed_clock_out':
			return {
				eyebrow: 'Attendance',
				subject: `${people(count)} may have forgotten to clock out${place}`,
				headline: `${people(count)} may have forgotten to clock out`,
				detail: `${people(count)}${place} ${count === 1 ? 'is' : 'are'} still clocked in well past the end of the shift.`,
				actionLabel: 'Review time cards',
			}
		case 'auto_clock_out':
			return {
				eyebrow: 'Attendance',
				subject: `${people(count)} ${count === 1 ? 'was' : 'were'} clocked out automatically${place}`,
				headline: `${people(count)} ${count === 1 ? 'was' : 'were'} clocked out automatically`,
				detail: `${people(count)}${place} forgot to clock out, so the time card${count === 1 ? ' was' : 's were'} closed automatically and need${count === 1 ? 's' : ''} a review.`,
				actionLabel: 'Review time cards',
			}
		case 'overtime_approaching':
			return {
				eyebrow: 'Overtime',
				subject: `${people(count)} ${count === 1 ? 'is' : 'are'} close to overtime${place}`,
				headline: `${people(count)} ${count === 1 ? 'is' : 'are'} close to overtime`,
				detail: `${people(count)}${place} will reach an overtime threshold soon.`,
				actionLabel: 'Review time cards',
			}
		case 'schedule_published':
			return {
				eyebrow: 'Schedule',
				subject:
					count === 1
						? `A schedule was published${place}`
						: `${count} schedules were published${place}`,
				headline:
					count === 1
						? 'A schedule was published'
						: `${count} schedules were published`,
				detail: `${count === 1 ? 'A week' : `${count} weeks`}${place} ${count === 1 ? 'was' : 'were'} published.`,
				actionLabel: 'Open the schedule',
			}
		case 'new_applicant':
			return {
				eyebrow: 'Hiring',
				subject:
					count === 1
						? `A new applicant${place}`
						: `${count} new applicants${place}`,
				headline:
					count === 1
						? 'You have a new applicant'
						: `You have ${count} new applicants`,
				detail: `${count === 1 ? 'Someone applied' : `${count} people applied`}${place}. Open the applicants to read ${count === 1 ? 'the application' : 'the applications'} and decide what happens next.`,
				actionLabel: 'Open the applicants',
			}
		case 'onboarding_due':
			return {
				eyebrow: 'Hiring',
				subject:
					count === 1
						? `An onboarding task needs attention${place}`
						: `${count} onboarding tasks need attention${place}`,
				headline:
					count === 1
						? 'An onboarding task needs attention'
						: `${count} onboarding tasks need attention`,
				detail: `${count === 1 ? 'A new hire has' : `${count} tasks across new hires have`} onboarding to finish${place}. Open the team to see who still has tasks left.`,
				actionLabel: 'Open the team',
			}
		case 'certificate_expiring':
			return {
				eyebrow: 'Hiring',
				subject:
					count === 1
						? `A certificate needs renewing${place}`
						: `${count} certificates need renewing${place}`,
				headline:
					count === 1
						? 'A certificate needs renewing'
						: `${count} certificates need renewing`,
				detail: `${count === 1 ? 'A certificate is' : `${count} certificates are`} expiring soon or already expired${place}. Open the team to see whose.`,
				actionLabel: 'Open the team',
			}
		case 'overtime_reached':
			return {
				eyebrow: 'Overtime',
				subject: `${people(count)} ${count === 1 ? 'has' : 'have'} reached overtime${place}`,
				headline: `${people(count)} ${count === 1 ? 'has' : 'have'} reached overtime`,
				detail: `${people(count)}${place} ${count === 1 ? 'has' : 'have'} reached an overtime threshold.`,
				actionLabel: 'Review time cards',
			}
	}
}
