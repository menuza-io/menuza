import { requireUserWithRole } from '@repo/auth'
import {
	Feedback as FeedbackTable,
	Organization as OrganizationTable,
	User as UserTable,
	db,
	desc,
	eq,
} from '@repo/database'
import {
	type Feedback,
	type Organization,
	type User,
} from '@repo/database/types'
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
import { useLoaderData } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'

export async function loader({ request }: { request: Request }) {
	await requireUserWithRole(request, 'admin')
	const feedback = await db
		.select({
			id: FeedbackTable.id,
			message: FeedbackTable.message,
			type: FeedbackTable.type,
			createdAt: FeedbackTable.createdAt,
			updatedAt: FeedbackTable.updatedAt,
			user: { name: UserTable.name, email: UserTable.email },
			organization: { name: OrganizationTable.name },
		})
		.from(FeedbackTable)
		.innerJoin(UserTable, eq(FeedbackTable.userId, UserTable.id))
		.innerJoin(
			OrganizationTable,
			eq(FeedbackTable.organizationId, OrganizationTable.id),
		)
		.orderBy(desc(FeedbackTable.createdAt))
	return Response.json({ feedback })
}

type LoaderData = {
	feedback: (Omit<Feedback, 'createdAt' | 'updatedAt'> & {
		createdAt: string
		updatedAt: string
		user: Pick<User, 'name' | 'email'>
		organization: Pick<Organization, 'name'>
	})[]
}

export default function AdminFeedbackPage() {
	const { feedback } = useLoaderData() as LoaderData

	return (
		<div className="space-y-8">
			<PageHeader
				title="Feedback"
				description="Here you can see all the feedback submitted by users."
			/>
			{feedback.length === 0 ? (
				<EmptyState
					title="No feedback yet"
					description="Feedback submitted by users will appear here."
					icons={['message-square']}
				/>
			) : (
				<Frame className="w-full">
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>User</TableHead>
								<TableHead className="hidden md:table-cell">
									Organization
								</TableHead>
								<TableHead>Feedback</TableHead>
								<TableHead>Type</TableHead>
								<TableHead className="hidden sm:table-cell">Date</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{feedback.map((item) => (
								<TableRow key={item.id}>
									<TableCell>
										<div className="text-sm font-medium">{item.user.name}</div>
										<div className="text-muted-foreground text-sm">
											{item.user.email}
										</div>
									</TableCell>
									<TableCell className="hidden md:table-cell">
										{item.organization.name}
									</TableCell>
									<TableCell className="max-w-md whitespace-normal">
										{item.message}
									</TableCell>
									<TableCell>
										<Badge variant="outline">{item.type}</Badge>
									</TableCell>
									<TableCell className="text-muted-foreground hidden text-sm sm:table-cell">
										{new Date(item.createdAt).toLocaleDateString()}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
						<TableFooter>
							<TableRow>
								<TableCell colSpan={5}>
									{feedback.length === 1
										? '1 item'
										: `${feedback.length} items`}
								</TableCell>
							</TableRow>
						</TableFooter>
					</Table>
				</Frame>
			)}
		</div>
	)
}
