import type { UpdateEnvelope } from '../../shared/contracts.js';

const MAX_BATCH_BYTES = 64 * 1024;
const MAX_PENDING = 2;
const ACK_TIMEOUT_MS = 5_000;
const MAX_QUEUE = 16;

type PendingBatch = UpdateEnvelope & { sentAt: number };
type QueuedItem = Pick<UpdateEnvelope, 'kind' | 'payload'>;

export class ObservationStream {
  private readonly now: () => number;
  private epoch: number;
  private sequence = 0;
  private pending = new Map<number, PendingBatch>();
  private queue: QueuedItem[] = [];
  private paused = false;
  private gap = 0;

  constructor(epoch: number, now: () => number = () => Date.now()) {
    this.epoch = epoch;
    this.now = now;
  }

  enqueue(kind: QueuedItem['kind'], payload: unknown): void {
    if (this.paused) {
      this.gap += 1;
      return;
    }
    const size = encodedBytes(payload);
    if (size > MAX_BATCH_BYTES) {
      this.gap += 1;
      return;
    }
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      this.gap += 1;
    }
    this.queue.push({ kind, payload });
  }

  flush(): UpdateEnvelope | null {
    if (this.paused || this.pending.size >= MAX_PENDING || !this.queue.length) return null;
    const items: QueuedItem[] = [];
    while (this.queue.length) {
      const next = this.queue[0];
      if (!next) break;
      const candidateItems = [...items, next];
      const candidate: UpdateEnvelope = {
        epoch: this.epoch,
        seq: this.sequence + 1,
        kind: 'diagnostic',
        payload: { items: candidateItems, gap: this.gap },
      };
      if (encodedBytes(candidate) > MAX_BATCH_BYTES) {
        if (items.length) break;
        this.queue.shift();
        this.gap += 1;
        continue;
      }
      this.queue.shift();
      items.push(next);
    }
    if (!items.length) return null;
    const batch: UpdateEnvelope = { epoch: this.epoch, seq: ++this.sequence, kind: 'diagnostic', payload: { items, gap: this.gap } };
    this.gap = 0;
    this.pending.set(batch.seq, { ...batch, sentAt: this.now() });
    return batch;
  }

  confirm(epoch: number, seq: number): boolean {
    if (epoch !== this.epoch || !Number.isInteger(seq) || seq <= 0) return false;
    let acknowledged = false;
    for (const pendingSeq of this.pending.keys()) {
      if (pendingSeq <= seq) {
        this.pending.delete(pendingSeq);
        acknowledged = true;
      }
    }
    if (acknowledged && this.pending.size < MAX_PENDING) this.paused = false;
    return acknowledged;
  }

  tick(): void {
    const oldest = [...this.pending.values()].sort((a, b) => a.sentAt - b.sentAt)[0];
    if (oldest && this.now() - oldest.sentAt > ACK_TIMEOUT_MS) {
      this.paused = true;
      this.gap += this.queue.length;
      this.queue = [];
    }
  }

  resume(epoch: number): boolean {
    if (epoch !== this.epoch) return false;
    this.paused = false;
    return true;
  }

  reset(epoch: number): void {
    this.epoch = epoch;
    this.sequence = 0;
    this.pending.clear();
    this.queue = [];
    this.paused = false;
    this.gap = 0;
  }

  stats(): { epoch: number; pending: number; queued: number; paused: boolean; gap: number } {
    return { epoch: this.epoch, pending: this.pending.size, queued: this.queue.length, paused: this.paused, gap: this.gap };
  }
}

function encodedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
  } catch {
    return MAX_BATCH_BYTES + 1;
  }
}

export const observationStreamLimits = {
  maxBatchBytes: MAX_BATCH_BYTES,
  maxPending: MAX_PENDING,
  ackTimeoutMs: ACK_TIMEOUT_MS,
  maxQueue: MAX_QUEUE,
} as const;
