import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { toast } from 'sonner'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { scheduleSettingsSchema } from '#app/utils/staffing/schedule-types.ts'

/**
 * Whether staff see an estimate of their own pay (#514): on their My schedule
 * page and, after their PIN, in the Station "My week" view. Off until you turn
 * it on. It is only ever hours times their rate with your overtime rules,
 * labelled "Estimate before tax", and never shown to anyone but the person.
 * Needs access to every workplace, like the other organization-wide settings.
 */
export function PayEstimateCard({ canEdit }: { canEdit: boolean }) {
	const { _ } = useLingui()
	const { client, ready, can } = useStaffClient('schedule')
	const canRead = ready && can(P.READ_SCHEDULE)
	const canWrite = canEdit && can(P.UPDATE_SCHEDULE)
	const query = useStaffQuery(
		client,
		canRead ? '/settings' : null,
		scheduleSettingsSchema,
	)
	const action = useStaffAction()
	if (!canRead || !query.data) return null

	async function change(showStaffPayEstimate: boolean) {
		const result = await action.run(() =>
			client.request('/settings', {
				method: 'PUT',
				json: { showStaffPayEstimate },
			}),
		)
		if (!result.ok) return
		toast.success(
			showStaffPayEstimate
				? _(t`Staff can now see an estimate of their pay.`)
				: _(t`Staff no longer see an estimate of their pay.`),
		)
		query.reload()
	}

	return (
		<Frame className="w-full" aria-labelledby="pay-estimate-heading">
			<FrameHeader>
				<FrameTitle id="pay-estimate-heading">
					<Trans>Pay estimate for staff</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						Let people see what they have earned so far this pay period. It is
						an estimate before tax, not payroll.
					</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel className="flex flex-col gap-3">
				<SwitchField
					label={<Trans>Show staff an estimate of their pay</Trans>}
					description={
						<Trans>
							Hours worked times their rate, with your overtime rules. Shown
							only to the person on their My schedule page and, after their
							PIN, on the Station time clock. Never on a shared screen.
						</Trans>
					}
					checked={query.data.showStaffPayEstimate}
					onCheckedChange={(on) => void change(on)}
					disabled={!canWrite || action.pending}
				/>
				{action.error ? (
					<Alert variant="destructive">
						<AlertDescription>{action.error}</AlertDescription>
					</Alert>
				) : null}
			</FramePanel>
		</Frame>
	)
}
