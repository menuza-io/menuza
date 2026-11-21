import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
import { Form, useLoaderData, useNavigation } from 'react-router'
import { action, loader } from './font-licences.server.ts'

export { action, loader }

export default function FontLicencesAdminRoute() {
	const { acceptances, search } = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const busy = useNavigation().state !== 'idle'
	return (
		<div className="space-y-6">
			<PageHeader
				title={<Trans>Font licences</Trans>}
				description={
					<Trans>
						Every custom font a member uploaded, who confirmed they hold a web
						licence, and when. Remove a font after a complaint: the site falls
						back to the theme font at once.
					</Trans>
				}
			/>
			<Form method="get" className="max-w-sm">
				<Input
					name="search"
					type="search"
					defaultValue={search}
					placeholder={_(msg`Search by organization or file`)}
					aria-label={_(msg`Search font licences`)}
				/>
			</Form>
			<Frame className="w-full">
				<Table variant="card">
					<TableHeader>
						<TableRow>
							<TableHead>
								<Trans>Organization</Trans>
							</TableHead>
							<TableHead>
								<Trans>Font file</Trans>
							</TableHead>
							<TableHead>
								<Trans>Confirmed by</Trans>
							</TableHead>
							<TableHead>
								<Trans>Status</Trans>
							</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{acceptances.length === 0 ? (
							<TableRow>
								<TableCell colSpan={5} className="text-muted-foreground">
									<Trans>No custom fonts have been uploaded.</Trans>
								</TableCell>
							</TableRow>
						) : null}
						{acceptances.map((row) => (
							<TableRow key={row.id}>
								<TableCell className="font-medium">
									{row.organization.name}{' '}
									<span className="text-muted-foreground font-mono text-xs">
										{row.organization.slug}
									</span>
								</TableCell>
								<TableCell>
									<div className="wrap-anywhere">{row.fileName}</div>
									<div className="text-muted-foreground font-mono text-[11px]">
										{row.role} · {row.fileHash.slice(0, 12)}
									</div>
								</TableCell>
								<TableCell>
									{row.member}
									<div className="text-muted-foreground text-xs">
										{new Date(row.acceptedAt).toLocaleString(i18n.locale)}
									</div>
								</TableCell>
								<TableCell>
									{row.removedAt ? (
										<Badge variant="outline">
											<Trans>Removed</Trans>
										</Badge>
									) : row.inUse ? (
										<Badge>
											<Trans>In use</Trans>
										</Badge>
									) : (
										<Badge variant="secondary">
											<Trans>Replaced</Trans>
										</Badge>
									)}
								</TableCell>
								<TableCell className="text-right">
									{row.removedAt ? null : (
										<Form method="post" className="flex justify-end gap-2">
											<input type="hidden" name="_action" value="remove-font" />
											<input type="hidden" name="acceptanceId" value={row.id} />
											<Input
												name="reason"
												className="w-40"
												placeholder={_(msg`Reason (optional)`)}
												aria-label={_(msg`Reason for removing the font`)}
											/>
											<Button
												type="submit"
												variant="destructive"
												size="sm"
												disabled={busy}
											>
												<Trans>Remove font</Trans>
											</Button>
										</Form>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</Frame>
		</div>
	)
}
