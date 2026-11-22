import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Separator } from '@repo/ui/separator'
import { Switch } from '@repo/ui/switch'
import { useEffect, useId, useState } from 'react'
import { useFetcher } from 'react-router'

type Recipient = {
	id: string
	kind: 'email' | 'phone'
	address: string
	verified: boolean
	stopped: boolean
	onlineOrders: boolean
	scheduledOrders: boolean
}

type View = {
	enabled: boolean
	canEdit?: boolean
	waitingMinutes?: number | null
	defaultWaitingMinutes?: number
	largeOrder?: {
		enabled: boolean
		itemThreshold: number | null
		amountThreshold: number | null
		remindMinutes: number
		fallback: { threshold: number | null; thresholdType: string }
	}
	recipients?: Recipient[]
	maxRecipients?: number
	textsAvailable?: boolean
	ok?: boolean
	error?: string
}

const ERRORS: Record<string, ReturnType<typeof msg>> = {
	invalid_address: msg`That is not an email address or a mobile number.`,
	sms_unavailable: msg`Texts are not available for restaurants in Saudi Arabia yet. Use an email address.`,
	limit_reached: msg`A location can tell at most five people or addresses.`,
	already_added: msg`That address is already on the list.`,
	wrong_code: msg`That code is not right.`,
	expired: msg`That code has expired. Send a new one.`,
	too_many_tries: msg`Too many wrong tries. Send a new code.`,
	rate_limited: msg`Too many tries. Wait a little and try again.`,
	code_rate_limited: msg`A code was sent a moment ago. Wait a little before sending another.`,
	code_failed: msg`The code could not be sent. Check the address and send it again.`,
	code_unavailable: msg`Texts cannot be sent from here.`,
}

/**
 * Settings, Locations, Order alerts (#131, #241, #300): how long an order may stay
 * New before managers are told, "tell me about large orders" with its
 * threshold, and the people this location tells about new online orders. Staff
 * contact details only. Shown only while the organization has order alerts on.
 */
export function LocationOrderAlertsCard({
	orgSlug,
	locationId,
}: {
	orgSlug: string
	locationId: string
}) {
	const { _ } = useLingui()
	const baseId = useId()
	const url = `/${orgSlug}/settings/locations/${locationId}/order-alerts`
	const fetcher = useFetcher<View>()
	const [data, setData] = useState<View | null>(null)
	const [waiting, setWaiting] = useState('')
	const [largeOn, setLargeOn] = useState(false)
	const [items, setItems] = useState('')
	const [amount, setAmount] = useState('')
	const [remind, setRemind] = useState('60')
	const [address, setAddress] = useState('')
	const [codes, setCodes] = useState<Record<string, string>>({})

	useEffect(() => {
		if (fetcher.state === 'idle' && !fetcher.data && !data) {
			void fetcher.load(url)
		}
	}, [fetcher, url, data])
	useEffect(() => {
		if (!fetcher.data) return
		if (fetcher.data.enabled !== undefined && 'recipients' in fetcher.data) {
			setData(fetcher.data)
		} else if (fetcher.data.enabled === false) {
			setData(fetcher.data)
		}
	}, [fetcher.data])
	useEffect(() => {
		if (!data?.enabled) return
		setWaiting(data.waitingMinutes ? String(data.waitingMinutes) : '')
		setLargeOn(data.largeOrder?.enabled ?? false)
		setItems(
			data.largeOrder?.itemThreshold
				? String(data.largeOrder.itemThreshold)
				: '',
		)
		setAmount(
			data.largeOrder?.amountThreshold
				? String(data.largeOrder.amountThreshold)
				: '',
		)
		setRemind(String(data.largeOrder?.remindMinutes ?? 60))
	}, [data])

	if (!data?.enabled) return null
	const saving = fetcher.state !== 'idle'
	const canEdit = data.canEdit === true
	const recipients = data.recipients ?? []
	const failed = fetcher.state === 'idle' && fetcher.data?.ok === false
	const errorText =
		failed && fetcher.data?.error
			? ERRORS[fetcher.data.error]
				? _(ERRORS[fetcher.data.error]!)
				: _(msg`That did not work. Try again.`)
			: null
	const submit = (fields: Record<string, string>) =>
		void fetcher.submit(fields, { method: 'POST', action: url })

	return (
		<Card data-testid="location-order-alerts-card">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-base">
					<Icon name="bell" className="size-4" />
					<Trans>Order alerts</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Who is told when an online order arrives, waits too long or is
						large. Alerts never show a guest&apos;s name, phone or what they
						ordered.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				<div className="grid gap-1">
					<Label htmlFor={`${baseId}-waiting`}>
						<Trans>Tell managers when an order has been New for</Trans>
					</Label>
					<div className="flex items-center gap-2">
						<Input
							id={`${baseId}-waiting`}
							type="number"
							min={2}
							max={120}
							className="w-24"
							placeholder={String(data.defaultWaitingMinutes ?? 10)}
							value={waiting}
							disabled={!canEdit}
							onChange={(event) => setWaiting(event.target.value)}
						/>
						<span className="text-muted-foreground text-sm">
							<Trans>minutes</Trans>
						</span>
					</div>
				</div>

				<div className="space-y-3">
					<div className="flex items-center gap-3">
						<Switch
							id={`${baseId}-large`}
							checked={largeOn}
							disabled={!canEdit}
							onCheckedChange={setLargeOn}
						/>
						<Label htmlFor={`${baseId}-large`}>
							<Trans>Tell me about large orders</Trans>
						</Label>
					</div>
					{largeOn ? (
						<div className="grid gap-3 sm:grid-cols-3">
							<div className="grid gap-1">
								<Label htmlFor={`${baseId}-items`}>
									<Trans>More than this many dishes</Trans>
								</Label>
								<Input
									id={`${baseId}-items`}
									type="number"
									min={1}
									value={items}
									disabled={!canEdit}
									onChange={(event) => setItems(event.target.value)}
								/>
							</div>
							<div className="grid gap-1">
								<Label htmlFor={`${baseId}-amount`}>
									<Trans>Or over this amount</Trans>
								</Label>
								<Input
									id={`${baseId}-amount`}
									type="number"
									min={1}
									value={amount}
									disabled={!canEdit}
									onChange={(event) => setAmount(event.target.value)}
								/>
							</div>
							<div className="grid gap-1">
								<Label htmlFor={`${baseId}-remind`}>
									<Trans>
										Remind me before a scheduled one starts (minutes)
									</Trans>
								</Label>
								<Input
									id={`${baseId}-remind`}
									type="number"
									min={5}
									value={remind}
									disabled={!canEdit}
									onChange={(event) => setRemind(event.target.value)}
								/>
							</div>
							<p className="text-muted-foreground text-xs sm:col-span-3">
								<Trans>
									Leave both blank to use this location&apos;s large-order rule.
								</Trans>
							</p>
						</div>
					) : null}
				</div>

				{canEdit ? (
					<Button
						variant="outline"
						disabled={saving}
						data-testid="order-alerts-save"
						onClick={() =>
							submit({
								intent: 'save_settings',
								waitingMinutes: waiting,
								largeEnabled: String(largeOn),
								largeItems: items,
								largeAmount: amount,
								largeRemind: remind || '60',
							})
						}
					>
						<Trans>Save order alerts</Trans>
					</Button>
				) : null}
				<Separator />

				<section aria-labelledby={`${baseId}-people`} className="space-y-3">
					<h3 id={`${baseId}-people`} className="text-base font-medium">
						<Trans>Tell these people about new orders</Trans>
					</h3>
					<p className="text-muted-foreground text-sm">
						{data.textsAvailable ? (
							<Trans>
								An email address or a mobile number. Each one confirms with a
								code first, and a text can be stopped by replying STOP.
							</Trans>
						) : (
							<Trans>
								An email address. Each one confirms with a code first. Texts are
								not available for restaurants in Saudi Arabia yet.
							</Trans>
						)}
					</p>
					{recipients.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No one yet.</Trans>
						</p>
					) : (
						<ul
							className="divide-border divide-y"
							data-testid="order-alert-recipients"
						>
							{recipients.map((recipient) => (
								<li key={recipient.id} className="space-y-2 py-3">
									<div className="flex flex-wrap items-center justify-between gap-2">
										<span className="flex items-center gap-2 text-sm font-medium wrap-anywhere">
											<Icon
												name={recipient.kind === 'phone' ? 'phone' : 'mail'}
												className="size-4 shrink-0"
											/>
											<bdi dir="ltr">{recipient.address}</bdi>
											{recipient.stopped ? (
												<Badge variant="outline">
													<Trans>Stopped</Trans>
												</Badge>
											) : recipient.verified ? (
												<Badge variant="secondary">
													<Trans>Confirmed</Trans>
												</Badge>
											) : (
												<Badge variant="outline">
													<Trans>Waiting for the code</Trans>
												</Badge>
											)}
										</span>
										{canEdit ? (
											<Button
												variant="ghost"
												size="sm"
												disabled={saving}
												data-testid="order-alert-remove"
												onClick={() =>
													submit({
														intent: 'remove',
														recipientId: recipient.id,
													})
												}
											>
												<Trans>Remove</Trans>
											</Button>
										) : null}
									</div>
									{canEdit && !recipient.verified ? (
										<div className="flex flex-wrap items-end gap-2">
											<div className="grid gap-1">
												<Label htmlFor={`${baseId}-code-${recipient.id}`}>
													<Trans>Code</Trans>
												</Label>
												<Input
													id={`${baseId}-code-${recipient.id}`}
													inputMode="numeric"
													autoComplete="one-time-code"
													className="w-32"
													value={codes[recipient.id] ?? ''}
													onChange={(event) =>
														setCodes((current) => ({
															...current,
															[recipient.id]: event.target.value,
														}))
													}
												/>
											</div>
											<Button
												size="sm"
												disabled={saving || !(codes[recipient.id] ?? '').trim()}
												onClick={() =>
													submit({
														intent: 'confirm',
														recipientId: recipient.id,
														code: codes[recipient.id] ?? '',
													})
												}
											>
												<Trans>Confirm</Trans>
											</Button>
											<Button
												size="sm"
												variant="outline"
												disabled={saving}
												onClick={() =>
													submit({
														intent: 'send_code',
														recipientId: recipient.id,
													})
												}
											>
												<Trans>Send the code again</Trans>
											</Button>
										</div>
									) : null}
									{canEdit && recipient.verified ? (
										<div className="flex flex-wrap gap-6">
											<div className="flex items-center gap-2">
												<Switch
													id={`${baseId}-online-${recipient.id}`}
													checked={recipient.onlineOrders}
													disabled={saving}
													onCheckedChange={(checked) =>
														submit({
															intent: 'switches',
															recipientId: recipient.id,
															onlineOrders: String(checked),
															scheduledOrders: String(
																recipient.scheduledOrders,
															),
														})
													}
												/>
												<Label htmlFor={`${baseId}-online-${recipient.id}`}>
													<Trans>Online orders</Trans>
												</Label>
											</div>
											<div className="flex items-center gap-2">
												<Switch
													id={`${baseId}-scheduled-${recipient.id}`}
													checked={recipient.scheduledOrders}
													disabled={saving}
													onCheckedChange={(checked) =>
														submit({
															intent: 'switches',
															recipientId: recipient.id,
															onlineOrders: String(recipient.onlineOrders),
															scheduledOrders: String(checked),
														})
													}
												/>
												<Label htmlFor={`${baseId}-scheduled-${recipient.id}`}>
													<Trans>Scheduled orders</Trans>
												</Label>
											</div>
										</div>
									) : null}
								</li>
							))}
						</ul>
					)}
					{canEdit && recipients.length < (data.maxRecipients ?? 5) ? (
						<div className="flex flex-wrap items-end gap-2">
							<div className="grid gap-1">
								<Label htmlFor={`${baseId}-address`}>
									<Trans>Email or mobile number</Trans>
								</Label>
								<Input
									id={`${baseId}-address`}
									className="w-72"
									value={address}
									onChange={(event) => setAddress(event.target.value)}
								/>
							</div>
							<Button
								disabled={saving || address.trim().length < 3}
								data-testid="order-alert-add"
								onClick={() => {
									submit({ intent: 'add_recipient', address })
									setAddress('')
								}}
							>
								<Trans>Add and send a code</Trans>
							</Button>
						</div>
					) : null}
					{errorText ? (
						<p role="alert" className="text-destructive text-sm">
							{errorText}
						</p>
					) : null}
				</section>
			</CardContent>
		</Card>
	)
}
