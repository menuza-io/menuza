import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserWithRole } from '@repo/auth'
import {
	SUPPORT_STATUS_LABELS,
	type SupportRequestStatus,
} from '@repo/common/support-requests'
import { Badge } from '@repo/ui/badge'
import { Frame } from '@repo/ui/frame'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Form, Link, useLoaderData } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	listRequests,
	type RequestFilters,
} from '#app/utils/support-requests.server.ts'

const KINDS = ['all', 'support', 'problem', 'feedback'] as const
const STATUSES = ['all', 'open', 'waiting_on_you', 'closed'] as const
const ASSIGNEES = ['all', 'me', 'unassigned'] as const

function pick<T extends readonly string[]>(
	value: string | null,
	allowed: T,
	fallback: T[number],
): T[number] {
	return value && (allowed as readonly string[]).includes(value)
		? value
		: fallback
}

/**
 * Feedback and support requests (#233, #406): one list for the sentiment
 * feedback and the requests members send from Help. A request opens its
 * thread; feedback stays a row.
 */
export async function loader({ request }: { request: Request }) {
	const agentId = await requireUserWithRole(request, 'admin')
	const url = new URL(request.url)
	const filters: RequestFilters = {
		kind: pick(url.searchParams.get('kind'), KINDS, 'all'),
		status: pick(url.searchParams.get('status'), STATUSES, 'all'),
		assignee: pick(url.searchParams.get('assignee'), ASSIGNEES, 'all'),
		search: url.searchParams.get('search') ?? '',
	}
	const requests = await listRequests(agentId, filters)
	return {
		filters,
		requests: requests.map((row) => ({
			...row,
			createdAt: row.createdAt.toISOString(),
			lastMessageAt: row.lastMessageAt.toISOString(),
		})),
	}
}

function statusVariant(status: SupportRequestStatus) {
	return status === 'open'
		? ('default' as const)
		: status === 'closed'
			? ('outline' as const)
			: ('secondary' as const)
}

export default function AdminFeedbackPage() {
	const { filters, requests } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const itemCount = requests.length

	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Feedback and support</Trans>}
				description={
					<Trans>
						Support requests from the Help menu, with their threads, and the
						feedback members leave.
					</Trans>
				}
			/>
			<Form method="get" className="flex flex-wrap items-end gap-3">
				<label className="text-sm">
					<span className="text-muted-foreground block text-xs">
						<Trans>Kind</Trans>
					</span>
					<select
						name="kind"
						defaultValue={filters.kind}
						className="bg-background h-8 rounded-md border px-2 text-sm"
					>
						<option value="all">{_(msg`All`)}</option>
						<option value="support">{_(msg`Questions`)}</option>
						<option value="problem">{_(msg`Problems`)}</option>
						<option value="feedback">{_(msg`Feedback`)}</option>
					</select>
				</label>
				<label className="text-sm">
					<span className="text-muted-foreground block text-xs">
						<Trans>Status</Trans>
					</span>
					<select
						name="status"
						defaultValue={filters.status}
						className="bg-background h-8 rounded-md border px-2 text-sm"
					>
						<option value="all">{_(msg`All`)}</option>
						<option value="open">{_(msg`Open`)}</option>
						<option value="waiting_on_you">
							{_(msg`Waiting on the restaurant`)}
						</option>
						<option value="closed">{_(msg`Closed`)}</option>
					</select>
				</label>
				<label className="text-sm">
					<span className="text-muted-foreground block text-xs">
						<Trans>Routed to</Trans>
					</span>
					<select
						name="assignee"
						defaultValue={filters.assignee}
						className="bg-background h-8 rounded-md border px-2 text-sm"
					>
						<option value="all">{_(msg`Anyone`)}</option>
						<option value="me">{_(msg`Me`)}</option>
						<option value="unassigned">{_(msg`Nobody`)}</option>
					</select>
				</label>
				<label className="text-sm">
					<span className="text-muted-foreground block text-xs">
						<Trans>Search</Trans>
					</span>
					<input
						name="search"
						defaultValue={filters.search}
						className="bg-background h-8 rounded-md border px-2 text-sm"
					/>
				</label>
				<button
					type="submit"
					className="bg-secondary h-8 rounded-md px-3 text-sm font-medium"
				>
					<Trans>Filter</Trans>
				</button>
			</Form>
			{requests.length === 0 ? (
				<EmptyState
					title={_(msg`Nothing here yet`)}
					description={_(msg`Requests and feedback will appear here.`)}
					icons={['message-square']}
				/>
			) : (
				<Frame className="w-full">
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>From</Trans>
								</TableHead>
								<TableHead className="hidden md:table-cell">
									<Trans>Restaurant</Trans>
								</TableHead>
								<TableHead>
									<Trans>Message</Trans>
								</TableHead>
								<TableHead>
									<Trans>Status</Trans>
								</TableHead>
								<TableHead className="hidden lg:table-cell">
									<Trans>Routed to</Trans>
								</TableHead>
								<TableHead className="hidden sm:table-cell">
									<Trans>Last activity</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{requests.map((item) => (
								<TableRow key={item.id}>
									<TableCell>
										<Link
											to={`/users/${item.sender.id}`}
											className="text-sm font-medium hover:underline"
										>
											{item.sender.name || item.sender.email}
										</Link>
										<div className="text-muted-foreground text-sm">
											{item.sender.email}
										</div>
									</TableCell>
									<TableCell className="hidden md:table-cell">
										<Link
											to={`/organizations/${item.organization.id}`}
											className="hover:underline"
										>
											{item.organization.name}
										</Link>
									</TableCell>
									<TableCell className="max-w-md whitespace-normal">
										{item.kind === 'feedback' ? (
											item.preview
										) : (
											<Link
												to={`/feedback/${item.id}`}
												className="hover:underline"
											>
												{item.subject || item.preview}
											</Link>
										)}
										<div className="mt-1 flex flex-wrap gap-1">
											<Badge variant="outline">
												{item.kind === 'feedback' ? item.type : item.kind}
											</Badge>
											{item.hasError ? (
												<Badge variant="secondary">
													<Trans>Error reference</Trans>
												</Badge>
											) : null}
										</div>
									</TableCell>
									<TableCell>
										{item.kind === 'feedback' ? null : (
											<div className="flex items-center gap-2">
												<Badge variant={statusVariant(item.status)}>
													{SUPPORT_STATUS_LABELS[item.status]}
												</Badge>
												{item.unread ? (
													<span
														className="bg-primary size-2 rounded-full"
														role="img"
														aria-label={_(msg`Unread`)}
													/>
												) : null}
											</div>
										)}
									</TableCell>
									<TableCell className="text-muted-foreground hidden text-sm lg:table-cell">
										{item.assigneeName ?? '—'}
									</TableCell>
									<TableCell className="text-muted-foreground hidden text-sm sm:table-cell">
										{new Date(item.lastMessageAt).toLocaleString()}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
						<TableFooter>
							<TableRow>
								<TableCell colSpan={6}>
									{requests.length === 1 ? (
										<Trans>1 item</Trans>
									) : (
										<Trans>{itemCount} items</Trans>
									)}
								</TableCell>
							</TableRow>
						</TableFooter>
					</Table>
				</Frame>
			)}
		</div>
	)
}
