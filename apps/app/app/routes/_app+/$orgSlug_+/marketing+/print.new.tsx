import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod'
import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	PRINT_PRODUCT_KEYS,
	PRINT_PRODUCTS,
	PRINT_TEMPLATE_STYLES,
	type PrintProductKey,
} from '@repo/common/print-shop'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Field,
	FieldError,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { useState } from 'react'
import {
	Form,
	Link,
	redirect,
	useActionData,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import {
	PRINT_PRODUCT_LABELS,
	PRINT_STYLE_LABELS,
} from '#app/components/print/print-labels.ts'
import { requirePrintShopAccess } from '#app/utils/print/access.server.ts'
import { createPrintDesign } from '#app/utils/print/designs.server.ts'

const NewPrintSchema = z.object({
	name: z.string().trim().min(1).max(120),
	product: z.enum(PRINT_PRODUCT_KEYS),
	sizeKey: z.string().trim().min(1).max(20),
	style: z.enum(PRINT_TEMPLATE_STYLES),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug, {
		write: true,
	})
	return {
		orgSlug: access.organization.slug,
		shipping: access.features.shipping,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug, {
		write: true,
	})
	const submission = parseWithZod(await request.formData(), {
		schema: NewPrintSchema,
	})
	if (submission.status !== 'success') {
		return { result: submission.reply() }
	}
	const product = PRINT_PRODUCTS[submission.value.product]
	if (!product.sizes.some((size) => size.key === submission.value.sizeKey)) {
		return {
			result: submission.reply({ fieldErrors: { sizeKey: ['Choose a size'] } }),
		}
	}
	const design = await createPrintDesign(access, submission.value)
	return redirect(`/${access.organization.slug}/marketing/print/${design.id}`)
}

export default function NewPrintRoute() {
	const { _ } = useLingui()
	const { orgSlug, shipping } = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const [product, setProduct] = useState<PrintProductKey>('table_card')
	const [sizeKey, setSizeKey] = useState(
		PRINT_PRODUCTS.table_card.sizes[0]!.key,
	)
	const [form, fields] = useForm({
		id: 'new-print',
		lastResult: actionData?.result,
		onValidate: ({ formData }) =>
			parseWithZod(formData, { schema: NewPrintSchema }),
		defaultValue: { name: _(PRINT_PRODUCT_LABELS.table_card.name) },
	})

	const chooseProduct = (next: PrintProductKey) => {
		setProduct(next)
		setSizeKey(PRINT_PRODUCTS[next].sizes[0]!.key)
	}

	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`New print`)}
				description={_(
					msg`Pick what to print. You can change the size, style and words next.`,
				)}
			/>
			<Form method="post" {...getFormProps(form)} className="space-y-8">
				<FieldSet>
					<FieldLegend>{_(msg`What to print`)}</FieldLegend>
					<RadioGroup
						name={fields.product.name}
						value={product}
						onValueChange={(value) => chooseProduct(value as PrintProductKey)}
						className="grid gap-3 sm:grid-cols-2"
					>
						{PRINT_PRODUCT_KEYS.map((key) => (
							<Label
								key={key}
								className="border-border has-[[data-checked]]:border-primary flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-4"
							>
								<RadioGroupItem value={key} className="mt-0.5" />
								<span className="flex flex-col gap-1">
									<span className="flex flex-wrap items-center gap-2 font-medium">
										{_(PRINT_PRODUCT_LABELS[key].name)}
										{shipping && PRINT_PRODUCTS[key].shippable ? (
											<Badge variant="secondary">{_(msg`Can ship`)}</Badge>
										) : null}
									</span>
									<span className="text-muted-foreground text-sm font-normal">
										{_(PRINT_PRODUCT_LABELS[key].description)}
									</span>
								</span>
							</Label>
						))}
					</RadioGroup>
				</FieldSet>

				<FieldSet>
					<FieldLegend>{_(msg`Size`)}</FieldLegend>
					<RadioGroup
						name={fields.sizeKey.name}
						value={sizeKey}
						onValueChange={(value) => setSizeKey(String(value))}
						className="flex flex-wrap gap-3"
					>
						{PRINT_PRODUCTS[product].sizes.map((size) => (
							<Label
								key={size.key}
								className="border-border has-[[data-checked]]:border-primary flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-4"
							>
								<RadioGroupItem value={size.key} />
								<bdi>{size.label}</bdi>
							</Label>
						))}
					</RadioGroup>
					<FieldError
						errors={fields.sizeKey.errors?.map((message) => ({ message }))}
					/>
				</FieldSet>

				<FieldSet>
					<FieldLegend>{_(msg`Style`)}</FieldLegend>
					<RadioGroup
						name={fields.style.name}
						defaultValue="classic"
						className="flex flex-wrap gap-3"
					>
						{PRINT_TEMPLATE_STYLES.map((style) => (
							<Label
								key={style}
								className="border-border has-[[data-checked]]:border-primary flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-4"
							>
								<RadioGroupItem value={style} />
								{_(PRINT_STYLE_LABELS[style])}
							</Label>
						))}
					</RadioGroup>
				</FieldSet>

				<Field data-invalid={fields.name.errors?.length ? true : undefined}>
					<FieldLabel htmlFor={fields.name.id}>{_(msg`Name`)}</FieldLabel>
					<Input
						{...getInputProps(fields.name, { type: 'text' })}
						className="max-w-md"
					/>
					<FieldError
						errors={fields.name.errors?.map((message) => ({ message }))}
					/>
				</Field>

				<div className="flex flex-wrap gap-3">
					<Button type="submit">{_(msg`Continue`)}</Button>
					<Button
						variant="outline"
						render={<Link to={`/${orgSlug}/marketing/print`} />}
					>
						{_(msg`Cancel`)}
					</Button>
				</div>
			</Form>
		</div>
	)
}
