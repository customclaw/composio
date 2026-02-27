/**
 * Composio Tool Router types for OpenClaw integration
 */

export type ComposioSessionTag =
  | "readOnlyHint"
  | "destructiveHint"
  | "idempotentHint"
  | "openWorldHint";

export interface ComposioConfig {
  enabled: boolean;
  apiKey?: string;
  allowedToolkits?: string[];
  blockedToolkits?: string[];
  readOnlyMode?: boolean;
  sessionTags?: ComposioSessionTag[];
  allowedToolSlugs?: string[];
  blockedToolSlugs?: string[];
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
  userId: string;
  authUrl?: string;
}

export interface ConnectedAccountSummary {
  id: string;
  toolkit: string;
  userId?: string;
  status?: string;
  authConfigId?: string;
  isDisabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}
