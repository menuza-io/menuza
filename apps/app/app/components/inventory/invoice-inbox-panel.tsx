import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	invoiceInboxConfigSchema,
	invoiceInboxDetailSchema,
	invoiceInboxListSchema,
	matchInvoiceResultSchema,
	type InvoiceInboxItem,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { formatUseBy } from '#app/components/inventory/freshness-panel.tsx'
import {
	useInventoryRevision,
	useNotifyInventoryChanged,
} from '#app/components/inventory/inventory-prefs.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'

/** The location's address, `invoices+<code>@<domain>`. */
export function invoiceAddress(code: string, domain: string): string {
	return `invoices+${code}@${domain}`
}

const codeSchema = z.object({ code: z.string() })

/**
 * "Invoices to match" on Purchasing (#503): the location's invoice address with
 * a copy button, invoices that arrived by email, by upload (several files at
 * once) or from a Station photo, and what to do with each: match it to an open
 * order (the delivery screen opens prefilled), make a delivery from it, allow
 * its sender, or dismiss it. The files live in the region's storage; the page
 * only holds ids and a short-lived link.
 */
export function InvoiceInboxPanel({
	orgSlug,
	locationId,
	canEdit,
	canSeeCost,
	canManageSettings,
	currency,
	search,
}: {
	orgSlug: string
	locationId: string
	canEdit: boolean
	canSeeCost: boolean
	canManageSettings: boolean
	currency: string
	search: string
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const revision = useInventoryRevision()
	const config = useInventoryQuery(
		`/invoice-inbox/config?${new URLSearchParams({ locationId })}`,
		invoiceInboxConfigSchema,
	)
	const list = useInventoryQuery(
		`/invoice-inbox?${new URLSearchParams({ locationId, status: 'open' })}`,
		invoiceInboxListSchema,
	)
	const [code, setCode] = useState<string | null>(null)
	const [open, setOpen] = useState<string | null>(null)
	const [uploading, setUploading] = useState(false)
	const fileInput = useRef<HTMLInputElement>(null)
	const { reload } = list
	const seen = useRef(revision)
	useEffect(() => {
		if (seen.current !== revision) {
			seen.current = revision
			reload()
		}
	}, [revision, reload])

	// The code is made on first use by the App; only the domain comes from the region.
	useEffect(() => {
		if (!config.data?.enabled) return
		let live = true
		void fetch(
			`/${orgSlug}/inventory-invoice-address?${new URLSearchParams({ locationId })}`,
			{ headers: { Accept: 'application/json' } },
		)
			.then((response) => (response.ok ? response.json() : null))
			.then((body: unknown) => {
				const parsed = codeSchema.safeParse(body)
				if (live && parsed.success) setCode(parsed.data.code)
			})
			.catch(() => undefined)
		return () => {
			live = false
		}
	}, [config.data?.enabled, orgSlug, locationId])

	if (config.loading && !config.data) {
		return <Skeleton className="h-24 w-full rounded-xl" />
	}
	if (!config.data) return null
	const address =
		config.data.enabled && config.data.domain && code
			? invoiceAddress(code, config.data.domain)
			: null

	async function upload(files: FileList | null) {
		if (!files || files.length === 0) return
		const form = new FormData()
		for (const file of Array.from(files)) form.append('files', file)
		setUploading(true)
		try {
			await request(
				`/invoice-inbox/upload?${new URLSearchParams({ locationId })}`,
				{ method: 'POST', body: form },
			)
			toast.success(t`Added to Invoices to match.`)
			notifyChanged()
			reload()
		} catch (error) {
			toast.error(i18n._(inventorySaveErrorMessage(error)))
		} finally {
			setUploading(false)
			if (fileInput.current) fileInput.current.value = ''
		}
	}

	const items = list.data?.items ?? []
	return (
		<div data-testid="invoice-inbox">
			<WorkspacePanel title={<Trans>Invoices to match</Trans>}>
				<div className="flex flex-col gap-4">
					{address ? (
						<div
							className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
							data-testid="invoice-address"
						>
							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="text-muted-foreground text-xs">
									<Trans>Ask suppliers to email invoices to</Trans>
								</span>
								<bdi
									dir="ltr"
									className="text-sm font-medium wrap-anywhere"
									data-testid="invoice-address-text"
								>
									{address}
								</bdi>
							</div>
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									void navigator.clipboard
										?.writeText(address)
										.then(() => toast.success(t`Copied.`))
										.catch(() => toast.error(t`Could not copy.`))
								}}
								data-testid="invoice-address-copy"
							>
								<Trans>Copy</Trans>
							</Button>
						</div>
					) : (
						<p className="text-muted-foreground text-xs">
							<Trans>
								Emailing invoices is not set up yet. You can still add them
								here.
							</Trans>
						</p>
					)}

					{canEdit ? (
						<div className="flex flex-wrap items-center gap-2">
							<input
								ref={fileInput}
								type="file"
								multiple
								hidden
								accept="application/pdf,image/jpeg,image/png,image/webp"
								onChange={(event) => void upload(event.target.files)}
								data-testid="invoice-upload-input"
							/>
							<Button
								variant="outline"
								size="sm"
								disabled={uploading}
								onClick={() => fileInput.current?.click()}
								data-testid="invoice-upload"
							>
								<Trans>Add invoices</Trans>
							</Button>
							<span className="text-muted-foreground text-xs">
								<Trans>PDF or photos, several at once.</Trans>
							</span>
						</div>
					) : null}

					{list.loading && !list.data ? (
						<Skeleton className="h-16 w-full rounded-xl" />
					) : items.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No invoices are waiting.</Trans>
						</p>
					) : (
						<ul
							className="flex flex-col divide-y rounded-xl border"
							data-testid="invoice-inbox-list"
						>
							{items.map((invoice) => (
								<li
									key={invoice.id}
									className="flex flex-wrap items-center justify-between gap-3 p-3"
									data-testid={`invoice-${invoice.id}`}
								>
									<span className="flex min-w-0 flex-col gap-1">
										<span className="flex flex-wrap items-center gap-2 text-sm font-medium wrap-anywhere">
											{invoice.supplierName ??
												invoice.fromAddress ??
												t`An invoice`}
											{invoice.invoiceNumber ? (
												<bdi dir="ltr" className="text-muted-foreground">
													#{invoice.invoiceNumber}
												</bdi>
											) : null}
										</span>
										<span className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
											<bdi dir="ltr">
												{new Intl.DateTimeFormat(i18n.locale, {
													dateStyle: 'medium',
													timeStyle: 'short',
												}).format(new Date(invoice.receivedAt))}
											</bdi>
											{canSeeCost && invoice.totalMinor !== undefined ? (
												<bdi dir="ltr">
													{formatMoney(
														invoice.totalMinor,
														invoice.currency ?? currency,
														i18n.locale,
													)}
												</bdi>
											) : null}
											<Plural
												value={invoice.files.length}
												one="# file"
												other="# files"
											/>
											{invoice.senderState === 'unknown' ? (
												<Badge variant="warning">
													<Trans>Unknown sender</Trans>
												</Badge>
											) : null}
											{invoice.duplicateOfId || invoice.duplicateDeliveryId ? (
												<Badge variant="warning">
													<Trans>Duplicate</Trans>
												</Badge>
											) : null}
											{invoice.status === 'matched' ? (
												<Badge variant="secondary">
													<Trans>Matched to an order</Trans>
												</Badge>
											) : null}
										</span>
									</span>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setOpen(invoice.id)}
										data-testid={`invoice-open-${invoice.id}`}
									>
										<Trans>Open</Trans>
									</Button>
								</li>
							))}
						</ul>
					)}
				</div>
				{open ? (
					<InvoiceDialog
						id={open}
						orgSlug={orgSlug}
						locationId={locationId}
						canEdit={canEdit}
						canManageSettings={canManageSettings}
						canSeeCost={canSeeCost}
						currency={currency}
						search={search}
						onClose={() => setOpen(null)}
						onChanged={() => {
							notifyChanged()
							reload()
						}}
					/>
				) : null}
			</WorkspacePanel>
		</div>
	)
}

function InvoiceDialog({
	id,
	orgSlug,
	locationId,
	canEdit,
	canManageSettings,
	canSeeCost,
	currency,
	search,
	onClose,
	onChanged,
}: {
	id: string
	orgSlug: string
	locationId: string
	canEdit: boolean
	canManageSettings: boolean
	canSeeCost: boolean
	currency: string
	search: string
	onClose: () => void
	onChanged: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const navigate = useNavigate()
	const detail = useInventoryQuery(
		`/invoice-inbox/${encodeURIComponent(id)}?${new URLSearchParams({ locationId })}`,
		invoiceInboxDetailSchema,
	)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const invoice = detail.data

	async function call(path: string, body: unknown) {
		setBusy(true)
		setError(null)
		try {
			return await request(`/invoice-inbox/${encodeURIComponent(id)}${path}`, {
				method: 'POST',
				body: JSON.stringify(body),
			})
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
			return null
		} finally {
			setBusy(false)
		}
	}

	const deliveryHref = (extra: Record<string, string>) => {
		const params = new URLSearchParams(
			search.startsWith('?') ? search.slice(1) : search,
		)
		for (const [key, value] of Object.entries(extra)) params.set(key, value)
		return `/${orgSlug}/inventory/purchasing/deliveries/new?${params.toString()}`
	}

	async function matchOrder(orderId: string, item: InvoiceInboxItem) {
		const body = await call('/match', {
			expectedVersion: item.version,
			orderId,
		})
		if (!body) return
		const result = matchInvoiceResultSchema.parse(body)
		onChanged()
		// The delivery screen opens for that order, started from this invoice.
		void navigate(
			deliveryHref({
				orderId: result.prefill?.orderId ?? orderId,
				inboxId: id,
			}),
		)
	}

	async function simple(
		path: '/dismiss' | '/allow-sender',
		item: InvoiceInboxItem,
	) {
		const body = await call(
			path,
			path === '/dismiss' ? { expectedVersion: item.version } : {},
		)
		if (!body) return
		toast.success(path === '/dismiss' ? t`Dismissed.` : t`Sender allowed.`)
		onChanged()
		if (path === '/dismiss') onClose()
		else detail.reload()
	}

	return (
		<Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
			<DialogContent data-testid="invoice-dialog">
				<DialogHeader>
					<DialogTitle>
						{invoice?.supplierName ?? invoice?.fromAddress ?? (
							<Trans>Invoice</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Check it, then match it to an order or make a delivery.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				{!invoice ? (
					<Skeleton className="h-24 w-full" />
				) : (
					<div className="flex flex-col gap-3 text-sm">
						<dl className="grid grid-cols-2 gap-2">
							{invoice.invoiceNumber ? (
								<>
									<dt className="text-muted-foreground">
										<Trans>Number</Trans>
									</dt>
									<dd>
										<bdi dir="ltr">{invoice.invoiceNumber}</bdi>
									</dd>
								</>
							) : null}
							{invoice.invoiceDate ? (
								<>
									<dt className="text-muted-foreground">
										<Trans>Date</Trans>
									</dt>
									<dd>
										<bdi dir="ltr">
											{formatUseBy(invoice.invoiceDate, i18n.locale)}
										</bdi>
									</dd>
								</>
							) : null}
							{canSeeCost && invoice.totalMinor !== undefined ? (
								<>
									<dt className="text-muted-foreground">
										<Trans>Total</Trans>
									</dt>
									<dd>
										<bdi dir="ltr">
											{formatMoney(
												invoice.totalMinor,
												invoice.currency ?? currency,
												i18n.locale,
											)}
										</bdi>
									</dd>
								</>
							) : null}
						</dl>
						{invoice.readState === 'not_configured' ? (
							<p className="text-muted-foreground text-xs">
								<Trans>
									Reading invoices is not set up, so the details are empty. Open
									the file and type them in when you receive.
								</Trans>
							</p>
						) : invoice.readState === 'failed' ? (
							<p className="text-muted-foreground text-xs">
								<Trans>We could not read this invoice.</Trans>
							</p>
						) : null}
						{invoice.duplicateOfId || invoice.duplicateDeliveryId ? (
							<Alert>
								<AlertDescription>
									<Trans>
										This looks like an invoice you already have: same supplier,
										same number.
									</Trans>
								</AlertDescription>
							</Alert>
						) : null}
						{invoice.senderState === 'unknown' ? (
							<Alert>
								<AlertDescription>
									<div className="flex flex-wrap items-center justify-between gap-2">
										<span>
											<Trans>
												Nobody has allowed{' '}
												<bdi dir="ltr">{invoice.fromAddress}</bdi> yet.
											</Trans>
										</span>
										{canManageSettings ? (
											<Button
												size="sm"
												variant="outline"
												disabled={busy}
												onClick={() => void simple('/allow-sender', invoice)}
												data-testid="invoice-allow-sender"
											>
												<Trans>Allow this sender</Trans>
											</Button>
										) : null}
									</div>
								</AlertDescription>
							</Alert>
						) : null}
						<ul className="flex flex-wrap gap-2">
							{invoice.files.map((file) => (
								<li key={file.id}>
									{file.url ? (
										<a
											className="text-primary text-sm underline"
											href={file.url}
											target="_blank"
											rel="noreferrer"
										>
											{file.fileName ?? t`Open the file`}
										</a>
									) : (
										<span className="text-muted-foreground text-sm">
											{file.fileName ?? t`File`}
										</span>
									)}
								</li>
							))}
						</ul>
						{invoice.lines.length > 0 ? (
							<ul className="flex flex-col gap-1 text-xs">
								{invoice.lines.slice(0, 8).map((line, index) => (
									<li key={index} className="flex justify-between gap-2">
										<span className="wrap-anywhere">{line.description}</span>
										<bdi dir="ltr" className="text-muted-foreground">
											{line.quantity ?? ''} {line.unit ?? ''}
										</bdi>
									</li>
								))}
							</ul>
						) : null}
						{canEdit ? (
							<div className="flex flex-col gap-2">
								{invoice.suggestedOrders.length > 0 ? (
									<div className="flex flex-col gap-1">
										<span className="text-muted-foreground text-xs">
											<Trans>Match to an open order</Trans>
										</span>
										{invoice.suggestedOrders.map((order) => (
											<Button
												key={order.id}
												variant="outline"
												size="sm"
												className="justify-between"
												disabled={busy}
												onClick={() => void matchOrder(order.id, invoice)}
												data-testid={`invoice-match-${order.id}`}
											>
												<span>
													<Trans>Order #{order.number}</Trans>
												</span>
												{order.expectedDate ? (
													<bdi dir="ltr" className="text-muted-foreground">
														{formatUseBy(order.expectedDate, i18n.locale)}
													</bdi>
												) : null}
											</Button>
										))}
									</div>
								) : null}
								{invoice.suggestedDeliveries.length > 0 ? (
									<div className="flex flex-col gap-1">
										<span className="text-muted-foreground text-xs">
											<Trans>
												Or it belongs to a delivery you already made
											</Trans>
										</span>
										{invoice.suggestedDeliveries.map((delivery) => (
											<Button
												key={delivery.id}
												variant="outline"
												size="sm"
												disabled={busy}
												onClick={async () => {
													const body = await call('/match', {
														expectedVersion: invoice.version,
														deliveryId: delivery.id,
													})
													if (body) {
														toast.success(t`Matched.`)
														onChanged()
														onClose()
													}
												}}
											>
												{delivery.receivedAt ? (
													<bdi dir="ltr">
														{new Intl.DateTimeFormat(i18n.locale, {
															dateStyle: 'medium',
														}).format(new Date(delivery.receivedAt))}
													</bdi>
												) : (
													<Trans>A delivery</Trans>
												)}
											</Button>
										))}
									</div>
								) : null}
							</div>
						) : null}
					</div>
				)}
				<DialogFooter className="flex-wrap gap-2">
					{invoice && canEdit ? (
						<>
							<Button
								variant="ghost"
								disabled={busy}
								onClick={() => void simple('/dismiss', invoice)}
								data-testid="invoice-dismiss"
							>
								<Trans>Dismiss</Trans>
							</Button>
							<Button
								disabled={busy}
								onClick={() => {
									onClose()
									void navigate(deliveryHref({ inboxId: id }))
								}}
								data-testid="invoice-make-delivery"
							>
								<Trans>Make a delivery from this invoice</Trans>
							</Button>
						</>
					) : (
						<Button variant="ghost" onClick={onClose}>
							<Trans>Close</Trans>
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
