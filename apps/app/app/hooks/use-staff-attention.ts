import { plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useCallback, useMemo } from 'react'
import { useOnboardingLabels } from '#app/components/staff/onboarding/onboarding-labels.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import {
	certificatesSchema,
	checklistSchema,
} from '#app/utils/staffing/onboarding-types.ts'
import {
	certificateView,
	checklistProgress,
	localToday,
	sortCertificates,
} from '#app/utils/staffing/onboarding-view.ts'
import { type StaffAssignmentRow } from '#app/utils/staffing/staff-types.ts'

export type ProfileSection =
	'details' | 'positions' | 'access' | 'onboarding' | 'certificates' | 'notes'

/** One thing worth a manager's attention on a person's page, with where to fix it. */
export type AttentionItem = {
	key: 'certificate' | 'onboarding' | 'pin'
	section: ProfileSection
	message: string
	/** The part of the page it points at, shown under the message. */
	where: string
	action: string
	/** Late or expired, as opposed to merely open. */
	urgent: boolean
}

export type AttentionBadges = Partial<
	Record<ProfileSection, { count: number; urgent: boolean }>
>

/**
 * What still needs doing for one person: certificates that expire or have
 * expired, onboarding tasks that are still open, and scopes where they have
 * no PIN yet. Read from the same endpoints as the tabs, so the page says the
 * same thing the tab does. Nothing is reported for someone who has left.
 */
export function useStaffAttention({
	staffId,
	assignments,
	scopeNames,
	hiring,
	terminated,
}: {
	staffId: string
	assignments: readonly StaffAssignmentRow[]
	scopeNames: ReadonlyMap<string, string>
	hiring: boolean
	terminated: boolean
}) {
	const { _ } = useLingui()
	const labels = useOnboardingLabels()
	const { client, ready } = useStaffClient('hiring')
	const live = hiring && ready && !terminated
	const tasks = useStaffQuery(
		client,
		live ? `/onboarding/staff/${staffId}/tasks` : null,
		checklistSchema,
	)
	const certificates = useStaffQuery(
		client,
		live ? `/certificates/staff/${staffId}` : null,
		certificatesSchema,
	)
	const { reload: reloadTasks } = tasks
	const { reload: reloadCertificates } = certificates
	const reload = useCallback(() => {
		reloadTasks()
		reloadCertificates()
	}, [reloadTasks, reloadCertificates])

	const today = useMemo(() => localToday(), [])
	// Small lists, read on every render so the labels stay in the current language.
	const items = (() => {
		if (terminated)
			return { list: [] as AttentionItem[], badges: {} as AttentionBadges }
		const list: AttentionItem[] = []
		const badges: AttentionBadges = {}

		const standing = sortCertificates(
			certificates.data?.certificates ?? [],
			today,
		)
			.map((certificate) => ({
				certificate,
				view: certificateView(certificate, today),
			}))
			.filter(
				({ view }) => view.status === 'expired' || view.status === 'expiring',
			)
		const expiringCount = standing.length
		if (standing.length > 0) {
			const first = standing[0]!
			const expired = first.view.status === 'expired'
			const label = labels.certificateTitle(first.certificate)
			const days = Math.abs(first.view.daysLeft ?? 0)
			const message =
				expiringCount > 1
					? _(t`${expiringCount} certificates are expiring or have expired`)
					: expired
						? _(t`${label} has expired`)
						: first.view.daysLeft === 0
							? _(t`${label} expires today`)
							: _(
									t`${label} expires in ${plural(days, { one: '# day', other: '# days' })}`,
								)
			list.push({
				key: 'certificate',
				section: 'certificates',
				message,
				where: _(t`Certificates`),
				action: _(t`Review`),
				urgent: standing.some(({ view }) => view.status === 'expired'),
			})
			badges.certificates = {
				count: standing.length,
				urgent: standing.some(({ view }) => view.status === 'expired'),
			}
		}

		const progress = checklistProgress(tasks.data?.tasks ?? [], today)
		const open = progress.total - progress.complete
		const late = progress.overdue
		if (open > 0) {
			list.push({
				key: 'onboarding',
				section: 'onboarding',
				message:
					progress.overdue > 0
						? _(t`${open} onboarding tasks are open, ${late} late`)
						: open === 1
							? _(t`1 onboarding task is still open`)
							: _(t`${open} onboarding tasks are still open`),
				where: _(t`Onboarding`),
				action: _(t`Open checklist`),
				urgent: progress.overdue > 0,
			})
			badges.onboarding = { count: open, urgent: progress.overdue > 0 }
		}

		const missing = assignments.filter((row) => row.active && !row.hasPin)
		const missingCount = missing.length
		if (missing.length > 0) {
			const first = scopeNames.get(missing[0]!.scopeId) ?? ''
			list.push({
				key: 'pin',
				section: 'access',
				message:
					missing.length === 1
						? _(t`No PIN at ${first} yet`)
						: _(t`No PIN yet at ${missingCount} workplaces`),
				where: _(t`Access and PIN`),
				action: _(t`Create PIN`),
				urgent: false,
			})
			badges.access = { count: missing.length, urgent: false }
		}
		return { list, badges }
	})()

	return { items: items.list, badges: items.badges, reload }
}
