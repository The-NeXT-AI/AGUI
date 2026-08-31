/**
 * Disposable pattern, mirroring the VSCode extension host contract.
 * Every registration returns a Disposable so extensions can tear down cleanly.
 */
export interface Disposable {
  dispose(): void;
}

export function disposable(dispose: () => void): Disposable {
  return { dispose };
}

/** Compose many disposables into one. */
export class CompositeDisposable implements Disposable {
  private readonly children: Disposable[] = [];
  private disposed = false;

  add(d: Disposable): this {
    if (this.disposed) {
      d.dispose();
    } else {
      this.children.push(d);
    }
    return this;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = this.children.length - 1; i >= 0; i--) {
      this.children[i]?.dispose();
    }
    this.children.length = 0;
  }
}
