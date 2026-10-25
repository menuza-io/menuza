import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { MessageSquare, Phone } from 'lucide-react'
import { formatPhone } from './guest.ts'
import { cn } from '~/ui/primitives.tsx'

/** Digits and a leading plus: what a `tel:` or `sms:` link dials. */
const dialable = (phone: string) => phone.replace(/[^\d+]/g, '')

const buttonClass =
	'border-border bg-card hover:bg-accent inline-flex h-12 min-w-0 items-center justify-center gap-2 rounded-xl border px-4 font-semibold transition active:scale-[0.97]'

/**
 * A guest's number, and one tap to call or text them. With the guest-details
 * grant the number is whole: it is grouped the way it is read out, with
 * Call and Text beside it. Without, the server sends only the end of it: it is
 * shown as it came, and there is nothing to dial.
 */
export function ContactRow({
	phone,
	canContact,
	canText = true,
	className,
}: {
	phone: string
	/** The number is whole (the guest-details grant): it can be called and texted. */
	canContact: boolean
	/** False for a guest who did not agree to be texted: only Call is offered. */
	canText?: boolean
	className?: string
}) {
	const { _ } = useLingui()
	const ending = phone.replace(/\D/g, '').slice(-4)
	if (!canContact)
		return (
			<p className={cn('flex items-center gap-3 text-base', className)}>
				<Phone aria-hidden className="text-muted-foreground size-5 shrink-0" />
				<span
					className="tnum"
					dir="ltr"
					aria-label={_(msg`Phone ending ${ending}`)}
				>
					{phone}
				</span>
			</p>
		)
	const dial = dialable(phone)
	return (
		<div
			className={cn(
				'border-border flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border p-3',
				className,
			)}
		>
			<span
				className="tnum mono min-w-0 text-lg font-semibold tracking-tight"
				dir="ltr"
			>
				{formatPhone(phone)}
			</span>
			<span className="ms-auto flex shrink-0 gap-2">
				<a href={`tel:${dial}`} className={buttonClass}>
					<Phone aria-hidden className="size-5" />
					<Trans>Call</Trans>
				</a>
				{canText ? (
					<a href={`sms:${dial}`} className={buttonClass}>
						<MessageSquare aria-hidden className="size-5" />
						<Trans>Text</Trans>
					</a>
				) : null}
			</span>
		</div>
	)
}
