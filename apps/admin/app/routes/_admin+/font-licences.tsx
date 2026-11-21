import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@repo/ui/alert-dialog'
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

/**
 * Taking a font off a site is destructive and the screen lists many rows, so
 * it asks first and names the file and the organization, for sighted and
 * screen-reader users alike.
 */
function RemoveFont({
	acceptanceId,
	fileName,
	organizationName,
	busy,
}: {
	acceptanceId: string
	fileName: string
	organizationName: string
	busy: boolean
}) {
	const { _ } = useLingui()
	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={
					<Button
						type="button"
						variant="destructive"
						size="sm"
						disabled={busy}
						aria-label={_(
							msg`Remove font ${fileName} from ${organizationName}`,
						)}
					/>
				}
			>
				<Trans>Remove font</Trans>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<Form method="post">
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Remove this font?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								{fileName} is taken off the site of {organizationName} at once,
								and the site falls back to the theme font. The licence record is
								kept.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<input type="hidden" name="_action" value="remove-font" />
					<input type="hidden" name="acceptanceId" value={acceptanceId} />
					<Input
						name="reason"
						className="my-4"
						placeholder={_(msg`Reason (optional)`)}
						aria-label={_(msg`Reason for removing the font`)}
					/>
					<AlertDialogFooter>
						<AlertDialogCancel>{_(msg`Cancel`)}</AlertDialogCancel>
						<Button type="submit" variant="destructive">
							<Trans>Remove font</Trans>
						</Button>
					</AlertDialogFooter>
				</Form>
			</AlertDialogContent>
		</AlertDialog>
	)
}

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
										<RemoveFont
											acceptanceId={row.id}
											fileName={row.fileName}
											organizationName={row.organization.name}
											busy={busy}
										/>
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
