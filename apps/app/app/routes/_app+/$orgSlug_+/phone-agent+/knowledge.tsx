import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	FAQ_ANSWER_MAX,
	FAQ_QUESTION_MAX,
	faqBankFor,
	type FaqCategory,
	type FaqEntry,
	type Pronunciation,
} from '@repo/phone-agent'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	FieldErrorText,
	localId,
	SettingsSaveBar,
	useSettingsErrorText,
	useSettingsFormState,
	useUnsavedChangesWarning,
} from '#app/components/phone-agent/settings-page.tsx'
import { useVerticalLabels } from '#app/components/phone-agent/vertical-labels.ts'
import { phoneAgentVertical } from '#app/utils/phone-agent/vertical.ts'
import { type Route } from './+types/knowledge.ts'
import { type KnowledgeActionResult } from './knowledge.server.ts'

export { action, loader } from './knowledge.server.ts'

type LoaderData = Route.ComponentProps['loaderData']

const FAQ_BANK = faqBankFor(phoneAgentVertical)

type FaqRow = {
	id: string
	category: FaqCategory
	question: string
	answer: string
	/** Filled by the AI and not saved yet. */
	draft?: boolean
}

function initialRows(saved: FaqEntry[]): FaqRow[] {
	const byId = new Map(
		saved.filter((entry) => !entry.scopeId).map((entry) => [entry.id, entry]),
	)
	const bank = FAQ_BANK.map((question) => ({
		id: question.id,
		category: question.category,
		question: question.question,
		answer: byId.get(question.id)?.answer ?? '',
	}))
	const bankIds = new Set(FAQ_BANK.map((question) => question.id))
	const custom = saved
		.filter((entry) => !entry.scopeId && !bankIds.has(entry.id))
		.map((entry) => ({
			id: entry.id,
			category: entry.category,
			question: entry.question,
			answer: entry.answer,
		}))
	return [...bank, ...custom]
}

export default function PhoneAgentKnowledge() {
	const { faq, pronunciations, keyterms, scopes, canUpdate, versions } =
		useLoaderData<LoaderData>()
	const [faqDirty, setFaqDirty] = useState(false)
	const [speechDirty, setSpeechDirty] = useState(false)
	useUnsavedChangesWarning(canUpdate && (faqDirty || speechDirty))
	return (
		<div className="flex flex-col gap-8">
			<PageHeader
				title={<Trans>Knowledge</Trans>}
				description={
					<Trans>
						Answers to common questions, and how the agent hears and says the
						names callers use.
					</Trans>
				}
			/>
			<AnnotatedLayout>
				<FaqSection
					saved={faq}
					// Scoped answers are kept as they are.
					scopedEntries={faq.filter((entry) => entry.scopeId)}
					scopes={scopes}
					versions={versions}
					canUpdate={canUpdate}
					onDirtyChange={setFaqDirty}
				/>
				<SpeechSection
					pronunciations={pronunciations}
					keyterms={keyterms}
					versions={versions}
					canUpdate={canUpdate}
					onDirtyChange={setSpeechDirty}
				/>
			</AnnotatedLayout>
		</div>
	)
}

function FaqSection({
	saved,
	scopedEntries,
	scopes,
	versions,
	canUpdate,
	onDirtyChange,
}: {
	saved: FaqEntry[]
	scopedEntries: FaqEntry[]
	scopes: LoaderData['scopes']
	versions: LoaderData['versions']
	canUpdate: boolean
	onDirtyChange: (dirty: boolean) => void
}) {
	const { _ } = useLingui()
	const describeError = useSettingsErrorText()
	const drafter = useFetcher<KnowledgeActionResult>()
	const [rows, setRows] = useState(() => initialRows(saved))
	const { faqCategories } = useVerticalLabels()
	const [tab, setTab] = useState<FaqCategory>(faqCategories[0]?.id ?? 'general')
	const [scopeId, setScopeId] = useState(scopes[0]?.id ?? '')
	// Without scopes, drafts use the business details for the whole org.
	const canDraft = scopes.length === 0 || Boolean(scopeId)
	// Field errors are keyed by position in the saved list (`faq.3.answer`),
	// which skips empty rows, so remember which row each position came from.
	const [submittedIds, setSubmittedIds] = useState<string[]>([])
	// AI drafts included in the save in flight; their badges stay until it
	// succeeds, so a failed save still shows which answers need review.
	const submittedDraftIds = useRef<Set<string>>(new Set())
	const form = useSettingsFormState({
		saved,
		versions,
		// The "AI draft" badge is not saved, so it doesn't count as an edit.
		draft: rows.map(({ id, category, question, answer }) => [
			id,
			category,
			question,
			answer,
		]),
		reset: (next) => setRows(initialRows(next)),
		canUpdate,
		onSaved: () => {
			const savedDrafts = submittedDraftIds.current
			submittedDraftIds.current = new Set()
			setRows((current) =>
				current.map((row) =>
					row.draft && savedDrafts.has(row.id) ? { ...row, draft: false } : row,
				),
			)
		},
	})
	const { pending, fieldErrors, save, dirty } = form
	useEffect(() => {
		onDirtyChange(dirty)
	}, [dirty, onDirtyChange])
	const disabled = !canUpdate || pending
	const rowErrors = (id: string) => {
		const index = submittedIds.indexOf(id)
		if (index === -1) return {}
		return {
			question:
				fieldErrors[`faq.${index}.question`] ?? fieldErrors[`faq.${index}.id`],
			answer: fieldErrors[`faq.${index}.answer`],
		}
	}

	useEffect(() => {
		const data = drafter.data
		if (drafter.state !== 'idle' || !data?.ok || !data.drafts) return
		const drafts = new Map(data.drafts.map((draft) => [draft.id, draft.answer]))
		setRows((current) =>
			current.map((row) =>
				!row.answer.trim() && drafts.has(row.id)
					? { ...row, answer: drafts.get(row.id)!, draft: true }
					: row,
			),
		)
	}, [drafter.state, drafter.data])

	const answered = rows.filter((row) => row.answer.trim()).length
	const draftCount = rows.filter((row) => row.draft).length
	const unanswered = rows.filter(
		(row) => !row.answer.trim() && row.category !== 'custom',
	)
	const drafting = drafter.state !== 'idle'
	const draftError =
		drafter.data && !drafter.data.ok
			? describeError(drafter.data.error)
			: undefined
	const draftedNone =
		drafter.state === 'idle' &&
		drafter.data?.ok &&
		drafter.data.drafts?.length === 0

	const counts = useMemo(() => {
		const out = new Map<FaqCategory, number>()
		for (const row of rows) {
			if (row.answer.trim())
				out.set(row.category, (out.get(row.category) ?? 0) + 1)
		}
		return out
	}, [rows])

	function update(id: string, patch: Partial<FaqRow>) {
		setRows((current) =>
			current.map((row) =>
				row.id === id ? { ...row, ...patch, draft: false } : row,
			),
		)
	}

	function onSubmit(event: React.FormEvent) {
		event.preventDefault()
		const entries: FaqEntry[] = [
			...rows
				.filter((row) => row.question.trim() && row.answer.trim())
				.map((row) => ({
					id: row.id,
					category: row.category,
					question: row.question.trim(),
					answer: row.answer.trim(),
					scopeId: null,
				})),
			...scopedEntries,
		]
		setSubmittedIds(entries.map((entry) => entry.id))
		submittedDraftIds.current = new Set(
			rows.filter((row) => row.draft).map((row) => row.id),
		)
		save({ faq: entries })
	}

	return (
		<form className="flex flex-col gap-6" onSubmit={onSubmit}>
			<AnnotatedSection
				title={<Trans>Frequently asked questions</Trans>}
				description={
					<Trans>
						Answer the questions callers ask you. Leave a question empty to skip
						it; the agent offers to take a message instead of guessing.
					</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-5">
						<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
							<div className="min-w-0">
								<p className="text-sm font-medium">
									{draftCount ? (
										<Trans>
											{answered} answered, {draftCount} drafted and not saved
										</Trans>
									) : (
										<Trans>{answered} answered</Trans>
									)}
								</p>
							</div>
							{canUpdate ? (
								<div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
									{scopes.length > 1 ? (
										<div>
											<Select
												value={scopeId}
												items={scopes.map((scope) => ({
													value: scope.id,
													label: scope.name,
												}))}
												onValueChange={(value) => {
													if (value) setScopeId(String(value))
												}}
											>
												<SelectTrigger
													id="faq-draft-scope"
													aria-label={_(msg`Draft answers for`)}
													className="w-full sm:w-48"
												>
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{scopes.map((scope) => (
														<SelectItem key={scope.id} value={scope.id}>
															{scope.name}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
									) : null}
									<Button
										type="button"
										variant="outline"
										disabled={drafting || !canDraft || unanswered.length === 0}
										onClick={() =>
											void drafter.submit(
												{
													intent: 'draft-faq',
													scopeId: scopes.length ? scopeId : null,
													questions: unanswered
														.slice(0, 60)
														.map(({ id, question }) => ({ id, question })),
												},
												{ method: 'POST', encType: 'application/json' },
											)
										}
									>
										<Icon name="sparkles" />
										{drafting ? (
											<Trans>Drafting…</Trans>
										) : (
											<Trans>Draft answers with AI</Trans>
										)}
									</Button>
								</div>
							) : null}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>
								AI drafts use your business details and training rules, and only
								fill empty answers. Review each one before saving.
							</Trans>
						</p>
						{draftError ? (
							<p role="alert" className="text-destructive text-sm">
								{draftError}
							</p>
						) : null}
						{draftedNone ? (
							<p role="status" className="text-muted-foreground text-sm">
								<Trans>
									Nothing could be answered from your business details. Add the
									answers yourself.
								</Trans>
							</p>
						) : null}

						<Tabs
							value={tab}
							onValueChange={(value) => {
								const next = faqCategories.find((item) => item.id === value)
								if (next) setTab(next.id)
							}}
						>
							<div className="overflow-x-auto pb-1">
								<TabsList>
									{faqCategories.map(({ id: category, label }) => (
										<TabsTrigger key={category} value={category}>
											{label}
											{counts.get(category) ? (
												<Badge variant="secondary">
													{counts.get(category)}
												</Badge>
											) : null}
										</TabsTrigger>
									))}
								</TabsList>
							</div>
							{faqCategories.map(({ id: category }) => (
								<TabsContent
									key={category}
									value={category}
									className="flex flex-col gap-5 pt-4"
								>
									{rows
										.filter((row) => row.category === category)
										.map((row) => (
											<FaqRowEditor
												key={row.id}
												row={row}
												custom={category === 'custom'}
												disabled={disabled}
												questionError={rowErrors(row.id).question}
												answerError={rowErrors(row.id).answer}
												onChange={(patch) => update(row.id, patch)}
												onRemove={() =>
													setRows((current) =>
														current.filter((item) => item.id !== row.id),
													)
												}
											/>
										))}
									{category === 'custom' ? (
										<Button
											type="button"
											variant="outline"
											size="sm"
											className="self-start"
											disabled={disabled}
											onClick={() =>
												setRows((current) => [
													...current,
													{
														id: localId('custom'),
														category: 'custom',
														question: '',
														answer: '',
													},
												])
											}
										>
											<Icon name="plus" />
											<Trans>Add a question</Trans>
										</Button>
									) : null}
								</TabsContent>
							))}
						</Tabs>
					</CardContent>
				</Card>
			</AnnotatedSection>
			<FieldErrorText error={fieldErrors.faq} />
			<SettingsSaveBar
				canUpdate={canUpdate}
				form={form}
				label={<Trans>Save answers</Trans>}
			/>
		</form>
	)
}

function FaqRowEditor({
	row,
	custom,
	disabled,
	questionError,
	answerError,
	onChange,
	onRemove,
}: {
	row: FaqRow
	custom: boolean
	disabled: boolean
	questionError?: string
	answerError?: string
	onChange: (patch: Partial<FaqRow>) => void
	onRemove: () => void
}) {
	const { _ } = useLingui()
	const answerId = `faq-answer-${row.id}`
	return (
		<div className="flex flex-col gap-1.5">
			{custom ? (
				<div className="flex items-center gap-2">
					<Input
						aria-label={_(msg`Question`)}
						placeholder={_(msg`Question`)}
						value={row.question}
						maxLength={FAQ_QUESTION_MAX}
						disabled={disabled}
						aria-invalid={questionError ? true : undefined}
						onChange={(event) => onChange({ question: event.target.value })}
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						disabled={disabled}
						aria-label={_(msg`Remove question`)}
						onClick={onRemove}
					>
						<Icon name="trash-2" />
					</Button>
				</div>
			) : (
				<div className="flex items-center gap-2">
					<Label htmlFor={answerId}>{row.question}</Label>
					{row.draft ? (
						<Badge variant="outline">
							<Trans>AI draft</Trans>
						</Badge>
					) : null}
				</div>
			)}
			<Textarea
				id={answerId}
				aria-label={custom ? _(msg`Answer`) : undefined}
				placeholder={_(msg`Leave empty to skip`)}
				rows={2}
				maxLength={FAQ_ANSWER_MAX}
				value={row.answer}
				disabled={disabled}
				aria-invalid={answerError ? true : undefined}
				onChange={(event) => onChange({ answer: event.target.value })}
			/>
			<FieldErrorText error={questionError} />
			<FieldErrorText error={answerError} />
		</div>
	)
}

function SpeechSection({
	pronunciations,
	keyterms,
	versions,
	canUpdate,
	onDirtyChange,
}: {
	pronunciations: Pronunciation[]
	keyterms: string[]
	versions: LoaderData['versions']
	canUpdate: boolean
	onDirtyChange: (dirty: boolean) => void
}) {
	const { _ } = useLingui()
	const [rows, setRows] = useState(pronunciations)
	const [terms, setTerms] = useState(keyterms)
	const [termInput, setTermInput] = useState('')
	// Saved pronunciations skip empty rows; position i came from row
	// submittedRows[i], which is how `pronunciations.i.term` maps back.
	const [submittedRows, setSubmittedRows] = useState<number[]>([])
	const [submittedTerms, setSubmittedTerms] = useState<string[]>([])
	const form = useSettingsFormState({
		saved: { pronunciations, keyterms },
		versions,
		draft: { rows, terms },
		reset: (saved) => {
			setRows(saved.pronunciations)
			setTerms(saved.keyterms)
		},
		canUpdate,
	})
	const { pending, fieldErrors, save, dirty } = form
	useEffect(() => {
		onDirtyChange(dirty)
	}, [dirty, onDirtyChange])
	const disabled = !canUpdate || pending
	const rowError = (index: number, field: 'term' | 'sayAs') => {
		const position = submittedRows.indexOf(index)
		return position === -1
			? undefined
			: fieldErrors[`pronunciations.${position}.${field}`]
	}
	const termErrorIndex = submittedTerms.findIndex(
		(ignoredTerm, index) => fieldErrors[`keyterms.${index}`],
	)
	const failedTerm = submittedTerms[termErrorIndex]
	const failedTermError = fieldErrors[`keyterms.${termErrorIndex}`]
	const termError =
		fieldErrors.keyterms ??
		(failedTerm && failedTermError
			? _(msg`${failedTerm}: ${failedTermError}`)
			: undefined)

	function addTerms() {
		const next = termInput
			.split(',')
			.map((term) => term.trim())
			.filter(Boolean)
		if (!next.length) return
		setTerms((current) => {
			const seen = new Set(current.map((term) => term.toLocaleLowerCase()))
			return [
				...current,
				...next.filter((term) => !seen.has(term.toLocaleLowerCase())),
			].slice(0, 100)
		})
		setTermInput('')
	}

	return (
		<form
			className="flex flex-col gap-6"
			onSubmit={(event) => {
				event.preventDefault()
				const kept = rows
					.map((row, index) => ({ row, index }))
					.filter(({ row }) => row.term.trim() && row.sayAs.trim())
				setSubmittedRows(kept.map(({ index }) => index))
				setSubmittedTerms(terms)
				save({
					pronunciations: kept.map(({ row }) => row),
					keyterms: terms,
				})
			}}
		>
			<AnnotatedSection
				title={<Trans>Pronunciations</Trans>}
				description={
					<Trans>
						Spell out how the agent should say words it gets wrong, like product
						names or your street. Write it the way it sounds.
					</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-3">
						{rows.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								<Trans>No pronunciations yet.</Trans>
							</p>
						) : null}
						{rows.map((row, index) => (
							<div key={index} className="flex flex-col gap-1">
								<div className="flex items-center gap-2">
									<Input
										aria-label={_(msg`Word`)}
										placeholder={_(msg`Word, e.g. Nguyen`)}
										value={row.term}
										maxLength={60}
										disabled={disabled}
										aria-invalid={rowError(index, 'term') ? true : undefined}
										onChange={(event) =>
											setRows((current) =>
												current.map((item, itemIndex) =>
													itemIndex === index
														? { ...item, term: event.target.value }
														: item,
												),
											)
										}
									/>
									<Icon name="arrow-right" className="text-muted-foreground" />
									<Input
										aria-label={_(msg`Say it as`)}
										placeholder={_(msg`Say it as, e.g. win`)}
										value={row.sayAs}
										maxLength={120}
										disabled={disabled}
										aria-invalid={rowError(index, 'sayAs') ? true : undefined}
										onChange={(event) =>
											setRows((current) =>
												current.map((item, itemIndex) =>
													itemIndex === index
														? { ...item, sayAs: event.target.value }
														: item,
												),
											)
										}
									/>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										disabled={disabled}
										aria-label={_(msg`Remove pronunciation`)}
										onClick={() =>
											setRows((current) =>
												current.filter(
													(ignoredItem, itemIndex) => itemIndex !== index,
												),
											)
										}
									>
										<Icon name="trash-2" />
									</Button>
								</div>
								<FieldErrorText error={rowError(index, 'term')} />
								<FieldErrorText error={rowError(index, 'sayAs')} />
							</div>
						))}
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="self-start"
							disabled={disabled || rows.length >= 100}
							onClick={() =>
								setRows((current) => [...current, { term: '', sayAs: '' }])
							}
						>
							<Icon name="plus" />
							<Trans>Add pronunciation</Trans>
						</Button>
					</CardContent>
				</Card>
				<FieldErrorText error={fieldErrors.pronunciations} />
			</AnnotatedSection>

			<AnnotatedSection
				title={<Trans>Key terms</Trans>}
				description={
					<Trans>
						Words the agent should listen for, so it understands callers who say
						them. Your business name and the names the agent already knows are
						included automatically.
					</Trans>
				}
			>
				<Card>
					<CardContent className="flex flex-col gap-3">
						<div className="flex gap-2">
							<Input
								aria-label={_(msg`Key term`)}
								placeholder={_(msg`e.g. product or brand names`)}
								value={termInput}
								maxLength={300}
								disabled={disabled || terms.length >= 100}
								onChange={(event) => setTermInput(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault()
										addTerms()
									}
								}}
							/>
							<Button
								type="button"
								variant="outline"
								disabled={disabled || !termInput.trim()}
								onClick={addTerms}
							>
								<Trans>Add</Trans>
							</Button>
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>Separate several terms with commas. Up to 100.</Trans>
						</p>
						{terms.length ? (
							<ul className="flex flex-wrap gap-2">
								{terms.map((term) => (
									<li key={term}>
										<Badge variant="secondary" className="gap-1">
											{term}
											{canUpdate ? (
												<button
													type="button"
													className="text-muted-foreground hover:text-foreground"
													aria-label={_(msg`Remove ${term}`)}
													disabled={disabled}
													onClick={() =>
														setTerms((current) =>
															current.filter((item) => item !== term),
														)
													}
												>
													<Icon name="x" size="xs" />
												</button>
											) : null}
										</Badge>
									</li>
								))}
							</ul>
						) : null}
						<FieldErrorText error={termError} />
					</CardContent>
				</Card>
			</AnnotatedSection>
			<SettingsSaveBar
				canUpdate={canUpdate}
				form={form}
				label={<Trans>Save pronunciations and key terms</Trans>}
			/>
		</form>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
