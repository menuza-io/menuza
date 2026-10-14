import { msg, plural } from '@lingui/macro'
import { type ManagerAlertKind } from '@repo/staffing'

type Translate = (message: any) => string

/**
 * Wording for a time clock alert. The notification carries only a kind and a
 * count (never a person), so that is all it can say; who it is about is read in
 * the time clock after opening it.
 */
export function staffingAlertCopy(
	kind: ManagerAlertKind,
	count: number,
	_: Translate,
): { subject: string; body: string } {
	const n = Math.max(1, Math.floor(count) || 1)
	switch (kind) {
		case 'no_clock_in':
			return {
				subject: _(
					plural(n, {
						one: '# person has not clocked in',
						other: '# people have not clocked in',
					}),
				),
				body: _(
					msg`Open the time clock to see who is missing.` as {
						id: string
						message: string
					},
				),
			}
		case 'missed_clock_out':
			return {
				subject: _(
					plural(n, {
						one: '# person may have forgotten to clock out',
						other: '# people may have forgotten to clock out',
					}),
				),
				body: _(
					msg`Review the time cards that need a look.` as {
						id: string
						message: string
					},
				),
			}
		case 'auto_clock_out':
			return {
				subject: _(
					plural(n, {
						one: '# person was clocked out automatically',
						other: '# people were clocked out automatically',
					}),
				),
				body: _(
					msg`Their time cards are waiting for a review.` as {
						id: string
						message: string
					},
				),
			}
		case 'overtime_approaching':
			return {
				subject: _(
					plural(n, {
						one: '# person is close to overtime',
						other: '# people are close to overtime',
					}),
				),
				body: _(
					msg`Check the time cards before the limit is reached.` as {
						id: string
						message: string
					},
				),
			}
		case 'schedule_published':
			return {
				subject: _(
					plural(n, {
						one: 'A schedule was published',
						other: '# schedules were published',
					}),
				),
				body: _(
					msg`Open the schedule to see what was published.` as {
						id: string
						message: string
					},
				),
			}
		case 'new_applicant':
			return {
				subject: _(
					plural(n, {
						one: '# new applicant',
						other: '# new applicants',
					}),
				),
				body: _(
					msg`Open the applicants to take a look.` as {
						id: string
						message: string
					},
				),
			}
		case 'onboarding_due':
			return {
				subject: _(
					plural(n, {
						one: '# onboarding task needs attention',
						other: '# onboarding tasks need attention',
					}),
				),
				body: _(
					msg`Open the team to see who still has onboarding to finish.` as {
						id: string
						message: string
					},
				),
			}
		case 'certificate_expiring':
			return {
				subject: _(
					plural(n, {
						one: '# certificate is expiring or has expired',
						other: '# certificates are expiring or have expired',
					}),
				),
				body: _(
					msg`Open the team to see whose certificate needs renewing.` as {
						id: string
						message: string
					},
				),
			}
		case 'overtime_reached':
			return {
				subject: _(
					plural(n, {
						one: '# person has reached overtime',
						other: '# people have reached overtime',
					}),
				),
				body: _(
					msg`Review the time cards for the week.` as {
						id: string
						message: string
					},
				),
			}
	}
}
