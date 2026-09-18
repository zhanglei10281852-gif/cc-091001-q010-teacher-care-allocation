// 按键串行化异步临界区：同一资源的占用/释放/递补依次执行，
// 从机制上保证并发请求不会突破资源容量。
export class KeyedMutex {
  constructor() {
    this.tails = new Map();
  }

  async run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
