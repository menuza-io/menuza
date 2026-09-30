/**
 * MSW request handlers for mocking API responses
 */

import { http, HttpResponse } from 'msw'
import { posSandboxHandlers } from '../../src/pos/sandbox'

export const handlers = [
	// Slack API mocks
	http.post('https://slack.com/api/oauth.v2.access', () => {
		return HttpResponse.json({
			ok: true,
			app_id: 'A1234567890',
			access_token: 'xoxb-test-slack-token',
			scope: 'channels:read,chat:write',
			team: {
				id: 'T1234567890',
				name: 'Test Team',
			},
			bot_user_id: 'U1234567890',
		})
	}),

	http.get('https://slack.com/api/conversations.list', () => {
		return HttpResponse.json({
			ok: true,
			channels: [
				{
					id: 'C1234567890',
					name: 'general',
					is_private: false,
					is_archived: false,
				},
				{
					id: 'C0987654321',
					name: 'random',
					is_private: false,
					is_archived: false,
				},
			],
		})
	}),

	http.post('https://slack.com/api/chat.postMessage', () => {
		return HttpResponse.json({
			ok: true,
			ts: '1234567890.123456',
		})
	}),

	// Jira API mocks
	http.post('https://auth.atlassian.com/oauth/token', () => {
		return HttpResponse.json({
			access_token: 'test-jira-access-token',
			refresh_token: 'test-jira-refresh-token',
			expires_in: 3600,
		})
	}),

	http.get('https://api.atlassian.com/oauth/token/accessible-resources', () => {
		return HttpResponse.json([
			{
				id: 'test-cloud-id',
				name: 'Test Jira Instance',
				url: 'https://test.atlassian.net',
			},
		])
	}),

	http.get(
		'https://api.atlassian.com/ex/jira/:cloudId/rest/api/3/project/search',
		() => {
			return HttpResponse.json({
				values: [
					{
						id: '10001',
						key: 'TEST',
						name: 'Test Project',
					},
					{
						id: '10002',
						key: 'DEMO',
						name: 'Demo Project',
					},
				],
			})
		},
	),

	// Asana API mocks
	http.post('https://app.asana.com/-/oauth_token', () => {
		return HttpResponse.json({
			access_token: 'new-asana-access-token',
			refresh_token: 'new-asana-refresh-token',
			expires_in: 3600,
		})
	}),

	http.get('https://app.asana.com/api/1.0/users/me', () => {
		return HttpResponse.json({
			data: {
				gid: 'user-123',
				name: 'Test User',
				email: 'test@example.com',
			},
		})
	}),

	http.get('https://app.asana.com/api/1.0/workspaces', () => {
		return HttpResponse.json({
			data: [
				{
					gid: 'workspace-123',
					name: 'Test Workspace',
					resource_type: 'workspace',
				},
			],
		})
	}),

	http.get('https://app.asana.com/api/1.0/projects', () => {
		return HttpResponse.json({
			data: [
				{
					gid: 'project-123',
					name: 'Test Project',
					resource_type: 'project',
					archived: false,
					public: true,
					workspace: {
						gid: 'workspace-123',
						name: 'Test Workspace',
						resource_type: 'workspace',
					},
				},
			],
		})
	}),

	http.post('https://app.asana.com/api/1.0/tasks', () => {
		return HttpResponse.json({
			data: {
				gid: 'task-123',
				name: 'Test Task',
				resource_type: 'task',
				permalink_url: 'https://app.asana.com/0/project-123/task-123',
			},
		})
	}),

	http.get('https://app.asana.com/api/1.0/projects/:projectId', () => {
		return HttpResponse.json({
			data: {
				gid: 'project-123',
				name: 'Test Project',
				resource_type: 'project',
			},
		})
	}),

	// ClickUp API mocks
	http.post('https://api.clickup.com/api/v2/oauth/token', () => {
		return HttpResponse.json({
			access_token: 'clickup-access-token',
			token_type: 'Bearer',
			expires_in: 3600,
		})
	}),

	http.get('https://api.clickup.com/api/v2/user', () => {
		return HttpResponse.json({
			user: {
				id: 123,
				username: 'testuser',
				email: 'test@example.com',
				color: '#ff0000',
				profilePicture: 'https://example.com/avatar.jpg',
				initials: 'TU',
				timezone: 'America/New_York',
			},
		})
	}),

	http.get('https://api.clickup.com/api/v2/team', () => {
		return HttpResponse.json({
			teams: [
				{
					id: 'team-123',
					name: 'Test Team',
					color: '#ff0000',
				},
			],
		})
	}),

	http.get('https://api.clickup.com/api/v2/team/:teamId/space', () => {
		return HttpResponse.json({
			spaces: [
				{
					id: 'space-123',
					name: 'Test Space',
					color: '#00ff00',
					private: false,
				},
			],
		})
	}),

	http.get('https://api.clickup.com/api/v2/space/:spaceId/list', () => {
		return HttpResponse.json({
			lists: [
				{
					id: 'list-123',
					name: 'Test List',
					task_count: 5,
					archived: false,
					folder: {
						id: 'folder-123',
						name: 'Test Folder',
					},
					space: {
						id: 'space-123',
						name: 'Test Space',
					},
				},
			],
		})
	}),

	http.get('https://api.clickup.com/api/v2/list/:listId', () => {
		return HttpResponse.json({
			id: 'list-123',
			name: 'Test List',
		})
	}),

	http.post('https://api.clickup.com/api/v2/list/:listId/task', () => {
		return HttpResponse.json({
			id: 'task-123',
			name: 'Test Task',
			url: 'https://app.clickup.com/t/task-123',
		})
	}),

	// Linear API mocks
	http.post('https://api.linear.app/oauth/token', () => {
		return HttpResponse.json({
			access_token: 'linear-access-token',
			token_type: 'Bearer',
			expires_in: 3600,
			scope: 'read write',
		})
	}),

	http.post('https://api.linear.app/graphql', async ({ request }) => {
		const body = (await request.json()) as any
		const query = body.query

		if (query.includes('projects')) {
			return HttpResponse.json({
				data: {
					projects: {
						nodes: [],
					},
				},
			})
		}

		if (query.includes('teams')) {
			return HttpResponse.json({
				data: {
					teams: {
						nodes: [
							{
								id: 'team-123',
								name: 'Engineering',
								key: 'ENG',
							},
						],
					},
				},
			})
		}

		if (query.includes('issueCreate')) {
			return HttpResponse.json({
				data: {
					issueCreate: {
						success: true,
						issue: {
							id: 'issue-123',
							title: 'Test Issue',
							url: 'https://linear.app/test/issue/ENG-123',
						},
					},
				},
			})
		}

		if (query.includes('team(')) {
			return HttpResponse.json({
				data: {
					team: {
						id: 'team-123',
						name: 'Engineering',
						key: 'ENG',
					},
				},
			})
		}

		return HttpResponse.json({
			data: {},
		})
	}),

	// GitHub API mocks
	http.post('https://github.com/login/oauth/access_token', () => {
		return HttpResponse.json({
			access_token: 'github-access-token',
			token_type: 'bearer',
			scope: 'repo',
		})
	}),

	http.get('https://api.github.com/user', () => {
		return HttpResponse.json({
			id: 123,
			login: 'testuser',
			name: 'Test User',
			email: 'test@example.com',
			avatar_url: 'https://github.com/avatar.jpg',
		})
	}),

	http.get('https://api.github.com/user/repos', () => {
		return HttpResponse.json([
			{
				id: 456,
				name: 'test-repo',
				full_name: 'testuser/test-repo',
				owner: {
					login: 'testuser',
				},
				private: false,
			},
		])
	}),

	http.get('https://api.github.com/repos/:owner/:repo', () => {
		return HttpResponse.json({
			id: 456,
			name: 'test-repo',
			full_name: 'testuser/test-repo',
		})
	}),

	http.post('https://api.github.com/repos/:owner/:repo/issues', () => {
		return HttpResponse.json({
			id: 789,
			number: 1,
			title: 'Test Issue',
			html_url: 'https://github.com/testuser/test-repo/issues/1',
		})
	}),

	// GitLab API mocks
	http.post('https://gitlab.com/oauth/token', () => {
		return HttpResponse.json({
			access_token: 'gitlab-access-token',
			refresh_token: 'gitlab-refresh-token',
			token_type: 'Bearer',
			expires_in: 3600,
		})
	}),

	http.get('https://gitlab.com/api/v4/user', () => {
		return HttpResponse.json({
			id: 123,
			username: 'testuser',
			name: 'Test User',
			email: 'test@example.com',
			avatar_url: 'https://gitlab.com/avatar.jpg',
		})
	}),

	http.get('https://gitlab.com/api/v4/projects', () => {
		return HttpResponse.json([
			{
				id: 456,
				name: 'test-project',
				path_with_namespace: 'testuser/test-project',
				web_url: 'https://gitlab.com/testuser/test-project',
			},
		])
	}),

	http.get('https://gitlab.com/api/v4/projects/:id', () => {
		return HttpResponse.json({
			id: 456,
			name: 'test-project',
			path_with_namespace: 'testuser/test-project',
		})
	}),

	http.post('https://gitlab.com/api/v4/projects/:id/issues', () => {
		return HttpResponse.json({
			id: 789,
			iid: 1,
			title: 'Test Issue',
			web_url: 'https://gitlab.com/testuser/test-project/-/issues/1',
		})
	}),

	// Notion API mocks
	http.post('https://api.notion.com/v1/oauth/token', () => {
		return HttpResponse.json({
			access_token: 'notion-access-token',
			token_type: 'bearer',
			bot_id: 'bot-123',
			workspace_id: 'workspace-123',
			workspace_name: 'Test Workspace',
			owner: {
				user: {
					id: 'user-123',
					name: 'Test User',
					avatar_url: 'https://notion.com/avatar.jpg',
				},
			},
		})
	}),

	http.post('https://api.notion.com/v1/search', () => {
		return HttpResponse.json({
			results: [
				{
					id: 'database-123',
					object: 'database',
					title: [
						{
							plain_text: 'Test Database',
						},
					],
				},
			],
		})
	}),

	http.get('https://api.notion.com/v1/databases/:id', () => {
		return HttpResponse.json({
			id: 'database-123',
			object: 'database',
			title: [
				{
					plain_text: 'Test Database',
				},
			],
		})
	}),

	http.post('https://api.notion.com/v1/pages', () => {
		return HttpResponse.json({
			id: 'page-123',
			object: 'page',
			url: 'https://notion.com/page-123',
		})
	}),

	// Trello API mocks
	http.get('https://api.trello.com/1/members/me/boards', () => {
		return HttpResponse.json([
			{
				id: 'board-123',
				name: 'Test Board',
				url: 'https://trello.com/b/board-123',
			},
		])
	}),

	http.get('https://api.trello.com/1/boards/:id/lists', () => {
		return HttpResponse.json([
			{
				id: 'list-123',
				name: 'Test List',
				board: {
					id: 'board-123',
					name: 'Test Board',
				},
			},
		])
	}),

	http.get('https://api.trello.com/1/lists/:id', () => {
		return HttpResponse.json({
			id: 'list-123',
			name: 'Test List',
		})
	}),

	http.post('https://api.trello.com/1/cards', () => {
		return HttpResponse.json({
			id: 'card-123',
			name: 'Test Card',
			url: 'https://trello.com/c/card-123',
		})
	}),

	// POS / delivery platform sandbox
	...posSandboxHandlers,

	// Generic error handler for unmatched requests
	http.all('*', ({ request }) => {
		console.warn(`Unhandled ${request.method} request to ${request.url}`)
		return new HttpResponse(null, { status: 404 })
	}),
]
