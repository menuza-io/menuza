import { msg, Plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	parseRosterPaste,
	ROSTER_IMPORT_MAX_ROWS,
	type RosterImportError,
} from '@repo/staffing'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Label } from '@repo/ui/label'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useMemo, useState } from 'react'
import { type StaffingLocation } from '#app/utils/staffing/client.ts'

export type ImportResult = {
	created: number
	skippedExisting: number[]
	createdPositions: string[]
}

export function ImportDialog({
	open,
	onOpenChange,
	locations,
	onImport,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	locations: StaffingLocation[]
	onImport: (input: {
		text: string
		locationId: string
	}) => Promise<{ error: string } | { result: ImportResult }>
}) {
	const { _ } = useLingui()
	const active = locations.filter((location) => location.isActive)
	const [text, setText] = useState('')
	const [locationId, setLocationId] = useState(active[0]?.id ?? '')
	const [error, setError] = useState<string | null>(null)
	const [result, setResult] = useState<ImportResult | null>(null)
	const [busy, setBusy] = useState(false)
	const preview = useMemo(() => parseRosterPaste(text), [text])
	const skippedLines = result?.skippedExisting.join(', ') ?? ''
	const newPositions = result?.createdPositions.join(', ') ?? ''
	const maxRows = ROSTER_IMPORT_MAX_ROWS

	useEffect(() => {
		if (open) {
			setText('')
			setResult(null)
			setError(null)
		}
	}, [open])

	const errorText: Record<RosterImportError, string> = {
		name_required: _(msg`Name is required`),
		invalid_email: _(msg`Email is not valid`),
		invalid_phone: _(msg`Phone is not valid`),
		duplicate_email: _(msg`Email appears twice`),
		too_many_rows: _(msg`Too many rows; import in batches`),
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						<Trans>Add people in bulk</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Paste one person per line: name, email, phone, position. Commas or
							tabs both work, so you can copy straight from a spreadsheet. Only
							the name is required. New position names are created for you.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{result ? (
					<div role="status" className="space-y-2 text-sm">
						<p className="font-medium">
							<Plural
								value={result.created}
								one="Added # person."
								other="Added # people."
							/>
						</p>
						{result.skippedExisting.length ? (
							<p>
								<Trans>
									Skipped lines {skippedLines} because someone with that email
									is already on the team.
								</Trans>
							</p>
						) : null}
						{result.createdPositions.length ? (
							<p>
								<Trans>New positions: {newPositions}</Trans>
							</p>
						) : null}
					</div>
				) : (
					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="import-location">
								<Trans>Location</Trans>
							</Label>
							<select
								id="import-location"
								className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
								value={locationId}
								onChange={(event) => setLocationId(event.target.value)}
							>
								{active.map((location) => (
									<option key={location.id} value={location.id}>
										{location.name}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="import-text">
								<Trans>People</Trans>
							</Label>
							<Textarea
								id="import-text"
								rows={10}
								dir="auto"
								className="font-mono text-sm"
								placeholder={'Ana Diaz, ana@example.com, +1 555 0100, Server'}
								value={text}
								onChange={(event) => setText(event.target.value)}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>Up to {maxRows} people at a time.</Trans>
							</p>
						</div>
						{text.trim() ? (
							<p className="text-sm" aria-live="polite">
								<Plural
									value={preview.rows.length}
									one="# person ready to add."
									other="# people ready to add."
								/>
							</p>
						) : null}
						{preview.errors.length ? (
							<ul className="text-destructive space-y-1 text-sm" role="alert">
								{preview.errors.slice(0, 10).map(({ line, code }) => {
									const problem = errorText[code]
									return (
										<li key={`${line}-${code}`}>
											<Trans>
												Line {line}: {problem}
											</Trans>
										</li>
									)
								})}
							</ul>
						) : null}
						{error ? (
							<p role="alert" className="text-destructive text-sm">
								{error}
							</p>
						) : null}
					</div>
				)}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						{result ? <Trans>Done</Trans> : <Trans>Cancel</Trans>}
					</Button>
					{result ? null : (
						<Button
							type="button"
							disabled={
								busy ||
								!locationId ||
								preview.rows.length === 0 ||
								preview.errors.length > 0
							}
							onClick={async () => {
								setBusy(true)
								const outcome = await onImport({ text, locationId })
								setBusy(false)
								if ('error' in outcome) setError(outcome.error)
								else setResult(outcome.result)
							}}
						>
							{busy ? <Trans>Adding…</Trans> : <Trans>Add people</Trans>}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
