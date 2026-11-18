/**
 * Event bus between application instances.
 * - LocalBus: a single instance (default).
 * - RedisBus: several instances behind a load balancer (REDIS_URL).
 */
import { Redis } from 'ioredis';

export type BusEvent =
  | { t: 'room'; creatorId: number; msg: Record<string, unknown>; remember?: boolean }
  | { t: 'user'; userId: number; msg: Record<string, unknown> }
  | { t: 'kick'; creatorId: number; userId: number }
  | { t: 'clear'; creatorId: number }
  | { t: 'delete'; creatorId: number; messageId: string }
  | { t: 'presence'; instance: string; creatorId: number; viewers: number[]; owners: number; at: number };

export interface Bus {
  publish(event: BusEvent): void;
  subscribe(handler: (event: BusEvent) => void): void;
  close(): Promise<void>;
}

export class LocalBus implements Bus {
  private handlers: ((e: BusEvent) => void)[] = [];
  publish(event: BusEvent): void {
    for (const h of this.handlers) h(event);
  }
  subscribe(handler: (event: BusEvent) => void): void {
    this.handlers.push(handler);
  }
  async close(): Promise<void> {}
}

const CHANNEL = 'ftw:events';

export class RedisBus implements Bus {
  private pub: Redis;
  private sub: Redis;
  private handlers: ((e: BusEvent) => void)[] = [];

  constructor(url: string) {
    this.pub = new Redis(url, { maxRetriesPerRequest: 3 });
    this.sub = new Redis(url, { maxRetriesPerRequest: 3 });
    this.sub.on('message', (_channel: string, raw: string) => {
      let event: BusEvent;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }
      for (const h of this.handlers) h(event);
    });
  }

  async ready(): Promise<void> {
    await this.sub.subscribe(CHANNEL);
  }

  publish(event: BusEvent): void {
    this.pub.publish(CHANNEL, JSON.stringify(event)).catch((err: unknown) => console.error('redis publish', err));
  }

  subscribe(handler: (event: BusEvent) => void): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    this.sub.disconnect();
    this.pub.disconnect();
  }
}

export async function createBus(redisUrl: string): Promise<Bus> {
  if (!redisUrl) return new LocalBus();
  const bus = new RedisBus(redisUrl);
  await bus.ready();
  return bus;
}
