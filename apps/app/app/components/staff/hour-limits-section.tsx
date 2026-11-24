import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { TextField } from '#app/components/staff/controls.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'

const limitsSchema = z.object({
	limits: z.object({
		dailyMinutes: z.number().nullable(),
		weeklyMinutes: z.number().nullable(),
		/** Present only for managers who may see private details. */
		followsRamadan: z.boolean().optional(),
	}),
})

const toHoursText = (minutes: number | null) =>
	minutes === null ? '' : String(Math.round((minutes / 60) * 100) / 100)

/** Blank is "follow the workplace's limit"; otherwise hours, decimals allowed. */
function toMinutes(text: string): number | null | undefined {
	if (text.trim() === '') return null
	const hours = Number(text.replace(',', '.'))
	if (!Number.isFinite(hours) || hours < 1 || hours > 168) return undefined
	return Math.round(hours * 60)
}

/**
 * A person's own hour limits (#527), for part-time work or a minor: they replace
 * the workplace's daily and weekly limits for this person. The schedule warns
 * above them. Whether the person follows the Ramadan limit is private: it is
 * shown and changed only with access to private details, and never appears for
 * other staff.
 */
export function HourLimitsSection({
	staffId,
	terminated,
}: {
	staffId: string
	terminated: boolean
}) {
	const { _ } = useLingui()
	const { client, ready, can } = useStaffClient('staff')
	const canRead = ready && can(P.READ_STAFF)
	const canWrite = can(P.UPDATE_STAFF) && !terminated
	const canWritePrivate = can(P.UPDATE_STAFF_PRIVATE)
	const query = useStaffQuery(
		client,
		canRead ? `/${encodeURIComponent(staffId)}/hour-limits` : null,
		limitsSchema,
	)
	const action = useStaffAction()
	const [daily, setDaily] = useState('')
	const [weekly, setWeekly] = useState('')
	const [ramadan, setRamadan] = useState(false)
	const limits = query.data?.limits ?? null
	useEffect(() => {
		if (!limits) return
		setDaily(toHoursText(limits.dailyMinutes))
		setWeekly(toHoursText(limits.weeklyMinutes))
		setRamadan(limits.followsRamadan ?? false)
	}, [limits])
	if (!canRead || !limits) return null

	const dailyMinutes = toMinutes(daily)
	const weeklyMinutes = toMinutes(weekly)
	const invalid = dailyMinutes === undefined || weeklyMinutes === undefined
	const ramadanShown = limits.followsRamadan !== undefined
	const dirty =
		!invalid &&
		(dailyMinutes !== limits.dailyMinutes ||
			weeklyMinutes !== limits.weeklyMinutes ||
			(ramadanShown && ramadan !== limits.followsRamadan))

	async function save() {
		if (invalid) return
		const body: Record<string, unknown> = {}
		if (dailyMinutes !== limits!.dailyMinutes) body.dailyMinutes = dailyMinutes
		if (weeklyMinutes !== limits!.weeklyMinutes) {
			body.weeklyMinutes = weeklyMinutes
		}
		if (ramadanShown && ramadan !== limits!.followsRamadan) {
			body.followsRamadan = ramadan
		}
		const result = await action.run(() =>
			client.request(`/${encodeURIComponent(staffId)}/hour-limits`, {
				method: 'PUT',
				json: body,
			}),
		)
		if (!result.ok) return
		toast.success(_(t`Hour limits saved.`))
		query.reload()
	}

	return (
		<Frame className="w-full" aria-labelledby="hour-limits-heading">
			<FrameHeader>
				<FrameTitle id="hour-limits-heading">
					<Trans>Hour limits</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						The schedule warns when this person is scheduled past these hours.
						Leave a box empty to follow the workplace's limit. Use it for
						part-time work or a minor.
					</Trans>
				</FrameDescription>
				{canWrite ? (
					<FrameAction>
						<Button
							type="button"
							disabled={!dirty || action.pending}
							onClick={() => void save()}
						>
							{action.pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
						</Button>
					</FrameAction>
				) : null}
			</FrameHeader>
			<FramePanel className="flex flex-col gap-4">
				<div className="grid gap-4 sm:grid-cols-2">
					<TextField
						label={<Trans>Most hours in a day</Trans>}
						inputMode="decimal"
						value={daily}
						disabled={!canWrite}
						onChange={(event) => setDaily(event.target.value)}
						error={
							dailyMinutes === undefined
								? _(t`Enter a number of hours, or leave it empty.`)
								: undefined
						}
					/>
					<TextField
						label={<Trans>Most hours in a week</Trans>}
						inputMode="decimal"
						value={weekly}
						disabled={!canWrite}
						onChange={(event) => setWeekly(event.target.value)}
						error={
							weeklyMinutes === undefined
								? _(t`Enter a number of hours, or leave it empty.`)
								: undefined
						}
					/>
				</div>
				{ramadanShown ? (
					<SwitchField
						label={<Trans>Follows the Ramadan limit</Trans>}
						description={
							<Trans>
								In Ramadan the workplace's shorter limits apply to this person.
								Only managers who can see private details see this setting.
							</Trans>
						}
						checked={ramadan}
						onCheckedChange={setRamadan}
						disabled={!canWrite || !canWritePrivate}
					/>
				) : null}
				{action.error ? (
					<Alert variant="destructive">
						<AlertDescription>{action.error}</AlertDescription>
					</Alert>
				) : null}
			</FramePanel>
		</Frame>
	)
}
