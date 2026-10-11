import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useEffect, useState } from 'react'
import { type Settings } from '#app/utils/staffing/client.ts'

export function StaffingSettingsDialog({
	open,
	onOpenChange,
	settings,
	canWrite,
	onSave,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	settings: Settings
	canWrite: boolean
	onSave: (settings: Settings) => Promise<string | null>
}) {
	const [weekStart, setWeekStart] = useState(settings.weekStart)
	const [threshold, setThreshold] = useState(
		settings.weeklyHoursThreshold?.toString() ?? '',
	)
	const [grace, setGrace] = useState(settings.lateGraceMinutes.toString())
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		if (!open) return
		setWeekStart(settings.weekStart)
		setThreshold(settings.weeklyHoursThreshold?.toString() ?? '')
		setGrace(settings.lateGraceMinutes.toString())
		setError(null)
	}, [open, settings])

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form
					className="space-y-5"
					onSubmit={async (event) => {
						event.preventDefault()
						setBusy(true)
						const message = await onSave({
							weekStart,
							weeklyHoursThreshold: threshold ? Number(threshold) : null,
							lateGraceMinutes: Number(grace || 0),
						})
						setBusy(false)
						if (message) setError(message)
						else onOpenChange(false)
					}}
				>
					<DialogHeader>
						<DialogTitle>
							<Trans>Staffing settings</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								These settings shape the schedule and timesheet warnings. They
								are warnings only, not payroll or labor-law calculations.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<fieldset disabled={!canWrite} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="settings-week-start">
								<Trans>Week starts on</Trans>
							</Label>
							<select
								id="settings-week-start"
								className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
								value={weekStart}
								onChange={(event) =>
									setWeekStart(event.target.value as Settings['weekStart'])
								}
							>
								<option value="monday">
									<Trans>Monday</Trans>
								</option>
								<option value="sunday">
									<Trans>Sunday</Trans>
								</option>
							</select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="settings-threshold">
								<Trans>Weekly hours warning</Trans>
							</Label>
							<Input
								id="settings-threshold"
								type="number"
								min={1}
								max={168}
								step="0.5"
								value={threshold}
								onChange={(event) => setThreshold(event.target.value)}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Flag people scheduled or clocked over this many hours in a
									week. Leave empty to turn off.
								</Trans>
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="settings-grace">
								<Trans>Late clock-in grace (minutes)</Trans>
							</Label>
							<Input
								id="settings-grace"
								type="number"
								min={0}
								max={120}
								step={1}
								required
								value={grace}
								onChange={(event) => setGrace(event.target.value)}
							/>
						</div>
					</fieldset>
					{error ? (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						{canWrite ? (
							<Button type="submit" disabled={busy}>
								<Trans>Save</Trans>
							</Button>
						) : null}
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
