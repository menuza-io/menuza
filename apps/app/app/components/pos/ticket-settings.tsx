import { type I18n } from '@lingui/core'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	DEFAULT_APP_CAPTION,
	DEFAULT_REVIEW_CAPTION,
	planReceiptExtras,
	RECEIPT_CAPTION_MAX_LENGTH,
	type ReceiptExtrasConfig,
	type ReceiptTargets,
} from '@repo/common/receipt-extras'
import {
	compactTickets,
	fieldClasses,
	fieldStyle,
	type KITCHEN_PRINT_TIMINGS,
	type RECEIPT_PRINT_TIMINGS,
	resolveTickets,
	TICKET_FIELDS,
	TICKET_TYPES,
	TICKET_TYPES_PRINTED_TODAY,
	type TicketsConfig,
	type TicketType,
} from '@repo/common/ticket-config'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Input } from '@repo/ui/input'
import { Switch } from '@repo/ui/switch'
import { useState } from 'react'
import { useFetcher } from 'react-router'

export type TicketSettingsLocation = {
	id: string
	name: string
	tickets: TicketsConfig
	/** What the receipt codes open at this location (#263); null where there is no target. */
	targets?: ReceiptTargets
	/** The organization logo's address, or null when none is set. */
	logoUrl?: string | null
}

export function ticketTypeLabel(_: I18n['_'], type: TicketType) {
	return {
		receipt: _(t`Guest receipt`),
		kitchen: _(t`Kitchen station ticket`),
		assembly: _(t`Assembly (expo) ticket`),
		label: _(t`Item label`),
	}[type]
}

/** The words an owner sees for each printable field. */
export function ticketFieldLabel(_: I18n['_'], type: TicketType, key: string) {
	const common: Record<string, string> = {
		dateTime: _(t`Date and time`),
		orderNumber: _(t`Order number`),
		orderType: _(t`Order type, table and time`),
		itemOptions: _(t`Item options`),
		itemNotes: _(t`Item notes`),
		items: _(t`Items`),
		ticketTitle: _(t`Ticket title`),
	}
	const receipt: Record<string, string> = {
		businessName: _(t`Business name`),
		vatNumber: _(t`VAT number`),
		invoiceTitle: _(t`“Simplified tax invoice” title`),
		invoiceNumber: _(t`Invoice number`),
		guestContact: _(t`Guest name and masked phone (online orders)`),
		servedBy: _(t`Served by`),
		subtotal: _(t`Subtotal`),
		discounts: _(t`Discounts`),
		tax: _(t`Tax`),
		tip: _(t`Tip`),
		total: _(t`Total`),
		payments: _(t`Payments, or paid status`),
		change: _(t`Change`),
		refunds: _(t`Refunds`),
		balanceDue: _(t`Balance due`),
		qrCode: _(t`Tax invoice QR code`),
		thankYou: _(t`“Thank you” line`),
	}
	const kitchen: Record<string, string> = {
		utensils: _(t`Utensils answer`),
		largeOrder: _(t`Large-order note`),
		courses: _(t`Course headings`),
		highlights: _(t`Allergy and attention marks`),
	}
	const assembly: Record<string, string> = {
		guestName: _(t`Guest name`),
		paymentStatus: _(t`Paid or unpaid`),
	}
	const label: Record<string, string> = {
		itemName: _(t`Item name`),
		count: _(t`Item count (1 of 3)`),
	}
	const byType = { receipt, kitchen, assembly, label }[type]
	return byType[key] ?? common[key] ?? key
}

const LOCKED_REASON = {
	// The reason is the same wherever it is shown.
	text: (_: I18n['_']) => _(t`Always printed`),
}

type PreviewKind = 'order' | 'changes' | 'cancelled'

/**
 * A sample ticket drawn from the same field list and the same rules the till
 * prints with (`@repo/common/ticket-config`), so a field hidden here is hidden
 * on the printed ticket.
 */
export function TicketPreview({
	type,
	config,
	kind = 'order',
	targets,
	logoUrl,
}: {
	type: TicketType
	config: TicketsConfig
	kind?: PreviewKind
	targets?: ReceiptTargets
	logoUrl?: string | null
}) {
	const { _ } = useLingui()
	const typeName = ticketTypeLabel(_, type)
	const tickets = resolveTickets(config)
	const style = (key: string) => {
		const s = fieldStyle(tickets, type, key)
		return { show: s.show, cls: fieldClasses(s) }
	}
	const lines = [
		{
			qty: 2,
			name: _(t`Burger`),
			variant: _(t`Large`),
			options: [_(t`Cheese`)],
			note: _(t`No onions`),
			cents: 2300,
			served: tickets.strikeCompleted,
		},
		{
			qty: 1,
			name: _(t`Fries`),
			variant: null,
			options: [],
			note: null,
			cents: 400,
			served: false,
		},
	]
	const shown =
		type === 'kitchen' && kind === 'changes'
			? [
					{
						qty: 1,
						name: _(t`Cheesecake`),
						variant: null,
						options: [],
						note: null,
						cents: 0,
						served: false,
					},
				]
			: lines
	const slip = type === 'kitchen' && kind === 'cancelled'
	// The same decision the till and a cloud printer make (#263).
	const extras =
		type === 'receipt'
			? planReceiptExtras({
					config: tickets.extras,
					targets: targets ?? { reviewUrl: null, appUrl: null },
					logoUrl: logoUrl ?? null,
					width: 80,
					fiscalQr: true,
				})
			: null
	const body = TICKET_FIELDS[type].map((field) => {
		const s = style(field.key)
		if (!s.show) return null
		const center = (node: React.ReactNode, extra = '') => (
			<div key={field.key} className={cn('text-center', extra, s.cls)}>
				{node}
			</div>
		)
		switch (`${type}:${field.key}`) {
			case 'receipt:businessName':
				return center(_(t`Cafe Bloom`), 'font-semibold')
			case 'receipt:vatNumber':
				return center(_(t`VAT No. 300000000000003`))
			case 'receipt:invoiceTitle':
				return center(_(t`Simplified tax invoice`), 'font-semibold')
			case 'receipt:invoiceNumber':
				return center(_(t`Invoice 7`))
			case 'receipt:guestContact':
				return center(`${_(t`Jordan`)} · •••• 0111`)
			case 'receipt:servedBy':
				return center(_(t`Served by Sam L.`))
		}
		switch (field.key) {
			case 'ticketTitle':
				return center(
					slip
						? _(t`CANCELLED`)
						: kind === 'changes'
							? _(t`Kitchen ticket: changes only`)
							: type === 'kitchen'
								? _(t`Kitchen ticket`)
								: _(t`Assembly ticket`),
					'font-semibold',
				)
			case 'dateTime':
				return center(_(t`18 Nov 2026, 14:02`))
			case 'orderNumber':
				return center('#T1-0042', 'my-1 text-sm font-semibold')
			case 'orderType':
				return center(_(t`Dine in · Table 4`))
			case 'guestName':
				return center(_(t`Jordan`))
			case 'utensils':
				return center(_(t`Utensils: yes`), 'font-semibold')
			case 'largeOrder':
				return center(_(t`Large order +10 min`))
			case 'courses':
				return (
					<div key={field.key} className={cn('mt-1 font-semibold', s.cls)}>
						{_(t`Mains`)}
					</div>
				)
			case 'items':
			case 'itemName':
				return (
					<div key={field.key} className="border-y border-dashed py-1">
						{shown.map((line) => (
							<div
								key={line.name}
								className={cn('mb-1', s.cls, line.served && 'line-through')}
							>
								<div className="flex justify-between gap-2">
									<span>
										{line.qty}× {line.name}
										{line.variant ? ` (${line.variant})` : ''}
									</span>
									{type === 'receipt' && line.cents > 0 ? (
										<span>${(line.cents / 100).toFixed(2)}</span>
									) : null}
								</div>
								{style('itemOptions').show
									? line.options.map((option) => (
											<div
												key={option}
												className={cn('ps-3', style('itemOptions').cls)}
											>
												+ {option}
											</div>
										))
									: null}
								{line.note && style('itemNotes').show ? (
									<div className={cn('ps-3 italic', style('itemNotes').cls)}>
										“{line.note}”
									</div>
								) : null}
							</div>
						))}
						{type === 'kitchen' && kind === 'changes' ? (
							<div className="mt-1">
								<div className="font-semibold">{_(t`Taken off`)}</div>
								<div className="line-through">1× {_(t`Salad`)}</div>
							</div>
						) : null}
					</div>
				)
			case 'itemOptions':
			case 'itemNotes':
				return null
			case 'subtotal':
				return row(field.key, _(t`Subtotal`), '$27.00', s.cls)
			case 'discounts':
				return row(field.key, _(t`Staff meal`), '-$2.00', s.cls)
			case 'tax':
				return row(field.key, _(t`Tax (10%)`), '$2.50', s.cls)
			case 'tip':
				return row(field.key, _(t`Tip`), '$3.00', s.cls)
			case 'total':
				return row(field.key, _(t`Total`), '$30.50', cn('font-semibold', s.cls))
			case 'payments':
				return row(field.key, _(t`Paid · Cash`), '$40.00', s.cls)
			case 'change':
				return row(field.key, _(t`Change`), '$9.50', s.cls)
			case 'refunds':
				return row(field.key, _(t`Refunded · Cash`), '-$5.00', s.cls)
			case 'balanceDue':
				return row(field.key, _(t`Balance due`), '$4.00', s.cls)
			case 'qrCode':
				return (
					<div
						key={field.key}
						className={cn(
							'border-foreground mx-auto mt-2 flex size-16 items-center justify-center border text-[10px]',
							s.cls,
						)}
					>
						QR
					</div>
				)
			case 'thankYou':
				return center(_(t`Thank you!`), 'mt-2')
			case 'paymentStatus':
				return center(_(t`Paid`))
			case 'highlights':
				return center(`⚠ ${_(t`Allergy`)}`, 'text-[10px]')
			case 'count':
				return center(_(t`1 of 3`))
			default:
				return null
		}
	})
	return (
		<div
			role="img"
			aria-label={_(t`Preview of the ${typeName}`)}
			data-ticket-preview={type}
			className="bg-card text-foreground mx-auto w-full max-w-[18rem] space-y-0.5 rounded-sm border p-3 font-mono text-[11px] leading-snug shadow-sm"
		>
			{extras?.logo ? (
				<div
					data-preview-logo
					className="border-foreground mx-auto mb-1 flex h-8 w-20 items-center justify-center border text-[10px]"
				>
					{_(t`Logo`)}
				</div>
			) : null}
			{body}
			{extras?.codes.map((code) => (
				<div
					key={code.kind}
					data-preview-code={code.kind}
					className="mt-2 text-center"
				>
					<div className="border-foreground mx-auto flex size-10 items-center justify-center border text-[8px]">
						QR
					</div>
					<div className="text-[10px]">{code.caption}</div>
				</div>
			))}
		</div>
	)
}

function row(key: string, label: string, value: string, cls: string) {
	return (
		<div key={key} className={cn('flex justify-between gap-2', cls)}>
			<span>{label}</span>
			<span>{value}</span>
		</div>
	)
}

/**
 * Logo, review code and app code on the guest receipt (#263). A code is
 * offered only when its target exists, and the screen says why when it does not.
 */
function ReceiptExtrasControls({
	extras,
	targets,
	hasLogo,
	disabled,
	onChange,
}: {
	extras: ReceiptExtrasConfig
	targets?: ReceiptTargets
	hasLogo: boolean
	disabled: boolean
	onChange: (patch: Partial<ReceiptExtrasConfig>) => void
}) {
	const { _ } = useLingui()
	return (
		<div className="space-y-1" data-testid="receipt-extras">
			<h5 className="text-sm font-semibold">
				<Trans>Logo and codes on the receipt</Trans>
			</h5>
			<p className="text-muted-foreground text-xs leading-relaxed">
				<Trans>
					Codes print small below the tax invoice code, with a caption. On a
					narrow roll that has no room for both, they are left off and the tax
					invoice code is kept. Refund and void slips never carry them.
				</Trans>
			</p>
			<div className="divide-y">
				<Option
					label={_(t`Logo at the top`)}
					hint={
						hasLogo ? (
							<Trans>
								Printed in one colour and kept short so it suits thermal paper.
							</Trans>
						) : (
							<Trans>Add a site icon in Website settings to use this.</Trans>
						)
					}
					checked={extras.logo}
					disabled={disabled || !hasLogo}
					onChange={(on) => onChange({ logo: on })}
				/>
				<CodeOption
					label={_(t`Review code`)}
					hint={
						targets?.reviewUrl ? (
							<Trans>Opens this location’s Google review page.</Trans>
						) : (
							<Trans>
								Add the location’s Google review link in Settings, Locations to
								use this.
							</Trans>
						)
					}
					available={Boolean(targets?.reviewUrl)}
					setting={extras.review}
					fallback={DEFAULT_REVIEW_CAPTION}
					captionLabel={_(t`Review code caption`)}
					disabled={disabled}
					onChange={(review) => onChange({ review })}
				/>
				<CodeOption
					label={_(t`App or rewards code`)}
					hint={
						targets?.appUrl ? (
							<Trans>
								Opens your app, or your rewards page when the app is not
								installed.
							</Trans>
						) : (
							<Trans>
								Needs a live app or the rewards program to have somewhere to
								send guests.
							</Trans>
						)
					}
					available={Boolean(targets?.appUrl)}
					setting={extras.app}
					fallback={DEFAULT_APP_CAPTION}
					captionLabel={_(t`App code caption`)}
					disabled={disabled}
					onChange={(app) => onChange({ app })}
				/>
			</div>
		</div>
	)
}

function CodeOption({
	label,
	hint,
	available,
	setting,
	fallback,
	captionLabel,
	disabled,
	onChange,
}: {
	label: string
	hint: React.ReactNode
	available: boolean
	setting: ReceiptExtrasConfig['review']
	fallback: string
	captionLabel: string
	disabled: boolean
	onChange: (next: ReceiptExtrasConfig['review']) => void
}) {
	// What is typed stays as typed (a trailing space included); the stored value
	// is cleaned when it is read back.
	const [typed, setTyped] = useState(setting.caption ?? '')
	return (
		<div>
			<Option
				label={label}
				hint={hint}
				checked={setting.show && available}
				disabled={disabled || !available}
				onChange={(on) => onChange({ ...setting, show: on })}
			/>
			{setting.show && available ? (
				<Input
					aria-label={captionLabel}
					value={typed}
					placeholder={fallback}
					maxLength={RECEIPT_CAPTION_MAX_LENGTH}
					disabled={disabled}
					className="mb-2 h-11 md:h-8"
					onChange={(event) => {
						setTyped(event.target.value)
						onChange({ ...setting, caption: event.target.value || null })
					}}
				/>
			) : null}
		</div>
	)
}

function Option({
	label,
	hint,
	checked,
	onChange,
	disabled,
}: {
	label: React.ReactNode
	hint?: React.ReactNode
	checked: boolean
	onChange: (on: boolean) => void
	disabled: boolean
}) {
	return (
		<div className="flex min-w-0 items-start justify-between gap-3 py-2">
			<div className="min-w-0">
				<p className="text-sm font-medium">{label}</p>
				{hint ? (
					<p className="text-muted-foreground text-xs leading-relaxed">
						{hint}
					</p>
				) : null}
			</div>
			<Switch
				checked={checked}
				disabled={disabled}
				aria-label={typeof label === 'string' ? label : undefined}
				onCheckedChange={onChange}
			/>
		</div>
	)
}

/**
 * Settings, Terminals: what prints on each ticket type, and when, per location
 * (#363), with a live preview drawn from the same rules the till prints with.
 */
export function TicketSettings({
	orgSlug,
	canWrite,
	locations,
}: {
	orgSlug: string
	canWrite: boolean
	locations: TicketSettingsLocation[]
}) {
	const { _ } = useLingui()
	if (locations.length === 0) return null
	return (
		<Card
			role="region"
			aria-label={_(t`Tickets`)}
			className="min-w-0 shadow-none"
		>
			<CardHeader className="gap-2 border-b">
				<CardTitle as="h3">
					<Trans>Tickets</Trans>
				</CardTitle>
				<CardDescription className="max-w-prose leading-relaxed">
					<Trans>
						Choose what prints on each ticket, which lines are bold or larger,
						and when tickets print. What you set here is what the till prints;
						nothing set prints what it always has.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="divide-y">
				{locations.map((location) => (
					<LocationTickets
						key={location.id}
						orgSlug={orgSlug}
						canWrite={canWrite}
						location={location}
						showName={locations.length > 1}
					/>
				))}
			</CardContent>
		</Card>
	)
}

function LocationTickets({
	orgSlug,
	canWrite,
	location,
	showName,
}: {
	orgSlug: string
	canWrite: boolean
	location: TicketSettingsLocation
	showName: boolean
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{
		ok: boolean
		error: string | null
		tickets: TicketsConfig | null
	}>()
	const saved =
		fetcher.data?.ok && fetcher.data.tickets
			? fetcher.data.tickets
			: location.tickets
	const [draft, setDraft] = useState<TicketsConfig>(saved)
	const [type, setType] = useState<TicketType>('receipt')
	const [kind, setKind] = useState<PreviewKind>('order')
	const resolved = resolveTickets(draft)
	const dirty =
		JSON.stringify(compactTickets(draft)) !==
		JSON.stringify(compactTickets(saved))
	const busy = fetcher.state !== 'idle'
	const printed = TICKET_TYPES_PRINTED_TODAY.includes(type)

	const setField = (
		key: string,
		patch: { show?: boolean; bold?: boolean; large?: boolean },
	) =>
		setDraft((current) => ({
			...current,
			[type]: {
				...current[type],
				[key]: { ...current[type]?.[key], ...patch },
			},
		}))
	const setOption = (patch: Partial<TicketsConfig>) =>
		setDraft((current) => ({ ...current, ...patch }))
	const setExtras = (patch: Partial<ReceiptExtrasConfig>) =>
		setDraft((current) => ({
			...current,
			extras: { ...resolveTickets(current).extras, ...patch },
		}))
	const previewKinds: PreviewKind[] = [
		'order',
		...(resolved.changesOnly ? (['changes'] as const) : []),
		...(resolved.cancellationSlip ? (['cancelled'] as const) : []),
	]
	const previewKind =
		type === 'kitchen' && previewKinds.includes(kind) ? kind : 'order'
	const kindLabel = (k: PreviewKind) =>
		k === 'order'
			? _(t`Order`)
			: k === 'changes'
				? _(t`Changes only`)
				: _(t`Cancellation slip`)

	const save = () => {
		void fetcher.submit(
			{
				locationId: location.id,
				tickets: JSON.stringify(compactTickets(draft)),
			},
			{
				method: 'POST',
				action: `/${orgSlug}/settings/terminals/ticket-settings`,
			},
		)
	}

	return (
		<section
			aria-label={showName ? location.name : _(t`Ticket settings`)}
			className="grid min-w-0 gap-6 py-5 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_18rem]"
		>
			<div className="min-w-0 space-y-4">
				{showName ? (
					<h4 className="text-base font-semibold wrap-anywhere">
						{location.name}
					</h4>
				) : null}
				<div
					role="group"
					aria-label={_(t`Ticket type`)}
					className="flex flex-wrap gap-2"
				>
					{TICKET_TYPES.map((candidate) => (
						<Button
							key={candidate}
							variant={candidate === type ? 'secondary' : 'outline'}
							className="h-11 md:h-8"
							aria-pressed={candidate === type}
							onClick={() => setType(candidate)}
						>
							{ticketTypeLabel(_, candidate)}
						</Button>
					))}
				</div>
				{!printed ? (
					<p className="bg-muted/50 text-muted-foreground rounded-lg p-3 text-sm">
						<Trans>
							Station does not print this ticket yet: it needs a cloud-connected
							printer. Your choices are saved and the preview shows them, and
							they apply as soon as it does.
						</Trans>
					</p>
				) : null}
				{type === 'kitchen' ? (
					<p className="text-muted-foreground text-sm">
						<Trans>
							Whether the ticket shows paid or unpaid, modifier group names and
							an order-type colour is set in Kitchen setup on Station.
						</Trans>
					</p>
				) : null}
				<table className="w-full text-sm">
					<thead>
						<tr className="text-muted-foreground text-start text-xs">
							<th scope="col" className="py-1 text-start font-medium">
								<Trans>Field</Trans>
							</th>
							<th scope="col" className="w-14 py-1 text-center font-medium">
								<Trans>Show</Trans>
							</th>
							<th scope="col" className="w-14 py-1 text-center font-medium">
								<Trans>Bold</Trans>
							</th>
							<th scope="col" className="w-14 py-1 text-center font-medium">
								<Trans>Larger</Trans>
							</th>
						</tr>
					</thead>
					<tbody className="divide-y">
						{TICKET_FIELDS[type].map((field) => {
							const s = fieldStyle(resolved, type, field.key)
							const label = ticketFieldLabel(_, type, field.key)
							return (
								<tr key={field.key}>
									<th scope="row" className="py-1.5 text-start font-normal">
										{label}
										{field.locked ? (
											<Badge variant="outline" className="ms-2">
												{LOCKED_REASON.text(_)}
											</Badge>
										) : null}
									</th>
									<td className="text-center">
										<Switch
											checked={s.show}
											disabled={!canWrite || field.locked}
											aria-label={_(t`Show ${label}`)}
											onCheckedChange={(on) =>
												setField(field.key, { show: on })
											}
										/>
									</td>
									<td className="text-center">
										<Switch
											checked={s.bold}
											disabled={!canWrite || !s.show}
											aria-label={_(t`Bold ${label}`)}
											onCheckedChange={(on) =>
												setField(field.key, { bold: on })
											}
										/>
									</td>
									<td className="text-center">
										<Switch
											checked={s.large}
											disabled={!canWrite || !s.show}
											aria-label={_(t`Larger ${label}`)}
											onCheckedChange={(on) =>
												setField(field.key, { large: on })
											}
										/>
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
				{type === 'receipt' ? (
					<ReceiptExtrasControls
						extras={resolved.extras}
						targets={location.targets}
						hasLogo={Boolean(location.logoUrl)}
						disabled={!canWrite}
						onChange={setExtras}
					/>
				) : null}
				<div className="space-y-1">
					<h5 className="text-sm font-semibold">
						<Trans>When tickets print</Trans>
					</h5>
					<div className="flex flex-wrap items-center justify-between gap-3 py-1">
						<span className="text-sm">
							<Trans>Guest receipt</Trans>
						</span>
						<Select
							value={resolved.when.receipt}
							onValueChange={(next) =>
								setOption({
									when: {
										...draft.when,
										receipt: next as (typeof RECEIPT_PRINT_TIMINGS)[number],
									},
								})
							}
							disabled={!canWrite}
						>
							<SelectTrigger
								className="h-11 w-fit md:h-8"
								aria-label={_(t`When the guest receipt prints`)}
							>
								<SelectValue>
									{resolved.when.receipt === 'on_close'
										? _(t`When a tab closes`)
										: _(t`When someone taps Print`)}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="manual">
									<Trans>When someone taps Print</Trans>
								</SelectItem>
								<SelectItem value="on_close">
									<Trans>When a tab closes</Trans>
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-wrap items-center justify-between gap-3 py-1">
						<span className="text-sm">
							<Trans>Kitchen ticket (online orders)</Trans>
						</span>
						<Select
							value={resolved.when.kitchen}
							onValueChange={(next) =>
								setOption({
									when: {
										...draft.when,
										kitchen: next as (typeof KITCHEN_PRINT_TIMINGS)[number],
									},
								})
							}
							disabled={!canWrite}
						>
							<SelectTrigger
								className="h-11 w-fit md:h-8"
								aria-label={_(t`When the kitchen ticket prints`)}
							>
								<SelectValue>
									{resolved.when.kitchen === 'on_acceptance'
										? _(t`When the order is accepted`)
										: resolved.when.kitchen === 'when_ready'
											? _(t`When the order is ready`)
											: _(t`When someone taps Print`)}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="manual">
									<Trans>When someone taps Print</Trans>
								</SelectItem>
								<SelectItem value="on_acceptance">
									<Trans>When the order is accepted</Trans>
								</SelectItem>
								<SelectItem value="when_ready">
									<Trans>When the order is ready</Trans>
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>
				<div className="divide-y">
					<Option
						label={_(t`Leave dine-in orders out of printing`)}
						hint={
							<Trans>
								Kitchen tickets and automatic prints skip dine-in orders. A
								guest can still ask for a receipt.
							</Trans>
						}
						checked={resolved.excludeDineIn}
						disabled={!canWrite}
						onChange={(on) => setOption({ excludeDineIn: on })}
					/>
					<Option
						label={_(t`Print only what changed on an adjusted order`)}
						hint={
							<Trans>
								A tab sent to the kitchen again prints just the new round and
								what was taken off.
							</Trans>
						}
						checked={resolved.changesOnly}
						disabled={!canWrite}
						onChange={(on) => setOption({ changesOnly: on })}
					/>
					<Option
						label={_(t`Strike through dishes already served`)}
						hint={<Trans>On a reprint, served dishes are crossed out.</Trans>}
						checked={resolved.strikeCompleted}
						disabled={!canWrite}
						onChange={(on) => setOption({ strikeCompleted: on })}
					/>
					<Option
						label={_(t`Print a cancellation slip when an order is cancelled`)}
						hint={
							<Trans>
								The kitchen gets a slip that says CANCELLED, so it stops making
								the order.
							</Trans>
						}
						checked={resolved.cancellationSlip}
						disabled={!canWrite}
						onChange={(on) => setOption({ cancellationSlip: on })}
					/>
				</div>
				{canWrite ? (
					<div className="flex flex-wrap items-center gap-3">
						<Button onClick={save} disabled={!dirty || busy}>
							<Trans>Save ticket settings</Trans>
						</Button>
						{dirty ? (
							<Button
								variant="ghost"
								onClick={() => setDraft(saved)}
								disabled={busy}
							>
								<Trans>Discard changes</Trans>
							</Button>
						) : null}
						{fetcher.data?.ok && !dirty ? (
							<span role="status" className="text-muted-foreground text-sm">
								<Trans>
									Saved. Terminals pick it up with the next menu update.
								</Trans>
							</span>
						) : null}
						{fetcher.data && !fetcher.data.ok ? (
							<span role="alert" className="text-destructive text-sm">
								<Trans>Could not save. Try again.</Trans>
							</span>
						) : null}
					</div>
				) : null}
			</div>
			<div className="min-w-0 space-y-3">
				<h5 className="text-sm font-semibold">
					<Trans>Preview</Trans>
				</h5>
				{type === 'kitchen' && previewKinds.length > 1 ? (
					<div
						role="group"
						aria-label={_(t`Preview of`)}
						className="flex flex-wrap gap-2"
					>
						{previewKinds.map((candidate) => (
							<Button
								key={candidate}
								variant={candidate === previewKind ? 'secondary' : 'outline'}
								className="h-9"
								aria-pressed={candidate === previewKind}
								onClick={() => setKind(candidate)}
							>
								{kindLabel(candidate)}
							</Button>
						))}
					</div>
				) : null}
				<TicketPreview
					type={type}
					config={draft}
					kind={previewKind}
					targets={location.targets}
					logoUrl={location.logoUrl}
				/>
			</div>
		</section>
	)
}
