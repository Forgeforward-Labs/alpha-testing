const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const optional = (name: string, fallback: string): string => {
  return process.env[name] ?? fallback;
};

const envName = optional('DREAMDEX_ENV', 'mainnet');

export const globalConfig = {
  botToken: required('BOT_TOKEN'),
  encryptionKey: required('BOT_ENCRYPTION_KEY'),
  rpcUrl: required('DREAMDEX_RPC_URL'),
  chainId: Number(optional('DREAMDEX_CHAIN_ID', envName === 'staging' ? '50312' : '5031')),
  envName,
  baseUrl: optional(
    'DREAMDEX_BASE_URL',
    envName === 'staging' ? 'https://stg.api.dreamdex.io' : 'https://api.dreamdex.io',
  ),
  wsUrl: optional(
    'DREAMDEX_WS_URL',
    envName === 'staging'
      ? 'wss://stg.api.dreamdex.io/v0/ws/public'
      : 'wss://api.dreamdex.io/v0/ws/public',
  ),
  siweDomain: optional('DREAMDEX_SIWE_DOMAIN', 'dreamdex.somnia.host'),
  siweUri: optional('DREAMDEX_SIWE_URI', 'https://dreamdex.somnia.host'),
  persistenceDir: optional('PERSISTENCE_DIR', './data'),
} as const;

export type GlobalConfig = typeof globalConfig;

if (Number.isNaN(globalConfig.chainId)) {
  throw new Error('DREAMDEX_CHAIN_ID must be a valid number.');
}

if (!/^[0-9a-fA-F]{64}$/.test(globalConfig.encryptionKey)) {
  throw new Error('BOT_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
}
