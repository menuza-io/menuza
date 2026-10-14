import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { SanitizedHtml } from '#app/components/sanitized-html.tsx'
import {
	toPayload,
	type PostingForm,
} from '#app/utils/hiring/job-posting-form.ts'
import { useJobLabels } from './job-labels.ts'

/**
 * A plain read of a posting as it stands: the facts first, then the text as
 * applicants will read it. Used on the Review step and as the whole screen for
 * a member who may look but not edit.
 *
 * The description shown here is either the editor's own output (a rich-text
 * schema that cannot carry a script) or the copy the server sanitized.
 */
export function JobSummary({ form }: { form: PostingForm }) {
	const { _, i18n } = useLingui()
	const labels = useJobLabels()
	const payload = toPayload(form)
	const pay = labels.payLine({
		payType: payload.payType,
		payMinMinor: payload.payMinMinor,
		payMaxMinor: payload.payMaxMinor,
		currency: payload.currency,
	})
	const closes = form.closesOn
		? new Intl.DateTimeFormat(i18n.locale, {
				dateStyle: 'long',
				timeZone: 'UTC',
			}).format(new Date(`${form.closesOn}T12:00:00Z`))
		: null
	const dealbreakers = form.questions.filter(
		(question) => question.kind === 'yes_no' && question.dealbreaker,
	).length
	const questionCount = form.questions.length

	const rows: Array<[string, string]> = [
		[_(t`Position`), form.positionName || '-'],
		[_(t`Type`), labels.employment[form.employmentType]],
		[_(t`Pay`), pay ?? _(t`Not shown`)],
		[_(t`Closes`), closes ?? _(t`When you close it`)],
		[
			_(t`Questions`),
			questionCount === 0
				? _(t`None`)
				: dealbreakers > 0
					? _(t`${questionCount} (${dealbreakers} dealbreaker)`)
					: `${questionCount}`,
		],
	]

	return (
		<div className="flex flex-col gap-6">
			<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
				{rows.map(([term, value]) => (
					<div key={term} className="col-span-2 grid grid-cols-subgrid">
						<dt className="text-muted-foreground">{term}</dt>
						<dd className="font-medium">{value}</dd>
					</div>
				))}
			</dl>
			<div className="flex flex-col gap-2">
				<h3 className="text-sm font-medium">
					<Trans>What applicants read</Trans>
				</h3>
				{form.descriptionHtml ? (
					<SanitizedHtml
						html={form.descriptionHtml}
						dir="auto"
						className="prose prose-sm dark:prose-invert text-foreground max-w-prose [&_ol]:list-decimal [&_ol]:ps-5 [&_ul]:list-disc [&_ul]:ps-5"
					/>
				) : (
					<p className="text-muted-foreground text-sm">
						<Trans>No description yet.</Trans>
					</p>
				)}
			</div>
		</div>
	)
}
