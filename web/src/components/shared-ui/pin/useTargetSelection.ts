import { useLayoutEffect, useRef } from 'react';

export interface TargetSelectionController {
  /** Cancels any in-flight async target metadata request for the previous selection. */
  invalidate: () => void;
  /**
   * Begins an async target selection capture. Returns a predicate that remains
   * `true` only while this capture is still the latest selection in the current
   * workspace mode and revision.
   */
  begin: () => () => boolean;
}

/**
 * Shared target-selection concurrency guard reused across all format adapters
 * so stale async metadata/hash responses can never overwrite a newer selection
 * or confirm a target after revision/mode changes.
 */
export function useTargetSelection(
  beginWorkspaceSelection: () => () => boolean,
  scope: string,
): TargetSelectionController {
  const generation = useRef(0);
  useLayoutEffect(() => () => { generation.current++; }, [scope]);
  return {
    invalidate: () => { generation.current++; },
    begin: () => {
      const validWorkspace = beginWorkspaceSelection();
      const selected = ++generation.current;
      return () => selected === generation.current && validWorkspace();
    },
  };
}
