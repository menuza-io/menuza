import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type JobPostingStatus } from '@repo/common/job-posting'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import { FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { toast } from 'sonner'
import { useSaveBar } from '#app/components/save-bar.tsx'
import {
	SelectField,
	TextField,
	type Option,
} from '#app/components/staff/controls.tsx'
import { PageWithBack } from '#app/components/staff/page-back.tsx'
import {
	LocaleContext,
	LocaleSwitcher,
} from '#app/components/website/locale-fields.tsx'
import {
	TranslateButton,
	TranslateProvider,
} from '#app/components/website/translate-provider.tsx'
import {
	emptyPostingForm,
	firstInvalidStep,
	formFromPosting,
	JOB_CURRENCIES,
	POSTING_STEPS,
	publishBlockers,
	readLocalized,
	toPayload,
	validateStep,
	writeLocalized,
	type PostingForm,
	type PostingFormError,
	type PostingFormErrors,
	type PostingStep,
} from '#app/utils/hiring/job-posting-form.ts'
import {
	type PostingActionData,
	type PostingDetail,
} from '#app/utils/hiring/job-posting-types.ts'
import { DescriptionEditor } from './description-editor.tsx'
import { useJobLabels } from './job-labels.ts'
import { JobSharePanel } from './job-share-panel.tsx'
import { JobStatus } from './job-status.tsx'
import { JobSummary } from './job-summary.tsx'
import {
	LocalizedTextField,
	TranslatingNotice,
	useTranslating,
} from './localized-fields.tsx'
import { ScreenerEditor } from './screener-editor.tsx'

type Props = {
	orgSlug: string
	/** `null` while writing a new job. */
	posting: PostingDetail | null
	defaultCurrency: string
	/** Where this organization's public site lives, with no trailing slash. */
	siteOrigin: string
	sitePublished: boolean
	initialStep: PostingStep
	/** The organization's site languages; job copy is written in each. */
	defaultLocale: string
	supportedLocales: string[]
}

/**
 * The job editor: role, pay, questions, review. One draft in memory, saved only
 * on an explicit button, so nothing half written reaches a draft by accident
 * and nothing goes live without the Publish button on the last step. Leaving
 * with unsaved changes asks first.
 */
export function JobEditor({
	orgSlug,
	posting,
	defaultCurrency,
	siteOrigin,
	sitePublished,
	initialStep,
	defaultLocale,
	supportedLocales,
}: Props) {
	const { _ } = useLingui()
	const labels = useJobLabels()
	const fetcher = useFetcher<PostingActionData>()
	const aiFetcher = useFetcher<PostingActionData>()
	const headingId = useId()

	const [saved, setSaved] = useState<PostingDetail | null>(posting)
	const [form, setForm] = useState<PostingForm>(() =>
		saved
			? formFromPosting(saved)
			: emptyPostingForm({ currency: defaultCurrency }),
	)
	const [step, setStep] = useState<PostingStep>(initialStep)
	const [activeLocale, setActiveLocale] = useState(defaultLocale)
	const [errors, setErrors] = useState<PostingFormErrors>({})
	const [serverError, setServerError] = useState<string | null>(null)
	const [beforeDraft, setBeforeDraft] = useState<PostingForm | null>(null)
	const stepHeading = useRef<HTMLHeadingElement>(null)

	const isGeneral = saved?.isGeneral === true
	const status: JobPostingStatus = saved?.status ?? 'draft'
	const savedKey = JSON.stringify(
		saved
			? toPayload(formFromPosting(saved))
			: toPayload(emptyPostingForm({ currency: defaultCurrency })),
	)
	const dirty = JSON.stringify(toPayload(form)) !== savedKey
	const busyIntent =
		fetcher.state !== 'idle' ? String(fetcher.formData?.get('intent')) : null
	const busy = busyIntent !== null

	useEffect(() => {
		const data = fetcher.data
		if (!data) return
		if (data.ok && data.intent !== 'ai_draft') {
			setSaved(data.posting)
			setForm(formFromPosting(data.posting))
			setServerError(null)
			setErrors({})
			toast.success(
				data.intent === 'publish'
					? _(t`The job is live.`)
					: data.intent === 'close'
						? _(t`The job is closed.`)
						: _(t`Saved.`),
			)
			return
		}
		if (!data.ok) setServerError(describeFailure(data, _))
	}, [fetcher.data, _])

	useEffect(() => {
		const data = aiFetcher.data
		if (!data) return
		if (data.ok && data.intent === 'ai_draft') {
			setBeforeDraft(form)
			setForm((current) => ({
				...current,
				title: data.draft.title,
				positionName: data.draft.positionName,
				employmentType: data.draft.employmentType,
				descriptionHtml: data.draft.descriptionHtml,
				questions: data.draft.questions,
			}))
			setStep('role')
			toast.success(_(t`Draft added. Read it through before you publish.`))
		}
		// Only the arrival of a new reply matters here.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [aiFetcher.data])

	useEffect(() => {
		stepHeading.current?.focus()
	}, [step])

	const patch = (changes: Partial<PostingForm>) =>
		setForm((current) => ({ ...current, ...changes }))
	const update = (change: (current: PostingForm) => PostingForm) =>
		setForm(change)

	const stepIndex = POSTING_STEPS.indexOf(step)
	const stepLabels: Record<PostingStep, string> = {
		role: _(t`Role`),
		pay: _(t`Pay`),
		screener: _(t`Questions`),
		review: _(t`Review`),
	}
	const options = { general: isGeneral }
	const blockers = publishBlockers(form, options)

	function submit(intent: 'save' | 'publish' | 'close' | 'delete') {
		const body = new FormData()
		body.set('intent', intent)
		body.set('step', step)
		if (intent === 'save' || intent === 'publish') {
			body.set('payload', JSON.stringify(toPayload(form)))
		}
		void fetcher.submit(body, { method: 'post' })
	}

	function goNext() {
		const found = validateStep(form, step, options)
		setErrors(found)
		if (Object.keys(found).length > 0) return
		setStep(POSTING_STEPS[Math.min(stepIndex + 1, POSTING_STEPS.length - 1)]!)
	}

	function saveDraft() {
		const invalid = firstInvalidStep(form, options)
		if (invalid) {
			setStep(invalid)
			setErrors(validateStep(form, invalid, options))
			return
		}
		submit('save')
	}

	// The bar is shown for saved postings only; a new one is just guarded so
	// leaving asks first. Publish and delete count as saving on a dirty job, so
	// Discard and Save cannot interrupt them; a clean job never shows the bar.
	useSaveBar({
		dirty,
		showBar: saved !== null,
		saving: busy && dirty,
		onSave: saveDraft,
		onDiscard: () => {
			if (!saved) return
			setForm(formFromPosting(saved))
			setBeforeDraft(null)
			setErrors({})
			setServerError(null)
		},
	})

	function publish() {
		const invalid = firstInvalidStep(form, options)
		if (invalid) {
			setStep(invalid)
			setErrors(validateStep(form, invalid, options))
			return
		}
		if (blockers.length > 0) {
			setStep(blockers[0]!.step)
			return
		}
		submit('publish')
	}

	const shareUrl = saved ? `${siteOrigin}/careers/${saved.slug}` : null
	const live = status === 'published'
	const title = form.title.trim() || _(t`New job`)

	return (
		<LocaleContext.Provider
			value={{
				activeLocale,
				defaultLocale,
				locales: supportedLocales,
				setActiveLocale,
			}}
		>
			<TranslateProvider
				activeLocale={activeLocale}
				defaultLocale={defaultLocale}
			>
				<div className="flex flex-col gap-6">
					<PageWithBack to={`/${orgSlug}/staff/hiring`} label={_(t`Jobs`)}>
						<PageHeader
							title={title}
							description={
								saved ? (
									<span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
										<JobStatus status={status} />
										{isGeneral ? (
											<span>
												<Trans>Standing application</Trans>
											</span>
										) : null}
									</span>
								) : (
									<Trans>
										Describe the role, the pay and what you want to ask.
									</Trans>
								)
							}
							actions={<LocaleSwitcher className="max-w-none" />}
						/>
					</PageWithBack>

					<Tabs
						value={step}
						onValueChange={(value) => setStep(value as PostingStep)}
					>
						<TabsList aria-label={_(t`Steps`)}>
							{POSTING_STEPS.map((name) => (
								<TabsTrigger
									key={name}
									value={name}
									className="min-h-11 flex-none md:min-h-0"
								>
									{stepLabels[name]}
								</TabsTrigger>
							))}
						</TabsList>
					</Tabs>

					{serverError ? (
						<Alert variant="destructive" className="max-w-prose">
							<AlertDescription>{serverError}</AlertDescription>
						</Alert>
					) : null}

					<form
						className="flex max-w-2xl flex-col gap-6"
						onSubmit={(event) => {
							event.preventDefault()
							if (step === 'review') return
							goNext()
						}}
						noValidate
					>
						<h2
							ref={stepHeading}
							tabIndex={-1}
							id={headingId}
							className="text-base font-medium outline-none"
						>
							{
								{
									role: _(t`What is the job?`),
									pay: _(t`What does it pay?`),
									screener: _(t`What do you want to ask?`),
									review: _(t`Check it over`),
								}[step]
							}
						</h2>

						{step === 'role' ? (
							<RoleStep
								form={form}
								errors={errors}
								patch={patch}
								update={update}
								employmentOptions={labels.employmentOptions}
								aiFetcher={aiFetcher}
								canUndoDraft={beforeDraft !== null}
								onUndoDraft={() => {
									if (beforeDraft) setForm(beforeDraft)
									setBeforeDraft(null)
								}}
							/>
						) : null}

						{step === 'pay' ? (
							<PayStep
								form={form}
								errors={errors}
								patch={patch}
								isGeneral={isGeneral}
							/>
						) : null}

						{step === 'screener' ? (
							<ScreenerEditor
								form={form}
								errors={errors}
								onChange={(questions) => patch({ questions })}
								update={update}
							/>
						) : null}

						{step === 'review' ? (
							<ReviewStep
								form={form}
								blockers={blockers}
								status={status}
								saved={saved !== null}
								dirty={dirty}
								sitePublished={sitePublished}
								orgSlug={orgSlug}
								shareUrl={live ? shareUrl : null}
								fileName={saved?.slug ?? 'job'}
								goTo={setStep}
								busy={busy}
								onClose={() => submit('close')}
								onDelete={() => submit('delete')}
							/>
						) : null}

						<div className="bg-background sticky bottom-0 flex flex-wrap items-center justify-between gap-2 border-t py-3">
							<Button
								type="button"
								variant="ghost"
								disabled={stepIndex === 0}
								onClick={() => setStep(POSTING_STEPS[stepIndex - 1]!)}
							>
								<Icon name="arrow-left" className="rtl:rotate-180" />
								<Trans>Back</Trans>
							</Button>
							<div className="flex flex-wrap items-center gap-2">
								{saved === null ? (
									<Button
										type="button"
										variant="outline"
										disabled={busy}
										onClick={saveDraft}
									>
										{busyIntent === 'save' ? (
											<Trans>Saving...</Trans>
										) : (
											<Trans>Save draft</Trans>
										)}
									</Button>
								) : null}
								{step !== 'review' ? (
									<Button type="submit">
										<Trans>Next</Trans>
										<Icon name="arrow-right" className="rtl:rotate-180" />
									</Button>
								) : live ? null : (
									<Button type="button" disabled={busy} onClick={publish}>
										{busyIntent === 'publish' ? (
											<Trans>Publishing...</Trans>
										) : status === 'draft' ? (
											<Trans>Publish</Trans>
										) : (
											<Trans>Reopen job</Trans>
										)}
									</Button>
								)}
							</div>
						</div>
					</form>
				</div>
			</TranslateProvider>
		</LocaleContext.Provider>
	)
}

function errorText(
	code: PostingFormError | undefined,
	_: ReturnType<typeof useLingui>['_'],
) {
	if (!code) return null
	return {
		title_required: _(t`Give the job a title.`),
		title_short: _(t`Use at least 3 letters.`),
		position_required: _(t`Say which position this is.`),
		pay_required: _(t`Enter a pay amount, or choose not to show pay.`),
		pay_invalid: _(t`Use a number like 18 or 18.50.`),
		pay_range: _(t`The top of the range must be at least the bottom.`),
		closes_on_invalid: _(t`Choose a date.`),
		closes_on_past: _(t`Choose a date that is not in the past.`),
		prompt_required: _(t`Write the question.`),
	}[code]
}

function describeFailure(
	data: Extract<PostingActionData, { ok: false }>,
	_: ReturnType<typeof useLingui>['_'],
) {
	switch (data.error) {
		case 'not_found':
			return _(t`This job no longer exists. Go back to the list.`)
		case 'invalid_input':
			return _(t`Some details need fixing. Check each step.`)
		case 'description_too_long':
			return _(t`The description is too long. Shorten it and try again.`)
		case 'cannot_publish':
			return _(t`This job is not ready to go live yet. See the Review step.`)
		case 'invalid_transition':
			return _(
				t`That is not possible for a job in this state. Reload the page.`,
			)
		case 'not_deletable':
			return _(t`Close a live job before deleting it.`)
		case 'read_only':
			return _(t`This account can look but not change jobs.`)
		case 'draft_failed':
			return data.reason === 'rate_limited'
				? _(t`You have used the drafting tool a lot. Try again in an hour.`)
				: _(
						t`The drafting tool could not help right now. Write it yourself or try again.`,
					)
		default:
			return _(t`Something went wrong. Try again.`)
	}
}

function RoleStep({
	form,
	errors,
	patch,
	update,
	employmentOptions,
	aiFetcher,
	canUndoDraft,
	onUndoDraft,
}: {
	form: PostingForm
	errors: PostingFormErrors
	patch: (changes: Partial<PostingForm>) => void
	update: (change: (current: PostingForm) => PostingForm) => void
	employmentOptions: Option[]
	aiFetcher: ReturnType<typeof useFetcher<PostingActionData>>
	canUndoDraft: boolean
	onUndoDraft: () => void
}) {
	const { _ } = useLingui()
	const descriptionLabel = useId()
	const { activeLocale, defaultLocale, translating } = useTranslating()
	const [prompt, setPrompt] = useState('')
	const drafting = aiFetcher.state !== 'idle'
	const aiError =
		aiFetcher.data && !aiFetcher.data.ok
			? describeFailure(aiFetcher.data, _)
			: null

	return (
		<div className="flex flex-col gap-6">
			{translating ? (
				<TranslatingNotice />
			) : (
				<div className="flex flex-col gap-2">
					<FieldLabel htmlFor="job-ai-prompt" className="text-sm font-medium">
						<Trans>Start from a few words</Trans>
					</FieldLabel>
					<Textarea
						id="job-ai-prompt"
						rows={2}
						maxLength={1000}
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						placeholder={_(
							t`Evening line cook, three nights a week, must be comfortable on grill`,
						)}
					/>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Only what you type here and your business name are used. Nothing
							is saved until you save.
						</Trans>
					</p>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							type="button"
							variant="outline"
							disabled={drafting || !prompt.trim()}
							onClick={() => {
								const body = new FormData()
								body.set('intent', 'ai_draft')
								body.set('prompt', prompt)
								void aiFetcher.submit(body, { method: 'post' })
							}}
						>
							<Icon name="sparkles" />
							{drafting ? (
								<Trans>Drafting...</Trans>
							) : (
								<Trans>Write a draft</Trans>
							)}
						</Button>
						{canUndoDraft ? (
							<Button type="button" variant="ghost" onClick={onUndoDraft}>
								<Icon name="undo-2" />
								<Trans>Undo draft</Trans>
							</Button>
						) : null}
					</div>
					{aiError ? (
						<Alert variant="destructive">
							<AlertDescription>{aiError}</AlertDescription>
						</Alert>
					) : null}
				</div>
			)}

			<LocalizedTextField
				label={<Trans>Job title</Trans>}
				hint={<Trans>What applicants see, like "Evening line cook".</Trans>}
				value={readLocalized(form, 'title', activeLocale, defaultLocale)}
				fallback={form.title}
				maxLength={120}
				error={translating ? null : errorText(errors.title, _)}
				onChange={(value) =>
					update((current) =>
						writeLocalized(
							current,
							'title',
							value,
							activeLocale,
							defaultLocale,
						),
					)
				}
			/>
			{translating ? null : (
				<>
					<TextField
						label={<Trans>Position</Trans>}
						hint={
							<Trans>
								The role on your team, like "Line cook". Used when you hire.
							</Trans>
						}
						value={form.positionName}
						maxLength={80}
						error={errorText(errors.positionName, _)}
						onChange={(event) => patch({ positionName: event.target.value })}
					/>
					<SelectField
						label={<Trans>Type</Trans>}
						options={employmentOptions}
						value={form.employmentType}
						onValueChange={(employmentType) =>
							patch({
								employmentType: employmentType as PostingForm['employmentType'],
							})
						}
					/>
				</>
			)}

			<div className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-2">
					<span id={descriptionLabel} className="text-sm font-medium">
						<Trans>Description</Trans>
					</span>
					{translating ? (
						<TranslateButton
							allowHtml
							textToTranslate={form.descriptionHtml}
							onTranslate={(value) =>
								update((current) =>
									writeLocalized(
										current,
										'descriptionHtml',
										value,
										activeLocale,
										defaultLocale,
									),
								)
							}
						/>
					) : null}
				</div>
				<DescriptionEditor
					key={activeLocale}
					labelId={descriptionLabel}
					value={readLocalized(
						form,
						'descriptionHtml',
						activeLocale,
						defaultLocale,
					)}
					onChange={(value) =>
						update((current) =>
							writeLocalized(
								current,
								'descriptionHtml',
								value,
								activeLocale,
								defaultLocale,
							),
						)
					}
				/>
			</div>
		</div>
	)
}

function PayStep({
	form,
	errors,
	patch,
	isGeneral,
}: {
	form: PostingForm
	errors: PostingFormErrors
	patch: (changes: Partial<PostingForm>) => void
	isGeneral: boolean
}) {
	const { _ } = useLingui()
	const labels = useJobLabels()
	const shows = form.payType !== 'none'
	return (
		<div className="flex flex-col gap-6">
			<SelectField
				label={<Trans>Pay</Trans>}
				options={labels.payOptions}
				value={form.payType}
				onValueChange={(payType) =>
					patch({ payType: payType as PostingForm['payType'] })
				}
			/>
			{shows ? (
				<div className="grid gap-6 sm:grid-cols-3">
					<TextField
						label={<Trans>From</Trans>}
						inputMode="decimal"
						dir="ltr"
						value={form.payMin}
						error={errorText(errors.payMin, _)}
						onChange={(event) => patch({ payMin: event.target.value })}
					/>
					<TextField
						label={<Trans>To</Trans>}
						hint={<Trans>Leave empty for one rate.</Trans>}
						inputMode="decimal"
						dir="ltr"
						value={form.payMax}
						error={errorText(errors.payMax, _)}
						onChange={(event) => patch({ payMax: event.target.value })}
					/>
					<SelectField
						label={<Trans>Currency</Trans>}
						options={JOB_CURRENCIES.map((currency) => ({
							value: currency,
							label: currency,
						}))}
						value={form.currency}
						onValueChange={(currency) => patch({ currency })}
					/>
				</div>
			) : (
				<p className="text-muted-foreground max-w-prose text-sm text-pretty">
					<Trans>
						The page will not mention pay. Showing a range tends to bring more
						applications.
					</Trans>
				</p>
			)}

			{isGeneral ? (
				<p className="text-muted-foreground max-w-prose text-sm text-pretty">
					<Trans>The general application stays open until you close it.</Trans>
				</p>
			) : (
				<TextField
					label={<Trans>Closes on</Trans>}
					type="date"
					optional
					hint={
						<Trans>
							The job closes by itself at the end of this day. Leave it empty to
							keep it open until you close it.
						</Trans>
					}
					value={form.closesOn}
					error={errorText(errors.closesOn, _)}
					onChange={(event) => patch({ closesOn: event.target.value })}
				/>
			)}
		</div>
	)
}

function ReviewStep({
	form,
	blockers,
	status,
	saved,
	dirty,
	sitePublished,
	orgSlug,
	shareUrl,
	fileName,
	goTo,
	busy,
	onClose,
	onDelete,
}: {
	form: PostingForm
	blockers: ReturnType<typeof publishBlockers>
	status: JobPostingStatus
	saved: boolean
	dirty: boolean
	sitePublished: boolean
	orgSlug: string
	shareUrl: string | null
	fileName: string
	goTo: (step: PostingStep) => void
	busy: boolean
	onClose: () => void
	onDelete: () => void
}) {
	const { _ } = useLingui()
	const [confirm, setConfirm] = useState<'close' | 'delete' | null>(null)
	const blockerText = {
		title: _(t`Add a job title.`),
		description: _(t`Write a description of at least a couple of sentences.`),
		pay: _(t`Enter the pay, or choose not to show it.`),
		closes_on_past: _(t`The closing date has passed. Choose a new one.`),
	}
	const live = status === 'published'

	return (
		<div className="flex flex-col gap-8">
			{status !== 'published' && blockers.length > 0 ? (
				<div className="flex flex-col gap-2">
					<p className="text-sm font-medium">
						<Trans>Before you can publish</Trans>
					</p>
					<ul className="flex flex-col gap-1">
						{blockers.map((blocker) => (
							<li key={blocker.code} className="text-sm">
								<Button
									type="button"
									variant="link"
									className="h-auto justify-start p-0 text-start md:h-auto"
									onClick={() => goTo(blocker.step)}
								>
									{blockerText[blocker.code]}
								</Button>
							</li>
						))}
					</ul>
				</div>
			) : null}

			{live && !sitePublished ? (
				<p className="text-sm text-pretty">
					<Trans>
						Your website is not published yet, so people cannot see this job.{' '}
						<Link
							to={`/${orgSlug}/settings`}
							className="underline underline-offset-4"
						>
							Publish your website
						</Link>
						.
					</Trans>
				</p>
			) : null}

			{shareUrl ? (
				<section
					aria-labelledby="share-heading"
					className="flex flex-col gap-3"
				>
					<h3 id="share-heading" className="text-sm font-medium">
						<Trans>Share this job</Trans>
					</h3>
					<JobSharePanel url={shareUrl} fileName={fileName} />
				</section>
			) : null}

			<JobSummary form={form} />

			{saved ? (
				<div className="flex flex-wrap gap-2 border-t pt-6">
					{live ? (
						<Button
							type="button"
							variant="outline"
							disabled={busy || dirty}
							onClick={() => setConfirm('close')}
						>
							<Trans>Close this job</Trans>
						</Button>
					) : (
						<Button
							type="button"
							variant="destructive"
							disabled={busy}
							onClick={() => setConfirm('delete')}
						>
							<Icon name="trash-2" />
							<Trans>Delete this job</Trans>
						</Button>
					)}
					{live && dirty ? (
						<p className="text-muted-foreground self-center text-sm">
							<Trans>Save your changes before closing.</Trans>
						</p>
					) : null}
				</div>
			) : null}

			<AlertDialog
				open={confirm !== null}
				onOpenChange={(open) => !open && setConfirm(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{confirm === 'delete' ? (
								<Trans>Delete this job?</Trans>
							) : (
								<Trans>Close this job?</Trans>
							)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{confirm === 'delete' ? (
								<Trans>
									The job and its link are removed for good. Applications you
									already received are kept.
								</Trans>
							) : (
								<Trans>
									The job disappears from your careers page and its link stops
									accepting applications. You can reopen it later.
								</Trans>
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant={confirm === 'delete' ? 'destructive' : 'default'}
							onClick={() => {
								if (confirm === 'delete') onDelete()
								else onClose()
								setConfirm(null)
							}}
						>
							{confirm === 'delete' ? (
								<Trans>Delete</Trans>
							) : (
								<Trans>Close</Trans>
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
