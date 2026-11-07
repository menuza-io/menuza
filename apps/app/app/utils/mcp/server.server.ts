import { type ORG_PERMISSIONS, userHasOrganizationPermission } from '@repo/auth'
import { type User, type Organization } from '@repo/database/types'

/**
 * MCP Server Service
 *
 * This service handles MCP (Model Context Protocol) operations including:
 * - Tool registration and management
 * - Tool execution with context
 * - MCP request handling (tools/list, tools/call)
 * - Error handling and validation
 */

export interface MCPContext {
	user: User
	organization: Organization
}

export interface MCPToolRequest {
	method: string
	params: {
		name: string
		arguments?: Record<string, any>
	}
}

export interface MCPToolResponse {
	content: Array<{
		type: 'text' | 'image' | 'resource'
		text?: string
		data?: string
		mimeType?: string
	}>
}

export interface MCPTool {
	name: string
	description: string
	inputSchema: any
	/**
	 * Organization permission the caller must hold, checked live on every call
	 * (the same one the app page for this data requires). A token or API key
	 * proves membership only, so a role change takes effect on the next call.
	 */
	permission?: (typeof ORG_PERMISSIONS)[keyof typeof ORG_PERMISSIONS]
	handler: (args: any, context: MCPContext) => Promise<MCPToolResponse>
}

// Tool registry - stores all registered tools
const tools = new Map<string, MCPTool>()

/**
 * Register a tool with the MCP server
 *
 * @param tool - The tool to register
 * @throws Error if tool with same name already exists
 */
export function registerTool(tool: MCPTool): void {
	if (tools.has(tool.name)) {
		throw new Error(`Tool already registered: ${tool.name}`)
	}
	tools.set(tool.name, tool)
}

/**
 * Get all registered tool definitions
 *
 * @returns Array of tool definitions (name, description, inputSchema)
 */
export function getToolDefinitions(): Array<{
	name: string
	description: string
	inputSchema: any
}> {
	return Array.from(tools.values()).map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
	}))
}

/**
 * Execute a tool with the given arguments and context
 *
 * @param name - Name of the tool to execute
 * @param args - Arguments to pass to the tool
 * @param context - MCP context (user, organization)
 * @returns Tool response
 * @throws Error if tool not found or execution fails
 */
export async function executeTool(
	name: string,
	args: any,
	context: MCPContext,
): Promise<MCPToolResponse> {
	const tool = tools.get(name)

	if (!tool) {
		throw new Error(`Tool not found: ${name}`)
	}

	if (
		tool.permission &&
		!(await userHasOrganizationPermission(
			context.user.id,
			context.organization.id,
			tool.permission,
		))
	) {
		return {
			content: [
				{
					type: 'text',
					text: `Permission denied: ${name} needs the ${tool.permission} permission in this organization.`,
				},
			],
		}
	}

	try {
		return await tool.handler(args, context)
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error'
		throw new Error(`Tool execution failed: ${errorMessage}`)
	}
}

/**
 * Handle an MCP request
 *
 * Supports:
 * - tools/list: Returns list of available tools
 * - tools/call: Executes a tool with given arguments
 *
 * @param request - MCP request
 * @param context - MCP context (user, organization)
 * @returns Response object
 * @throws Error if method is unknown or execution fails
 */
export async function handleMCPRequest(
	request: MCPToolRequest,
	context: MCPContext,
): Promise<any> {
	if (!request.method) {
		throw new Error('Missing method in request')
	}

	if (request.method === 'tools/list') {
		return {
			tools: getToolDefinitions(),
		}
	}

	if (request.method === 'tools/call') {
		if (!request.params) {
			throw new Error('Missing params in request')
		}

		const { name, arguments: args } = request.params

		if (!name) {
			throw new Error('Missing tool name in params')
		}

		return await executeTool(name, args || {}, context)
	}

	throw new Error(`Unknown method: ${request.method}`)
}

/**
 * Clear all registered tools (useful for testing)
 */
export function clearTools(): void {
	tools.clear()
}

/**
 * Get a specific tool by name
 *
 * @param name - Name of the tool
 * @returns Tool or undefined if not found
 */
export function getTool(name: string): MCPTool | undefined {
	return tools.get(name)
}
