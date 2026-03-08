import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { Logger } from '../utils/Logger';

const BG_TASK = 'agent-ultra-bg';

export class BackgroundTaskManager {
  private logger: Logger;
  private isRegistered: boolean;

  constructor() {
    this.logger = new Logger('BackgroundTaskManager');
    this.isRegistered = false;
  }

  async initialize(): Promise<void> {
    TaskManager.defineTask(BG_TASK, async () => {
      try {
        this.logger.info('Background task executed');
        return BackgroundFetch.BackgroundFetchResult.NewData;
      } catch {
        return BackgroundFetch.BackgroundFetchResult.Failed;
      }
    });
    this.logger.info('BackgroundTaskManager initialized');
  }

  async start(): Promise<void> {
    if (this.isRegistered) return;
    try {
      await BackgroundFetch.registerTaskAsync(BG_TASK, {
        minimumInterval: 900,
        stopOnTerminate: false,
        startOnBoot: true,
      });
      this.isRegistered = true;
      this.logger.info('Background tasks started');
    } catch (error: any) {
      this.logger.error('Failed to start bg tasks: ' + error.message);
    }
  }

  async stop(): Promise<void> {
    if (!this.isRegistered) return;
    await BackgroundFetch.unregisterTaskAsync(BG_TASK);
    this.isRegistered = false;
    this.logger.info('Background tasks stopped');
  }
}
