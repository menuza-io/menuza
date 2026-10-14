import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useId, type ReactNode } from 'react'
import { type NewDashboardBlock } from '#app/utils/dashboards/config.ts'
import {
	type ReportTemplateGroup,
	type SavedReportOption,
} from '#app/utils/dashboards/reports.ts'
import { AddBlockOption, AddBlockSection } from './add-block-dialog.tsx'

function TemplateCategory({
	category,
	children,
}: {
	category: string
	children: ReactNode
}) {
	const headingId = useId()
	return (
		<div
			role="group"
			aria-labelledby={headingId}
			className="flex flex-col gap-2"
		>
			<h4 id={headingId} className="text-muted-foreground text-xs font-medium">
				{category}
			</h4>
			{children}
		</div>
	)
}

/**
 * The Add block dialog sections for reports: the organization's saved
 * reports, then the report templates by category. Any of them can be added
 * more than once.
 */
export function ReportBlockOptions({
	savedReports,
	templateGroups,
	onSelect,
}: {
	savedReports: readonly SavedReportOption[]
	templateGroups: readonly ReportTemplateGroup[]
	onSelect: (block: NewDashboardBlock) => void
}) {
	const { _ } = useLingui()
	return (
		<>
			<AddBlockSection title={_(msg`Saved reports`)}>
				{savedReports.length > 0 ? (
					<ul className="flex flex-col gap-2">
						{savedReports.map((report) => (
							<li key={report.id}>
								<AddBlockOption
									title={report.title}
									description={report.subjectLabel}
									onSelect={() =>
										onSelect({
											type: 'report',
											config: { source: 'saved', reportId: report.id },
										})
									}
								/>
							</li>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground text-sm">
						<Trans>Reports you save on the Reports page appear here.</Trans>
					</p>
				)}
			</AddBlockSection>
			<AddBlockSection title={_(msg`Report templates`)}>
				{templateGroups.map((group) => (
					<TemplateCategory key={group.category} category={group.category}>
						<ul className="flex flex-col gap-2">
							{group.templates.map((template) => (
								<li key={template.id}>
									<AddBlockOption
										title={template.title}
										description={template.description}
										onSelect={() =>
											onSelect({
												type: 'report',
												config: { source: 'template', templateId: template.id },
											})
										}
									/>
								</li>
							))}
						</ul>
					</TemplateCategory>
				))}
			</AddBlockSection>
		</>
	)
}
