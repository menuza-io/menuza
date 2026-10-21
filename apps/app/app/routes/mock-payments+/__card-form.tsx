import { Trans } from '@lingui/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { type ReactNode, useEffect, useRef } from 'react'

export type CardFormError = {
	/** Which field the message belongs to, when it does. */
	field?: 'number' | 'expiry' | 'cvc'
	message: ReactNode
}

/** Id of the error alert, referenced by the invalid field's `aria-describedby`. */
export const CARD_ERROR_ID = 'mock-card-error'

/** Labeled card fields with stable test ids, shared by both hosted pages. */
export function CardFields({
	defaultEmail,
	errorField,
	withZip,
}: {
	defaultEmail?: string | null
	errorField?: CardFormError['field']
	withZip: boolean
}) {
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="mock-email">
					<Trans>Email</Trans>
				</Label>
				<Input
					id="mock-email"
					name="email"
					type="email"
					autoComplete="email"
					defaultValue={defaultEmail ?? ''}
					data-testid="mock-card-email"
				/>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="mock-card-number">
					<Trans>Card number</Trans>
				</Label>
				<Input
					id="mock-card-number"
					name="number"
					inputMode="numeric"
					autoComplete="cc-number"
					placeholder="4242 4242 4242 4242"
					required
					aria-invalid={errorField === 'number' || undefined}
					aria-describedby={errorField === 'number' ? CARD_ERROR_ID : undefined}
					data-testid="mock-card-number"
				/>
			</div>
			<div className="grid grid-cols-2 gap-3">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="mock-card-expiry">
						<Trans>Expiry (MM/YY)</Trans>
					</Label>
					<Input
						id="mock-card-expiry"
						name="expiry"
						autoComplete="cc-exp"
						placeholder="12/34"
						required
						aria-invalid={errorField === 'expiry' || undefined}
						aria-describedby={
							errorField === 'expiry' ? CARD_ERROR_ID : undefined
						}
						data-testid="mock-card-expiry"
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="mock-card-cvc">
						<Trans>CVC</Trans>
					</Label>
					<Input
						id="mock-card-cvc"
						name="cvc"
						inputMode="numeric"
						autoComplete="cc-csc"
						placeholder="123"
						required
						aria-invalid={errorField === 'cvc' || undefined}
						aria-describedby={errorField === 'cvc' ? CARD_ERROR_ID : undefined}
						data-testid="mock-card-cvc"
					/>
				</div>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="mock-card-name">
					<Trans>Name on card</Trans>
				</Label>
				<Input
					id="mock-card-name"
					name="name"
					autoComplete="cc-name"
					data-testid="mock-card-name"
				/>
			</div>
			{withZip ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="mock-card-zip">
						<Trans>ZIP</Trans>
					</Label>
					<Input
						id="mock-card-zip"
						name="postalCode"
						autoComplete="postal-code"
						defaultValue="94103"
						data-testid="mock-card-zip"
					/>
				</div>
			) : null}
		</div>
	)
}

/**
 * The card error. It is announced (`role="alert"`) and takes focus when it
 * appears: on the first invalid field when the error names one, otherwise on
 * the alert itself, so keyboard and screen reader users land on the problem.
 */
export function CardErrorAlert({
	children,
	field,
}: {
	children: ReactNode
	field?: CardFormError['field']
}) {
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const input = field ? document.getElementById(`mock-card-${field}`) : null
		;(input ?? ref.current)?.focus()
	}, [field, children])
	return (
		<Alert
			ref={ref}
			id={CARD_ERROR_ID}
			tabIndex={-1}
			variant="destructive"
			data-testid="mock-error"
		>
			<AlertDescription>{children}</AlertDescription>
		</Alert>
	)
}
