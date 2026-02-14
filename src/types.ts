/**
 * Composio Tool Router types for OpenClaw integration
 */

export interface ComposioConfig {
  enabled: boolean;
  apiKey?: string;
  defaultUserId?: string;
  allowedToolkits?: string[];
  blockedToolkits?: string[];
}

export interface ToolSearchResult {
  name: string;
  slug: string;
  description: string;
  toolkit: string;
  parameters: Record<string, unknown>;
}

export interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ConnectionStatus {
  toolkit: string;
  connected: boolean;
  userId?: string;
  authUrl?: string;
}

