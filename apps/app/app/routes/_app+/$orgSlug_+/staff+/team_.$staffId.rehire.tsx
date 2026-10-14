import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Label } from '@repo/ui/label'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { TextAreaField } from '#app/components/staff/controls.tsx'
import { useProfileContext } from '#app/components/staff/profile-context.ts'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient } from '#app/hooks/use-staff-client.ts'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { STAFF_WRITE_REQUIREMENT } from '#app/utils/staffing/sections.ts'
import { staffDisplayName } from '#app/utils/staffing/staff-format.ts'
import { staffResultSchema } from '#app/utils/staffing/staff-types.ts'
import { type Route } from './+types/team_.$staffId.rehire.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireStaffingAccess(request, params.orgSlug, STAFF_WRITE_REQUIREMENT)
	return null
}

/** Rehiring is its own action, with a reason, never a side effect of an edit. */
export default function RehireStaffRoute() {
	const { _, i18n } = useLingui()
	const { staff, onChanged, close } = useProfileContext()
	const { client } = useStaffClient('staff')
	const action = useStaffAction()
	const name = staffDisplayName(staff, i18n.locale)
	const notEligible = staff.eligibleForRehire === false

	const [reason, setReason] = useState('')
	const [override, setOverride] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setError(null)
		if (!reason.trim()) {
			setError(_(t`Add a reason.`))
			return
		}
		if (notEligible && !override) {
			setError(_(t`Confirm that you want to rehire them anyway.`))
			return
		}
		const result = await action.run(async () =>
			staffResultSchema.parse(
				await client.request(`/${staff.id}/rehire`, {
					method: 'POST',
					json: { reason: reason.trim(), overrideIneligible: override },
				}),
			),
		)
		if (result.ok) {
			toast.success(_(t`${name} was rehired. Add their workplaces again.`))
			onChanged()
			close()
		}
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !action.pending) close()
			}}
		>
			<DialogContent>
				<form
					onSubmit={(event) => void submit(event)}
					noValidate
					className="flex flex-col gap-4"
				>
					<DialogHeader>
						<DialogTitle>
							<Trans>Rehire {name}</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								They become active again. Their workplaces, positions and PINs
								are not restored, so add them again from their profile.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<TextAreaField
						label={<Trans>Reason</Trans>}
						value={reason}
						onChange={(event) => setReason(event.target.value)}
						rows={3}
						maxLength={500}
						autoFocus
					/>
					{notEligible ? (
						<Label className="flex items-start gap-3 text-sm">
							<Checkbox
								className="mt-0.5"
								checked={override}
								onCheckedChange={(checked) => setOverride(checked)}
							/>
							<span>
								<Trans>
									They were marked not eligible for rehire. I want to rehire
									them anyway.
								</Trans>
							</span>
						</Label>
					) : null}
					{error || action.error ? (
						<Alert variant="destructive">
							<AlertDescription>{error ?? action.error}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={action.pending}
							onClick={close}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={action.pending}>
							{action.pending ? (
								<Trans>Rehiring…</Trans>
							) : (
								<Trans>Rehire</Trans>
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
