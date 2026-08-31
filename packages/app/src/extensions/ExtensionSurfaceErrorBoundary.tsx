import { Component, type ErrorInfo, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";

type ExtensionSurfaceErrorBoundaryProps = {
  extensionId: string;
  contributionId: string;
  surface: string;
  resetKey?: string;
  children: ReactNode;
};

type ExtensionSurfaceErrorBoundaryState = {
  message: string;
};

export class ExtensionSurfaceErrorBoundary extends Component<
  ExtensionSurfaceErrorBoundaryProps,
  ExtensionSurfaceErrorBoundaryState
> {
  state: ExtensionSurfaceErrorBoundaryState = { message: "" };

  static getDerivedStateFromError(error: unknown): ExtensionSurfaceErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.warn(
      `Extension contribution crashed: ${this.props.extensionId}:${this.props.contributionId}`,
      error,
      info.componentStack,
    );
  }

  componentDidUpdate(previous: ExtensionSurfaceErrorBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.message) {
      this.setState({ message: "" });
    }
  }

  render(): ReactNode {
    if (!this.state.message) return this.props.children;
    return (
      <div className="border-danger/30 bg-danger/5 text-danger flex min-h-10 items-start gap-2 rounded-md border p-2 text-[12px]">
        <ShieldAlert size={14} className="mt-0.5 shrink-0" />
        <span>
          Extension {this.props.contributionId} failed on {this.props.surface}: {this.state.message}
        </span>
      </div>
    );
  }
}
