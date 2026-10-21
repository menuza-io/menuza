import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { ORDER_STATUS_LABELS } from '#app/utils/orders/status-label.ts'

type Tone =
	'neutral' | 'primary' | 'success' | 'warning' | 'destructive' | 'muted'

const TONES: Record<Tone, { dot: string; text: string }> = {
	neutral: { dot: 'bg-muted-foreground/50', text: 'text-foreground' },
	primary: { dot: 'bg-primary', text: 'text-foreground' },
	success: { dot: 'bg-success', text: 'text-foreground' },
	warning: { dot: 'bg-warning', text: 'text-warning' },
	destructive: { dot: 'bg-destructive', text: 'text-destructive' },
	muted: { dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
}

const ORDER_TONES: Record<string, Tone> = {
	accepted: 'primary',
	preparing: 'warning',
	ready: 'success',
	completed: 'muted',
	cancelled: 'muted',
	expired: 'muted',
	payment_review: 'destructive',
}

export const PAYMENT_STATUS_LABELS: Record<string, MessageDescriptor> = {
	unpaid: msg`Unpaid`,
	pending: msg`Awaiting payment`,
	paid: msg`Paid`,
	failed: msg`Payment failed`,
	expired: msg`Payment expired`,
	review: msg`Payment under review`,
}

const PAYMENT_TONES: Record<string, Tone> = {
	unpaid: 'neutral',
	pending: 'warning',
	paid: 'success',
	failed: 'destructive',
	expired: 'muted',
	review: 'destructive',
}

function Dot({
	tone,
	label,
	className,
	testId,
}: {
	tone: Tone
	label: string
	className?: string
	testId?: string
}) {
	const style = TONES[tone]
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1.5 text-xs whitespace-nowrap',
				style.text,
				className,
			)}
			data-testid={testId}
			data-status-tone={tone}
		>
			<span
				aria-hidden="true"
				className={cn('size-1.5 shrink-0 rounded-full', style.dot)}
			/>
			{label}
		</span>
	)
}

/** Order lifecycle status: dot plus the word, never color alone. */
export function OrderStatusLabel({
	status,
	className,
	testId,
}: {
	status: string
	className?: string
	testId?: string
}) {
	const { _ } = useLingui()
	const label = ORDER_STATUS_LABELS[status]
	return (
		<Dot
			tone={ORDER_TONES[status] ?? 'neutral'}
			label={label ? _(label) : status}
			className={className}
			testId={testId}
		/>
	)
}

/** Payment status, shown next to (never merged into) the order status. */
export function PaymentStatusLabel({
	status,
	className,
	testId,
}: {
	status: string
	className?: string
	testId?: string
}) {
	const { _ } = useLingui()
	const label = PAYMENT_STATUS_LABELS[status]
	return (
		<Dot
			tone={PAYMENT_TONES[status] ?? 'neutral'}
			label={label ? _(label) : status}
			className={className}
			testId={testId}
		/>
	)
}
