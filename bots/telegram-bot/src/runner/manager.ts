import path from 'node:path';
import { BotRunner } from './bot-runner.js';
import type { UserBotConfig } from './types.js';
import type { GlobalConfig } from '../config.js';

export class BotInstanceManager {
  private runners = new Map<string, BotRunner>();

  constructor(private readonly globalConfig: GlobalConfig) {}

  async start(config: UserBotConfig): Promise<void> {
    const existing = this.runners.get(config.telegramId);
    if (existing?.isRunning) {
      throw new Error('Bot is already running for this user.');
    }

    const persistenceDir = path.join(
      this.globalConfig.persistenceDir,
      config.telegramId,
    );
    const runner = new BotRunner(
      { ...config, persistenceDir },
      this.globalConfig,
    );

    this.runners.set(config.telegramId, runner);
    await runner.start();
  }

  async stop(telegramId: string): Promise<void> {
    const runner = this.runners.get(telegramId);
    if (!runner) throw new Error('No bot running for this user.');
    await runner.stop();
    this.runners.delete(telegramId);
  }

  get(telegramId: string): BotRunner | undefined {
    return this.runners.get(telegramId);
  }

  isRunning(telegramId: string): boolean {
    return this.runners.get(telegramId)?.isRunning ?? false;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runners.values()].map((r) => r.stop()));
    this.runners.clear();
  }
}
