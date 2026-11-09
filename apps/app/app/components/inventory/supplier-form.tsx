import { getFormProps, useForm } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod/v4'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	SUPPLIER_ORDER_CHANNELS,
	type Supplier,
	type SupplierOrderChannel,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { type FormEvent, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { type z } from 'zod'
import { useNotifyInventoryChanged } from '#app/components/inventory/inventory-prefs.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import {
	buildCreateSupplierPayload,
	buildUpdateSupplierPayload,
	DELIVERY_DAY_NUMBERS,
	emptySupplierFormValues,
	parseDeliveryDays,
	supplierFormSchema,
	supplierFormValues,
} from '#app/utils/inventory/supplier-form.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'
import { currencyExponent } from '#app/utils/money-input.ts'

const CHANNEL_LABELS = {
	email: msg`Email`,
	whatsapp: msg`WhatsApp`,
	phone: msg`Phone call`,
	other: msg`Something else`,
} as const

/** Sunday-first short weekday names in the viewer's language. */
export function weekdayName(
	day: number,
	locale: string,
	width: 'short' | 'long' = 'short',
): string {
	// 7 January 2024 is a Sunday.
	return new Intl.DateTimeFormat(locale, { weekday: width }).format(
		new Date(2024, 0, 7 + day),
	)
}

/**
 * Add or edit a supplier: the contract's fields and nothing more. Only the
 * name is required. `layout="sheet"` is the Add sheet (footer buttons);
 * `layout="inline"` sits inside the Edit sheet above the supplier's products.
 */
export function SupplierForm({
	mode,
	supplier,
	currency,
	layout,
	onSaved,
	onCancel,
}: {
	mode: 'create' | 'edit'
	supplier?: Supplier
	currency: string
	layout: 'sheet' | 'inline'
	onSaved: () => void
	onCancel?: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const idPrefix = useId()
	const initial = useMemo(
		() =>
			mode === 'edit' && supplier
				? supplierFormValues(supplier, currency)
				: emptySupplierFormValues(),
		[mode, supplier, currency],
	)
	const [channel, setChannel] = useState<SupplierOrderChannel>(
		initial.orderChannel,
	)
	const [days, setDays] = useState(initial.deliveryDays)
	const [error, setError] = useState<string | null>(null)
	const [pending, setPending] = useState(false)
	// A retry after a lost answer replays the same create, never a second one.
	const clientIdRef = useRef(newClientId('s'))

	const messages = useMemo(
		() => ({
			nameRequired: t`Enter the supplier's name.`,
			nameTooLong: t`Keep the name under 80 characters.`,
			textInvalid: t`Remove the special characters.`,
			contactTooLong: t`Keep the contact name under 80 characters.`,
			phoneTooLong: t`Keep the phone number under 40 characters.`,
			emailInvalid: t`Enter an email address, for example orders@supplier.com.`,
			daysInvalid: t`Choose days of the week.`,
			cutoffTimeInvalid: t`Enter a time, for example 16:00.`,
			cutoffDaysInvalid: t`Enter a number of days from 0 to 14.`,
			cutoffNeedsBoth: t`Give both the time and how many days before delivery.`,
			minimumInvalid: t`Enter an amount, for example 400 or 400.50.`,
			termsTooLong: t`Keep the payment terms under 80 characters.`,
			vatTooLong: t`Keep the VAT number under 40 characters.`,
			notesTooLong: t`Keep the note under 500 characters.`,
		}),
		[t],
	)
	const schema = useMemo(
		() => supplierFormSchema(messages, { currency }),
		[messages, currency],
	)

	const [form, fields] = useForm({
		id: `inventory-supplier-form-${mode}`,
		defaultValue: {
			name: initial.name,
			contactName: initial.contactName,
			phone: initial.phone,
			email: initial.email,
			cutoffTime: initial.cutoffTime,
			cutoffDaysBefore: initial.cutoffDaysBefore,
			minimumOrder: initial.minimumOrder,
			paymentTerms: initial.paymentTerms,
			vatNumber: initial.vatNumber,
			notes: initial.notes,
		},
		onValidate({ formData }) {
			return parseWithZod(formData, { schema })
		},
		shouldValidate: 'onBlur',
		shouldRevalidate: 'onInput',
		onSubmit(event, { submission }) {
			event.preventDefault()
			if (submission?.status !== 'success' || pending) return
			void save(submission.value)
		},
	})

	async function save(parsed: z.infer<typeof schema>) {
		setPending(true)
		setError(null)
		try {
			if (mode === 'create') {
				await request('/suppliers', {
					method: 'POST',
					body: JSON.stringify(
						buildCreateSupplierPayload(parsed, {
							clientId: clientIdRef.current,
							currency,
						}),
					),
				})
				clientIdRef.current = newClientId('s')
				const addedName = parsed.name
				toast.success(t`${addedName} added.`)
			} else if (supplier) {
				await request(`/suppliers/${encodeURIComponent(supplier.id)}`, {
					method: 'PATCH',
					body: JSON.stringify(buildUpdateSupplierPayload(parsed, supplier)),
				})
				const savedName = parsed.name
				toast.success(t`${savedName} saved.`)
			}
			notifyChanged()
			onSaved()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setPending(false)
		}
	}

	const exponent = currencyExponent(currency)
	const selectedDays = parseDeliveryDays(days).map(String)

	const body = (
		<>
			<input type="hidden" name="orderChannel" value={channel} />
			<input type="hidden" name="deliveryDays" value={days} />

			{error ? (
				<Alert variant="destructive" data-testid="supplier-form-error">
					<Icon name="alert-triangle" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			<TextField
				label={<Trans>Name</Trans>}
				name={fields.name.name}
				id={`${idPrefix}-name`}
				defaultValue={initial.name}
				error={fields.name.errors?.[0] ?? null}
				maxLength={80}
				dir="auto"
				autoComplete="off"
				data-testid="supplier-form-name"
			/>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<TextField
					label={<Trans>Contact person</Trans>}
					optional
					name={fields.contactName.name}
					defaultValue={initial.contactName}
					error={fields.contactName.errors?.[0] ?? null}
					maxLength={80}
					dir="auto"
					autoComplete="off"
					data-testid="supplier-form-contact"
				/>
				<TextField
					label={<Trans>Phone</Trans>}
					optional
					name={fields.phone.name}
					defaultValue={initial.phone}
					error={fields.phone.errors?.[0] ?? null}
					type="tel"
					inputMode="tel"
					maxLength={40}
					dir="ltr"
					autoComplete="off"
					data-testid="supplier-form-phone"
				/>
			</div>
			<TextField
				label={<Trans>Email</Trans>}
				optional
				name={fields.email.name}
				defaultValue={initial.email}
				error={fields.email.errors?.[0] ?? null}
				type="email"
				inputMode="email"
				maxLength={200}
				dir="ltr"
				autoComplete="off"
				data-testid="supplier-form-email"
			/>

			<SelectField
				label={<Trans>You order by</Trans>}
				id={`${idPrefix}-channel`}
				testId="supplier-form-channel"
				options={SUPPLIER_ORDER_CHANNELS.map((value) => ({
					value,
					label: i18n._(CHANNEL_LABELS[value]),
				}))}
				value={channel}
				onValueChange={(next) => setChannel(next as SupplierOrderChannel)}
			/>

			<Field data-invalid={fields.deliveryDays.errors?.[0] ? true : undefined}>
				<FieldLabel id={`${idPrefix}-days`}>
					<Trans>They deliver on</Trans>{' '}
					<span className="text-muted-foreground font-normal">
						<Trans>(optional)</Trans>
					</span>
				</FieldLabel>
				<ToggleGroup
					aria-labelledby={`${idPrefix}-days`}
					variant="outline"
					spacing={1}
					multiple
					value={selectedDays}
					onValueChange={(next) =>
						setDays(
							next
								.map(Number)
								.sort((a, b) => a - b)
								.join(','),
						)
					}
					className="flex-wrap"
				>
					{DELIVERY_DAY_NUMBERS.map((day) => (
						<ToggleGroupItem
							key={day}
							value={String(day)}
							className="h-11 min-w-11 md:h-8"
							data-testid={`supplier-form-day-${day}`}
						>
							{weekdayName(day, i18n.locale)}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				{fields.deliveryDays.errors?.[0] ? (
					<FieldError>{fields.deliveryDays.errors[0]}</FieldError>
				) : null}
			</Field>

			<fieldset className="flex flex-col gap-2">
				<legend className="mb-1 text-sm font-medium">
					<Trans>Order cut-off</Trans>{' '}
					<span className="text-muted-foreground font-normal">
						<Trans>(optional)</Trans>
					</span>
				</legend>
				<div className="grid grid-cols-2 gap-3">
					<Field
						data-invalid={fields.cutoffTime.errors?.[0] ? true : undefined}
					>
						<FieldLabel htmlFor={`${idPrefix}-cutoff-time`}>
							<Trans>Order by</Trans>
						</FieldLabel>
						<Input
							id={`${idPrefix}-cutoff-time`}
							name={fields.cutoffTime.name}
							type="time"
							defaultValue={initial.cutoffTime}
							dir="ltr"
							className="h-11 md:h-8"
							aria-invalid={fields.cutoffTime.errors?.[0] ? true : undefined}
							data-testid="supplier-form-cutoff-time"
						/>
						{fields.cutoffTime.errors?.[0] ? (
							<FieldError>{fields.cutoffTime.errors[0]}</FieldError>
						) : null}
					</Field>
					<TextField
						label={<Trans>Days before delivery</Trans>}
						name={fields.cutoffDaysBefore.name}
						defaultValue={initial.cutoffDaysBefore}
						error={fields.cutoffDaysBefore.errors?.[0] ?? null}
						inputMode="numeric"
						placeholder="1"
						dir="ltr"
						data-testid="supplier-form-cutoff-days"
					/>
				</div>
				<FieldDescription>
					<Trans>
						For example 16:00 and 1 day before: order by 4 PM the day before
						they deliver.
					</Trans>
				</FieldDescription>
			</fieldset>

			<TextField
				label={<Trans>Minimum order ({currency})</Trans>}
				optional
				name={fields.minimumOrder.name}
				defaultValue={initial.minimumOrder}
				error={fields.minimumOrder.errors?.[0] ?? null}
				inputMode="decimal"
				placeholder={exponent === 0 ? '400' : '400.00'}
				dir="ltr"
				data-testid="supplier-form-minimum"
			/>
			<TextField
				label={<Trans>Payment terms</Trans>}
				optional
				name={fields.paymentTerms.name}
				defaultValue={initial.paymentTerms}
				error={fields.paymentTerms.errors?.[0] ?? null}
				maxLength={80}
				dir="auto"
				placeholder={t`For example: 30 days`}
				data-testid="supplier-form-terms"
			/>
			<TextField
				label={<Trans>VAT number</Trans>}
				optional
				name={fields.vatNumber.name}
				defaultValue={initial.vatNumber}
				error={fields.vatNumber.errors?.[0] ?? null}
				maxLength={40}
				dir="ltr"
				autoComplete="off"
				data-testid="supplier-form-vat"
			/>
			<TextField
				label={<Trans>Note</Trans>}
				optional
				name={fields.notes.name}
				defaultValue={initial.notes}
				error={fields.notes.errors?.[0] ?? null}
				maxLength={500}
				dir="auto"
				data-testid="supplier-form-notes"
			/>
		</>
	)

	const saveLabel = pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>

	if (layout === 'inline') {
		return (
			<form
				{...getFormProps(form)}
				noValidate
				className="flex flex-col gap-5"
				data-testid="supplier-form"
			>
				{body}
				<div className="flex justify-end">
					<Button
						type="submit"
						disabled={pending}
						data-testid="supplier-form-submit"
					>
						{saveLabel}
					</Button>
				</div>
			</form>
		)
	}

	return (
		<SheetForm
			id={form.id}
			title={mode === 'create' ? t`Add supplier` : t`Edit supplier`}
			description={
				mode === 'create'
					? t`Only the name is needed. Add what you know now and the rest later.`
					: undefined
			}
			onSubmit={(event: FormEvent<HTMLFormElement>) => {
				getFormProps(form).onSubmit?.(event)
			}}
			footer={
				<>
					<Button
						type="button"
						variant="outline"
						onClick={onCancel}
						disabled={pending}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="submit"
						disabled={pending}
						data-testid="supplier-form-submit"
					>
						{saveLabel}
					</Button>
				</>
			}
		>
			{body}
		</SheetForm>
	)
}
