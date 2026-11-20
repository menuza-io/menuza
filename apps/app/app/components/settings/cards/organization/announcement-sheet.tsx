import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod/v4'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type AnnouncementStatus } from '@repo/common/announcement-window'
import {
	getLocalizedEditableValue,
	parseLocalizedString,
	pickLocalized,
	serializeLocalizedString,
	type LocalizedString,
	type SiteLocalesConfig,
} from '@repo/common/site-locales'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Field, FieldError, FieldGroup, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { Switch } from '@repo/ui/switch'
import {
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from 'react'
import { useFetcher } from 'react-router'
import { z } from 'zod'
import {
	ErrorList,
	Field as FormField,
	convertErrorsToFieldFormat,
} from '#app/components/forms.tsx'
import {
	LocaleContext,
	LocaleSwitcher,
	LocalizedInput,
	LocalizedTextarea,
	updateLocalizedValue,
} from '#app/components/website/locale-fields.tsx'
import { TranslateItemsButton } from '#app/components/website/translate-provider.tsx'
import { isSafeAnnouncementLink } from '#app/utils/safe-link.ts'
import { toDateTimeInputValue } from '#app/utils/website/schedule-format.ts'
import { toTranslateItem } from '#app/utils/website/translation.ts'

export const ANNOUNCEMENT_TYPES = [
	'info',
	'warning',
	'error',
	'success',
] as const

export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number]

export { isSafeAnnouncementLink }

export const AnnouncementSchema = z
	.object({
		id: z.string().optional(),
		contentJson: z.string().min(1, 'Content is required'),
		defaultLocale: z.string().min(1),
		type: z.enum(ANNOUNCEMENT_TYPES),
		isEnabled: z.enum(['true', 'false']).default('true'),
		addLink: z.enum(['on', 'off']).optional(),
		linkUrl: z.string().trim().optional(),
		linkLabelJson: z.string().optional(),
		linkNewTab: z.enum(['on', 'off']).optional(),
		/**
		 * The show window (#238), wall-clock `YYYY-MM-DDTHH:mm` in the site's
		 * time zone, which the server (never the browser) converts to UTC. Empty
		 * is "right away" and "until I turn it off".
		 */
		startsAtLocal: z.string().trim().optional(),
		endsAtLocal: z.string().trim().optional(),
	})
	.superRefine((data, ctx) => {
		const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u
		for (const key of ['startsAtLocal', 'endsAtLocal'] as const) {
			const value = data[key]
			if (value && !shape.test(value)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: [key],
					message: 'Enter a valid date and time',
				})
			}
		}
		// Same format in the same zone, so text order is time order.
		if (
			data.startsAtLocal &&
			data.endsAtLocal &&
			shape.test(data.startsAtLocal) &&
			shape.test(data.endsAtLocal) &&
			data.endsAtLocal <= data.startsAtLocal
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['endsAtLocal'],
				message: 'Show until must be after Show from',
			})
		}
		let contentMap: LocalizedString = {}
		try {
			contentMap = parseLocalizedString(data.contentJson, data.defaultLocale)
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['contentJson'],
				message: 'Invalid content translations',
			})
			return
		}

		const defaultContent = contentMap[data.defaultLocale]?.trim() ?? ''
		if (!defaultContent) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['contentJson'],
				message: `Content is required in the default language`,
			})
		}

		for (const [locale, value] of Object.entries(contentMap)) {
			if (value && value.length > 500) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['contentJson'],
					message: `Content for ${locale} must be 500 characters or less`,
				})
			}
		}

		const wantsLink = data.addLink === 'on'
		if (!wantsLink) return

		if (!data.linkUrl) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['linkUrl'],
				message: 'Link URL is required when a link is enabled',
			})
			return
		}

		if (!isSafeAnnouncementLink(data.linkUrl)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['linkUrl'],
				message: 'Enter an http(s) URL or a path starting with /',
			})
		}

		if (data.linkLabelJson) {
			const labels = parseLocalizedString(
				data.linkLabelJson,
				data.defaultLocale,
			)
			for (const [locale, value] of Object.entries(labels)) {
				if (value && value.length > 80) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ['linkLabelJson'],
						message: `Link label for ${locale} is too long`,
					})
				}
			}
		}
	})

export const createAnnouncementIntent = 'create-announcement'
export const updateAnnouncementIntent = 'update-announcement'
export const deleteAnnouncementIntent = 'delete-announcement'
export const toggleAnnouncementIntent = 'toggle-announcement'

export type AnnouncementRecord = {
	id: string
	content: LocalizedString
	type: AnnouncementType
	isEnabled: boolean
	linkUrl: string | null
	linkLabel: LocalizedString
	linkNewTab: boolean
	position: number | null
	/** The show window, ISO (UTC); null for "right away" / "until I turn it off". */
	startsAt: string | null
	endsAt: string | null
	status: AnnouncementStatus
	createdAt: string
	updatedAt: string
}

export function getAnnouncementPreviewText(
	announcement: Pick<AnnouncementRecord, 'content'>,
	locale: string,
	defaultLocale: string = locale,
): string {
	return (
		pickLocalized(announcement.content, locale, defaultLocale) ||
		'Untitled announcement'
	)
}

type AnnouncementSheetProps = {
	open: boolean
	onOpenChange: (open: boolean) => void
	organizationId: string
	localesConfig: SiteLocalesConfig
	announcement?: AnnouncementRecord | null
	/** Start a new announcement from this one's text (reusing an ended one). */
	asNew?: boolean
	/** The site's time zone, for the show window. */
	timeZone: string
}

export function AnnouncementSheet({
	open,
	onOpenChange,
	organizationId,
	localesConfig,
	announcement,
	asNew = false,
	timeZone,
}: AnnouncementSheetProps) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{
		status?: 'success' | 'error'
		result?: unknown
	}>()
	const isEditing = Boolean(announcement) && !asNew
	const formId = useId()
	const isSubmitting = fetcher.state !== 'idle'
	const sheetKey = asNew ? 'new' : (announcement?.id ?? 'new')
	// A reused announcement keeps its text but starts with a fresh window.
	const windowSource = asNew ? null : announcement
	const prevFetcherState = useRef(fetcher.state)
	const [formInstance, setFormInstance] = useState(0)

	const defaultLocale = localesConfig.defaultLocale
	const { activeLocale, locales } = useContext(LocaleContext)
	// LocaleSwitcher hides itself below two locales; match it here.
	const hasMultipleLocales = locales.length > 1

	const [isEnabled, setIsEnabled] = useState(announcement?.isEnabled ?? true)
	const [type, setType] = useState<AnnouncementType>(
		announcement?.type ?? 'info',
	)
	const [addLink, setAddLink] = useState(Boolean(announcement?.linkUrl))
	const [linkNewTab, setLinkNewTab] = useState(announcement?.linkNewTab ?? true)
	const [contentJson, setContentJson] = useState(() =>
		serializeLocalizedString(announcement?.content ?? {}),
	)
	const [linkLabelJson, setLinkLabelJson] = useState(() =>
		serializeLocalizedString(announcement?.linkLabel ?? {}),
	)
	const localOf = (iso: string | null | undefined) =>
		iso ? toDateTimeInputValue(iso, timeZone) : ''
	const [startsAtLocal, setStartsAtLocal] = useState(
		localOf(windowSource?.startsAt),
	)
	const [endsAtLocal, setEndsAtLocal] = useState(localOf(windowSource?.endsAt))
	const [untilOff, setUntilOff] = useState(!windowSource?.endsAt)

	useEffect(() => {
		if (!open) return
		setStartsAtLocal(localOf(windowSource?.startsAt))
		setEndsAtLocal(localOf(windowSource?.endsAt))
		setUntilOff(!windowSource?.endsAt)
		setFormInstance((current) => current + 1)
		setIsEnabled(announcement?.isEnabled ?? true)
		setType(announcement?.type ?? 'info')
		setAddLink(Boolean(announcement?.linkUrl))
		setLinkNewTab(announcement?.linkNewTab ?? true)
		setContentJson(serializeLocalizedString(announcement?.content ?? {}))
		setLinkLabelJson(serializeLocalizedString(announcement?.linkLabel ?? {}))
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, announcement, asNew, timeZone])

	const [form, fields] = useForm({
		id: `${formId}-${sheetKey}-${formInstance}`,
		constraint: getZodConstraint(AnnouncementSchema),
		lastResult:
			fetcher.data?.status === 'error'
				? (fetcher.data.result as never)
				: undefined,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: AnnouncementSchema })
		},
		defaultValue: {
			id: announcement?.id ?? '',
			contentJson,
			defaultLocale,
			type: announcement?.type ?? 'info',
			isEnabled: announcement?.isEnabled === false ? 'false' : 'true',
			addLink: announcement?.linkUrl ? 'on' : undefined,
			linkUrl: announcement?.linkUrl ?? '',
			linkLabelJson,
			linkNewTab: announcement?.linkNewTab === false ? undefined : 'on',
			startsAtLocal,
			endsAtLocal: untilOff ? '' : endsAtLocal,
		},
		shouldRevalidate: 'onBlur',
	})

	useEffect(() => {
		const finishedSubmit =
			prevFetcherState.current !== 'idle' && fetcher.state === 'idle'
		prevFetcherState.current = fetcher.state

		if (finishedSubmit && fetcher.data?.status === 'success') {
			onOpenChange(false)
		}
	}, [fetcher.state, fetcher.data, onOpenChange])

	const typeLabels: Record<AnnouncementType, string> = {
		info: _(msg`Info`),
		warning: _(msg`Warning`),
		error: _(msg`Error`),
		success: _(msg`Success`),
	}

	const missingDefaultContent = !getLocalizedEditableValue(
		contentJson,
		defaultLocale,
		defaultLocale,
	).trim()

	const translateItems = useMemo(() => {
		const items = [
			toTranslateItem('content', contentJson, defaultLocale, activeLocale),
		]
		if (addLink) {
			items.push(
				toTranslateItem(
					'linkLabel',
					linkLabelJson,
					defaultLocale,
					activeLocale,
				),
			)
		}
		return items.filter((item) => item != null)
	}, [activeLocale, addLink, contentJson, defaultLocale, linkLabelJson])

	const handleTranslateAll = useCallback(
		(translations: Array<{ id: string; text: string }>) => {
			for (const { id, text } of translations) {
				if (id === 'content') {
					setContentJson((prev) =>
						updateLocalizedValue(prev, text, activeLocale, defaultLocale),
					)
				}
				if (id === 'linkLabel') {
					setLinkLabelJson((prev) =>
						updateLocalizedValue(prev, text, activeLocale, defaultLocale),
					)
				}
			}
		},
		[activeLocale, defaultLocale],
	)

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 sm:max-w-lg"
			>
				<SheetHeader className="border-b">
					<SheetTitle>
						{isEditing ? (
							<Trans>Edit announcement</Trans>
						) : (
							<Trans>New announcement</Trans>
						)}
					</SheetTitle>
					<SheetDescription>
						{hasMultipleLocales ? (
							<Trans>
								Write the banner in the default language, then switch locales to
								translate. Enabled banners appear at the top of your public
								site.
							</Trans>
						) : (
							<Trans>
								Enabled banners appear at the top of your public site.
							</Trans>
						)}
					</SheetDescription>
				</SheetHeader>

				<fetcher.Form
					key={`${sheetKey}-${formInstance}`}
					method="POST"
					{...getFormProps(form)}
					className="flex min-h-0 flex-1 flex-col"
				>
					<input
						type="hidden"
						name="intent"
						value={
							isEditing ? updateAnnouncementIntent : createAnnouncementIntent
						}
					/>
					<input type="hidden" name="organizationId" value={organizationId} />
					{isEditing ? (
						<input type="hidden" name="id" value={announcement?.id} />
					) : null}
					<input
						type="hidden"
						name="isEnabled"
						value={isEnabled ? 'true' : 'false'}
					/>
					<input type="hidden" name="type" value={type} />
					<input type="hidden" name="defaultLocale" value={defaultLocale} />
					<input type="hidden" name="contentJson" value={contentJson} />
					<input type="hidden" name="linkLabelJson" value={linkLabelJson} />
					<input type="hidden" name="startsAtLocal" value={startsAtLocal} />
					<input
						type="hidden"
						name="endsAtLocal"
						value={untilOff ? '' : endsAtLocal}
					/>
					{addLink ? <input type="hidden" name="addLink" value="on" /> : null}
					{linkNewTab && addLink ? (
						<input type="hidden" name="linkNewTab" value="on" />
					) : null}

					<div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
						<div className="flex items-center justify-between gap-3">
							<div className="space-y-0.5">
								<p className="text-sm font-medium">
									<Trans>Enabled</Trans>
								</p>
								<p className="text-muted-foreground text-xs">
									<Trans>Show this banner on your public site</Trans>
								</p>
							</div>
							<Switch
								checked={isEnabled}
								onCheckedChange={(checked) => setIsEnabled(Boolean(checked))}
								disabled={isSubmitting}
							/>
						</div>

						<Field data-invalid={Boolean(fields.type.errors?.length)}>
							<FieldLabel htmlFor={fields.type.id}>
								<Trans>Type</Trans>
							</FieldLabel>
							<Select
								value={type}
								onValueChange={(value) => {
									if (
										value === 'info' ||
										value === 'warning' ||
										value === 'error' ||
										value === 'success'
									) {
										setType(value)
									}
								}}
								disabled={isSubmitting}
							>
								<SelectTrigger id={fields.type.id} className="w-full">
									<SelectValue placeholder={_(msg`Select type`)}>
										{typeLabels[type]}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{ANNOUNCEMENT_TYPES.map((announcementType) => (
										<SelectItem key={announcementType} value={announcementType}>
											{typeLabels[announcementType]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<FieldError
								errors={convertErrorsToFieldFormat(fields.type.errors)}
							/>
						</Field>

						<Field data-invalid={Boolean(fields.contentJson.errors?.length)}>
							<div className="flex items-center justify-between gap-2">
								<FieldLabel htmlFor={`${form.id}-content`}>
									<Trans>Content</Trans>
								</FieldLabel>
								<div className="flex items-center gap-1">
									{hasMultipleLocales && missingDefaultContent ? (
										<Badge variant="secondary">
											<Trans>Default language required</Trans>
										</Badge>
									) : null}
									<TranslateItemsButton
										items={translateItems}
										onApply={handleTranslateAll}
									/>
									<LocaleSwitcher className="max-w-none" />
								</div>
							</div>
							<LocalizedTextarea
								id={`${form.id}-content`}
								value={contentJson}
								onChange={setContentJson}
								aria-invalid={
									fields.contentJson.errors?.length ? true : undefined
								}
								aria-describedby={
									fields.contentJson.errors?.length
										? fields.contentJson.errorId
										: undefined
								}
								rows={4}
								placeholder={_(
									msg`Share an update, maintenance notice, or promotion…`,
								)}
								disabled={isSubmitting}
							/>
							<FieldError
								id={fields.contentJson.errorId}
								errors={convertErrorsToFieldFormat(fields.contentJson.errors)}
							/>
						</Field>

						<FieldGroup>
							<label className="flex items-center gap-2 text-sm">
								<Checkbox
									checked={addLink}
									onCheckedChange={(checked) => setAddLink(checked === true)}
									disabled={isSubmitting}
								/>
								<Trans>Add a link</Trans>
							</label>

							{addLink ? (
								<div className="space-y-4 pl-6">
									<FormField
										labelProps={{ children: _(msg`Link URL`) }}
										inputProps={{
											...getInputProps(fields.linkUrl, { type: 'url' }),
											placeholder: 'https://…',
											disabled: isSubmitting,
										}}
										errors={fields.linkUrl.errors}
									/>
									<Field
										data-invalid={Boolean(fields.linkLabelJson.errors?.length)}
									>
										<FieldLabel htmlFor={`${form.id}-link-label`}>
											<Trans>Link label</Trans>
										</FieldLabel>
										<LocalizedInput
											id={`${form.id}-link-label`}
											value={linkLabelJson}
											onChange={setLinkLabelJson}
											aria-invalid={
												fields.linkLabelJson.errors?.length ? true : undefined
											}
											aria-describedby={
												fields.linkLabelJson.errors?.length
													? fields.linkLabelJson.errorId
													: undefined
											}
											placeholder={_(msg`Learn more`)}
											disabled={isSubmitting}
										/>
										<FieldError
											id={fields.linkLabelJson.errorId}
											errors={convertErrorsToFieldFormat(
												fields.linkLabelJson.errors,
											)}
										/>
									</Field>
									<label className="flex items-center gap-2 text-sm">
										<Checkbox
											checked={linkNewTab}
											onCheckedChange={(checked) =>
												setLinkNewTab(checked === true)
											}
											disabled={isSubmitting}
										/>
										<Trans>Open in new tab</Trans>
									</label>
								</div>
							) : null}
						</FieldGroup>

						<FieldGroup>
							<Field
								data-invalid={Boolean(fields.startsAtLocal.errors?.length)}
							>
								<FieldLabel htmlFor={`${form.id}-from`}>
									<Trans>Show from</Trans>
								</FieldLabel>
								<Input
									id={`${form.id}-from`}
									type="datetime-local"
									value={startsAtLocal}
									onChange={(event) =>
										setStartsAtLocal(event.currentTarget.value)
									}
									disabled={isSubmitting}
								/>
								<p className="text-muted-foreground text-xs">
									<Trans>Leave empty to show it right away.</Trans>
								</p>
								<FieldError
									errors={convertErrorsToFieldFormat(
										fields.startsAtLocal.errors,
									)}
								/>
							</Field>
							<label className="flex items-center gap-2 text-sm">
								<Checkbox
									checked={untilOff}
									onCheckedChange={(checked) => setUntilOff(checked === true)}
									disabled={isSubmitting}
								/>
								<Trans>Until I turn it off</Trans>
							</label>
							{!untilOff ? (
								<Field
									data-invalid={Boolean(fields.endsAtLocal.errors?.length)}
								>
									<FieldLabel htmlFor={`${form.id}-until`}>
										<Trans>Show until</Trans>
									</FieldLabel>
									<Input
										id={`${form.id}-until`}
										type="datetime-local"
										value={endsAtLocal}
										onChange={(event) =>
											setEndsAtLocal(event.currentTarget.value)
										}
										disabled={isSubmitting}
									/>
									<FieldError
										errors={convertErrorsToFieldFormat(
											fields.endsAtLocal.errors,
										)}
									/>
								</Field>
							) : null}
							<p className="text-muted-foreground text-xs">
								<Trans>Times are in your site's time zone ({timeZone}).</Trans>
							</p>
						</FieldGroup>

						<ErrorList errors={form.errors} id={form.errorId} />
					</div>

					<SheetFooter className="border-t sm:flex-row sm:justify-end">
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={isSubmitting}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={isSubmitting}>
							{isEditing ? (
								<Trans>Save changes</Trans>
							) : (
								<Trans>Add announcement</Trans>
							)}
						</Button>
					</SheetFooter>
				</fetcher.Form>
			</SheetContent>
		</Sheet>
	)
}
