import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod/v4'
import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	PRINT_MAX_COPIES,
	PRINT_MAX_ORDER_LINES,
	PRINT_US_STATES,
	printShippingAddressSchema,
} from '@repo/common/print-shop'
import { printCatalog } from '@repo/common/print-shop-catalog'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Field, FieldError, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { PageHeader } from '@repo/ui/page-header'
import { useState } from 'react'
import {
	Form,
	Link,
	redirect,
	useActionData,
	useLoaderData,
	useNavigation,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
import { printFormErrors } from '#app/components/print/print-form-errors.ts'
import { printProductLabel } from '#app/components/print/print-labels.ts'
import {
	PRINT_ORDER_ERROR_FALLBACK,
	PRINT_ORDER_ERROR_LABELS,
} from '#app/components/print/print-order-labels.ts'
import { printShopUi } from '#app/components/print/vertical-ui.tsx'
import {
	isPrintShippingPaused,
	requirePrintShopAccess,
} from '#app/utils/print/access.server.ts'
import { listPrintDesigns } from '#app/utils/print/designs.server.ts'
import {
	createPrintQuote,
	PrintOrderError,
	shippableSizes,
} from '#app/utils/print/orders.server.ts'
import { listPrintScopes } from '#app/utils/print/print-snapshot.server.ts'

const OrderFormSchema = printShippingAddressSchema
	.omit({ country: true })
	.extend({
		scopeId: z.string().max(100).optional(),
		// Conform does not coerce inside a record: the field text arrives as is.
		copies: z
			.record(
				z.string(),
				z.preprocess(
					(value) => (value === undefined || value === '' ? 0 : value),
					// Codes, translated by `printFormErrors`.
					z.coerce
						.number({ error: 'copies_number' })
						.int('copies_whole')
						.min(0, 'copies_min')
						.max(PRINT_MAX_COPIES, 'copies_max'),
				),
			)
			.optional()
			.default({}),
	})

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug, {
		pay: true,
	})
	const [designs, shippable, scopes] = await Promise.all([
		listPrintDesigns(access.organization.id),
		shippableSizes(),
		listPrintScopes(access.organization.id),
	])
	return {
		orgSlug: access.organization.slug,
		orgName: access.organization.name,
		canWrite: access.canWrite,
		paused: isPrintShippingPaused(),
		designs: designs
			.filter(
				(design) =>
					design.status === 'approved' &&
					printCatalog.products[design.product]?.shippable &&
					shippable.has(`${design.product}:${design.sizeKey}`),
			)
			.map((design) => ({
				id: design.id,
				name: design.name,
				product: design.product,
				size:
					printCatalog.getSize(design.product, design.sizeKey)?.label ??
					design.sizeKey,
			})),
		// The vertical's places prefill the ship-to (a business's own address).
		scopes: scopes.map((scope) => ({
			id: scope.id,
			name: scope.name,
			address: scope.shipTo,
		})),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug, {
		pay: true,
	})
	if (isPrintShippingPaused()) {
		throw new Response('Shipped prints are paused', { status: 503 })
	}
	const submission = parseWithZod(await request.formData(), {
		schema: OrderFormSchema,
	})
	if (submission.status !== 'success') {
		return { result: submission.reply(), error: null }
	}
	const { copies, scopeId, ...address } = submission.value
	const lines = Object.entries(copies)
		.filter(([, quantity]) => quantity > 0)
		.map(([designId, quantity]) => ({ designId, quantity }))
		.slice(0, PRINT_MAX_ORDER_LINES)
	if (lines.length === 0) {
		return {
			result: submission.reply(),
			error: 'no_lines',
		}
	}
	try {
		const orderId = await createPrintQuote(request, access, {
			lines,
			address: { ...address, country: 'US' },
			scopeId: scopeId || null,
		})
		return redirect(
			`/${access.organization.slug}/marketing/print/orders/${orderId}`,
		)
	} catch (error) {
		if (error instanceof PrintOrderError) {
			return { result: submission.reply(), error: error.code }
		}
		throw error
	}
}

export default function NewPrintOrderRoute() {
	const { _ } = useLingui()
	const data = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const busy = useNavigation().state !== 'idle'
	const first = data.scopes[0]
	const [address, setAddress] = useState({
		recipientName: data.orgName,
		...(first?.address ?? {
			line1: '',
			line2: '',
			city: '',
			state: '',
			postalCode: '',
		}),
	})
	const [form, fields] = useForm({
		id: 'print-order',
		lastResult: actionData?.result,
		shouldRevalidate: 'onBlur',
		onValidate: ({ formData }) =>
			parseWithZod(formData, { schema: OrderFormSchema }),
	})
	const errors = (name: keyof typeof fields) =>
		printFormErrors(_, fields[name].errors)

	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Order prints`)}
				description={_(
					msg`Shipped to a US address. You see the price with shipping before you pay; sales tax is added at payment.`,
				)}
				actions={
					<Button
						variant="outline"
						render={<Link to={`/${data.orgSlug}/marketing/print/orders`} />}
					>
						{_(msg`Print orders`)}
					</Button>
				}
			/>
			{data.paused ? (
				<Alert>
					<AlertTitle>
						{_(msg`Shipped prints are paused for a moment`)}
					</AlertTitle>
					<AlertDescription>
						{_(msg`Try again later. Downloads still work.`)}
					</AlertDescription>
				</Alert>
			) : null}
			{actionData?.error ? (
				<Alert variant="destructive" role="alert">
					<AlertTitle>
						{actionData.error === 'no_lines'
							? _(msg`Nothing to print yet`)
							: _(msg`We could not price this order`)}
					</AlertTitle>
					<AlertDescription>
						{_(
							PRINT_ORDER_ERROR_LABELS[actionData.error] ??
								PRINT_ORDER_ERROR_FALLBACK,
						)}
					</AlertDescription>
				</Alert>
			) : null}

			{data.designs.length === 0 ? (
				<EmptyState
					title={_(msg`Nothing to ship yet`)}
					description={_(
						printShopUi.copy?.nothingToShip ??
							msg`Approve a print first. Only approved prints in a shippable size can be ordered.`,
					)}
					icons={['printer']}
					action={
						data.canWrite
							? {
									label: _(msg`Create a print`),
									href: `/${data.orgSlug}/marketing/print/new`,
								}
							: undefined
					}
				/>
			) : (
				<Form
					method="post"
					{...getFormProps(form)}
					className="grid gap-6 lg:grid-cols-2"
				>
					<Card>
						<CardHeader>
							<CardTitle>{_(msg`What to print`)}</CardTitle>
							<CardDescription>
								{_(
									msg`Copies of each print. A set of cards prints every card this many times.`,
								)}
							</CardDescription>
						</CardHeader>
						<CardContent className="flex flex-col gap-4">
							{data.designs.map((design) => {
								const copiesErrors = form.allErrors[`copies.${design.id}`]
								return (
									<div key={design.id} className="flex flex-col gap-1">
										<Field
											orientation="horizontal"
											className="items-center justify-between gap-4"
											data-invalid={copiesErrors?.length ? true : undefined}
										>
											<FieldLabel
												htmlFor={`copies-${design.id}`}
												className="flex flex-col items-start gap-0.5"
											>
												<span className="wrap-anywhere">{design.name}</span>
												<span className="text-muted-foreground text-xs font-normal">
													{_(printProductLabel(design.product).name)} ·{' '}
													<bdi>{design.size}</bdi>
												</span>
											</FieldLabel>
											<Input
												id={`copies-${design.id}`}
												name={`copies.${design.id}`}
												type="number"
												inputMode="numeric"
												min={0}
												max={PRINT_MAX_COPIES}
												defaultValue={0}
												className="w-24"
												aria-invalid={copiesErrors?.length ? true : undefined}
												aria-describedby={
													copiesErrors?.length
														? `copies-${design.id}-error`
														: undefined
												}
											/>
										</Field>
										<FieldError
											id={`copies-${design.id}-error`}
											errors={printFormErrors(_, copiesErrors)}
										/>
									</div>
								)
							})}
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle>{_(msg`Ship to`)}</CardTitle>
						</CardHeader>
						<CardContent className="grid gap-4 sm:grid-cols-2">
							{data.scopes.length > 1 ? (
								<Field className="sm:col-span-2">
									<FieldLabel htmlFor="order-scope">
										{_(printShopUi.scope?.label ?? msg`Ship from`)}
									</FieldLabel>
									<select
										id="order-scope"
										name="scopeId"
										defaultValue={first?.id}
										onChange={(event) => {
											const next = data.scopes.find(
												(scope) => scope.id === event.target.value,
											)
											if (next?.address)
												setAddress((current) => ({
													...current,
													...next.address!,
												}))
										}}
										className="border-input bg-background h-11 rounded-md border px-3 text-sm"
									>
										{data.scopes.map((scope) => (
											<option key={scope.id} value={scope.id}>
												{scope.name}
											</option>
										))}
									</select>
								</Field>
							) : first ? (
								<input type="hidden" name="scopeId" value={first.id} />
							) : null}
							<AddressField
								label={_(msg`Recipient`)}
								field={fields.recipientName}
								value={address.recipientName}
								onChange={(v) => setAddress({ ...address, recipientName: v })}
								errors={errors('recipientName')}
								autoComplete="name"
								wide
							/>
							<Field
								className="sm:col-span-2"
								data-invalid={
									fields.recipientPhone.errors?.length ? true : undefined
								}
							>
								<FieldLabel htmlFor={fields.recipientPhone.id}>
									{_(msg`Phone for the carrier`)}
								</FieldLabel>
								<Input
									{...getInputProps(fields.recipientPhone, { type: 'tel' })}
									autoComplete="tel"
									dir="ltr"
								/>
								<FieldError
									id={fields.recipientPhone.errorId}
									errors={errors('recipientPhone')}
								/>
							</Field>
							<AddressField
								label={_(msg`Street address`)}
								field={fields.line1}
								value={address.line1}
								onChange={(v) => setAddress({ ...address, line1: v })}
								errors={errors('line1')}
								autoComplete="address-line1"
								wide
							/>
							<AddressField
								label={_(msg`Apartment, suite (optional)`)}
								field={fields.line2}
								value={address.line2}
								onChange={(v) => setAddress({ ...address, line2: v })}
								errors={errors('line2')}
								autoComplete="address-line2"
								wide
							/>
							<AddressField
								label={_(msg`City`)}
								field={fields.city}
								value={address.city}
								onChange={(v) => setAddress({ ...address, city: v })}
								errors={errors('city')}
								autoComplete="address-level2"
							/>
							<Field
								data-invalid={fields.state.errors?.length ? true : undefined}
							>
								<FieldLabel htmlFor={fields.state.id}>
									{_(msg`State`)}
								</FieldLabel>
								<select
									id={fields.state.id}
									name={fields.state.name}
									value={address.state}
									onChange={(event) =>
										setAddress({ ...address, state: event.target.value })
									}
									autoComplete="address-level1"
									aria-invalid={fields.state.errors?.length ? true : undefined}
									aria-describedby={
										fields.state.errors?.length
											? fields.state.errorId
											: undefined
									}
									className="border-input bg-background h-11 rounded-md border px-3 text-sm"
								>
									<option value="">{_(msg`Choose`)}</option>
									{PRINT_US_STATES.map((state) => (
										<option key={state} value={state}>
											{state}
										</option>
									))}
								</select>
								<FieldError
									id={fields.state.errorId}
									errors={errors('state')}
								/>
							</Field>
							<AddressField
								label={_(msg`ZIP code`)}
								field={fields.postalCode}
								value={address.postalCode}
								onChange={(v) => setAddress({ ...address, postalCode: v })}
								errors={errors('postalCode')}
								autoComplete="postal-code"
								inputMode="numeric"
							/>
						</CardContent>
					</Card>

					<div className="lg:col-span-2">
						<Button type="submit" disabled={busy || data.paused}>
							{_(msg`See the price`)}
						</Button>
					</div>
				</Form>
			)}
		</div>
	)
}

function AddressField({
	label,
	field,
	value,
	onChange,
	errors,
	autoComplete,
	inputMode,
	wide,
}: {
	label: string
	field: { id: string; name: string; errorId: string; errors?: string[] }
	value: string
	onChange: (value: string) => void
	errors?: Array<{ message: string }>
	autoComplete: string
	inputMode?: 'numeric'
	wide?: boolean
}) {
	return (
		<Field
			className={wide ? 'sm:col-span-2' : undefined}
			data-invalid={field.errors?.length ? true : undefined}
		>
			<FieldLabel htmlFor={field.id}>{label}</FieldLabel>
			<Input
				id={field.id}
				name={field.name}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				autoComplete={autoComplete}
				inputMode={inputMode}
				aria-invalid={field.errors?.length ? true : undefined}
				aria-describedby={field.errors?.length ? field.errorId : undefined}
			/>
			<FieldError id={field.errorId} errors={errors} />
		</Field>
	)
}
