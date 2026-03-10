export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageSource = 'ultra' | 'model' | 'system';

export interface PromptTrace {
  model: string;
  systemPrompt: string;
  framedUserMessage: string;
  includedMessages: Array<{ role: MessageRole; content: string }>;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  source?: MessageSource;
  meta?: {
    promptTrace?: PromptTrace;
    mode?: 'command' | 'conversation' | 'ai_instruction';
    capability?: string;
    risk?: 'safe' | 'moderate' | 'dangerous' | 'blocked';
  };
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  summary?: string;
  summaryUpdatedAt?: number;
  messageCountSinceSummary?: number;
  messages: ChatMessage[];
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  preview: string;
  messageCount: number;
}

export interface UltraModelDef {
  id: string;
  contextWindow: number;
  speedTier: 'fast' | 'balanced' | 'heavy';
  strengths: Array<'code' | 'analysis' | 'chat' | 'long_context' | 'tool_use'>;
}

export type ExecutionResultType =
  | 'text'
  | 'action_result'
  | 'model_switch_request'
  | 'approval_required'
  | 'blocked'
  | 'error'
  | 'clarify';

export interface UltraExecutionResult {
  type: ExecutionResultType;
  message: string;
  data?: any;
}

export interface ActionPlan {
  capability: string;
  params: Record<string, any>;
  reason?: string;
  raw?: string;
}

export interface SafetyCheckResult {
  allowed: boolean;
  risk: 'safe' | 'moderate' | 'dangerous' | 'blocked';
  requiresApproval: boolean;
  reasons: string[];
}

export type EventPhase = 'INTAKE' | 'PLAN' | 'VERIFY' | 'APPROVE' | 'EXECUTE' | 'VERIFY_RESULT' | 'LEARN';

export interface ExecutionEvent {
  id: string;
  timestamp: number;
  phase: EventPhase;
  capability?: string;
  inputSummary: string;
  outputSummary: string;
  model?: string;
  cost?: number;
  idempotencyKey?: string;
  success: boolean;
  conversationId?: string;
}

export interface ParamDef {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
}

export interface CapabilitySchema {
  capabilityId: string;
  version: number;
  requiredParams: Record<string, ParamDef>;
  optionalParams: Record<string, ParamDef>;
}

export interface RecommendInput {
  taskType: 'code' | 'analysis' | 'conversation' | 'simple' | 'agent_action';
  requiredContextTokens: number;
  currentModel: string;
}

export interface ModelRecommendation {
  recommended: string;
  reason: string;
}

export interface BudgetCheck {
  allowed: boolean;
  reason: string;
}

export interface SessionStats {
  actionCount: number;
  highRiskCount: number;
  totalCost: number;
}
