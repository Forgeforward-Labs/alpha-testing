'use client';
import { useState, useEffect } from 'react';
import type { BotSnapshot } from '@/types';

const BOT_URL = process.env.NEXT_PUBLIC_BOT_URL ?? 'http://localhost:3001';

export function useBotState() {
  const [state, setState] = useState<BotSnapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    fetch(`${BOT_URL}/api/state`)
      .then((r) => r.json())
      .then((data: BotSnapshot) => { setState(data); setConnected(true); })
      .catch(() => setConnected(false));

    const es = new EventSource(`${BOT_URL}/api/events`);

    const handle = (e: MessageEvent<string>) => {
      const parsed = JSON.parse(e.data) as BotSnapshot;
      setState(parsed);
      setConnected(true);
    };

    es.addEventListener('state', handle);
    es.addEventListener('trade', handle);
    es.addEventListener('heartbeat', handle);
    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);

  return { state, connected };
}
