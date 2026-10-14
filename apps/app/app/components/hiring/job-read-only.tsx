import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { PageHeader } from '@repo/ui/page-header'
import { PageWithBack } from '#app/components/staff/page-back.tsx'
import { formFromPosting } from '#app/utils/hiring/job-posting-form.ts'
import { type PostingDetail } from '#app/utils/hiring/job-posting-types.ts'
import { JobStatus } from './job-status.tsx'
import { JobSummary } from './job-summary.tsx'

/** A job as someone who may look but not change it sees it. */
export function JobReadOnly({
	orgSlug,
	posting,
}: {
	orgSlug: string
	posting: PostingDetail
}) {
	const { _ } = useLingui()
	return (
		<div className="flex max-w-2xl flex-col gap-6">
			<PageWithBack to={`/${orgSlug}/staff/hiring`} label={_(t`Jobs`)}>
				<PageHeader
					title={posting.title}
					description={<JobStatus status={posting.status} />}
				/>
			</PageWithBack>
			<JobSummary form={formFromPosting(posting)} />
		</div>
	)
}
