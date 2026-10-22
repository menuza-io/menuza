import {
	getFormProps,
	getInputProps,
	useForm,
	useInputControl,
} from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { t, Trans } from '@lingui/macro'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Field, FieldLabel, FieldError } from '@repo/ui/field'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useFetcher } from 'react-router'
import { z } from 'zod'
import {
	ErrorList,
	convertErrorsToFieldFormat,
} from '#app/components/forms.tsx'
import { useConformSaveBar } from '#app/components/save-bar.tsx'

export const TeamSizeSchema = z.object({
	intent: z.string().optional(),
	size: z.string().min(1, 'Team size is required'),
	organizationId: z.string(),
})

export default function TeamSizeCard({
	organization,
	actionData,
}: {
	organization: { id: string; size?: string | null }
	actionData?: any
}) {
	const fetcher = useFetcher()
	const [form, fields] = useForm({
		id: 'team-size-form',
		constraint: getZodConstraint(TeamSizeSchema),
		lastResult: fetcher.data?.result ?? actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: TeamSizeSchema })
		},
		// Hidden inputs belong in the defaults, or Conform reports the form dirty.
		defaultValue: {
			intent: 'update-team-size',
			size: organization.size || '',
			organizationId: organization.id,
		},
	})

	const sizeControl = useInputControl(fields.size)
	useConformSaveBar(form, fetcher)

	const teamSizeOptions = [
		{ value: '1-10', label: t`1-10 people` },
		{ value: '11-50', label: t`11-50 people` },
		{ value: '51-200', label: t`51-200 people` },
		{ value: '201-500', label: t`201-500 people` },
		{ value: '500+', label: t`500+ people` },
	]

	return (
		<fetcher.Form method="POST" {...getFormProps(form)}>
			<Card>
				<CardHeader className="pb-3">
					<CardTitle className="text-base">
						<Trans>Team Size</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>Help us tailor recommendations to your organization.</Trans>
					</CardDescription>
				</CardHeader>
				<input type="hidden" name="intent" value="update-team-size" />
				<input {...getInputProps(fields.organizationId, { type: 'hidden' })} />
				<CardContent className="pt-0">
					<Field data-invalid={fields.size.errors?.length ? true : undefined}>
						<FieldLabel htmlFor={fields.size.id}>
							<Trans>Organization Size</Trans>
						</FieldLabel>
						<div className="flex flex-col gap-3 sm:flex-row sm:items-start">
							<div className="min-w-0 flex-1">
								<Select
									name={fields.size.name}
									value={sizeControl.value ?? ''}
									onValueChange={(value) => sizeControl.change(value ?? '')}
									items={[
										{ label: 'Select team size', value: null },
										...teamSizeOptions,
									]}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{teamSizeOptions.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<FieldError
									errors={convertErrorsToFieldFormat(fields.size.errors)}
								/>
							</div>
						</div>
					</Field>
					<ErrorList errors={form.errors} id={form.errorId} />
				</CardContent>
			</Card>
		</fetcher.Form>
	)
}
