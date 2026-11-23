import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserWithRole } from '@repo/auth'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Input } from '@repo/ui/input'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Form, Link, useLoaderData } from 'react-router'
import { ENV } from 'varlock/env'
import { lookupRequest } from '#app/utils/request-lookup.server.ts'

/**
 * Request lookup (#385): paste the reference id from an error page and see the
 * server log lines of that request, and the support request that came with it.
 */
export async function loader({ request }: { request: Request }) {
	const agentId = await requireUserWithRole(request, 'admin')
	const id = new URL(request.url).searchParams.get('id')?.trim() ?? ''
	if (!id) return { id: '', result: null }
	const result = await lookupRequest({
		agentId,
		traceId: id,
		config: {
			apiToken: ENV.BETTERSTACK_TELEMETRY_TOKEN,
			sourceId: ENV.BETTERSTACK_LOGS_SOURCE_ID,
		},
		request,
	})
	return { id, result }
}

export default function RequestLookupPage() {
	const { id, result } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const logs = result?.logs

	return (
		<div className="space-y-6">
			<PageHeader
				title={<Trans>Request lookup</Trans>}
				description={
					<Trans>
						Find a request from the reference an owner reads off the error page.
					</Trans>
				}
			/>
			<Form method="get" className="flex max-w-xl items-end gap-3">
				<div className="flex-1 space-y-1.5">
					<label htmlFor="lookup-id" className="text-sm font-medium">
						<Trans>Reference</Trans>
					</label>
					<Input
						id="lookup-id"
						name="id"
						defaultValue={id}
						placeholder="a1b2c3d4e5f6a7b8"
						className="font-mono"
						autoComplete="off"
					/>
				</div>
				<Button type="submit">
					<Trans>Look up</Trans>
				</Button>
			</Form>

			{logs?.status === 'invalid_id' ? (
				<p className="text-destructive text-sm" role="alert">
					<Trans>
						A reference is 16 letters and digits, for example a1b2c3d4e5f6a7b8.
					</Trans>
				</p>
			) : null}
			{logs?.status === 'not_configured' ? (
				<p className="text-muted-foreground text-sm">
					<Trans>
						The log provider is not set up here. Add the Better Stack Telemetry
						token and source id, then look up again.
					</Trans>
				</p>
			) : null}
			{logs?.status === 'unavailable' ? (
				<p className="text-destructive text-sm" role="alert">
					<Trans>The log provider did not answer. Try again in a moment.</Trans>
				</p>
			) : null}

			{result && result.requests.length > 0 ? (
				<div className="space-y-2">
					<h2 className="font-medium">
						<Trans>Support requests with this reference</Trans>
					</h2>
					<ul className="text-sm">
						{result.requests.map((item) => (
							<li key={item.id}>
								<Link to={`/feedback/${item.id}`} className="underline">
									{item.subject || item.id}
								</Link>{' '}
								· {item.organization.name}
							</li>
						))}
					</ul>
				</div>
			) : null}

			{logs?.status === 'ok' ? (
				logs.hits.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No log lines were found for this reference.</Trans>
					</p>
				) : (
					<Frame className="w-full">
						<Table variant="card">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Time</Trans>
									</TableHead>
									<TableHead>
										<Trans>Level</Trans>
									</TableHead>
									<TableHead>
										<Trans>Request</Trans>
									</TableHead>
									<TableHead>
										<Trans>Result</Trans>
									</TableHead>
									<TableHead>
										<Trans>Message</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{logs.hits.map((hit, index) => (
									<TableRow key={`${hit.at}-${index}`}>
										<TableCell className="text-sm">{hit.at ?? '—'}</TableCell>
										<TableCell>
											{hit.level ? (
												<Badge
													variant={
														hit.level === 'error' ? 'destructive' : 'outline'
													}
												>
													{hit.level}
												</Badge>
											) : null}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{[hit.method, hit.path].filter(Boolean).join(' ') || '—'}
										</TableCell>
										<TableCell className="text-sm">
											{hit.statusCode ?? '—'}
											{hit.durationMs !== null ? ` · ${hit.durationMs} ms` : ''}
											{hit.errorType ? ` · ${hit.errorType}` : ''}
										</TableCell>
										<TableCell className="max-w-md text-sm whitespace-normal">
											{hit.message ?? ''}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</Frame>
				)
			) : null}
			<span className="sr-only">{_(msg`Request lookup results`)}</span>
		</div>
	)
}
