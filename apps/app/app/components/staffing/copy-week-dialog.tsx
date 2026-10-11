import { msg, Plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { addDays } from '@repo/staffing'
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
import { useEffect, useState } from 'react'
import { formatWallDate, type Schedule } from '#app/utils/staffing/client.ts'

const selectClass =
	'border-input bg-background h-9 w-full rounded-md border px-2 text-sm'

export type CopyWeekInput = {
	fromWeekStart: string
	positionId: string | null
	replace: boolean
}

export function CopyWeekDialog({
	open,
	onOpenChange,
	weekStart,
	positions,
	onCopy,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	weekStart: string
	positions: Schedule['positions']
	onCopy: (
		input: CopyWeekInput,
	) => Promise<{ error: string } | { created: number; opened: number }>
}) {
	const { _, i18n } = useLingui()
	const [fromWeekStart, setFrom] = useState(() => addDays(weekStart, -7))
	const [positionId, setPositionId] = useState<string | null>(null)
	const [replace, setReplace] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [done, setDone] = useState<{ created: number; opened: number } | null>(
		null,
	)

	useEffect(() => {
		if (open) {
			setFrom(addDays(weekStart, -7))
			setPositionId(null)
			setReplace(false)
			setError(null)
			setDone(null)
		}
	}, [open, weekStart])

	const sourceWeeks = [-7, -14, -21, -28, 7].map((offset) =>
		addDays(weekStart, offset),
	)
	const created = done?.created ?? 0
	const opened = done?.opened ?? 0

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form
					className="space-y-4"
					onSubmit={async (event) => {
						event.preventDefault()
						setBusy(true)
						const result = await onCopy({ fromWeekStart, positionId, replace })
						setBusy(false)
						if ('error' in result) setError(result.error)
						else {
							setError(null)
							setDone(result)
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>
							<Trans>Copy shifts into this week</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Copies keep their local start and end times. People who left or
								no longer work here become open shifts.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					{done ? (
						<p role="status" className="bg-muted rounded-md p-3 text-sm">
							<Plural
								value={created}
								one="Copied # shift as a draft."
								other="Copied # shifts as drafts."
							/>{' '}
							{opened > 0 ? (
								<Plural
									value={opened}
									one="# became an open shift."
									other="# became open shifts."
								/>
							) : null}
						</p>
					) : (
						<>
							<div className="space-y-2">
								<Label htmlFor="copy-from">
									<Trans>Copy from the week of</Trans>
								</Label>
								<select
									id="copy-from"
									className={selectClass}
									value={fromWeekStart}
									onChange={(event) => setFrom(event.target.value)}
								>
									{sourceWeeks.map((date) => (
										<option key={date} value={date}>
											{formatWallDate(i18n.locale, date, {
												month: 'short',
												day: 'numeric',
												year: 'numeric',
											})}
										</option>
									))}
								</select>
							</div>
							<div className="space-y-2">
								<Label htmlFor="copy-position">
									<Trans>Positions</Trans>
								</Label>
								<select
									id="copy-position"
									className={selectClass}
									value={positionId ?? ''}
									onChange={(event) =>
										setPositionId(event.target.value || null)
									}
								>
									<option value="">{_(msg`All positions`)}</option>
									{positions
										.filter((position) => !position.archived)
										.map((position) => (
											<option key={position.id} value={position.id}>
												{position.name}
											</option>
										))}
								</select>
							</div>
							<div className="flex items-start gap-2">
								<Checkbox
									id="copy-replace"
									checked={replace}
									onCheckedChange={(checked) => setReplace(checked === true)}
								/>
								<Label htmlFor="copy-replace" className="font-normal">
									<Trans>
										Replace this week’s shifts first (published shifts are
										removed when you next publish)
									</Trans>
								</Label>
							</div>
						</>
					)}
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
							{done ? <Trans>Done</Trans> : <Trans>Cancel</Trans>}
						</Button>
						{!done ? (
							<Button type="submit" disabled={busy}>
								<Trans>Copy shifts</Trans>
							</Button>
						) : null}
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
