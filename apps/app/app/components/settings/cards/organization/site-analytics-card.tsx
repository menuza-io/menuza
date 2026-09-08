import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Form, useNavigation } from 'react-router'
import { z } from 'zod'
import { ErrorList, Field } from '#app/components/forms.tsx'

export const siteAnalyticsActionIntent = 'update-site-analytics'

export const SiteAnalyticsSchema = z.object({
	organizationId: z.string(),
	facebookPixelId: z
		.string()
		.trim()
		.refine(
			(value) => value === '' || /^\d{5,20}$/.test(value),
			'Enter a valid numeric Pixel ID, or leave blank to disable.',
		),
	googleTagManagerId: z
		.string()
		.trim()
		.refine(
			(value) => value === '' || /^GTM-[A-Z0-9]+$/.test(value),
			'Enter a valid container ID like GTM-XXXXXXX, or leave blank to disable.',
		),
	googleAnalyticsId: z
		.string()
		.trim()
		.refine(
			(val) => val === '' || /^G-[A-Z0-9]+$/.test(val),
			'Enter a valid Measurement ID like G-XXXXXXXXXX, or leave blank to disable.',
		),
	tiktokPixelId: z
		.string()
		.trim()
		.refine(
			(value) => value === '' || /^[A-Z0-9]{10,30}$/.test(value),
			'Enter a valid TikTok Pixel ID, or leave blank to disable.',
		),
})

export function SiteAnalyticsCard({
	organization,
	actionData,
}: {
	organization: {
		id: string
		facebookPixelId?: string | null
		googleTagManagerId?: string | null
		googleAnalyticsId?: string | null
		tiktokPixelId?: string | null
	}
	actionData?: { result?: unknown }
}) {
	const navigation = useNavigation()
	const isSubmitting = navigation.state !== 'idle'

	const [form, fields] = useForm({
		id: 'site-analytics-form',
		constraint: getZodConstraint(SiteAnalyticsSchema),
		lastResult: actionData?.result as never,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: SiteAnalyticsSchema })
		},
		defaultValue: {
			organizationId: organization.id,
			facebookPixelId: organization.facebookPixelId ?? '',
			googleTagManagerId: organization.googleTagManagerId ?? '',
			googleAnalyticsId: organization.googleAnalyticsId ?? '',
			tiktokPixelId: organization.tiktokPixelId ?? '',
		},
	})

	return (
		<Form method="post" {...getFormProps(form)}>
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Analytics and tracking</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Connect the analytics platforms you use on your public website.
							Leave any field blank to disable that integration.
						</Trans>
					</CardDescription>
				</CardHeader>
				<input type="hidden" name="intent" value={siteAnalyticsActionIntent} />
				<input type="hidden" name="organizationId" value={organization.id} />
				<CardContent className="space-y-4">
					<Field
						labelProps={{ children: <Trans>Facebook Pixel ID</Trans> }}
						inputProps={{
							...getInputProps(fields.facebookPixelId, { type: 'text' }),
							placeholder: '123456789012345',
							autoComplete: 'off',
						}}
						errors={fields.facebookPixelId.errors}
					/>
					<Field
						labelProps={{ children: <Trans>Google Tag Manager ID</Trans> }}
						inputProps={{
							...getInputProps(fields.googleTagManagerId, { type: 'text' }),
							placeholder: 'GTM-XXXXXXX',
							autoComplete: 'off',
						}}
						errors={fields.googleTagManagerId.errors}
					/>
					<Field
						labelProps={{ children: <Trans>Google Analytics ID</Trans> }}
						inputProps={{
							...getInputProps(fields.googleAnalyticsId, { type: 'text' }),
							placeholder: 'G-XXXXXXXXXX',
							autoComplete: 'off',
						}}
						errors={fields.googleAnalyticsId.errors}
					/>
					<Field
						labelProps={{ children: <Trans>TikTok Pixel ID</Trans> }}
						inputProps={{
							...getInputProps(fields.tiktokPixelId, { type: 'text' }),
							placeholder: 'CXXXXXXXXXXXXXXXXXXX',
							autoComplete: 'off',
						}}
						errors={fields.tiktokPixelId.errors}
					/>
					<ErrorList errors={form.errors} id={form.errorId} />
				</CardContent>
				<CardFooter className="justify-end border-t">
					<Button type="submit" disabled={isSubmitting}>
						<Trans>Save changes</Trans>
					</Button>
				</CardFooter>
			</Card>
		</Form>
	)
}
