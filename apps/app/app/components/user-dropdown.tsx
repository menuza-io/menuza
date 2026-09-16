import { Trans } from '@lingui/macro'
import { getUserImgSrc } from '@repo/common'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuPortal,
	DropdownMenuContent,
	DropdownMenuItem,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Img } from 'openimg/react'
import { Link, useSubmit } from 'react-router'
import { useCurrentOrganization } from '#app/utils/organization/organizations.ts'
import { useUser } from '#app/utils/user.ts'

export function UserDropdown() {
	const user = useUser()
	const { organization } = useCurrentOrganization()
	const submit = useSubmit()
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="secondary"
						render={
							<Link
								to={`/users/${user.username}`}
								// this is for progressive enhancement
								onClick={(e) => e.preventDefault()}
								className="flex items-center gap-2"
							>
								<Img
									className="size-8 rounded-full object-cover"
									alt={user.name ?? user.username}
									src={getUserImgSrc(user.image?.objectKey)}
									width={256}
									height={256}
								/>
								<span className="text-sm font-bold">
									{user.name ?? user.username}
								</span>
							</Link>
						}
					/>
				}
			/>
			<DropdownMenuPortal>
				<DropdownMenuContent sideOffset={8} align="end">
					<DropdownMenuItem>
						<Link prefetch="intent" to={`/profile`}>
							<Icon className="text-base" name="user">
								<Trans>Profile</Trans>
							</Icon>
						</Link>
					</DropdownMenuItem>
					<DropdownMenuItem>
						<Link prefetch="intent" to={`/${organization.slug}`}>
							<Icon className="text-base" name="clock">
								<Trans>Dashboard</Trans>
							</Icon>
						</Link>
					</DropdownMenuItem>
					<DropdownMenuItem
						render={<button className="flex w-full items-center" />}
						onClick={() =>
							submit(new FormData(), { method: 'POST', action: '/logout' })
						}
					>
						<Icon className="text-base" name="log-out">
							<Trans>Logout</Trans>
						</Icon>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenuPortal>
		</DropdownMenu>
	)
}
