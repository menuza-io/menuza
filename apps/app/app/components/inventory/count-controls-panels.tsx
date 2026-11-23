import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	type CountDevice,
	type CountLateEntry,
	countLateEntriesResultSchema,
	type CountSecondCheck,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import { useQuantityFormat } from '#app/components/inventory/inventory-prefs.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'

/**
 * Who is still counting (#474): every device and person that joined, with the
 * time of its last sync and the entries it said it still holds. A device
 * silent for two hours is "not responding".
 */
export function DevicesPanel({
	devices,
	now,
}: {
	devices: readonly CountDevice[]
	now: number
}) {
	const { t, i18n } = useLingui()
	const pending = devices.filter((device) => device.state !== 'done')
	if (pending.length === 0) return null
	const time = (at: number) =>
		new Intl.DateTimeFormat(i18n.locale, { timeStyle: 'short' }).format(
			new Date(at),
		)
	return (
		<Alert data-testid="review-devices">
			<Icon name="smartphone" />
			<AlertDescription>
				<p className="font-medium">
					<Plural
						value={pending.length}
						one="# device is still counting"
						other="# devices are still counting"
					/>
				</p>
				<ul className="mt-1 flex flex-col gap-1 text-sm">
					{pending.map((device) => {
						const synced =
							now - device.lastSyncAt < 60_000
								? t`just now`
								: time(device.lastSyncAt)
						return (
							<li
								key={device.deviceId}
								className="flex flex-wrap items-center gap-2"
								data-testid={`review-device-${device.deviceId}`}
							>
								<span className="wrap-anywhere">
									{device.name ?? <Trans>A device</Trans>}
								</span>
								{device.state === 'not_responding' ? (
									<Badge variant="warning">
										<Trans>Not responding</Trans>
									</Badge>
								) : null}
								{device.unsentCount !== null && device.unsentCount > 0 ? (
									<span data-testid="review-device-unsent">
										<Plural
											value={device.unsentCount}
											one="# entry not sent yet"
											other="# entries not sent yet"
										/>
									</span>
								) : null}
								<span className="text-muted-foreground">
									<Trans>
										Last synced <bdi dir="ltr">{synced}</bdi>
									</Trans>
								</span>
							</li>
						)
					})}
				</ul>
			</AlertDescription>
		</Alert>
	)
}

/**
 * The key-item second-person check (#525) on the review: while the count waits
 * for the second person, when the two counts differ side by side, and what was
 * settled or skipped afterwards.
 */
export function SecondCheckPanel({
	countId,
	countVersion,
	second,
	canEdit,
	canSkip,
	onChanged,
}: {
	countId: string
	countVersion: number
	second: CountSecondCheck
	canEdit: boolean
	/** A manager (`update:settings:any`) may skip with a reason. */
	canSkip: boolean
	onChanged: () => void
}) {
	const { t, i18n } = useLingui()
	const quantity = useQuantityFormat()
	const { request } = useInventoryClient()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [choices, setChoices] = useState<Record<string, 'first' | 'second'>>({})
	const [skipping, setSkipping] = useState(false)
	const [reason, setReason] = useState('')

	async function post(path: string, body: unknown) {
		setBusy(true)
		setError(null)
		try {
			await request(`/counts/${encodeURIComponent(countId)}${path}`, {
				method: 'POST',
				body: JSON.stringify(body),
			})
			onChanged()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setBusy(false)
		}
	}

	if (second.state === null) return null
	const unresolved = second.lines.filter((line) => line.resolution === null)
	const fmt = (
		line: CountSecondCheck['lines'][number],
		value: number | null,
	) =>
		value === null ? (
			<span className="text-muted-foreground">
				<Trans>Not counted</Trans>
			</span>
		) : (
			quantity.format(value, {
				baseUnit: line.baseUnit,
				countUnit: line.baseUnit,
				units: [],
			})
		)

	const skipReason = second.skipReason ?? ''
	if (second.state === 'done' || second.state === 'skipped') {
		return (
			<p className="text-muted-foreground text-sm" data-testid="second-summary">
				{second.state === 'skipped' ? (
					<Trans>
						The second count of the key items was skipped:{' '}
						<span className="wrap-anywhere">{skipReason}</span>
					</Trans>
				) : second.lines.length === 0 ? (
					<Trans>
						A second person counted the key items and the counts match.
					</Trans>
				) : (
					<Plural
						value={second.lines.length}
						one="A second person counted the key items. # difference was settled."
						other="A second person counted the key items. # differences were settled."
					/>
				)}
			</p>
		)
	}

	return (
		<section
			className="flex flex-col gap-3 rounded-xl border p-4"
			data-testid="second-check"
		>
			<h2 className="text-sm font-semibold">
				<Trans>Second count of the key items</Trans>
			</h2>
			{error ? (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			{second.state === 'waiting' ? (
				<>
					<p className="text-sm" data-testid="second-waiting">
						<Plural
							value={second.keyItemCount}
							one="A different person has to count # key item again, signed in with their own PIN or login."
							other="A different person has to count the # key items again, signed in with their own PIN or login."
						/>
					</p>
					{second.secondCounters.length > 0 ? (
						<p className="text-muted-foreground text-xs">
							<Plural
								value={second.secondCounters.length}
								one="# person has counted so far."
								other="# people have counted so far."
							/>
						</p>
					) : null}
					{canEdit ? (
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								disabled={busy || second.secondCounters.length === 0}
								onClick={() =>
									void post('/second/finish', { expectedVersion: countVersion })
								}
								data-testid="second-finish"
							>
								<Trans>Compare the two counts</Trans>
							</Button>
							{canSkip ? (
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => setSkipping((open) => !open)}
									data-testid="second-skip-open"
								>
									<Trans>Skip with a reason</Trans>
								</Button>
							) : null}
						</div>
					) : null}
				</>
			) : (
				<>
					<p className="text-sm" data-testid="second-settle-intro">
						<Plural
							value={unresolved.length}
							one="# key item was counted differently. Choose which count stands."
							other="# key items were counted differently. Choose which count stands for each."
						/>
					</p>
					<ul className="flex flex-col gap-2">
						{second.lines.map((line) => {
							const choice = choices[line.itemId] ?? line.resolution
							return (
								<li
									key={line.itemId}
									className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
									data-testid={`second-line-${line.itemId}`}
								>
									<span className="font-medium wrap-anywhere">{line.name}</span>
									<div className="flex flex-wrap items-center gap-2">
										<Button
											type="button"
											size="sm"
											variant={choice === 'first' ? 'default' : 'outline'}
											aria-pressed={choice === 'first'}
											disabled={!canEdit || line.resolution !== null}
											onClick={() =>
												setChoices((current) => ({
													...current,
													[line.itemId]: 'first',
												}))
											}
											data-testid={`second-pick-first-${line.itemId}`}
										>
											<Trans>First:</Trans>{' '}
											<bdi dir="ltr">{fmt(line, line.firstQuantity)}</bdi>
										</Button>
										<Button
											type="button"
											size="sm"
											variant={choice === 'second' ? 'default' : 'outline'}
											aria-pressed={choice === 'second'}
											disabled={
												!canEdit ||
												line.resolution !== null ||
												line.secondQuantity === null
											}
											onClick={() =>
												setChoices((current) => ({
													...current,
													[line.itemId]: 'second',
												}))
											}
											data-testid={`second-pick-second-${line.itemId}`}
										>
											<Trans>Second:</Trans>{' '}
											<bdi dir="ltr">{fmt(line, line.secondQuantity)}</bdi>
										</Button>
									</div>
								</li>
							)
						})}
					</ul>
					{canEdit ? (
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								disabled={
									busy ||
									unresolved.some((line) => choices[line.itemId] === undefined)
								}
								onClick={() =>
									void post('/second/settle', {
										expectedVersion: countVersion,
										resolutions: Object.fromEntries(
											unresolved.map((line) => [
												line.itemId,
												choices[line.itemId],
											]),
										),
									})
								}
								data-testid="second-settle"
							>
								<Trans>Settle and continue to review</Trans>
							</Button>
							{canSkip ? (
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => setSkipping((open) => !open)}
									data-testid="second-skip-open"
								>
									<Trans>Skip with a reason</Trans>
								</Button>
							) : null}
						</div>
					) : null}
				</>
			)}
			{skipping && canSkip ? (
				<div className="flex flex-col gap-2" data-testid="second-skip-form">
					<Textarea
						value={reason}
						onChange={(event) => setReason(event.target.value)}
						maxLength={200}
						rows={2}
						aria-label={t`Why is the second count skipped?`}
						placeholder={t`Why is the second count skipped?`}
						data-testid="second-skip-reason"
					/>
					<div>
						<Button
							type="button"
							disabled={busy || reason.trim().length < 3}
							onClick={() =>
								void post('/second/skip', {
									expectedVersion: countVersion,
									reason: reason.trim(),
								})
							}
							data-testid="second-skip-confirm"
						>
							<Trans>Skip the second count</Trans>
						</Button>
					</div>
				</div>
			) : null}
		</section>
	)
}

/**
 * Entries that reached the count after it was approved (#474): listed, never
 * lost. "Add to a correction" posts one adjustment; Dismiss leaves stock alone.
 */
export function LateEntriesPanel({
	countId,
	canEdit,
	canSeeCost,
	currency,
}: {
	countId: string
	canEdit: boolean
	canSeeCost: boolean
	currency: string
}) {
	const { i18n } = useLingui()
	const { request } = useInventoryClient()
	const late = useInventoryQuery(
		`/counts/${encodeURIComponent(countId)}/late-entries`,
		countLateEntriesResultSchema,
	)
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const entries = (late.data?.entries ?? []).filter(
		(entry) => entry.status === 'open',
	)

	async function resolve(entry: CountLateEntry, action: 'apply' | 'dismiss') {
		setBusy(entry.id)
		setError(null)
		try {
			await request(
				`/counts/${encodeURIComponent(countId)}/late-entries/${encodeURIComponent(entry.id)}/${action}`,
				{
					method: 'POST',
					body: JSON.stringify({ clientId: newClientId('l') }),
				},
			)
			late.reload()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setBusy(null)
		}
	}

	if (late.error && !late.data) {
		return (
			<Alert variant="destructive">
				<AlertDescription>
					{i18n._(inventoryErrorMessage(late.error))}
				</AlertDescription>
			</Alert>
		)
	}
	if (entries.length === 0) return null
	return (
		<section
			className="flex flex-col gap-3 rounded-xl border p-4"
			data-testid="late-entries"
		>
			<h2 className="text-sm font-semibold">
				<Plural
					value={entries.length}
					one="# late entry arrived after approval"
					other="# late entries arrived after approval"
				/>
			</h2>
			<p className="text-muted-foreground text-xs">
				<Trans>
					A device sent these after the count was approved. Nothing was lost and
					nothing was changed yet. Add one to a correction to adjust your stock,
					or dismiss it.
				</Trans>
			</p>
			{error ? (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<ul className="flex flex-col gap-2">
				{entries.map((entry) => {
					const countedText = new Intl.NumberFormat(i18n.locale, {
						maximumFractionDigits: 3,
					}).format(entry.quantity / 1000)
					const changeText =
						entry.adjustment === undefined || entry.adjustment === null
							? ''
							: `${entry.adjustment > 0 ? '+' : ''}${new Intl.NumberFormat(
									i18n.locale,
									{ maximumFractionDigits: 3 },
								).format(entry.adjustment / 1000)}`
					return (
						<li
							key={entry.id}
							className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
							data-testid={`late-entry-${entry.id}`}
						>
							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="font-medium wrap-anywhere">
									{entry.itemName}
								</span>
								<span className="text-muted-foreground text-xs">
									<Trans>
										Counted <bdi dir="ltr">{countedText}</bdi>
									</Trans>
									{entry.adjustment !== undefined &&
									entry.adjustment !== null ? (
										<>
											{' · '}
											{entry.superseded ? (
												<Trans>A later count already measured this item.</Trans>
											) : (
												<Trans>
													Would change stock by{' '}
													<bdi dir="ltr">{changeText}</bdi>
												</Trans>
											)}
										</>
									) : null}
									{canSeeCost && entry.adjustmentValueMinor !== undefined ? (
										<>
											{' · '}
											<bdi dir="ltr">
												{formatMoney(
													entry.adjustmentValueMinor,
													entry.currency ?? currency,
													i18n.locale,
												)}
											</bdi>
										</>
									) : null}
								</span>
							</div>
							{canEdit ? (
								<div className="flex items-center gap-2">
									<Button
										type="button"
										size="sm"
										disabled={busy !== null || !canSeeCost}
										onClick={() => void resolve(entry, 'apply')}
										data-testid={`late-apply-${entry.id}`}
									>
										<Trans>Add to a correction</Trans>
									</Button>
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={busy !== null}
										onClick={() => void resolve(entry, 'dismiss')}
										data-testid={`late-dismiss-${entry.id}`}
									>
										<Trans>Dismiss</Trans>
									</Button>
								</div>
							) : null}
						</li>
					)
				})}
			</ul>
		</section>
	)
}
