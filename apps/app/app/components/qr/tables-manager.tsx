import { msg, plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Field, FieldDescription, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { useQrClient } from '#app/hooks/use-qr-client.ts'
import {
	expandTableLabels,
	qrTableSchema,
	type QrTable,
} from '#app/utils/qr/qr-model.ts'

type Location = { id: string; name: string }

export function TablesManager({
	orgSlug,
	locations,
	canWrite,
	floorPlanAvailable,
	printHref,
}: {
	orgSlug: string
	locations: Location[]
	canWrite: boolean
	floorPlanAvailable: boolean
	/** Print shop link for table cards, when the member can open it. */
	printHref: string | null
}) {
	const { _ } = useLingui()
	const request = useQrClient(orgSlug)
	const [locationId, setLocationId] = useState(locations[0]?.id ?? '')
	const [tables, setTables] = useState<QrTable[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [labels, setLabels] = useState('')

	const load = useCallback(async () => {
		if (!locationId) return
		try {
			const payload = z
				.object({ tables: z.array(qrTableSchema) })
				.parse(
					await request(`/tables?locationId=${encodeURIComponent(locationId)}`),
				)
			setTables(payload.tables)
			setError(null)
		} catch {
			setError(_(msg`Unable to load tables. Try again.`))
		} finally {
			setLoading(false)
		}
	}, [locationId, request, _])

	useEffect(() => {
		setLoading(true)
		void load()
	}, [load])

	const run = async (work: () => Promise<unknown>, done: string) => {
		setBusy(true)
		try {
			await work()
			toast.success(done)
			await load()
		} catch (cause) {
			toast.error(
				cause instanceof OperatorRequestError
					? cause.message
					: _(msg`That did not work. Try again.`),
			)
		} finally {
			setBusy(false)
		}
	}

	const addTables = (event: FormEvent) => {
		event.preventDefault()
		const list = expandTableLabels(labels)
		if (list.length === 0) return
		void run(
			() =>
				request('/tables/bulk', {
					method: 'POST',
					body: JSON.stringify({ locationId, labels: list }),
				}),
			_(
				plural(list.length, {
					one: 'Added # table',
					other: 'Added # tables',
				}),
			),
		).then(() => setLabels(''))
	}

	const importFloorPlan = () =>
		run(
			() =>
				request('/tables/import-floor-plan', {
					method: 'POST',
					body: JSON.stringify({ locationId }),
				}),
			_(msg`Floor plan tables are in sync`),
		)

	return (
		<div className="space-y-6">
			{locations.length > 1 ? (
				<Field className="max-w-xs">
					<FieldLabel htmlFor="qr-location">{_(msg`Location`)}</FieldLabel>
					<select
						id="qr-location"
						value={locationId}
						onChange={(event) => setLocationId(event.target.value)}
						className="border-input bg-background h-11 rounded-md border px-3 text-sm"
					>
						{locations.map((location) => (
							<option key={location.id} value={location.id}>
								{location.name}
							</option>
						))}
					</select>
				</Field>
			) : null}

			{canWrite ? (
				<form
					onSubmit={addTables}
					className="flex flex-col gap-3 sm:flex-row sm:items-end"
				>
					<Field className="flex-1">
						<FieldLabel htmlFor="qr-new-tables">
							{_(msg`Add tables`)}
						</FieldLabel>
						<Input
							id="qr-new-tables"
							value={labels}
							onChange={(event) => setLabels(event.target.value)}
							placeholder="T1-T12, Patio 1"
							maxLength={600}
						/>
						<FieldDescription>
							{_(
								msg`Type one label, a range like T1-T12, or a list separated by commas.`,
							)}
						</FieldDescription>
					</Field>
					<div className="flex flex-wrap gap-2 sm:pb-7">
						<Button type="submit" disabled={busy || !labels.trim()}>
							<Icon name="plus" className="size-4" />
							{_(msg`Add`)}
						</Button>
						{floorPlanAvailable ? (
							<Button
								type="button"
								variant="outline"
								disabled={busy}
								onClick={() => void importFloorPlan()}
							>
								{_(msg`Import floor plan`)}
							</Button>
						) : null}
					</div>
				</form>
			) : null}

			{printHref && tables.length > 0 ? (
				<Button variant="outline" render={<Link to={printHref} />}>
					<Icon name="printer" className="size-4" />
					{_(msg`Print table cards`)}
				</Button>
			) : null}

			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : loading ? (
				<p role="status">{_(msg`Loading tables…`)}</p>
			) : tables.length === 0 ? (
				<div className="rounded-lg border p-8 text-center">
					<h3 className="font-medium">{_(msg`No tables yet`)}</h3>
					<p className="text-muted-foreground mt-2 text-sm">
						{_(
							msg`Each table gets its own QR code. Guests scan it to order, and every phone at the table shares one tab.`,
						)}
					</p>
				</div>
			) : (
				<ul className="divide-border divide-y rounded-lg border">
					{tables.map((table) => (
						<TableRow
							key={table.id}
							table={table}
							canWrite={canWrite}
							busy={busy}
							onRename={(label) =>
								run(
									() =>
										request(`/tables/${table.id}`, {
											method: 'PATCH',
											body: JSON.stringify({ label }),
										}),
									_(msg`Table renamed`),
								)
							}
							onRegenerate={() =>
								run(
									() =>
										request(`/tables/${table.id}`, {
											method: 'PATCH',
											body: JSON.stringify({ regenerateToken: true }),
										}),
									_(msg`New QR code made. Print and replace the old card.`),
								)
							}
							onArchive={() =>
								run(
									() =>
										request(`/tables/${table.id}`, {
											method: 'PATCH',
											body: JSON.stringify({ archived: true }),
										}),
									_(msg`Table archived`),
								)
							}
						/>
					))}
				</ul>
			)}
		</div>
	)
}

function TableRow({
	table,
	canWrite,
	busy,
	onRename,
	onRegenerate,
	onArchive,
}: {
	table: QrTable
	canWrite: boolean
	busy: boolean
	onRename: (label: string) => Promise<void>
	onRegenerate: () => Promise<void>
	onArchive: () => Promise<void>
}) {
	const { _ } = useLingui()
	const [editing, setEditing] = useState(false)
	const [label, setLabel] = useState(table.label)
	return (
		<li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				{editing ? (
					<form
						className="flex items-center gap-2"
						onSubmit={(event) => {
							event.preventDefault()
							void onRename(label.trim()).then(() => setEditing(false))
						}}
					>
						<Input
							aria-label={_(msg`Table label`)}
							value={label}
							onChange={(event) => setLabel(event.target.value)}
							maxLength={40}
							className="w-40"
							autoFocus
						/>
						<Button type="submit" size="sm" disabled={busy || !label.trim()}>
							{_(msg`Save`)}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => {
								setLabel(table.label)
								setEditing(false)
							}}
						>
							{_(msg`Cancel`)}
						</Button>
					</form>
				) : (
					<span className="font-medium wrap-anywhere">
						<bdi>{table.label}</bdi>
					</span>
				)}
				{table.openTabId ? (
					<Badge variant="warning">{_(msg`Tab open`)}</Badge>
				) : null}
				{table.importedRsvTableId ? (
					<Badge variant="secondary">{_(msg`From floor plan`)}</Badge>
				) : null}
			</div>
			{canWrite && !editing ? (
				<div className="flex flex-wrap gap-2">
					<Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
						<Icon name="pencil" className="size-4" />
						{_(msg`Rename`)}
					</Button>
					<AlertDialog>
						<AlertDialogTrigger
							render={
								<Button size="sm" variant="ghost" disabled={busy}>
									{_(msg`New QR code`)}
								</Button>
							}
						/>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>
									{_(msg`Make a new QR code for this table?`)}
								</AlertDialogTitle>
								<AlertDialogDescription>
									{_(
										msg`Every printed card for this table stops working right away, including cards you ordered. Print the new card before you replace the old one.`,
									)}
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>{_(msg`Cancel`)}</AlertDialogCancel>
								<AlertDialogAction
									variant="destructive"
									onClick={() => void onRegenerate()}
								>
									{_(msg`Make a new code`)}
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy || Boolean(table.openTabId)}
						onClick={() => void onArchive()}
					>
						{_(msg`Archive`)}
					</Button>
				</div>
			) : null}
		</li>
	)
}
