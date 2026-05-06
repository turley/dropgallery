// Shared CancelledError used by every UI adapter to signal a clean user
// cancellation (exit 0, no work done) — see PRD §5.2.
export class CancelledError extends Error {
  constructor(stage) {
    super(`User cancelled at ${stage}`);
    this.name = 'CancelledError';
    this.stage = stage;
  }
}
