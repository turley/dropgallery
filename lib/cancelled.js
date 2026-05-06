// Thrown by UI adapters when the user cancels — caller exits 0, no work done.
export class CancelledError extends Error {
  constructor(stage) {
    super(`User cancelled at ${stage}`);
    this.name = 'CancelledError';
    this.stage = stage;
  }
}
