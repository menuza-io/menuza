import { getFormProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod/v4'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	SITE_CONTENT_LOCALES,
	SITE_CONTENT_LOCALE_LABELS,
	isSiteContentLocale,
	type SiteContentLocale,
	type SiteLocalesConfig,
} from '@repo/common/site-locales'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Field, FieldError, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useMemo, useState } from 'react'
import { useFetcher } from 'react-router'
import { z } from 'zod'
import { convertErrorsToFieldFormat } from '#app/components/forms.tsx'
import { useSaveBar } from '#app/components/save-bar.tsx'

export const siteLocalesActionIntent = 'update-site-locales'

export const SiteLocalesSchema = z
	.object({
		organizationId: z.string(),
		locales: z.preprocess(
			(value) => {
				if (Array.isArray(value)) return value.filter(Boolean)
				if (typeof value === 'string' && value) return [value]
				return []
			},
			z.array(z.string()).min(1, 'Select at least one language'),
		),
		defaultLocale: z.string().refine(isSiteContentLocale, {
			message: 'Choose a valid default language',
		}),
	})
	.superRefine((data, ctx) => {
		if (!data.locales.every(isSiteContentLocale)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['locales'],
				message: 'One or more languages are not supported',
			})
		}

		if (!data.locales.includes(data.defaultLocale)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['defaultLocale'],
				message: 'Default language must be one of the selected languages',
			})
		}
	})

export function SiteLocalesCard({
	organization,
	localesConfig,
	actionData,
}: {
	organization: { id: string }
	localesConfig: SiteLocalesConfig
	actionData?: { result?: unknown }
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher()
	const isSubmitting = fetcher.state !== 'idle'

	const [selectedLocales, setSelectedLocales] = useState<SiteContentLocale[]>(
		localesConfig.locales,
	)
	const [defaultLocale, setDefaultLocale] = useState<SiteContentLocale>(
		localesConfig.defaultLocale,
	)

	const [form, fields] = useForm({
		id: 'site-locales',
		constraint: getZodConstraint(SiteLocalesSchema),
		lastResult: (fetcher.data?.result ?? actionData?.result) as never,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: SiteLocalesSchema })
		},
		defaultValue: {
			organizationId: organization.id,
			defaultLocale: localesConfig.defaultLocale,
		},
	})

	// The draft lives in state and the hidden inputs mirror it, so Conform cannot
	// see edits; compare with the saved config instead. Saving revalidates the
	// loader, which makes the saved config equal the draft again.
	const dirty =
		defaultLocale !== localesConfig.defaultLocale ||
		selectedLocales.join() !== localesConfig.locales.join()
	useSaveBar({
		dirty,
		saving: isSubmitting,
		onSave: () => {
			const element = document.getElementById(form.id)
			if (element instanceof HTMLFormElement) element.requestSubmit()
		},
		onDiscard: () => {
			setSelectedLocales(localesConfig.locales)
			setDefaultLocale(localesConfig.defaultLocale)
		},
	})

	const availableDefaults = useMemo(() => {
		return selectedLocales.length > 0
			? selectedLocales
			: ([localesConfig.defaultLocale] as SiteContentLocale[])
	}, [selectedLocales, localesConfig.defaultLocale])

	const selectedLocalesSummary = useMemo(() => {
		if (selectedLocales.length === 0) {
			return _(msg`Select languages`)
		}

		const labels = selectedLocales.map(
			(locale) => SITE_CONTENT_LOCALE_LABELS[locale],
		)

		const first = labels[0]
		const second = labels[1]
		if (!first || !second || labels.length <= 2) {
			return labels.join(', ')
		}

		const remainingCount = labels.length - 2
		return _(msg`${first}, ${second}, +${remainingCount} more`)
	}, [_, selectedLocales])

	const toggleLocale = (locale: SiteContentLocale, checked: boolean) => {
		setSelectedLocales((current) => {
			if (checked) {
				return SITE_CONTENT_LOCALES.filter(
					(item) => item === locale || current.includes(item),
				)
			}

			const next = current.filter((item) => item !== locale)
			if (next.length === 0) return current

			if (defaultLocale === locale) {
				setDefaultLocale(next[0]!)
			}
			return next
		})
	}

	return (
		<fetcher.Form method="POST" {...getFormProps(form)}>
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Languages</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Choose which languages your public website supports, and which one
							visitors see by default.
						</Trans>
					</CardDescription>
				</CardHeader>
				<input type="hidden" name="intent" value={siteLocalesActionIntent} />
				<input type="hidden" name="organizationId" value={organization.id} />
				{selectedLocales.map((locale) => (
					<input key={locale} type="hidden" name="locales" value={locale} />
				))}
				<input type="hidden" name="defaultLocale" value={defaultLocale} />

				<CardContent className="space-y-6">
					<Field data-invalid={Boolean(fields.locales.errors?.length)}>
						<FieldLabel id={`${fields.locales.id}-label`}>
							<Trans>Supported languages</Trans>
						</FieldLabel>
						<p className="text-muted-foreground mt-1 mb-3 text-xs">
							<Trans>
								Select the languages visitors can browse your site in.
							</Trans>
						</p>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										type="button"
										variant="outline"
										disabled={isSubmitting}
										aria-labelledby={`${fields.locales.id}-label`}
										aria-invalid={Boolean(fields.locales.errors?.length)}
										className="border-input w-full justify-between rounded-md font-normal sm:max-w-xs"
									>
										<span className="truncate">{selectedLocalesSummary}</span>
										<Icon
											name="chevron-down"
											className="text-muted-foreground size-4 shrink-0"
										/>
									</Button>
								}
							/>
							<DropdownMenuContent
								align="start"
								className="max-h-72 w-(--anchor-width) min-w-56"
							>
								{SITE_CONTENT_LOCALES.map((locale) => {
									const checked = selectedLocales.includes(locale)
									const isOnlySelected = checked && selectedLocales.length === 1
									return (
										<DropdownMenuCheckboxItem
											key={locale}
											checked={checked}
											disabled={isSubmitting || isOnlySelected}
											onCheckedChange={(value) =>
												toggleLocale(locale, value === true)
											}
										>
											<span className="flex min-w-0 flex-1 items-center justify-between gap-3">
												<span className="truncate">
													{SITE_CONTENT_LOCALE_LABELS[locale]}
												</span>
												<span className="text-muted-foreground text-xs tracking-wide uppercase">
													{locale}
												</span>
											</span>
										</DropdownMenuCheckboxItem>
									)
								})}
							</DropdownMenuContent>
						</DropdownMenu>
						<FieldError
							errors={convertErrorsToFieldFormat(fields.locales.errors)}
						/>
					</Field>

					<div className="border-border border-t pt-6">
						<Field data-invalid={Boolean(fields.defaultLocale.errors?.length)}>
							<FieldLabel htmlFor={fields.defaultLocale.id}>
								<Trans>Default language</Trans>
							</FieldLabel>
							<p className="text-muted-foreground mt-1 mb-3 text-xs">
								<Trans>
									Used when a visitor&apos;s preferred language isn&apos;t
									available, and as the required language for announcement
									content.
								</Trans>
							</p>
							<Select
								value={defaultLocale}
								onValueChange={(value) => {
									if (isSiteContentLocale(value)) setDefaultLocale(value)
								}}
								disabled={isSubmitting}
							>
								<SelectTrigger
									id={fields.defaultLocale.id}
									className="border-input w-full font-normal sm:max-w-xs"
								>
									<SelectValue placeholder={_(msg`Select default language`)}>
										{({ value }) => {
											const locale = isSiteContentLocale(value)
												? value
												: defaultLocale
											return (
												<span className="flex min-w-0 flex-1 items-center justify-between gap-3">
													<span className="truncate">
														{SITE_CONTENT_LOCALE_LABELS[locale]}
													</span>
													<span className="text-xs tracking-wide uppercase">
														{locale}
													</span>
												</span>
											)
										}}
									</SelectValue>
								</SelectTrigger>
								<SelectContent className="rounded-xl p-1.5">
									{availableDefaults.map((locale) => (
										<SelectItem
											key={locale}
											value={locale}
											className="group data-highlighted:bg-accent data-highlighted:text-accent-foreground data-selected:bg-primary data-selected:text-primary-foreground rounded-lg px-2 py-1.5 pr-8"
										>
											<span className="flex min-w-0 flex-1 items-center justify-between gap-3">
												<span className="truncate">
													{SITE_CONTENT_LOCALE_LABELS[locale]}
												</span>
												<span className="group-data-highlighted:text-accent-foreground text-xs tracking-wide uppercase">
													{locale}
												</span>
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<FieldError
								errors={convertErrorsToFieldFormat(fields.defaultLocale.errors)}
							/>
						</Field>
					</div>
				</CardContent>
			</Card>
		</fetcher.Form>
	)
}
