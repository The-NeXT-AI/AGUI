/**
 * "Thinking" text with a highlight sweeping across it — the AGUI loading
 * indicator (background-clip:text shimmer). Shown while the agent has not yet
 * produced its first token.
 */
export function ThinkingShimmer({ label = "Thinking" }: { label?: string }) {
  return (
    <span className="thinking-shimmer" role="status" aria-label={`${label}...`}>
      <span className="thinking-shimmer-label" data-text={label} aria-hidden="true">
        {label}
      </span>
      <span className="thinking-shimmer-dots" aria-hidden="true">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </span>
  );
}
