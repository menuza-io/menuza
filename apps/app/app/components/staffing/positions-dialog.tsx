import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { POSITION_COLOR_KEYS, type PositionColorKey } from '@repo/staffing'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PositionSwatch } from '@repo/ui/position-color'
import { useState } from 'react'
import { type Position } from '#app/utils/staffing/client.ts'

const selectClass =
	'border-input bg-background h-9 rounded-md border px-2 text-sm'

export function usePositionColorLabels() {
	const { _ } = useLingui()
	return {
		gray: _(msg`Gray`),
		red: _(msg`Red`),
		orange: _(msg`Orange`),
		yellow: _(msg`Yellow`),
		green: _(msg`Green`),
		teal: _(msg`Teal`),
		blue: _(msg`Blue`),
		purple: _(msg`Purple`),
		pink: _(msg`Pink`),
	} satisfies Record<PositionColorKey, string>
}

export function PositionsDialog({
	open,
	onOpenChange,
	positions,
	canWrite,
	onCreate,
	onUpdate,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	positions: Position[]
	canWrite: boolean
	onCreate: (input: {
		name: string
		colorKey: PositionColorKey
	}) => Promise<string | null>
	onUpdate: (
		id: string,
		input: { name?: string; colorKey?: string; archived?: boolean },
	) => Promise<string | null>
}) {
	const { _ } = useLingui()
	const colors = usePositionColorLabels()
	const [name, setName] = useState('')
	const [colorKey, setColorKey] = useState<PositionColorKey>('blue')
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const run = async (work: () => Promise<string | null>) => {
		setBusy(true)
		const message = await work()
		setBusy(false)
		setError(message)
		return message
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						<Trans>Positions</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Positions are the jobs people work, such as Cook or Server.
							Archive a position to stop new assignments; existing shifts keep
							it.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<ul className="divide-border divide-y rounded-md border">
					{positions.length === 0 ? (
						<li className="text-muted-foreground p-3 text-sm">
							<Trans>No positions yet.</Trans>
						</li>
					) : null}
					{positions.map((position) => {
						const positionName = position.name
						return (
							<li key={position.id} className="flex items-center gap-3 p-3">
								<PositionSwatch color={position.colorKey} size="md" />
								<span className="flex-1 text-sm font-medium">
									{position.name}
								</span>
								{position.archived ? (
									<Badge variant="outline">
										<Trans>Archived</Trans>
									</Badge>
								) : null}
								{canWrite ? (
									<>
										<select
											aria-label={_(msg`Color for ${positionName}`)}
											className={selectClass}
											value={position.colorKey}
											disabled={busy}
											onChange={(event) =>
												void run(() =>
													onUpdate(position.id, {
														colorKey: event.target.value,
													}),
												)
											}
										>
											{POSITION_COLOR_KEYS.map((key) => (
												<option key={key} value={key}>
													{colors[key]}
												</option>
											))}
										</select>
										<Button
											type="button"
											size="sm"
											variant="ghost"
											disabled={busy}
											onClick={() =>
												void run(() =>
													onUpdate(position.id, {
														archived: !position.archived,
													}),
												)
											}
										>
											{position.archived ? (
												<Trans>Restore</Trans>
											) : (
												<Trans>Archive</Trans>
											)}
										</Button>
									</>
								) : null}
							</li>
						)
					})}
				</ul>
				{canWrite ? (
					<form
						className="flex flex-wrap items-end gap-2"
						onSubmit={(event) => {
							event.preventDefault()
							void run(() => onCreate({ name, colorKey })).then((message) => {
								if (!message) setName('')
							})
						}}
					>
						<div className="min-w-40 flex-1 space-y-1">
							<Label htmlFor="new-position-name">
								<Trans>New position</Trans>
							</Label>
							<Input
								id="new-position-name"
								required
								maxLength={60}
								value={name}
								onChange={(event) => setName(event.target.value)}
							/>
						</div>
						<select
							aria-label={_(msg`Color`)}
							className={selectClass}
							value={colorKey}
							onChange={(event) =>
								setColorKey(event.target.value as PositionColorKey)
							}
						>
							{POSITION_COLOR_KEYS.map((key) => (
								<option key={key} value={key}>
									{colors[key]}
								</option>
							))}
						</select>
						<Button type="submit" disabled={busy || !name.trim()}>
							<Trans>Add</Trans>
						</Button>
					</form>
				) : null}
				{error ? (
					<p role="alert" className="text-destructive text-sm">
						{error}
					</p>
				) : null}
			</DialogContent>
		</Dialog>
	)
}
