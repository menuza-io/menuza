import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod/v4'
import { Trans } from '@lingui/macro'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { useFetcher } from 'react-router'
import { z } from 'zod'
import { ErrorList, Field } from '#app/components/forms.tsx'
import { useConformSaveBar } from '#app/components/save-bar.tsx'

export const siteAnalyticsActionIntent = 'update-site-analytics'

// Conform submits an empty input as `undefined`, so each ID is optional: a
// blank field disables that integration and only a filled-in value is checked.
function optionalTrackingId(pattern: RegExp, message: string) {
	return z
		.string()
		.trim()
		.optional()
		.refine((value) => !value || pattern.test(value), message)
}

export const SiteAnalyticsSchema = z.object({
	intent: z.string().optional(),
	organizationId: z.string(),
	facebookPixelId: optionalTrackingId(
		/^\d{5,20}$/,
		'Enter a valid numeric Pixel ID, or leave blank to disable.',
	),
	googleTagManagerId: optionalTrackingId(
		/^GTM-[A-Z0-9]+$/,
		'Enter a valid container ID like GTM-XXXXXXX, or leave blank to disable.',
	),
	googleAnalyticsId: optionalTrackingId(
		/^G-[A-Z0-9]+$/,
		'Enter a valid Measurement ID like G-XXXXXXXXXX, or leave blank to disable.',
	),
	tiktokPixelId: optionalTrackingId(
		/^[A-Z0-9]{10,30}$/,
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
	const fetcher = useFetcher()

	const [form, fields] = useForm({
		id: 'site-analytics-form',
		constraint: getZodConstraint(SiteAnalyticsSchema),
		lastResult: (fetcher.data?.result ?? actionData?.result) as never,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: SiteAnalyticsSchema })
		},
		// Hidden inputs belong in the defaults, or Conform reports the form dirty.
		defaultValue: {
			intent: siteAnalyticsActionIntent,
			organizationId: organization.id,
			facebookPixelId: organization.facebookPixelId ?? '',
			googleTagManagerId: organization.googleTagManagerId ?? '',
			googleAnalyticsId: organization.googleAnalyticsId ?? '',
			tiktokPixelId: organization.tiktokPixelId ?? '',
		},
	})

	useConformSaveBar(form, fetcher)

	return (
		<fetcher.Form method="post" {...getFormProps(form)}>
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
			</Card>
		</fetcher.Form>
	)
}
