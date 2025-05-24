/**
 * IMPORTANT: Check README.md first for project configuration, team structure, and usage examples
 *
 * PaddockPal Jira MCP Server (Cloudflare Worker)
 *
 * Available Tools:
 * 1. list_issue_types: List all available issue types in Jira
 *    - No parameters required
 *
 * 2. get_user: Get a user's account ID by email address
 *    - Required: email (string)
 *
 * 3. create_project: Create a new Jira project
 *    - Required: key (string), name (string), projectTypeKey (string), leadAccountId (string)
 *    - Optional: description (string), projectTemplateKey (string)
 *
 * 4. create_issue: Create a new Jira issue or subtask
 *    - Required: projectKey (string), summary (string), issueType (string)
 *    - Optional: description (string), assignee (string), labels (string[]),
 *               components (string[]), priority (string), parent (string)
 *
 */

import { DurableObject } from "cloudflare:workers";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  JIRA_HOST: string;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
}

/**
 * Environment variables required for Jira API authentication (provided via Cloudflare Worker environment):
 * - JIRA_HOST: Jira instance hostname (e.g., paddock.atlassian.net)
 * - JIRA_EMAIL: User's email address for authentication
 * - JIRA_API_TOKEN: API token from https://id.atlassian.com/manage-profile/security/api-tokens
 */

/**
 * Default project configuration from README.md
 */
const DEFAULT_PROJECT = {
  KEY: "CPG",
  ID: "10000",
  NAME: "Website MVP",
  TYPE: "software",
  ENTITY_ID: "e01e939e-8442-4967-835d-362886c653e3",
};

/**
 * Default project manager configuration from README.md
 */
const DEFAULT_MANAGER = {
  EMAIL: "ghsstephens@gmail.com",
  ACCOUNT_ID: "712020:dc572395-3fef-4ee3-a31c-2e1b288c72d6",
  NAME: "George",
};

interface JiraField {
  id: string;
  name: string;
  required: boolean;
  schema: {
    type: string;
    system?: string;
    custom?: string;
    customId?: number;
  };
}

interface JiraIssueType {
  id: string;
  name: string;
  fields: Record<string, JiraField>;
}

/**
 * Interface definitions for Jira API requests
 */

/**
 * Arguments for creating a new Jira issue or subtask
 * @property projectKey - Key of the project to create the issue in
 * @property summary - Issue title/summary
 * @property issueType - Type of issue (e.g., "Task", "Story", "Subtask")
 * @property description - Optional detailed description
 * @property assignee - Optional email of user to assign
 * @property labels - Optional array of labels to apply
 * @property components - Optional array of component names
 * @property priority - Optional priority level
 * @property parent - Optional parent issue key (required for subtasks)
 */
interface CreateIssueArgs {
  projectKey: string;
  summary: string;
  issueType: string;
  description?: string;
  assignee?: string;
  labels?: string[];
  components?: string[];
  priority?: string;
  parent?: string;
}

interface GetIssuesArgs {
  projectKey: string;
  jql?: string;
}

interface UpdateIssueArgs {
  issueKey: string;
  summary?: string;
  description?: string;
  assignee?: string;
  status?: string;
  priority?: string;
}

interface CreateIssueLinkArgs {
  inwardIssueKey: string;
  outwardIssueKey: string;
  linkType: string;
}

/**
 * Arguments for getting a user's account ID
 * @property email - Email address of the user to look up
 */
interface GetUserArgs {
  email: string;
}

/**
 * Represents a Jira issue type with its properties
 * @property id - Unique identifier for the issue type
 * @property name - Display name of the issue type
 * @property description - Optional description of when to use this type
 * @property subtask - Whether this is a subtask type
 */
interface IssueType {
  id: string;
  name: string;
  description?: string;
  subtask: boolean;
}

/**
 * Converts plain text to Atlassian Document Format (ADF)
 * Used for formatting issue descriptions in Jira's rich text format
 * @param text - Plain text to convert to ADF
 * @returns ADF document object with the text content
 */
function convertToADF(text: string) {
  const lines = text.split("\n");
  const content: any[] = [];
  let currentList: any = null;
  let currentListType: "bullet" | "ordered" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = lines[i + 1] || "";

    // Skip empty lines between paragraphs
    if (line.trim() === "") {
      currentList = null;
      currentListType = null;
      continue;
    }

    // Handle bullet points
    if (line.trim().startsWith("- ")) {
      const listItem = line.trim().substring(2);
      if (currentListType !== "bullet") {
        currentList = {
          type: "bulletList",
          content: [],
        };
        content.push(currentList);
        currentListType = "bullet";
      }
      currentList.content.push({
        type: "listItem",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: listItem,
              },
            ],
          },
        ],
      });
    }
    // Handle numbered lists
    else if (/^\d+\.\s/.test(line.trim())) {
      const listItem = line.trim().replace(/^\d+\.\s/, "");
      if (currentListType !== "ordered") {
        currentList = {
          type: "orderedList",
          content: [],
        };
        content.push(currentList);
        currentListType = "ordered";
      }
      currentList.content.push({
        type: "listItem",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: listItem,
              },
            ],
          },
        ],
      });
    }
    // Handle headings (check next line for underline)
    else if (nextLine && /^=+$/.test(nextLine.trim())) {
      currentList = null;
      currentListType = null;
      content.push({
        type: "heading",
        attrs: { level: 1 },
        content: [
          {
            type: "text",
            text: line.trim(),
          },
        ],
      });
      i++; // Skip the underline
    } else if (nextLine && /^-+$/.test(nextLine.trim())) {
      currentList = null;
      currentListType = null;
      content.push({
        type: "heading",
        attrs: { level: 2 },
        content: [
          {
            type: "text",
            text: line.trim(),
          },
        ],
      });
      i++; // Skip the underline
    }
    // Handle regular paragraphs
    else {
      currentList = null;
      currentListType = null;
      content.push({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: line,
          },
        ],
      });
    }
  }

  return {
    version: 1,
    type: "doc",
    content,
  };
}

/**
 * Jira MCP Durable Object class
 */
export class MyMCP extends DurableObject<Env> {
  
  private async makeJiraRequest(
    endpoint: string,
    method: string = 'GET',
    body?: any
  ): Promise<any> {
    const auth = btoa(`${this.env.JIRA_EMAIL}:${this.env.JIRA_API_TOKEN}`);
    
    const response = await fetch(`https://${this.env.JIRA_HOST}/rest/api/3/${endpoint}`, {
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }

  private validateCreateIssueArgs(args: unknown): args is CreateIssueArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as any).projectKey === "string" &&
      typeof (args as any).summary === "string" &&
      typeof (args as any).issueType === "string"
    );
  }

  private validateGetUserArgs(args: unknown): args is GetUserArgs {
    return (
      typeof args === "object" &&
      args !== null &&
      typeof (args as any).email === "string"
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle MCP requests
    if (url.pathname === '/mcp' && request.method === 'POST') {
      try {
        const body = await request.json();
        const result = await this.handleMCPRequest(body);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleMCPRequest(request: any): Promise<any> {
    switch (request.method) {
      case 'tools/list':
        return {
          tools: [
            {
              name: "list_issue_types",
              description: "List all available issue types in Jira",
              inputSchema: {
                type: "object",
                properties: {},
                required: [],
              },
            },
            {
              name: "get_user",
              description: "Get a user's account ID by email address",
              inputSchema: {
                type: "object",
                properties: {
                  email: {
                    type: "string",
                    description: "Email address of the user to look up",
                  },
                },
                required: ["email"],
              },
            },
            {
              name: "create_issue",
              description: "Create a new Jira issue or subtask",
              inputSchema: {
                type: "object",
                properties: {
                  projectKey: {
                    type: "string",
                    description: "Key of the project to create the issue in",
                  },
                  summary: {
                    type: "string",
                    description: "Issue title/summary",
                  },
                  issueType: {
                    type: "string",
                    description: "Type of issue (e.g., 'Task', 'Story', 'Subtask')",
                  },
                  description: {
                    type: "string",
                    description: "Optional detailed description",
                  },
                  assignee: {
                    type: "string",
                    description: "Optional email of user to assign",
                  },
                  labels: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional array of labels to apply",
                  },
                  components: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional array of component names",
                  },
                  priority: {
                    type: "string",
                    description: "Optional priority level",
                  },
                  parent: {
                    type: "string",
                    description: "Optional parent issue key (required for subtasks)",
                  },
                },
                required: ["projectKey", "summary", "issueType"],
              },
            },
          ],
        };

      case 'tools/call':
        return await this.handleToolCall(request.params);

      default:
        throw new Error(`Unknown method: ${request.method}`);
    }
  }

  private async handleToolCall(params: any): Promise<any> {
    switch (params.name) {
      case 'list_issue_types':
        try {
          const response = await this.makeJiraRequest('issuetype');
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  response.map((type: { id: string; name: string; description?: string; subtask?: boolean }) => ({
                    id: type.id,
                    name: type.name,
                    description: type.description || "No description available",
                    subtask: type.subtask || false,
                  })),
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error fetching issue types: ${error instanceof Error ? error.message : 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }

      case 'get_user':
        if (!this.validateGetUserArgs(params.arguments)) {
          throw new Error('Invalid arguments for get_user');
        }
        
        try {
          const response = await this.makeJiraRequest(
            `user/search?query=${encodeURIComponent(params.arguments.email)}&maxResults=1`
          );

          if (!response || response.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No user found with email: ${params.arguments.email}`,
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    accountId: response[0].accountId,
                    displayName: response[0].displayName,
                    emailAddress: response[0].emailAddress,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error fetching user: ${error instanceof Error ? error.message : 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }

      case 'create_issue':
        if (!this.validateCreateIssueArgs(params.arguments)) {
          throw new Error('Invalid arguments for create_issue');
        }

        const args = params.arguments;
        const projectKey = args.projectKey || DEFAULT_PROJECT.KEY;
        const assignee = args.assignee || DEFAULT_MANAGER.EMAIL;

        try {
          const issueData = {
            fields: {
              project: { key: projectKey },
              summary: args.summary,
              issuetype: { name: args.issueType },
              description: args.description ? convertToADF(args.description) : undefined,
              assignee: { accountId: assignee },
              labels: args.labels,
              components: args.components?.map((name: string) => ({ name })),
              priority: args.priority ? { name: args.priority } : undefined,
              parent: args.parent ? { key: args.parent } : undefined,
            },
          };

          const response = await this.makeJiraRequest('issue', 'POST', issueData);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    message: "Issue created successfully",
                    issue: {
                      id: response.id,
                      key: response.key,
                      url: `https://${this.env.JIRA_HOST}/browse/${response.key}`,
                    },
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error creating issue: ${error instanceof Error ? error.message : 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }

      default:
        throw new Error(`Unknown tool: ${params.name}`);
    }
  }
}

// Worker fetch handler
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Get or create a Durable Object instance
    const id = env.MCP_OBJECT.idFromName("mcp-jira-server");
    const durableObject = env.MCP_OBJECT.get(id);
    
    // Forward the request to the Durable Object
    return durableObject.fetch(request);
  },
};
