import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod/v4'
import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	PRINT_TEMPLATE_STYLES,
	type PrintProductKey,
} from '@repo/common/print-shop'
import { printCatalog } from '@repo/common/print-shop-catalog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import {
	Field,
	FieldError,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from '@repo/ui/field'
import { Input } from '@repo/ui/input'
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
import { printFormErrors } from '#app/components/print/print-form-errors.ts'
import {
	printProductLabel,
	printSizeText,
	PRINT_STYLE_LABELS,
} from '#app/components/print/print-labels.ts'
import { requirePrintShopAccess } from '#app/utils/print/access.server.ts'
import { createPrintDesign } from '#app/utils/print/designs.server.ts'

const NewPrintSchema = z.object({
	// Codes, translated by `printFormErrors`.
	name: z.string({ error: 'name' }).trim().min(1, 'name').max(120),
	product: z
		.string({ error: 'product' })
		.refine((key) => printCatalog.isProduct(key), 'product'),
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
	const product = printCatalog.products[submission.value.product]!
	if (!product.sizes.some((size) => size.key === submission.value.sizeKey)) {
		return {
			result: submission.reply({ fieldErrors: { sizeKey: ['size'] } }),
		}
	}
	const design = await createPrintDesign(access, submission.value)
	return redirect(`/${access.organization.slug}/marketing/print/${design.id}`)
}

export default function NewPrintRoute() {
	const { _ } = useLingui()
	const { orgSlug, shipping } = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const firstProduct = printCatalog.productKeys[0]!
	const [product, setProduct] = useState<PrintProductKey>(firstProduct)
	const [sizeKey, setSizeKey] = useState(
		printCatalog.products[firstProduct]!.sizes[0]!.key,
	)
	const [form, fields] = useForm({
		id: 'new-print',
		lastResult: actionData?.result,
		onValidate: ({ formData }) =>
			parseWithZod(formData, { schema: NewPrintSchema }),
	})

	const [name, setName] = useState(_(printProductLabel(firstProduct).name))
	const [nameEdited, setNameEdited] = useState(false)
	const chooseProduct = (next: PrintProductKey) => {
		setProduct(next)
		setSizeKey(printCatalog.products[next]!.sizes[0]!.key)
		// Follow the product until the operator types a name of their own.
		if (!nameEdited) setName(_(printProductLabel(next).name))
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
						{printCatalog.productKeys.map((key) => (
							<ChoiceCard key={key}>
								<RadioGroupItem value={key} />
								<ChoiceCardContent>
									<ChoiceCardTitle>
										{_(printProductLabel(key).name)}
										{shipping && printCatalog.products[key]!.shippable ? (
											<Badge variant="secondary">{_(msg`Can ship`)}</Badge>
										) : null}
									</ChoiceCardTitle>
									<ChoiceCardDescription>
										{_(printProductLabel(key).description)}
									</ChoiceCardDescription>
								</ChoiceCardContent>
							</ChoiceCard>
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
						{printCatalog.products[product]!.sizes.map((size) => (
							<ChoiceCard key={size.key} className="w-auto">
								<RadioGroupItem value={size.key} />
								<ChoiceCardTitle>
									<bdi>
										{printSizeText(
											_,
											size.label,
											printCatalog.products[product]!.folded,
										)}
									</bdi>
								</ChoiceCardTitle>
							</ChoiceCard>
						))}
					</RadioGroup>
					<FieldError errors={printFormErrors(_, fields.sizeKey.errors)} />
				</FieldSet>

				<FieldSet>
					<FieldLegend>{_(msg`Style`)}</FieldLegend>
					<RadioGroup
						name={fields.style.name}
						defaultValue="classic"
						className="flex flex-wrap gap-3"
					>
						{PRINT_TEMPLATE_STYLES.map((style) => (
							<ChoiceCard key={style} className="w-auto">
								<RadioGroupItem value={style} />
								<ChoiceCardTitle>
									{_(PRINT_STYLE_LABELS[style])}
								</ChoiceCardTitle>
							</ChoiceCard>
						))}
					</RadioGroup>
				</FieldSet>

				<Field data-invalid={fields.name.errors?.length ? true : undefined}>
					<FieldLabel htmlFor={fields.name.id}>{_(msg`Name`)}</FieldLabel>
					<Input
						{...getInputProps(fields.name, { type: 'text' })}
						value={name}
						onChange={(event) => {
							setName(event.target.value)
							setNameEdited(true)
						}}
						className="max-w-md"
					/>
					<FieldError errors={printFormErrors(_, fields.name.errors)} />
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
