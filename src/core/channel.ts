/**
 * Bridges callback-style producers (browser events, page callbacks) to `for await`.
 * The producer calls push()/close()/fail(); the consumer iterates.
 */
export class Channel<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | null = null;
  private finished = false;
  private error: unknown = null;

  push(item: T): void {
    if (this.finished) return;
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.finished = true;
    this.wake();
  }

  fail(err: unknown): void {
    if (this.finished) return;
    this.error = err ?? new Error('failed');
    this.finished = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length) { yield this.items.shift()!; continue; }
      if (this.finished) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => { this.waiter = resolve; });
    }
  }
}
