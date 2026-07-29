import 'dotenv/config';
import { Bot } from 'grammy';
import { globalConfig } from './config.js';
import './db/database.js';  // Initialize DB on startup
import { BotInstanceManager } from './runner/manager.js';
import { handleStart } from './commands/start.js';
import { handleAddress } from './commands/address.js';
import { handleWallet } from './commands/wallet.js';
import { makeStartBot, makeStopBot, makeStatus } from './commands/bot.js';
import { makeBuy, makeSell } from './commands/trade.js';
import { handleConfig } from './commands/config.js';
import { handlePnl, handleHistory } from './commands/pnl.js';
import { makePositions } from './commands/positions.js';
import { handlePairs, handlePair } from './commands/pairs.js';

const manager = new BotInstanceManager(globalConfig);
const bot = new Bot(globalConfig.botToken);

// Commands
bot.command('start', handleStart);
bot.command('address', handleAddress);
bot.command('wallet', handleWallet);
bot.command('pairs', handlePairs);
bot.command('pair', handlePair);
bot.command('startbot', makeStartBot(manager));
bot.command('stopbot', makeStopBot(manager));
bot.command('status', makeStatus(manager));
bot.command('positions', makePositions(manager));
bot.command('buy', makeBuy(manager));
bot.command('sell', makeSell(manager));
bot.command('config', handleConfig);
bot.command('pnl', handlePnl);
bot.command('history', handleHistory);

// Error handler
bot.catch((err) => {
  console.error('[bot] Unhandled error:', err);
});

// Graceful shutdown
const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n[shutdown] Received ${signal}; stopping all bots...`);
  await manager.stopAll();
  await bot.stop();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

console.log('[bot] Starting Telegram trading bot...');
bot.start({
  onStart: async () => {
    console.log('[bot] Bot is running and listening for messages.');
    await bot.api.setMyCommands([
      { command: 'start',     description: 'Register and get your wallet address' },
      { command: 'address',   description: 'Show your deposit address' },
      { command: 'wallet',    description: 'Show wallet address and live balances' },
      { command: 'pairs',     description: 'List available trading pairs' },
      { command: 'pair',      description: 'Switch trading pair — /pair SOMI:USDso' },
      { command: 'startbot',  description: 'Start the trading bot — /startbot [grid|marketMaker|threshold]' },
      { command: 'stopbot',   description: 'Stop the trading bot' },
      { command: 'status',    description: 'Show bot status and strategy info' },
      { command: 'positions', description: 'Show open lots and balances' },
      { command: 'buy',       description: 'Manual buy — /buy <amount> [price]' },
      { command: 'sell',      description: 'Manual sell — /sell <amount> [price]' },
      { command: 'config',    description: 'View or update config — /config [key value]' },
      { command: 'pnl',       description: 'Session P&L summary' },
      { command: 'history',   description: 'Recent trade history — /history [n]' },
    ]);
    console.log('[bot] Command menu registered with Telegram.');
  },
});
