import { type JobPostingStatus } from '@repo/common/job-posting'
import { useJobLabels } from './job-labels.ts'

/**
 * Status as a dot plus plain text, like the roster: only a live posting gets a
 * strong dot, so a list of drafts and closed roles stays quiet.
 */
export function JobStatus({ status }: { status: JobPostingStatus }) {
	const labels = useJobLabels()
	const dot = {
		draft: 'bg-muted-foreground/50',
		published: 'bg-primary',
		closed: 'bg-muted-foreground',
		expired: 'bg-destructive/70',
	}[status]
	return (
		<span className="text-muted-foreground inline-flex items-center gap-2 text-sm">
			<span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} />
			{labels.status[status]}
		</span>
	)
}
