import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { type OrderSendChannel, type SendOrderResult } from '@repo/inventory'
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
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useState } from 'react'
import { MessageActions } from '#app/components/inventory/credit-message-dialog.tsx'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import {
	copyToClipboard,
	EMAIL_SKIPPED_MESSAGES,
	SEND_CHANNEL_LABELS,
} from '#app/utils/inventory/order-view.ts'

/**
 * Sending an order, in two steps so nothing leaves by accident: this dialog
 * says who gets it and how, and only the Send button calls the region. The
 * result then says what happened in plain words. The region marks the order
 * sent for every channel; WhatsApp, copy and PDF are finished by the person
 * (a link, the text, the print dialog), and an email the region could not
 * send falls back to the person's own email app.
 */
export function SendOrderDialog({
	open,
	onOpenChange,
	channel,
	supplierName,
	supplierEmail,
	supplierPhone,
	itemCount,
	onSend,
	onPrint,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	channel: OrderSendChannel
	supplierName: string
	supplierEmail: string | null
	supplierPhone: string | null
	itemCount: number
	/** Saves the draft when needed, then sends; throws on a failed call. */
	onSend: (channel: OrderSendChannel) => Promise<SendOrderResult>
	/** Prints the same text the supplier receives. */
	onPrint: (text: string) => void
}) {
	const { i18n } = useLingui()
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [result, setResult] = useState<SendOrderResult | null>(null)
	const [copied, setCopied] = useState<boolean | null>(null)

	// A fresh send each time the dialog opens.
	useEffect(() => {
		if (open) {
			setPending(false)
			setError(null)
			setResult(null)
			setCopied(null)
		}
	}, [open, channel])

	async function send() {
		if (pending) return
		setPending(true)
		setError(null)
		try {
			const sent = await onSend(channel)
			setResult(sent)
			if (sent.channel === 'whatsapp' && sent.waLink) {
				window.open(sent.waLink, '_blank', 'noopener,noreferrer')
			} else if (sent.channel === 'copy') {
				setCopied(await copyToClipboard(sent.text))
			} else if (sent.channel === 'pdf') {
				onPrint(sent.text)
			}
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setPending(false)
		}
	}

	const supplier = supplierName
	const email = supplierEmail
	const channelName = i18n._(SEND_CHANNEL_LABELS[channel])

	return (
		<Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
			<DialogContent className="sm:max-w-lg" data-testid="send-dialog">
				<DialogHeader>
					<DialogTitle>
						{result ? (
							<Trans>Order sent</Trans>
						) : (
							<Trans>Send this order?</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						{result ? (
							<Trans>
								The order is marked as sent. Here is what happens next.
							</Trans>
						) : (
							<Trans>
								<span className="wrap-anywhere">{supplier}</span> will get{' '}
								<Plural
									value={itemCount}
									one="# item"
									other="# items"
								/>
								. Nothing is sent until you press Send.
							</Trans>
						)}
					</DialogDescription>
				</DialogHeader>

				{error ? (
					<Alert variant="destructive" data-testid="send-error">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				{!result ? (
					<ul className="flex flex-col gap-1 text-sm" data-testid="send-plan">
						<li>
							<span className="text-muted-foreground">
								<Trans>How</Trans>:
							</span>{' '}
							<span className="font-medium">{channelName}</span>
						</li>
						{channel === 'email' ? (
							<li className="text-muted-foreground">
								{email ? (
									<Trans>
										Sent to <bdi dir="ltr">{email}</bdi>.
									</Trans>
								) : (
									<Trans>
										This supplier has no email address yet, so your own email
										app opens with the order written out.
									</Trans>
								)}
							</li>
						) : null}
						{channel === 'whatsapp' ? (
							<li className="text-muted-foreground">
								{supplierPhone ? (
									<Trans>
										WhatsApp opens a chat with{' '}
										<bdi dir="ltr">{supplierPhone}</bdi> and the order written
										out.
									</Trans>
								) : (
									<Trans>
										WhatsApp opens with the order written out. Choose who to
										send it to.
									</Trans>
								)}
							</li>
						) : null}
						{channel === 'copy' ? (
							<li className="text-muted-foreground">
								<Trans>The order is copied so you can paste it anywhere.</Trans>
							</li>
						) : null}
						{channel === 'pdf' ? (
							<li className="text-muted-foreground">
								<Trans>
									The print window opens. Choose Save as PDF to keep a file.
								</Trans>
							</li>
						) : null}
					</ul>
				) : (
					<SendResult
						result={result}
						copied={copied}
						onPrint={() => onPrint(result.text)}
					/>
				)}

				<DialogFooter>
					{result ? (
						<Button
							type="button"
							onClick={() => onOpenChange(false)}
							data-testid="send-done"
						>
							<Trans>Done</Trans>
						</Button>
					) : (
						<>
							<Button
								type="button"
								variant="outline"
								onClick={() => onOpenChange(false)}
								disabled={pending}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								type="button"
								onClick={() => void send()}
								disabled={pending}
								data-testid="send-confirm"
							>
								{pending ? (
									<Icon name="loader" className="animate-spin" />
								) : (
									<Icon name="send" />
								)}
								{pending ? <Trans>Sending…</Trans> : <Trans>Send</Trans>}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function SendResult({
	result,
	copied,
	onPrint,
}: {
	result: SendOrderResult
	copied: boolean | null
	onPrint: () => void
}) {
	const { i18n } = useLingui()
	const email = result.order.supplierEmail
	const reason = result.emailSkipped
		? i18n._(EMAIL_SKIPPED_MESSAGES[result.emailSkipped])
		: null
	return (
		<div className="flex flex-col gap-3" data-testid="send-result">
			{result.channel === 'email' && result.emailSent ? (
				<p className="text-sm" data-testid="send-email-sent">
					{email ? (
						<Trans>
							The email was sent to <bdi dir="ltr">{email}</bdi>.
						</Trans>
					) : (
						<Trans>The email was sent.</Trans>
					)}
				</p>
			) : null}

			{result.channel === 'email' && !result.emailSent ? (
				<>
					<Alert data-testid="send-email-fallback">
						<AlertDescription>
							{reason ? <>{reason} </> : null}
							<Trans>
								Nothing was emailed. Open your own email app with the order
								written out, or copy the text.
							</Trans>
						</AlertDescription>
					</Alert>
					<MessageActions
						text={result.text}
						waLink={null}
						mailto={result.mailto}
					/>
				</>
			) : null}

			{result.channel === 'whatsapp' ? (
				<>
					<p className="text-sm">
						{result.waLink ? (
							<Trans>
								WhatsApp should have opened. If it did not, use the button
								below.
							</Trans>
						) : (
							<Trans>
								This order is too long for a WhatsApp link. Copy the text and
								paste it into the chat.
							</Trans>
						)}
					</p>
					<MessageActions
						text={result.text}
						waLink={result.waLink}
						mailto={null}
					/>
				</>
			) : null}

			{result.channel === 'copy' ? (
				<>
					<p className="text-sm" data-testid="send-copy-note">
						{copied ? (
							<Trans>The order text is copied.</Trans>
						) : (
							<Trans>
								We could not copy it for you. Select the text below and copy it.
							</Trans>
						)}
					</p>
					<Textarea
						readOnly
						value={result.text}
						rows={8}
						dir="auto"
						aria-label={i18n._(SEND_CHANNEL_LABELS.copy)}
					/>
					<MessageActions text={result.text} waLink={null} mailto={null} />
				</>
			) : null}

			{result.channel === 'pdf' ? (
				<Button
					type="button"
					variant="outline"
					className="self-start"
					onClick={onPrint}
					data-testid="send-print-again"
				>
					<Icon name="printer" />
					<Trans>Print again</Trans>
				</Button>
			) : null}
		</div>
	)
}
