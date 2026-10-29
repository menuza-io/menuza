import { getFormProps, useForm, type SubmissionResult } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import { Form, Link, useNavigation } from 'react-router'
import {
	MediaLibraryPicker,
	type MediaLibraryAsset,
} from '#app/components/media-library/media-library-picker.tsx'
import { isScheduleLocalValid } from '#app/utils/social/time.ts'
import { SocialPostFormSchema } from '#app/utils/social/post-schema.ts'
import {
	SOCIAL_MAX_MEDIA,
	SOCIAL_PLATFORM_RULES,
	socialPostProblems,
	type SocialPlatform,
	type SocialPostMedia,
} from '#app/utils/social/platforms.ts'
import {
	SOCIAL_PROBLEM_LABELS,
	socialFormErrors,
} from './social-labels.ts'
import { SocialPlatformIcon } from './social-ui.tsx'

export type ComposerAccount = {
	id: string
	platform: SocialPlatform
	name: string
	username: string | null
	status: 'active' | 'needs_reauth'
}

export type ComposerDefaults = {
	body: string
	accountIds: string[]
	media: SocialPostMedia[]
	/** `datetime-local` value in `timeZone`, or empty. */
	scheduledAt: string
}

export function SocialPostComposer({
	id,
	orgSlug,
	accounts,
	defaults,
	lastResult,
	timeZone,
	cancelTo,
}: {
	id: string
	orgSlug: string
	accounts: ComposerAccount[]
	defaults: ComposerDefaults
	lastResult: SubmissionResult<string[]> | undefined
	timeZone: string
	cancelTo: string
}) {
	const { _ } = useLingui()
	const navigation = useNavigation()
	const submittingIntent =
		navigation.state === 'submitting'
			? navigation.formData?.get('intent')
			: null
	const [form, fields] = useForm({
		id,
		lastResult,
		shouldRevalidate: 'onInput',
		constraint: getZodConstraint(SocialPostFormSchema),
		defaultValue: {
			body: defaults.body,
			accountIds: defaults.accountIds,
			mediaIds: defaults.media.map((item) => item.mediaId),
			scheduledAt: defaults.scheduledAt || undefined,
			timeZone,
		},
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: SocialPostFormSchema })
		},
	})
	const [selected, setSelected] = useState<string[]>(() =>
		defaults.accountIds.filter((accountId) =>
			accounts.some(
				(account) => account.id === accountId && account.status === 'active',
			),
		),
	)
	const [body, setBody] = useState(defaults.body)
	const [media, setMedia] = useState<SocialPostMedia[]>(defaults.media)
	const [scheduledAt, setScheduledAt] = useState(defaults.scheduledAt)

	const activeSelected = selected.filter((accountId) =>
		accounts.some(
			(account) => account.id === accountId && account.status === 'active',
		),
	)
	const platforms = [
		...new Set(
			accounts
				.filter((account) => activeSelected.includes(account.id))
				.map((account) => account.platform),
		),
	]
	const problems = socialPostProblems({
		body,
		mediaCount: media.length,
		platforms,
	})
	const textLimit = Math.min(
		...(platforms.length > 0 ? platforms : (['facebook'] as const)).map(
			(platform) => SOCIAL_PLATFORM_RULES[platform].maxText,
		),
	)
	const textLength = [...body.trim()].length
	const canSend = activeSelected.length > 0 && problems.length === 0
	const canSchedule =
		Boolean(scheduledAt) && isScheduleLocalValid(scheduledAt, timeZone)
	const busy = submittingIntent != null

	const toggleAccount = (accountId: string, checked: boolean) => {
		const account = accounts.find((item) => item.id === accountId)
		if (!account || account.status === 'needs_reauth') return
		setSelected((current) =>
			checked
				? [...new Set([...current, accountId])]
				: current.filter((value) => value !== accountId),
		)
	}

	const addMedia = (asset: MediaLibraryAsset) =>
		setMedia((current) =>
			current.some((item) => item.mediaId === asset.id) ||
			current.length >= SOCIAL_MAX_MEDIA
				? current
				: [
						...current,
						{ mediaId: asset.id, url: asset.url, altText: asset.altText },
					],
		)

	return (
		<Form method="post" {...getFormProps(form)} className="space-y-8">
			<input type="hidden" name="timeZone" value={timeZone} />
			{media.map((item) => (
				<input
					key={item.mediaId}
					type="hidden"
					name="mediaIds"
					value={item.mediaId}
				/>
			))}

			{form.errors?.length ? (
				<Alert variant="destructive">
					<Icon name="circle-alert" />
					<AlertTitle>{_(msg`This post can’t be sent yet`)}</AlertTitle>
					<AlertDescription>
						<ul className="list-disc ps-4">
							{socialFormErrors(_, form.errors)?.map((error) => (
								<li key={error.message}>{error.message}</li>
							))}
						</ul>
					</AlertDescription>
				</Alert>
			) : null}

			<div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
				<div className="space-y-8">
					<FieldSet
						data-invalid={fields.accountIds.errors?.length ? true : undefined}
					>
						<FieldLegend>{_(msg`Post to`)}</FieldLegend>
						{accounts.length === 0 ? (
							<Alert>
								<Icon name="link-2" />
								<AlertTitle>{_(msg`No accounts connected`)}</AlertTitle>
								<AlertDescription>
									<p>
										{_(
											msg`Connect a Facebook Page or an Instagram account to publish. You can still save a draft.`,
										)}
									</p>
									<Link
										to={`/${orgSlug}/marketing/social/accounts`}
										className="underline underline-offset-4"
									>
										{_(msg`Connect accounts`)}
									</Link>
								</AlertDescription>
							</Alert>
						) : (
							<div className="grid gap-3 sm:grid-cols-2">
								{accounts.map((account) => {
									const disabled = account.status === 'needs_reauth'
									return (
										<Label
											key={account.id}
											className="border-border has-[[data-checked]]:border-primary flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border p-3 has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-60"
										>
											<Checkbox
												name="accountIds"
												value={account.id}
												checked={selected.includes(account.id)}
												disabled={disabled}
												onCheckedChange={(checked) =>
													toggleAccount(account.id, checked === true)
												}
											/>
											<SocialPlatformIcon platform={account.platform} />
											<span className="flex min-w-0 flex-col">
												<span className="truncate font-medium">
													{account.name}
												</span>
												{account.username ? (
													<span className="text-muted-foreground truncate text-xs font-normal">
														@{account.username}
													</span>
												) : null}
											</span>
											{disabled ? (
												<Badge variant="warning" className="ms-auto">
													{_(msg`Reconnect`)}
												</Badge>
											) : null}
										</Label>
									)
								})}
							</div>
						)}
						<FieldError
							errors={socialFormErrors(_, fields.accountIds.errors)}
						/>
					</FieldSet>

					<Field data-invalid={fields.body.errors?.length ? true : undefined}>
						<FieldLabel htmlFor={fields.body.id}>{_(msg`Text`)}</FieldLabel>
						<Textarea
							id={fields.body.id}
							name={fields.body.name}
							value={body}
							onChange={(event) => setBody(event.target.value)}
							rows={8}
							placeholder={_(msg`What would you like to share?`)}
						/>
						<FieldDescription>
							<span
								className={textLength > textLimit ? 'text-destructive' : undefined}
							>
								{(() => {
									const used = textLength.toLocaleString()
									const limit = textLimit.toLocaleString()
									return _(msg`${used} of ${limit} characters`)
								})()}
							</span>
						</FieldDescription>
						<FieldError errors={socialFormErrors(_, fields.body.errors)} />
					</Field>

					<FieldSet>
						<FieldLegend>{_(msg`Images`)}</FieldLegend>
						<FieldDescription>
							{_(
								msg`Instagram needs at least one image. Several images become a carousel.`,
							)}
						</FieldDescription>
						{media.length > 0 ? (
							<ul className="grid grid-cols-3 gap-3 sm:grid-cols-5">
								{media.map((item, index) => (
									<li
										key={item.mediaId}
										className="border-border relative aspect-square overflow-hidden rounded-lg border"
									>
										<img
											src={item.url}
											alt={item.altText ?? ''}
											className="size-full object-cover"
										/>
										<Button
											type="button"
											variant="secondary"
											size="icon-xs"
											className="absolute end-1 top-1"
											onClick={() =>
												setMedia((current) =>
													current.filter((_, i) => i !== index),
												)
											}
											aria-label={_(msg`Remove image`)}
										>
											<Icon name="x" />
										</Button>
									</li>
								))}
							</ul>
						) : null}
						<div>
							<MediaLibraryPicker
								orgSlug={orgSlug}
								onSelect={addMedia}
								disabled={media.length >= SOCIAL_MAX_MEDIA}
								triggerLabel={_(msg`Add image`)}
							/>
						</div>
						<FieldError errors={socialFormErrors(_, fields.mediaIds.errors)} />
					</FieldSet>

					<Field
						data-invalid={fields.scheduledAt.errors?.length ? true : undefined}
					>
						<FieldLabel htmlFor={fields.scheduledAt.id}>
							{_(msg`Schedule for`)}
						</FieldLabel>
						<Input
							id={fields.scheduledAt.id}
							name={fields.scheduledAt.name}
							type="datetime-local"
							value={scheduledAt}
							onChange={(event) => setScheduledAt(event.target.value)}
							className="max-w-xs"
						/>
						<FieldDescription>
							{_(msg`Times are in ${timeZone}.`)}
						</FieldDescription>
						<FieldError
							errors={socialFormErrors(_, fields.scheduledAt.errors)}
						/>
					</Field>
				</div>

				<aside className="space-y-4">
					<h2 className="text-sm font-medium">{_(msg`Preview`)}</h2>
					<div className="border-border bg-card space-y-3 rounded-lg border p-4">
						<div className="text-muted-foreground flex items-center gap-2 text-xs">
							{platforms.length > 0 ? (
								platforms.map((platform) => (
									<SocialPlatformIcon key={platform} platform={platform} />
								))
							) : (
								<span>{_(msg`Choose an account to preview`)}</span>
							)}
						</div>
						{body.trim() ? (
							<p className="text-sm wrap-anywhere whitespace-pre-wrap">
								{body}
							</p>
						) : null}
						{media.length > 0 ? (
							<div className="border-border relative aspect-square overflow-hidden rounded-md border">
								<img
									src={media[0]!.url}
									alt={media[0]!.altText ?? ''}
									className="size-full object-cover"
								/>
								{media.length > 1 ? (
									<Badge variant="secondary" className="absolute end-2 top-2">
										1/{media.length}
									</Badge>
								) : null}
							</div>
						) : null}
					</div>
					{problems.length > 0 ? (
						<ul className="text-warning space-y-1 text-sm">
							{problems.map(({ platform, problem }) => (
								<li key={`${platform}:${problem}`} className="flex gap-2">
									<Icon name="alert-triangle" className="mt-0.5 size-4 shrink-0" />
									{_(SOCIAL_PROBLEM_LABELS[platform][problem])}
								</li>
							))}
						</ul>
					) : null}
				</aside>
			</div>

			<div className="flex flex-wrap gap-3">
				<Button
					type="submit"
					name="intent"
					value="publish"
					disabled={!canSend || busy}
				>
					<Icon name={submittingIntent === 'publish' ? 'loader' : 'send'} />
					{submittingIntent === 'publish'
						? _(msg`Publishing…`)
						: _(msg`Publish now`)}
				</Button>
				<Button
					type="submit"
					name="intent"
					value="schedule"
					variant="secondary"
					disabled={!canSend || !canSchedule || busy}
				>
					<Icon name="calendar-clock" />
					{_(msg`Schedule`)}
				</Button>
				<Button
					type="submit"
					name="intent"
					value="draft"
					variant="outline"
					disabled={busy}
				>
					{_(msg`Save draft`)}
				</Button>
				<Button variant="ghost" render={<Link to={cancelTo} />}>
					{_(msg`Cancel`)}
				</Button>
			</div>
		</Form>
	)
}
