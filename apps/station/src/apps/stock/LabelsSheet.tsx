import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type StationItem } from '@repo/inventory'
import { useEffect, useMemo, useRef, useState } from 'react'
import { StockApiError } from './api.ts'
import { BigStepper } from './BigStepper.tsx'
import { filterItems } from './model.ts'
import { newClientId } from './queue.ts'
import { type StockState } from './useStock.ts'
import { printLabelInBrowser } from '~/lib/label-print.ts'
import { Button, Chip, fieldClass, Input, Modal } from '~/ui/primitives.tsx'

/**
 * Labels (#523): a "made" label (made and use-by time) for a prep item, or an
 * "opened" label for a stock item, with the Arabic name under the English one.
 * Online only: the region works out the use-by time from the item's shelf life
 * and sends the job to the location's cloud label printer; when none is online
 * the tablet prints the label itself through the browser. One id per press, so
 * a second tap never prints twice.
 */
export function LabelsSheet({
	stock,
	open,
	onClose,
	onToast,
}: {
	stock: StockState
	open: boolean
	onClose: () => void
	onToast: (text: string) => void
}) {
	const { _ } = useLingui()
	const { catalog, ctx } = stock
	const [query, setQuery] = useState('')
	const [itemId, setItemId] = useState<string | null>(null)
	const [kind, setKind] = useState<'made' | 'opened'>('made')
	const [copies, setCopies] = useState<number | null>(1)
	const [quantity, setQuantity] = useState('')
	const [busy, setBusy] = useState(false)
	const [problem, setProblem] = useState<string | null>(null)
	const requestId = useRef(newClientId())
	useEffect(() => {
		if (open) return
		setQuery('')
		setItemId(null)
		setCopies(1)
		setQuantity('')
		setProblem(null)
		requestId.current = newClientId()
	}, [open])
	const items = useMemo(
		() => filterItems(catalog?.items ?? [], query).slice(0, 60),
		[catalog, query],
	)
	const item: StationItem | null =
		catalog?.items.find((entry) => entry.id === itemId) ?? null
	const pick = (next: StationItem) => {
		setItemId(next.id)
		setKind(next.kind === 'made' ? 'made' : 'opened')
		requestId.current = newClientId()
	}
	const print = async () => {
		if (!item || !ctx || busy) return
		setBusy(true)
		setProblem(null)
		try {
			const result = await stock.api.printLabel({
				requestId: requestId.current,
				locationId: ctx.locationId,
				itemId: item.id,
				kind,
				copies: copies ?? 1,
				...(quantity.trim() ? { quantityLabel: quantity.trim() } : {}),
				madeAt: Date.now(),
			})
			if (result.printed) {
				onToast(_(t`Label sent to the printer.`))
			} else {
				printLabelInBrowser(result.label, {
					made: _(t`Made`),
					opened: _(t`Opened`),
					useBy: _(t`Use by`),
					madeBy: _(t`Made by`),
					quantity: _(t`Quantity`),
				})
			}
			// The next press is a new label.
			requestId.current = newClientId()
			setItemId(null)
			setQuantity('')
			setCopies(1)
		} catch (caught) {
			const code = caught instanceof StockApiError ? caught.code : 'unknown'
			setProblem(
				code === 'connection_lost'
					? _(t`You are offline. Labels need the connection.`)
					: _(t`That label did not print. Try again.`),
			)
		} finally {
			setBusy(false)
		}
	}
	return (
		<Modal
			open={open}
			onClose={() => {
				if (!busy) onClose()
			}}
			title={_(t`Labels`)}
			size="lg"
			footer={
				<>
					<Button variant="secondary" onClick={onClose} disabled={busy}>
						<Trans>Close</Trans>
					</Button>
					<Button
						variant="primary"
						disabled={busy || !item || !stock.reachable}
						onClick={() => void print()}
					>
						<Trans>Print label</Trans>
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-4" data-testid="labels-sheet">
				{!stock.reachable ? (
					<p role="alert" className="notice-warning px-4 py-3 text-sm">
						<Trans>You are offline. Labels need the connection.</Trans>
					</p>
				) : null}
				{problem ? (
					<p role="alert" className="notice-danger px-4 py-3 text-sm">
						{problem}
					</p>
				) : null}
				<Input
					type="search"
					aria-label={_(t`Search items`)}
					placeholder={_(t`Search items`)}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<ul className="flex flex-wrap gap-2">
					{items.map((entry) => (
						<li key={entry.id}>
							<Chip
								selected={entry.id === itemId}
								onClick={() => pick(entry)}
								data-testid={`label-item-${entry.id}`}
							>
								{entry.name}
							</Chip>
						</li>
					))}
				</ul>
				{item ? (
					<div className="flex flex-col gap-3">
						<p className="text-xl font-semibold break-words">{item.name}</p>
						<div className="flex gap-2">
							<Chip selected={kind === 'made'} onClick={() => setKind('made')}>
								<Trans>Made now</Trans>
							</Chip>
							<Chip
								selected={kind === 'opened'}
								onClick={() => setKind('opened')}
							>
								<Trans>Opened now</Trans>
							</Chip>
						</div>
						<label className="flex flex-col gap-1">
							<span className="text-muted-foreground text-sm">
								<Trans>Quantity on the label (optional)</Trans>
							</span>
							<input
								className={fieldClass}
								maxLength={24}
								value={quantity}
								onChange={(event) => setQuantity(event.target.value)}
							/>
						</label>
						<div className="flex flex-col gap-1">
							<span className="text-muted-foreground text-sm">
								<Trans>Number of labels</Trans>
							</span>
							<BigStepper
								value={copies}
								label={_(t`Number of labels`)}
								step={1}
								fractions={false}
								onChange={(next) =>
									setCopies(
										next === null ? null : Math.min(5, Math.max(1, next)),
									)
								}
							/>
						</div>
					</div>
				) : null}
			</div>
		</Modal>
	)
}
