import { Trans } from '@lingui/macro'
import {
	publicFormFieldsSchema,
	toPublicFormProjection,
	type PublicFormField,
} from '@repo/common/public-form'
import {
	parseSiteLocalesConfig,
	pickLocalized,
} from '@repo/common/site-locales'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Spinner } from '@repo/ui/spinner'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { ScrollArea } from '@repo/ui/scroll-area'
import { Textarea } from '@repo/ui/textarea'
import {
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import {
	Link,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useBlocker,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'

import {
	useAIPanel,
	useAIPanelHotkey,
} from '#app/components/ai/ai-panel-context.tsx'
import { GlobalAIToggle } from '#app/components/ai/global-ai-panel.tsx'
import { FormBuilderSidebar } from '#app/components/website/form-builder-sidebar.tsx'
import { LocaleContext } from '#app/components/website/locale-fields.tsx'
import { TranslateProvider } from '#app/components/website/translate-provider.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	deleteCachedPublicForm,
	setCachedPublicForm,
} from '#app/utils/sites/kv-cache.server.ts'
import { parseTenantFormResponse } from '#app/utils/website/tenant-form-response.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

type FormField = PublicFormField
type WebsiteForm = {
	id: string
	name: string
	description: string | null
	fields: FormField[]
	status: 'draft' | 'published'
	submitLabel: string
	successMessage: string
}
type FormSubmission = {
	id: string
	values: Record<string, string>
	createdAt: string | null
}

const updateSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500),
	fields: publicFormFieldsSchema,
	submitLabel: z.string().trim().min(1).max(50),
	successMessage: z.string().trim().min(1).max(300),
	status: z.enum(['draft', 'published']),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { fetchTenant, orgId } = await getOperatorTenantClient(
		request,
		params.orgSlug || '',
	)
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		siteLocales: true,
		siteDefaultLocale: true,
	})
	const response = await fetchTenant(
		`/operator/forms/${encodeURIComponent(params.formId || '')}/submissions`,
		{ signal: AbortSignal.timeout(3000) },
	)
	if (!response.ok) {
		if (response.status === 404) {
			throw new Response('Form not found', { status: 404 })
		}
		throw new Response('Regional forms unavailable', { status: 502 })
	}
	const { locales } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const payload = (await response.json()) as {
		form: WebsiteForm
		submissions: FormSubmission[]
	}
	return {
		...payload,
		locales,
		defaultLocale: organization.siteDefaultLocale ?? 'en',
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const { fetchTenant, orgId } = await getOperatorTenantClient(
		request,
		params.orgSlug || '',
	)
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)
	const parsed = updateSchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.issues[0]?.message ?? 'Check the form.' },
			{ status: 400 },
		)
	}
	const response = await fetchTenant(
		`/operator/forms/${encodeURIComponent(params.formId || '')}`,
		{ method: 'PUT', body: JSON.stringify(parsed.data) },
	)
	if (!response.ok) {
		return Response.json(
			{ error: 'Unable to save the form.' },
			{ status: response.status },
		)
	}
	const payload = await response.json().catch(() => null)
	const savedForm = parseTenantFormResponse(payload)
	if (!savedForm) {
		return Response.json({ error: 'Unable to save the form.' }, { status: 502 })
	}
	const projection = toPublicFormProjection(savedForm)
	if (projection) await setCachedPublicForm(orgId, projection)
	else await deleteCachedPublicForm(orgId, savedForm.id)
	return { success: true, form: savedForm }
}

function FormFieldPreview({ field }: { field: FormField }) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const label = pickLocalized(field.label, activeLocale, defaultLocale)
	const choices = (field.options ?? []).map((choice) =>
		pickLocalized(choice, activeLocale, defaultLocale),
	)

	if (field.type === 'heading') {
		return (
			<h2 className="pt-2 text-lg font-semibold tracking-tight">{label}</h2>
		)
	}
	if (field.type === 'paragraph') {
		return (
			<p className="text-muted-foreground text-sm leading-relaxed">{label}</p>
		)
	}
	const controlId = `preview-${field.id}`
	return (
		<fieldset className="space-y-2">
			{field.type === 'single_choice' || field.type === 'multiple_choice' ? (
				<legend className="text-sm font-medium">
					{label}
					{field.required ? (
						<span className="text-destructive ml-1">*</span>
					) : null}
				</legend>
			) : (
				<Label htmlFor={controlId}>
					{label}
					{field.required ? (
						<span className="text-destructive ml-1">*</span>
					) : null}
				</Label>
			)}
			{field.type === 'textarea' ? (
				<Textarea id={controlId} required={field.required} rows={4} />
			) : field.type === 'single_choice' || field.type === 'multiple_choice' ? (
				<div className="space-y-2 pt-1">
					{choices.map((choice, index) => (
						<label
							key={`${choice}-${index}`}
							className="flex items-center gap-2 text-sm"
						>
							<input
								type={field.type === 'single_choice' ? 'radio' : 'checkbox'}
								name={field.id}
								value={choice}
								required={field.required && field.type === 'single_choice'}
								className="border-input accent-primary size-4"
							/>
							{choice}
						</label>
					))}
				</div>
			) : (
				<Input
					id={controlId}
					type={
						field.type === 'datetime'
							? 'datetime-local'
							: field.type === 'name'
								? 'text'
								: field.type
					}
					autoComplete={
						field.type === 'name'
							? 'name'
							: field.type === 'email'
								? 'email'
								: field.type === 'tel'
									? 'tel'
									: undefined
					}
					required={field.required}
				/>
			)}
		</fieldset>
	)
}

export default function WebsiteFormBuilderRoute() {
	const initial = useLoaderData<typeof loader>()
	const fetcher = useFetcher<typeof action>()
	useAIPanelHotkey()
	const { isOpen: isAIPanelOpen, isExpanded: isAIPanelExpanded } = useAIPanel()
	const [isLg, setIsLg] = useState(true)
	const [form, setForm] = useState(initial.form)
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [mode, setMode] = useState<'build' | 'preview' | 'responses'>('build')
	const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop')
	const [testSuccess, setTestSuccess] = useState(false)
	const [savedForm, setSavedForm] = useState(initial.form)
	const [activeLocale, setActiveLocale] = useState(initial.defaultLocale)
	const pendingSnapshot = useRef('')

	useEffect(() => {
		const mql = window.matchMedia('(min-width: 1024px)')
		const onChange = () => setIsLg(mql.matches)
		onChange()
		mql.addEventListener('change', onChange)
		return () => mql.removeEventListener('change', onChange)
	}, [])

	useEffect(() => {
		if (fetcher.data && 'form' in fetcher.data && fetcher.data.form) {
			const responseForm = fetcher.data.form
			setForm((current) =>
				JSON.stringify(current) === pendingSnapshot.current
					? responseForm
					: current,
			)
			setSavedForm(responseForm)
		}
	}, [fetcher.data])

	const isDirty = useMemo(
		() => JSON.stringify(form) !== JSON.stringify(savedForm),
		[form, savedForm],
	)
	const blocker = useBlocker(isDirty)
	useEffect(() => {
		if (blocker.state !== 'blocked') return
		if (window.confirm('Leave without saving your form changes?')) {
			blocker.proceed()
		} else {
			blocker.reset()
		}
	}, [blocker])
	useEffect(() => {
		const warn = (event: BeforeUnloadEvent) => {
			if (!isDirty) return
			event.preventDefault()
		}
		window.addEventListener('beforeunload', warn)
		return () => window.removeEventListener('beforeunload', warn)
	}, [isDirty])
	const submitForm = useCallback(
		(nextForm: WebsiteForm) => {
			pendingSnapshot.current = JSON.stringify(nextForm)
			setForm(nextForm)
			void fetcher.submit(nextForm, {
				method: 'post',
				encType: 'application/json',
			})
		},
		[fetcher],
	)
	const save = useCallback(() => {
		submitForm(form)
	}, [form, submitForm])
	const publish = useCallback(() => {
		submitForm({ ...form, status: 'published' })
	}, [form, submitForm])
	const unpublish = useCallback(() => {
		submitForm({ ...form, status: 'draft' })
	}, [form, submitForm])
	const isSaving = fetcher.state !== 'idle'
	const canPublish = form.status === 'draft' || isDirty

	const localizedName = pickLocalized(
		form.name,
		activeLocale,
		initial.defaultLocale,
	)
	const localizedDescription = pickLocalized(
		form.description,
		activeLocale,
		initial.defaultLocale,
	)
	const localizedSubmitLabel = pickLocalized(
		form.submitLabel,
		activeLocale,
		initial.defaultLocale,
	)
	const localizedSuccessMessage = pickLocalized(
		form.successMessage,
		activeLocale,
		initial.defaultLocale,
	)

	const preview = (
		<main className="bg-muted/30 flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 sm:p-8">
			<div
				className={cn(
					'bg-background border-border w-full rounded-xl border shadow-sm transition-[max-width] duration-200 motion-reduce:transition-none',
					viewport === 'mobile' ? 'max-w-[375px]' : 'max-w-2xl',
				)}
			>
				<div className="border-border border-b px-6 py-5 sm:px-8">
					<h1 className="text-xl font-semibold tracking-tight">
						{localizedName}
					</h1>
					{localizedDescription ? (
						<p className="text-muted-foreground mt-2 text-sm leading-relaxed">
							{localizedDescription}
						</p>
					) : null}
				</div>
				{testSuccess ? (
					<div className="flex min-h-64 flex-col items-center justify-center p-8 text-center">
						<span className="mb-4 flex size-11 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
							<Icon name="check" className="size-5" />
						</span>
						<p className="font-medium">{localizedSuccessMessage}</p>
						<Button
							variant="link"
							className="mt-2"
							onClick={() => setTestSuccess(false)}
						>
							<Trans>Test again</Trans>
						</Button>
					</div>
				) : (
					<form
						className="space-y-5 p-6 sm:p-8"
						onSubmit={(event) => {
							event.preventDefault()
							if (event.currentTarget.reportValidity()) setTestSuccess(true)
						}}
					>
						{form.fields.map((field) => (
							<FormFieldPreview key={field.id} field={field} />
						))}
						<Button type="submit" className="w-full sm:w-auto">
							{localizedSubmitLabel}
						</Button>
						<p className="text-muted-foreground text-center text-xs">
							<Trans>Test mode — responses are not saved</Trans>
						</p>
					</form>
				)}
			</div>
		</main>
	)

	return (
		<LocaleContext.Provider
			value={{
				activeLocale,
				defaultLocale: initial.defaultLocale,
				locales: initial.locales,
				setActiveLocale,
			}}
		>
			<TranslateProvider
				activeLocale={activeLocale}
				defaultLocale={initial.defaultLocale}
			>
				<div className="bg-muted fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden">
					<header className="border-border bg-background flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3">
						<div className="flex min-w-0 items-center gap-2">
							<Button
								variant="ghost"
								size="icon-xs"
								render={<Link to=".." relative="path" />}
								aria-label="Back to forms"
							>
								<Icon name="arrow-left" className="size-4" />
							</Button>
							<div className="bg-border hidden h-5 w-px sm:block" aria-hidden />
							<span className="max-w-48 truncate text-sm font-medium">
								{localizedName}
							</span>
							<div className="text-muted-foreground hidden items-center gap-1.5 text-xs sm:flex">
								<span
									className={cn(
										'size-1.5 rounded-full',
										form.status === 'published'
											? 'bg-emerald-500'
											: 'bg-muted-foreground/40',
									)}
								/>
								{form.status === 'published' ? (
									<Trans>Published</Trans>
								) : (
									<Trans>Draft</Trans>
								)}
							</div>
						</div>
						<div className="flex items-center gap-2">
							<div className="bg-muted hidden rounded-lg p-0.5 lg:flex">
								<Button
									variant="ghost"
									size="icon-xs"
									className={cn(
										viewport === 'desktop' && 'bg-background shadow-sm',
									)}
									onClick={() => setViewport('desktop')}
									aria-label="Desktop preview"
									aria-pressed={viewport === 'desktop'}
								>
									<Icon name="laptop" className="size-3.5" />
								</Button>
								<Button
									variant="ghost"
									size="icon-xs"
									className={cn(
										viewport === 'mobile' && 'bg-background shadow-sm',
									)}
									onClick={() => setViewport('mobile')}
									aria-label="Mobile preview"
									aria-pressed={viewport === 'mobile'}
								>
									<Icon name="smartphone" className="size-3.5" />
								</Button>
							</div>
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									setMode(mode === 'responses' ? 'build' : 'responses')
								}
							>
								<Icon
									name={mode === 'responses' ? 'blocks' : 'file-text'}
									className="size-4"
								/>
								<span className="hidden sm:inline">
									{mode === 'responses' ? (
										<Trans>Builder</Trans>
									) : (
										<Trans>Responses</Trans>
									)}
								</span>
								{mode !== 'responses' ? (
									<Badge variant="secondary" className="ml-1">
										{initial.submissions.length}
									</Badge>
								) : null}
							</Button>
							<GlobalAIToggle />
							{form.status === 'draft' ? (
								<Button
									size="sm"
									variant="outline"
									onClick={save}
									disabled={!isDirty || isSaving}
								>
									{isSaving ? (
										<Trans>Saving…</Trans>
									) : (
										<Trans>Save draft</Trans>
									)}
								</Button>
							) : null}
							<Button
								size="sm"
								onClick={publish}
								disabled={!canPublish || isSaving}
							>
								{isSaving ? (
									<Spinner />
								) : form.status === 'draft' ? (
									<Trans>Publish</Trans>
								) : (
									<Trans>Publish updates</Trans>
								)}
							</Button>
							{form.status === 'published' ? (
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												variant="ghost"
												size="icon-xs"
												aria-label="More actions"
											>
												<Icon name="ellipsis" className="size-4" />
											</Button>
										}
									/>
									<DropdownMenuContent align="end" className="min-w-44">
										<DropdownMenuItem
											variant="destructive"
											onClick={unpublish}
											disabled={isSaving}
										>
											<Trans>Unpublish</Trans>
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							) : null}
						</div>
					</header>
					{fetcher.data && 'error' in fetcher.data && fetcher.data.error ? (
						<p
							className="bg-destructive/10 text-destructive border-destructive/20 border-b px-4 py-2 text-center text-sm"
							role="alert"
						>
							{String(fetcher.data.error)}
						</p>
					) : null}

					<div className="bg-background flex h-11 shrink-0 items-center justify-center border-b lg:hidden">
						<div className="bg-muted flex rounded-lg p-0.5">
							<Button
								variant="ghost"
								size="sm"
								className={cn(mode === 'build' && 'bg-background shadow-sm')}
								onClick={() => setMode('build')}
								aria-pressed={mode === 'build'}
							>
								<Trans>Build</Trans>
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className={cn(mode === 'preview' && 'bg-background shadow-sm')}
								onClick={() => setMode('preview')}
								aria-pressed={mode === 'preview'}
							>
								<Trans>Preview</Trans>
							</Button>
						</div>
					</div>

					{mode === 'responses' ? (
						<Responses
							form={form}
							submissions={initial.submissions}
							defaultLocale={initial.defaultLocale}
						/>
					) : (
						<div
							className={cn(
								'flex min-h-0 flex-1 gap-2 p-2',
								isAIPanelOpen && !isAIPanelExpanded && isLg && 'pr-107',
							)}
						>
							<FormBuilderSidebar
								form={form}
								setForm={setForm}
								selectedId={selectedId}
								setSelectedId={setSelectedId}
								className={cn(
									mode === 'build' ? 'flex' : 'hidden',
									'shrink-0 lg:w-80',
								)}
							/>
							<div
								className={cn(
									'min-h-0 min-w-0 flex-1 lg:flex',
									mode === 'preview' ? 'flex' : 'hidden',
								)}
							>
								{preview}
							</div>
						</div>
					)}
				</div>
			</TranslateProvider>
		</LocaleContext.Provider>
	)
}

function Responses({
	form,
	submissions,
	defaultLocale,
}: {
	form: WebsiteForm
	submissions: FormSubmission[]
	defaultLocale: string
}) {
	const { activeLocale } = useContext(LocaleContext)
	const responseFields = form.fields.filter(
		(field) => field.type !== 'heading' && field.type !== 'paragraph',
	)
	return (
		<ScrollArea className="bg-background min-h-0 flex-1">
			<div className="mx-auto max-w-6xl p-6 sm:p-10">
				<div className="mb-6">
					<h1 className="text-xl font-semibold">
						<Trans>Responses</Trans>
					</h1>
					<p className="text-muted-foreground mt-1 text-sm">
						<Trans>
							Submissions are stored in this organization’s regional tenant
							database.
						</Trans>
					</p>
				</div>
				<div className="border-border overflow-x-auto rounded-xl border">
					<table className="w-full text-left text-sm">
						<thead className="bg-muted/50 border-b">
							<tr>
								<th className="px-4 py-3 font-medium">
									<Trans>Submitted</Trans>
								</th>
								{responseFields.map((field) => (
									<th key={field.id} className="px-4 py-3 font-medium">
										{pickLocalized(field.label, activeLocale, defaultLocale)}
									</th>
								))}
							</tr>
						</thead>
						<tbody className="divide-y">
							{submissions.length === 0 ? (
								<tr>
									<td
										colSpan={responseFields.length + 1}
										className="text-muted-foreground px-4 py-16 text-center"
									>
										<Trans>No responses yet.</Trans>
									</td>
								</tr>
							) : (
								submissions.map((submission) => (
									<tr key={submission.id}>
										<td className="px-4 py-3 whitespace-nowrap">
											{submission.createdAt
												? new Date(submission.createdAt).toLocaleString()
												: '—'}
										</td>
										{responseFields.map((field) => (
											<td
												key={field.id}
												className="max-w-sm px-4 py-3 whitespace-pre-wrap"
											>
												{submission.values[field.id] || '—'}
											</td>
										))}
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</div>
		</ScrollArea>
	)
}
