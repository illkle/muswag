export class SerialQueue {
  private tail = Promise.resolve();

  /** Runs operations one at a time in submission order. */
  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
