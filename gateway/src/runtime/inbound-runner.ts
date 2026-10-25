import type { InboundWeChatMessage } from "../types.js";
import { FileInboundInbox } from "./inbox.js";

const MAX_ACTIVE_CHATS = 8;

interface InboundRunnerOptions {
  inbox: FileInboundInbox;
  process(message: InboundWeChatMessage): Promise<void>;
  steer(message: InboundWeChatMessage): Promise<boolean>;
  covered(message: InboundWeChatMessage): void;
  onError(error: unknown): void;
}

/** Admission is serialized per chat; a running query never blocks receiving its next input. */
export class InboundRunner {
  private readonly admissions = new Map<string, Promise<void>>();
  private readonly roots = new Map<string, Promise<void>>();
  private readonly handling = new Set<string>();
  private readonly blockedChats = new Set<string>();
  private stopped = false;

  constructor(private readonly options: InboundRunnerOptions) {}

  hasPending(chatId: string): boolean {
    return this.roots.has(chatId) || this.options.inbox.list().some(message => message.chatId === chatId);
  }

  schedule(): void {
    if (this.stopped) return;
    const messages = this.options.inbox.list();
    const firstByChat = new Map<string, string>();
    for (const message of messages) if (!firstByChat.has(message.chatId)) firstByChat.set(message.chatId, message.deliveryKey);
    for (const message of messages) {
      if (this.handling.has(message.deliveryKey)) continue;
      if (this.blockedChats.has(message.chatId) && firstByChat.get(message.chatId) !== message.deliveryKey) continue;
      const chats = new Set([...this.admissions.keys(), ...this.roots.keys()]);
      if (!chats.has(message.chatId) && chats.size >= MAX_ACTIVE_CHATS) continue;
      this.handling.add(message.deliveryKey);
      const prior = this.admissions.get(message.chatId) ?? Promise.resolve();
      let started = false;
      const admission = prior.then(async () => {
        if (this.stopped) return;
        const root = this.roots.get(message.chatId);
        if (root) {
          if (await this.options.steer(message)) {
            this.options.covered(message);
            this.options.inbox.remove(message.deliveryKey);
            return;
          }
          await root;
          if (this.blockedChats.has(message.chatId)) return;
        }
        if (this.stopped) return;
        if (this.blockedChats.has(message.chatId) && firstByChat.get(message.chatId) !== message.deliveryKey) return;
        started = true;
        const work = this.options.process(message)
          .then(() => {
            this.options.inbox.remove(message.deliveryKey);
            this.blockedChats.delete(message.chatId);
          })
          .catch(error => {
            this.blockedChats.add(message.chatId);
            this.options.onError(error);
          })
          .finally(() => {
            this.handling.delete(message.deliveryKey);
            if (this.roots.get(message.chatId) === work) this.roots.delete(message.chatId);
          });
        this.roots.set(message.chatId, work);
      }).catch(error => this.options.onError(error)).finally(() => {
        if (!started) this.handling.delete(message.deliveryKey);
        if (this.admissions.get(message.chatId) === admission) this.admissions.delete(message.chatId);
      });
      this.admissions.set(message.chatId, admission);
    }
  }

  halt(): void { this.stopped = true; }

  async stop(): Promise<void> {
    this.halt();
    await Promise.all(this.admissions.values());
    await Promise.all(this.roots.values());
  }
}
