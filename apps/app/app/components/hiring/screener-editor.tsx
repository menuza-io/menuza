import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	JOB_POSTING_LIMITS,
	type ScreenerQuestion,
} from '@repo/common/job-posting'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import {
	moveQuestion,
	newOpenQuestion,
	newYesNoQuestion,
	readPrompt,
	writePrompt,
	type PostingForm,
	type PostingFormErrors,
} from '#app/utils/hiring/job-posting-form.ts'
import { useJobLabels } from './job-labels.ts'
import {
	LocalizedTextField,
	TranslatingNotice,
	useTranslating,
} from './localized-fields.tsx'

/**
 * Screener questions: yes/no questions that can be dealbreakers, and open
 * questions. A dealbreaker flags an applicant whose answer differs; it never
 * rejects anyone, and applicants never see which answer it is.
 */
export function ScreenerEditor({
	form,
	onChange,
	update,
	errors,
}: {
	form: PostingForm
	onChange: (questions: ScreenerQuestion[]) => void
	update: (change: (current: PostingForm) => PostingForm) => void
	errors: PostingFormErrors
}) {
	const { _ } = useLingui()
	const questions = form.questions
	const { activeLocale, defaultLocale, translating } = useTranslating()
	const labels = useJobLabels()
	const maxQuestions = JOB_POSTING_LIMITS.questions
	const full = questions.length >= maxQuestions

	function updateQuestion(index: number, next: ScreenerQuestion) {
		onChange(questions.map((question, i) => (i === index ? next : question)))
	}

	if (translating) {
		return (
			<div className="flex flex-col gap-6">
				<TranslatingNotice />
				{questions.length === 0 ? (
					<p className="text-muted-foreground max-w-prose text-sm text-pretty">
						<Trans>
							There are no questions to translate. Add questions in the default
							language first.
						</Trans>
					</p>
				) : (
					questions.map((question, index) => {
						const number = index + 1
						return (
							<LocalizedTextField
								key={question.id}
								label={<Trans>Question {number}</Trans>}
								value={readPrompt(form, question, activeLocale, defaultLocale)}
								fallback={question.prompt}
								maxLength={JOB_POSTING_LIMITS.prompt}
								onChange={(value) =>
									update((current) =>
										writePrompt(
											current,
											question.id,
											value,
											activeLocale,
											defaultLocale,
										),
									)
								}
							/>
						)
					})
				)}
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-6">
			{questions.length === 0 ? (
				<p className="text-muted-foreground max-w-prose text-sm text-pretty">
					<Trans>
						Questions are optional. A short yes or no on weekends or experience
						saves you reading every application.
					</Trans>
				</p>
			) : (
				<ol className="flex flex-col gap-8">
					{questions.map((question, index) => {
						const number = index + 1
						return (
							<li key={question.id} className="flex flex-col gap-4">
								<div className="flex items-center justify-between gap-2">
									<h3 className="text-sm font-medium">
										<Trans>Question {number}</Trans>
									</h3>
									<div className="flex items-center gap-1">
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={_(t`Move question ${number} up`)}
											disabled={index === 0}
											onClick={() =>
												onChange(moveQuestion(questions, index, index - 1))
											}
										>
											<Icon name="chevron-up" />
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={_(t`Move question ${number} down`)}
											disabled={index === questions.length - 1}
											onClick={() =>
												onChange(moveQuestion(questions, index, index + 1))
											}
										>
											<Icon name="chevron-down" />
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={_(t`Remove question ${number}`)}
											onClick={() =>
												onChange(questions.filter((ignored, i) => i !== index))
											}
										>
											<Icon name="trash-2" />
										</Button>
									</div>
								</div>

								<TextField
									label={
										question.kind === 'yes_no' ? (
											<Trans>Yes or no question</Trans>
										) : (
											<Trans>Open question</Trans>
										)
									}
									value={question.prompt}
									maxLength={JOB_POSTING_LIMITS.prompt}
									error={
										errors[`question:${question.id}`]
											? _(t`Write the question.`)
											: null
									}
									onChange={(event) =>
										updateQuestion(index, {
											...question,
											prompt: event.target.value,
										})
									}
								/>

								{question.kind === 'yes_no' ? (
									<>
										<SelectField
											label={<Trans>Topic</Trans>}
											options={labels.categoryOptions}
											value={question.category}
											onValueChange={(category) =>
												updateQuestion(index, {
													...question,
													category: category as typeof question.category,
												})
											}
										/>
										<SwitchField
											label={<Trans>Dealbreaker</Trans>}
											description={
												<Trans>
													Flag applicants who answer differently. You still
													decide who to talk to.
												</Trans>
											}
											checked={question.dealbreaker}
											onCheckedChange={(dealbreaker) =>
												updateQuestion(index, { ...question, dealbreaker })
											}
										/>
										{question.dealbreaker ? (
											<SelectField
												label={<Trans>The right answer is</Trans>}
												options={[
													{ value: 'yes', label: _(t`Yes`) },
													{ value: 'no', label: _(t`No`) },
												]}
												value={question.requiredAnswer}
												onValueChange={(requiredAnswer) =>
													updateQuestion(index, {
														...question,
														requiredAnswer: requiredAnswer as 'yes' | 'no',
													})
												}
											/>
										) : null}
									</>
								) : (
									<SwitchField
										label={<Trans>Required</Trans>}
										description={
											<Trans>
												Applicants must answer before they can apply.
											</Trans>
										}
										checked={question.required}
										onCheckedChange={(required) =>
											updateQuestion(index, { ...question, required })
										}
									/>
								)}
							</li>
						)
					})}
				</ol>
			)}

			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					disabled={full}
					onClick={() => onChange([...questions, newYesNoQuestion(questions)])}
				>
					<Icon name="plus" />
					<Trans>Yes or no question</Trans>
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={full}
					onClick={() => onChange([...questions, newOpenQuestion(questions)])}
				>
					<Icon name="plus" />
					<Trans>Open question</Trans>
				</Button>
			</div>
			{full ? (
				<p className="text-muted-foreground text-sm">
					<Trans>That is the most a posting can ask ({maxQuestions}).</Trans>
				</p>
			) : null}
		</div>
	)
}
