import { agentControlSchema, type AgentControl } from "./types.js";

type WaitingConsumer = {
  resolve(result: IteratorResult<AgentControl>): void;
};

export class AgentControlQueue implements AsyncIterable<AgentControl> {
  private readonly queued: AgentControl[] = [];
  private readonly waiting: WaitingConsumer[] = [];
  private closed = false;
  private iteratorCreated = false;

  public push(control: AgentControl): boolean {
    if (this.closed) return false;
    const parsed = agentControlSchema.parse(control);
    const consumer = this.waiting.shift();
    if (consumer === undefined) this.queued.push(parsed);
    else consumer.resolve({ done: false, value: parsed });
    return true;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const consumer of this.waiting.splice(0))
      consumer.resolve({ done: true, value: undefined });
  }

  public [Symbol.asyncIterator](): AsyncIterator<AgentControl> {
    if (this.iteratorCreated) throw new Error("AgentControlQueue supports one consumer");
    this.iteratorCreated = true;
    return {
      next: () => this.next(),
      return: () => {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  private next(): Promise<IteratorResult<AgentControl>> {
    const control = this.queued.shift();
    if (control !== undefined) return Promise.resolve({ done: false, value: control });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiting.push({ resolve }));
  }
}
