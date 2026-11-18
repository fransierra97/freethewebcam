/**
 * Real-time message delivery per room (one room per creator).
 * Each instance keeps its own connections; events travel over the bus (local or Redis),
 * so it works the same with one or several instances.
 */
import { randomBytes } from 'node:crypto';
import { LocalBus, type Bus, type BusEvent } from './bus.ts';

export interface ChatConn {
  userId: number;
  name: string;
  level: string;
  isOwner: boolean;
  isStaff: boolean;
  lastMessageAt: number;
  lastChatAt?: number;
  lastReactAt?: number;
  isMod?: boolean;
  send(msg: object): void;
  close(): void;
}

export type RoomEvent = Record<string, unknown> & { type: string };

const HISTORY = 50;
const OWNER_GRACE_MS = 30_000;
const PRESENCE_TTL_MS = 60_000;
const HEARTBEAT_MS = 20_000;

interface Presence {
  viewers: number[];
  owners: number;
  at: number;
}

export class Hub {
  readonly instance = randomBytes(6).toString('hex');
  private bus: Bus;
  private rooms = new Map<number, Set<ChatConn>>();
  private history = new Map<number, RoomEvent[]>();
  private ownerTimers = new Map<number, NodeJS.Timeout>();
  /** creatorId → instance → presence (from all instances, including this one). */
  private presence = new Map<number, Map<string, Presence>>();
  private heartbeat: NodeJS.Timeout;
  /** Called when the creator has been offline on every instance for a while. */
  onOwnerGone: (creatorId: number) => void = () => {};

  constructor(bus: Bus = new LocalBus()) {
    this.bus = bus;
    bus.subscribe((e) => this.deliver(e));
    this.heartbeat = setInterval(() => {
      for (const id of this.rooms.keys()) this.announce(id);
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const t of this.ownerTimers.values()) clearTimeout(t);
    void this.bus.close();
  }

  // ---- Local connections ----

  join(creatorId: number, conn: ChatConn): void {
    let set = this.rooms.get(creatorId);
    if (!set) this.rooms.set(creatorId, (set = new Set()));
    set.add(conn);
    if (conn.isOwner) {
      clearTimeout(this.ownerTimers.get(creatorId));
      this.ownerTimers.delete(creatorId);
    }
    for (const msg of this.history.get(creatorId) ?? []) conn.send(msg);
    this.announce(creatorId);
  }

  leave(creatorId: number, conn: ChatConn): void {
    const set = this.rooms.get(creatorId);
    if (!set) return;
    set.delete(conn);
    if (!set.size) this.rooms.delete(creatorId);
    this.announce(creatorId);
    if (conn.isOwner && !this.ownerOnline(creatorId)) {
      clearTimeout(this.ownerTimers.get(creatorId));
      const timer = setTimeout(() => {
        this.ownerTimers.delete(creatorId);
        if (!this.ownerOnline(creatorId)) this.onOwnerGone(creatorId);
      }, OWNER_GRACE_MS);
      timer.unref();
      this.ownerTimers.set(creatorId, timer);
    }
  }

  // ---- Sending (goes through the bus) ----

  broadcast(creatorId: number, msg: RoomEvent, opts: { remember?: boolean } = {}): void {
    this.bus.publish({ t: 'room', creatorId, msg, remember: opts.remember });
  }

  toUser(userId: number, msg: RoomEvent): void {
    this.bus.publish({ t: 'user', userId, msg });
  }

  kick(creatorId: number, userId: number): void {
    this.bus.publish({ t: 'kick', creatorId, userId });
  }

  clearHistory(creatorId: number): void {
    this.bus.publish({ t: 'clear', creatorId });
  }

  /** Deletes a chat message (and its history entry) on all instances. */
  deleteMessage(creatorId: number, messageId: string): void {
    this.bus.publish({ t: 'delete', creatorId, messageId });
  }

  /** People currently connected to the room (for giveaways), excluding the creator. */
  presentUserIds(creatorId: number): number[] {
    const ids = new Set<number>();
    for (const p of this.fresh(creatorId)) p.viewers.forEach((v) => ids.add(v));
    return [...ids];
  }

  // ---- Global presence ----

  private fresh(creatorId: number): Presence[] {
    const now = Date.now();
    return [...(this.presence.get(creatorId)?.values() ?? [])].filter((p) => now - p.at < PRESENCE_TTL_MS);
  }

  viewerCount(creatorId: number): number {
    const ids = new Set<number>();
    for (const p of this.fresh(creatorId)) p.viewers.forEach((v) => ids.add(v));
    return ids.size;
  }

  ownerOnline(creatorId: number): boolean {
    return this.fresh(creatorId).some((p) => p.owners > 0);
  }

  private announce(creatorId: number): void {
    const conns = [...(this.rooms.get(creatorId) ?? [])];
    this.bus.publish({
      t: 'presence',
      instance: this.instance,
      creatorId,
      viewers: [...new Set(conns.filter((c) => !c.isOwner).map((c) => c.userId))],
      owners: conns.filter((c) => c.isOwner).length,
      at: Date.now(),
    });
  }

  // ---- Delivery on this instance ----

  private deliver(e: BusEvent): void {
    switch (e.t) {
      case 'room': {
        if (e.remember) {
          const list = this.history.get(e.creatorId) ?? [];
          list.push(e.msg as RoomEvent);
          if (list.length > HISTORY) list.shift();
          this.history.set(e.creatorId, list);
        }
        for (const conn of this.rooms.get(e.creatorId) ?? []) conn.send(e.msg);
        break;
      }
      case 'user':
        for (const set of this.rooms.values()) for (const conn of set) if (conn.userId === e.userId) conn.send(e.msg);
        break;
      case 'kick':
        for (const conn of this.rooms.get(e.creatorId) ?? []) {
          if (conn.userId === e.userId) {
            conn.send({ type: 'system', text: 'You have been banned from this room.' });
            conn.close();
          }
        }
        break;
      case 'clear':
        this.history.delete(e.creatorId);
        break;
      case 'delete': {
        const list = this.history.get(e.creatorId);
        if (list) this.history.set(e.creatorId, list.filter((m) => m.id !== e.messageId));
        for (const conn of this.rooms.get(e.creatorId) ?? []) conn.send({ type: 'chat_delete', id: e.messageId });
        break;
      }
      case 'presence': {
        let map = this.presence.get(e.creatorId);
        if (!map) this.presence.set(e.creatorId, (map = new Map()));
        const before = this.viewerCount(e.creatorId);
        if (!e.viewers.length && !e.owners) map.delete(e.instance);
        else map.set(e.instance, { viewers: e.viewers, owners: e.owners, at: e.at });
        const after = this.viewerCount(e.creatorId);
        if (after !== before) for (const conn of this.rooms.get(e.creatorId) ?? []) conn.send({ type: 'viewers', count: after });
        break;
      }
    }
  }
}
