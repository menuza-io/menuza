import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { formatPhone } from './guest.ts'
import { foldDigits } from './phone.ts'
import { cn } from '~/ui/primitives.tsx'

/** Digits and a leading plus: what a `tel:` or `sms:` link dials. */
const dialable = (phone: string) => foldDigits(phone).replace(/[^\d+]/g, '')

const buttonClass =
	'hover:bg-accent inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-(--station-control-radius) px-3 text-sm font-medium transition'

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
	callFirst = false,
	className,
}: {
	phone: string
	/** The number is whole (the guest-details grant): it can be called and texted. */
	canContact: boolean
	/** False for a guest who did not agree to be texted: only Call is offered. */
	canText?: boolean
	/** Calling is the way to reach them (nothing was texted): Call stands out. */
	callFirst?: boolean
	className?: string
}) {
	const { _ } = useLingui()
	const ending = foldDigits(phone).replace(/\D/g, '').slice(-4)
	if (!canContact)
		return (
			<p className={cn('flex items-center gap-3 text-base', className)}>
				<Icon
					name="phone"
					aria-hidden
					className="text-muted-foreground size-5 shrink-0"
				/>
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
				'flex flex-wrap items-center gap-x-4 gap-y-2 py-2',
				className,
			)}
		>
			<span className="tnum min-w-0 text-base font-medium" dir="ltr">
				{formatPhone(phone)}
			</span>
			<span className="ms-auto flex shrink-0 gap-2">
				<a
					href={`tel:${dial}`}
					className={cn(
						buttonClass,
						callFirst &&
							'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
					)}
				>
					<Icon name="phone" aria-hidden className="size-5" />
					<Trans>Call</Trans>
				</a>
				{canText ? (
					<a href={`sms:${dial}`} className={buttonClass}>
						<Icon name="message-square" aria-hidden className="size-5" />
						<Trans>Text</Trans>
					</a>
				) : null}
			</span>
		</div>
	)
}
