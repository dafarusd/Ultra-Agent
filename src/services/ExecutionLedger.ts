import { Platform } from 'react-native';
import * as ExpoFileSystem from 'expo-file-system/legacy';
import { ExecutionEvent, EventPhase, BudgetCheck, SessionStats } from '../types/ultra';
import { Logger } from '../utils/Logger';

const FileSystem: any = Platform.OS !== 'web' ? ExpoFileSystem : null;
const isNative = Platform.OS !== 'web';

interface BudgetLimits {
  maxActionsPerSession: number;
  maxCostPerSession: number;
  maxHighRiskPerSession: number;
  /** Max spend for a single task/run (0 = disabled). */
  maxCostPerTask: number;
  /** Max spend across a rolling 24-hour window (0 = disabled). */
  maxCostPerDay: number;
}

const DEFAULT_BUDGET: BudgetLimits = {
  maxActionsPerSession: 50,
  maxCostPerSession: 2.0,
  maxHighRiskPerSession: 3,
  maxCostPerTask: 0,
  maxCostPerDay: 0,
};

const SESSION_WINDOW_MS = 60 * 60 * 1000;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

const LEDGER_FILE = 'execution-ledger.json';
const WEB_STORAGE_KEY = 'ultra_execution_ledger';

export class ExecutionLedger {
  private events: ExecutionEvent[] = [];
  private logger: Logger;
  budgetLimits: BudgetLimits;
  private baseDir: string;
  private initialized = false;

  constructor(budgetLimits?: Partial<BudgetLimits>) {
    this.logger = new Logger('ExecutionLedger');
    this.budgetLimits = { ...DEFAULT_BUDGET, ...budgetLimits };
    this.baseDir = (isNative && FileSystem?.documentDirectory) || '';
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.loadEvents();
      this.initialized = true;
      this.logger.info(`ExecutionLedger initialized with ${this.events.length} events`);
    } catch (e: any) {
      this.logger.error('Failed to initialize ExecutionLedger', e);
      this.events = [];
      this.initialized = true;
    }
  }

  async logEvent(event: Omit<ExecutionEvent, 'id' | 'timestamp'>): Promise<ExecutionEvent> {
    await this.initialize();

    const fullEvent: ExecutionEvent = {
      ...event,
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      timestamp: Date.now(),
    };

    this.events.push(fullEvent);

    const MAX_LEDGER_EVENTS = 500;
    if (this.events.length > MAX_LEDGER_EVENTS) {
      this.events = this.events.slice(-MAX_LEDGER_EVENTS);
    }

    await this.persistEvents();
    this.logger.info(`Event logged: ${fullEvent.phase} ${fullEvent.capability ?? ''}`);
    return fullEvent;
  }

  async getEvents(filters?: {
    phase?: EventPhase;
    capability?: string;
    conversationId?: string;
    since?: number;
    success?: boolean;
  }): Promise<ExecutionEvent[]> {
    await this.initialize();

    if (!filters) return [...this.events];

    return this.events.filter((e) => {
      if (filters.phase && e.phase !== filters.phase) return false;
      if (filters.capability && e.capability !== filters.capability) return false;
      if (filters.conversationId && e.conversationId !== filters.conversationId) return false;
      if (filters.since && e.timestamp < filters.since) return false;
      if (filters.success !== undefined && e.success !== filters.success) return false;
      return true;
    });
  }

  async checkIdempotency(key: string): Promise<boolean> {
    await this.initialize();
    return this.events.some((e) => e.idempotencyKey === key);
  }

  async getSessionStats(): Promise<SessionStats> {
    await this.initialize();

    const sessionStart = Date.now() - SESSION_WINDOW_MS;
    const sessionEvents = this.events.filter((e) => e.timestamp >= sessionStart);

    const actionCount = sessionEvents.filter((e) => e.phase === 'EXECUTE').length;
    const highRiskCount = sessionEvents.filter(
      (e) => e.phase === 'EXECUTE' && e.inputSummary.includes('[dangerous]')
    ).length;
    const totalCost = sessionEvents.reduce((sum, e) => sum + (e.cost ?? 0), 0);

    return { actionCount, highRiskCount, totalCost };
  }

  async getDailyStats(): Promise<{ totalCost: number }> {
    await this.initialize();
    const dayStart = Date.now() - DAILY_WINDOW_MS;
    const dailyEvents = this.events.filter(e => e.timestamp >= dayStart);
    const totalCost = dailyEvents.reduce((sum, e) => sum + (e.cost ?? 0), 0);
    return { totalCost };
  }

  async checkBudget(): Promise<BudgetCheck> {
    const stats = await this.getSessionStats();

    if (stats.actionCount >= this.budgetLimits.maxActionsPerSession) {
      return {
        allowed: false,
        reason: `Session action limit reached (${stats.actionCount}/${this.budgetLimits.maxActionsPerSession}). Wait for the session window to reset.`,
      };
    }

    if (stats.totalCost >= this.budgetLimits.maxCostPerSession) {
      return {
        allowed: false,
        reason: `Session cost limit reached ($${stats.totalCost.toFixed(2)}/$${this.budgetLimits.maxCostPerSession.toFixed(2)}). Wait for the session window to reset.`,
      };
    }

    if (stats.highRiskCount >= this.budgetLimits.maxHighRiskPerSession) {
      return {
        allowed: false,
        reason: `High-risk operation limit reached (${stats.highRiskCount}/${this.budgetLimits.maxHighRiskPerSession}). Wait for the session window to reset.`,
      };
    }

    if (this.budgetLimits.maxCostPerDay > 0) {
      const dailyStats = await this.getDailyStats();
      if (dailyStats.totalCost >= this.budgetLimits.maxCostPerDay) {
        return {
          allowed: false,
          reason: `Daily cost limit reached ($${dailyStats.totalCost.toFixed(2)}/$${this.budgetLimits.maxCostPerDay.toFixed(2)}). Resets after 24 hours.`,
        };
      }
    }

    return { allowed: true, reason: 'Within budget' };
  }

  /** Check whether a single task's accumulated cost would exceed the per-task limit. */
  checkTaskBudget(taskCostSoFar: number): BudgetCheck {
    if (this.budgetLimits.maxCostPerTask <= 0) return { allowed: true, reason: 'No per-task limit set' };
    if (taskCostSoFar >= this.budgetLimits.maxCostPerTask) {
      return {
        allowed: false,
        reason: `Per-task cost limit reached ($${taskCostSoFar.toFixed(4)}/$${this.budgetLimits.maxCostPerTask.toFixed(2)}). Start a new conversation to continue.`,
      };
    }
    return { allowed: true, reason: 'Within per-task budget' };
  }

  private async loadEvents(): Promise<void> {
    if (isNative) {
      try {
        const filePath = this.baseDir + LEDGER_FILE;
        const info = await FileSystem.getInfoAsync(filePath);
        if (info.exists) {
          const raw = await FileSystem.readAsStringAsync(filePath);
          this.events = JSON.parse(raw) ?? [];
        }
      } catch (e: any) {
        this.logger.error('Failed to load ledger from file system', e);
        this.events = [];
      }
    } else {
      try {
        const raw = localStorage.getItem(WEB_STORAGE_KEY);
        if (raw) {
          this.events = JSON.parse(raw) ?? [];
        }
      } catch (e: any) {
        this.logger.error('Failed to load ledger from localStorage', e);
        this.events = [];
      }
    }
  }

  private async persistEvents(): Promise<void> {
    const data = JSON.stringify(this.events);

    if (isNative) {
      try {
        const filePath = this.baseDir + LEDGER_FILE;
        await FileSystem.writeAsStringAsync(filePath, data);
      } catch (e: any) {
        this.logger.error('Failed to persist ledger to file system', e);
      }
    } else {
      try {
        localStorage.setItem(WEB_STORAGE_KEY, data);
      } catch (e: any) {
        this.logger.error('Failed to persist ledger to localStorage', e);
      }
    }
  }
}
