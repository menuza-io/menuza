# Jira Provider Implementation Summary

## Overview

The Jira provider has been implemented with OAuth authentication, project
management, and issue creation capabilities. This implementation provides
integration with Jira Cloud instances for project management and issue tracking
workflows.

## Implemented Features

### OAuth Integration ✅

- **OAuth URL Generation**: Creates proper Atlassian OAuth authorization URLs
  with required scopes
- **Token Exchange**: Handles OAuth callback and exchanges authorization codes
  for access tokens
- **Environment Configuration**: Requires `JIRA_CLIENT_ID` and
  `JIRA_CLIENT_SECRET` environment variables
- **Error Handling**: Comprehensive error handling for OAuth failures
- **Resource Discovery**: Automatically discovers accessible Jira resources and
  cloud instances

**Key Components:**

- `getAuthUrl()` - Generates Atlassian OAuth authorization URLs
- `handleCallback()` - Processes OAuth callbacks and exchanges tokens
- `refreshToken()` - Handles token refresh using refresh tokens
- Environment variable validation
- OAuth state management integration

**Required Scopes:**

- `read:jira-work` - Read access to Jira work items
- `write:jira-work` - Write access to create and update issues
- `manage:jira-project` - Project management permissions

### Project Operations ✅

- **Project Listing**: Fetches accessible Jira projects from the connected
  instance
- **Project Validation**: Validates project accessibility and permissions
- **Project Metadata**: Captures project information (key, name, type, lead,
  description)
- **Channel Mapping**: Maps Jira projects to the generic "channel" interface for
  consistency

**Key Components:**

- `getAvailableChannels()` - Retrieves accessible Jira projects (mapped as
  channels)
- `validateConnection()` - Validates project connections
- `getProject()` - Fetches specific project details
- `getProjects()` - Retrieves all accessible projects

### Issue Operations

- **Issue Creation**: Creates Jira issues from note data
- **Dynamic Issue Types**: Dynamically fetches and validates available issue
  types for the project
- **Smart Fallbacks**: Uses preferred issue type when available, falls back to
  appropriate alternatives
- **Content Formatting**: Creates well-formatted Atlassian Document Format (ADF)
  content
- **Bot User Support**: Can create issues as a service account instead of
  personal user
- **Reporter Configuration**: Configurable issue reporter account at integration
  or connection level in issue description
- **URL Linking**: Automatic linking back to the original note

**Key Components:**

- `postMessage()` - Creates Jira issues from message data
- `createIssue()` - Handles Jira API issue creation
- `formatJiraIssue()` - Formats message data for Jira issue structure
- Content truncation and validation

## Configuration Schema

The Jira provider supports the following configuration options:

```json
{
	"instanceUrl": {
		"type": "string",
		"title": "Jira Instance URL",
		"description": "Your Jira Cloud instance URL (e.g., https://yourcompany.atlassian.net)",
		"pattern": "^https://[a-zA-Z0-9-]+\\.atlassian\\.net/?$",
		"required": true
	},
	"defaultIssueType": {
		"type": "string",
		"title": "Default Issue Type",
		"description": "Default issue type for created issues (e.g., Task, Story, Bug)",
		"default": "Task"
	},
	"includeNoteContent": {
		"type": "boolean",
		"title": "Include Note Content",
		"description": "Include the full note content in the issue description",
		"default": true
	}
}
```

## API Endpoints Used

### Atlassian OAuth

- `https://auth.atlassian.com/authorize` - OAuth authorization
- `https://auth.atlassian.com/oauth/token` - Token exchange and refresh

### Atlassian API

- `https://api.atlassian.com/me` - Current user information
- `https://api.atlassian.com/oauth/token/accessible-resources` - Accessible
  resources

### Jira Cloud API

- `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/project/search` - List
  projects
- `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/project/{projectKey}` -
  Get project
- `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/issue` - Create issue

## Environment Variables Required

```bash
# Jira OAuth Configuration
JIRA_CLIENT_ID=your_jira_client_id
JIRA_CLIENT_SECRET=your_jira_client_secret
```

## Integration Workflow

1. **Setup**: Configure Jira instance URL and OAuth credentials
2. **Authentication**: User authorizes access through Atlassian OAuth
3. **Project Selection**: User selects target Jira project for integration
4. **Issue Creation**: Notes automatically create issues in the selected project

## Error Handling

The provider includes comprehensive error handling for:

- OAuth authentication failures
- Invalid or expired tokens
- Network connectivity issues
- Jira API errors and rate limiting
- Missing configuration or permissions
- Invalid project keys or issue types

## Security Considerations

- OAuth tokens are securely stored and automatically refreshed
- All API requests use HTTPS
- Sensitive configuration is validated and sanitized
- Error messages don't expose sensitive information
- Proper scope validation ensures minimal required permissions

## Bot User Functionality

The Jira provider includes support for creating issues with a service account
(bot user) instead of the connected user's personal account. This provides
several benefits:

- Consistent issue creation identity across the organization
- Separation between personal and automated activity
- Better tracking of integration-created issues
- Professional appearance in Jira workflows

### Configuration Options

**Integration-level configuration**:

```typescript
// In JiraConfig
useBotUser?: boolean       // Enable/disable bot user functionality
botUser?: {                // Bot user details
  accountId: string        // Jira account ID for the bot user
  displayName: string      // Display name for reference
  emailAddress?: string    // Optional email address
}
```

**Connection-level override**:

```typescript
// In JiraConnectionConfig
useBotUser?: boolean       // Override integration setting
reporterAccountId?: string // Specific reporter account for this connection
```

### Setting Up a Bot User

1. **Create a Service Account in Jira**
   - Create a dedicated user in Jira admin settings
   - Grant appropriate project permissions (minimum: Create Issues)
   - Recommended naming: `menuza-bot@yourcompany.com`

2. **Find the Account ID**
   - Use the built-in user search utility in settings
   - Check user profile URL:
     `https://yourcompany.atlassian.net/jira/people/ACCOUNT_ID`
   - Or use the Jira API: `GET /rest/api/3/myself`

3. **Configure in Settings**
   - Enable "Use Bot User" in Jira integration settings
   - Select or search for the service account
   - Save configuration

### Implementation Details

- `getReporterAccountId()` - Determines the appropriate reporter account ID
  using a priority-based algorithm
- `configureBotUser()` - Validates and configures a bot user account
- `searchUsers()` - Searches for Jira users to find service accounts
- `validateBotUser()` - Checks if a user has appropriate permissions

## Future Enhancements

- **Advanced Project Settings**: Project-specific default issue types and field
  mapping
- **Custom Field Support**: Support for custom fields in Jira issues
- **Two-way Sync**: Update notes when Jira issues are updated
- **Enhanced Error Recovery**: More granular error handling and recovery
- **Attachment Support**: Upload note attachments to Jira and sync
- Support for Jira Server (on-premise) instances

## Testing Recommendations

To test the Jira provider:

1. Set up a Jira Cloud development instance
2. Create an Atlassian OAuth app with required scopes
3. Configure environment variables
4. Test OAuth flow and token management
5. Verify project listing and validation
6. Test issue creation with various note types
7. Validate error handling scenarios
