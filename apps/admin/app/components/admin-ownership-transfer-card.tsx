import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Link, useFetcher } from 'react-router'

type Member = {
	userId: string
	name: string
	roleName: string
	isAdmin: boolean
}

/**
 * Start an ownership transfer (#291): the person who asks must have been
 * verified in the last 15 minutes (the server checks). The member named becomes
 * an admin; the caller stays one until the restaurant removes them.
 */
export function AdminOwnershipTransferCard({
	organizationId,
	members,
}: {
	organizationId: string
	members: Member[]
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ error?: string; message?: string }>()
	const admins = members.filter((member) => member.isAdmin)
	const others = members.filter((member) => !member.isAdmin)
	const error = fetcher.data?.error
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Ownership transfer</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Only after you have verified the caller on their user page. The
						server refuses without a verification from the last 15 minutes.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{admins.length > 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>Verify the caller first:</Trans>{' '}
						{admins.map((admin, index) => (
							<span key={admin.userId}>
								{index > 0 ? ', ' : ''}
								<Link to={`/users/${admin.userId}`} className="underline">
									{admin.name}
								</Link>
							</span>
						))}
					</p>
				) : null}
				<fetcher.Form
					method="post"
					action={`/organizations/${organizationId}/ownership-transfer`}
					className="flex flex-wrap items-end gap-3"
				>
					<label className="text-sm">
						<span className="text-muted-foreground block text-xs">
							<Trans>Caller (current admin)</Trans>
						</span>
						<select
							name="fromUserId"
							required
							className="bg-background h-8 rounded-md border px-2"
						>
							<option value="">{_(msg`Choose a person`)}</option>
							{admins.map((member) => (
								<option key={member.userId} value={member.userId}>
									{member.name}
								</option>
							))}
						</select>
					</label>
					<label className="text-sm">
						<span className="text-muted-foreground block text-xs">
							<Trans>New admin</Trans>
						</span>
						<select
							name="toUserId"
							required
							className="bg-background h-8 rounded-md border px-2"
						>
							<option value="">{_(msg`Choose a person`)}</option>
							{others.map((member) => (
								<option key={member.userId} value={member.userId}>
									{member.name} ({member.roleName})
								</option>
							))}
						</select>
					</label>
					<Button
						type="submit"
						variant="outline"
						disabled={fetcher.state !== 'idle'}
					>
						<Trans>Start transfer</Trans>
					</Button>
					{error ? (
						<p className="text-destructive text-sm" role="alert">
							{error === 'verification_required' ? (
								<Trans>Verify the caller first.</Trans>
							) : error === 'caller_not_admin' ? (
								<Trans>The caller must be an admin of this restaurant.</Trans>
							) : error === 'already_admin' ? (
								<Trans>That member is already an admin.</Trans>
							) : (
								<Trans>Something went wrong.</Trans>
							)}
						</p>
					) : null}
				</fetcher.Form>
			</CardContent>
		</Card>
	)
}
