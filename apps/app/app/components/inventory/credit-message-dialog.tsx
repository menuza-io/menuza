import { Trans, useLingui } from '@lingui/react/macro'
import { type CreditMessage, creditMessageSchema } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { copyToClipboard, textLocale } from '#app/utils/inventory/order-view.ts'

/** Copy, WhatsApp and email buttons for a drafted message (an order or a credit request). */
export function MessageActions({
	text,
	waLink,
	mailto,
}: {
	text: string
	waLink: string | null
	mailto: string | null
}) {
	const { t } = useLingui()
	return (
		<div className="flex flex-wrap gap-2" data-testid="message-actions">
			<Button
				type="button"
				variant="outline"
				onClick={async () => {
					if (await copyToClipboard(text)) toast.success(t`Copied.`)
					else toast.error(t`Could not copy. Select the text and copy it.`)
				}}
				data-testid="message-copy"
			>
				<Icon name="copy" />
				<Trans>Copy the text</Trans>
			</Button>
			{waLink ? (
				<Button
					variant="outline"
					render={<a href={waLink} target="_blank" rel="noopener noreferrer" />}
					data-testid="message-whatsapp"
				>
					<Icon name="message-circle" />
					<Trans>Open WhatsApp</Trans>
				</Button>
			) : null}
			{mailto ? (
				<Button
					variant="outline"
					render={<a href={mailto} />}
					data-testid="message-mailto"
				>
					<Icon name="mail" />
					<Trans>Open email</Trans>
				</Button>
			) : null}
		</div>
	)
}

/**
 * "Ask for credit": the message to the supplier about what came short or did
 * not arrive on a delivery received against an order. The region drafts the
 * text (in the language you are using); you read it, then copy it or open it
 * in WhatsApp or your email. Nothing is sent from here.
 */
export function CreditMessageDialog({
	open,
	onOpenChange,
	deliveryId,
	canSeeCost,
	currency,
	title,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	deliveryId: string
	canSeeCost: boolean
	currency: string
	title?: string
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const [state, setState] = useState<{
		message: CreditMessage | null
		error: Error | null
		loading: boolean
	}>({ message: null, error: null, loading: false })

	useEffect(() => {
		if (!open) return
		let live = true
		setState({ message: null, error: null, loading: true })
		request(`/deliveries/${encodeURIComponent(deliveryId)}/credit-message`, {
			method: 'POST',
			body: JSON.stringify({ locale: textLocale(i18n.locale) }),
		}).then(
			(body) => {
				if (!live) return
				const parsed = creditMessageSchema.safeParse(body)
				setState(
					parsed.success
						? { message: parsed.data, error: null, loading: false }
						: {
								message: null,
								error: new Error('malformed_response'),
								loading: false,
							},
				)
			},
			(error: unknown) => {
				if (!live) return
				setState({
					message: null,
					error: error instanceof Error ? error : new Error('failed'),
					loading: false,
				})
			},
		)
		return () => {
			live = false
		}
	}, [open, deliveryId, request, i18n.locale])

	const { message } = state
	const worth =
		canSeeCost && message?.totalMinor !== undefined && message.totalMinor > 0
			? formatMoney(
					message.totalMinor,
					message.currency ?? currency,
					i18n.locale,
				)
			: null

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg" data-testid="credit-dialog">
				<DialogHeader>
					<DialogTitle>{title ?? <Trans>Ask for credit</Trans>}</DialogTitle>
					<DialogDescription>
						<Trans>
							Read the message, then copy it or open it in WhatsApp or your
							email. Nothing is sent from here.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{state.loading ? (
					<div role="status" className="flex flex-col gap-2">
						<span className="sr-only">
							<Trans>Writing the message</Trans>
						</span>
						<Skeleton className="h-6 w-1/2" />
						<Skeleton className="h-32 w-full" />
					</div>
				) : state.error ? (
					<Alert variant="destructive" data-testid="credit-error">
						<AlertDescription>
							{i18n._(inventoryErrorMessage(state.error))}
						</AlertDescription>
					</Alert>
				) : message && message.text === null ? (
					<p className="text-sm" data-testid="credit-nothing">
						<Trans>
							Nothing is short on this delivery, so there is nothing to ask for.
						</Trans>
					</p>
				) : message?.text ? (
					<div className="flex flex-col gap-3">
						{worth ? (
							<p className="text-muted-foreground text-sm">
								<Trans>
									What came short is worth about{' '}
									<bdi dir="ltr" className="tabular-nums">
										{worth}
									</bdi>
									.
								</Trans>
							</p>
						) : null}
						<Textarea
							readOnly
							value={message.text}
							rows={10}
							aria-label={t`Message to the supplier`}
							dir="auto"
							data-testid="credit-text"
						/>
						<MessageActions
							text={message.text}
							waLink={message.waLink}
							mailto={message.mailto}
						/>
					</div>
				) : null}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						data-testid="credit-close"
					>
						<Trans>Done</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
