import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { UltraDevLog as DebugLog } from '../utils/UltraDevLog';
import { MemoryManager } from '../core/MemoryManager';
import type { TaskExecutor } from '../core/TaskExecutor';
import type { ModelRouter } from '../core/ModelRouter';

export interface EventTrigger {
  id: string;
  type: 'sms' | 'battery' | 'notification' | 'schedule';
  condition: string;
  action: string;
  enabled: boolean;
  createdAt: number;
  lastFired?: number;
}

export class EventMonitor {
  private triggers: EventTrigger[] = [];
  private scheduleInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private uiEventEmitter: NativeEventEmitter | null = null;

  constructor(
    private executor: TaskExecutor,
    private memory: MemoryManager,
    private ai: ModelRouter
  ) {}

  async start(): Promise<void> {
    if (this.isRunning || Platform.OS !== 'android') return;
    this.isRunning = true;

    await this.loadTriggers();

    if (NativeModules.AppController) {
      this.uiEventEmitter = new NativeEventEmitter(NativeModules.AppController);
      this.uiEventEmitter.addListener('onUiTreeChanged', (event) => {
        this.evaluateNotificationTriggers(event.packageName);
      });
    }

    this.scheduleInterval = setInterval(() => {
      this.evaluateScheduleTriggers();
    }, 60000);

    DebugLog.systemEvent('EventMonitor', `Started. Triggers: ${this.triggers.length}`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.scheduleInterval) clearInterval(this.scheduleInterval);
    if (this.uiEventEmitter) this.uiEventEmitter.removeAllListeners('onUiTreeChanged');
  }

  private async evaluateScheduleTriggers(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    for (const trigger of this.triggers.filter(t => t.enabled && t.type === 'schedule')) {
      const conditionMet = this.evaluateCondition(trigger.condition, { hour, minute });
      if (conditionMet) {
        const cooldown = 60000;
        if (!trigger.lastFired || Date.now() - trigger.lastFired > cooldown) {
          trigger.lastFired = Date.now();
          await this.fireTrigger(trigger);
        }
      }
    }
  }

  private async evaluateNotificationTriggers(packageName: string): Promise<void> {
    for (const trigger of this.triggers.filter(t => t.enabled && t.type === 'notification')) {
      const conditionMet = this.evaluateCondition(trigger.condition, { packageName });
      if (conditionMet) {
        const cooldown = 5000;
        if (!trigger.lastFired || Date.now() - trigger.lastFired > cooldown) {
          trigger.lastFired = Date.now();
          await this.fireTrigger(trigger);
        }
      }
    }
  }

  private evaluateCondition(condition: string, data: Record<string, any>): boolean {
    const c = condition.toLowerCase();
    if (data.hour !== undefined && data.minute !== undefined) {
      const timeMatch = condition.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (timeMatch) {
        let targetHour = parseInt(timeMatch[1]);
        const targetMin = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
        const ampm = timeMatch[3]?.toLowerCase();
        if (ampm === 'pm' && targetHour < 12) targetHour += 12;
        if (ampm === 'am' && targetHour === 12) targetHour = 0;
        return data.hour === targetHour && Math.abs(data.minute - targetMin) <= 1;
      }
    }
    if (data.packageName) {
      return c.includes(data.packageName.toLowerCase());
    }
    return false;
  }

  private async fireTrigger(trigger: EventTrigger): Promise<void> {
    DebugLog.systemEvent('EventMonitor', `TRIGGER_FIRE id=${trigger.id} action="${trigger.action.slice(0, 60)}"`);
    try {
      const { CommandParser } = await import('../core/CommandParser');
      const parser = new CommandParser();
      const plan = parser.parse(trigger.action);
      if (plan) {
        await this.executor.runWithPlan(plan, `trigger_${trigger.id}`);
      }
    } catch (err: any) {
      DebugLog.error('EventMonitor', `Trigger ${trigger.id} failed: ${err.message}`);
    }
  }

  async addTrigger(trigger: Omit<EventTrigger, 'id' | 'createdAt'>): Promise<string> {
    const id = `trigger_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const full: EventTrigger = { ...trigger, id, createdAt: Date.now() };
    this.triggers.push(full);
    await this.memory.storeLongterm(`trigger:${id}`, 'event_trigger', JSON.stringify(full));
    return id;
  }

  async removeTrigger(id: string): Promise<void> {
    this.triggers = this.triggers.filter(t => t.id !== id);
  }

  getTriggers(): EventTrigger[] {
    return [...this.triggers];
  }

  private async loadTriggers(): Promise<void> {
    const stored = await this.memory.retrieveRelevant('event_trigger', 50);
    for (const record of stored) {
      if (record.capability === 'event_trigger') {
        try {
          const trigger: EventTrigger = JSON.parse(record.outcome);
          if (trigger.id && trigger.type && trigger.action) {
            this.triggers.push(trigger);
          }
        } catch {}
      }
    }
  }
}