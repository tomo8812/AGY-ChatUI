import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { workspaceApi } from '../../../api/workspace';
import {
  buildTargetInspectionRequestParams,
  extractSupportedSelectorKinds,
  getRegisteredUiModesForFormat,
  type RegisteredUiMode,
  type TargetSelectionFormat,
  type TargetSelectorView,
} from '../../../../../shared/target-selection-registry';

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

export interface CapabilitiesLike {
  readonly operations?: ReadonlyArray<{
    readonly operation: string;
    readonly availability: string;
    readonly scope?: string;
  }>;
}

export interface InspectableArtifactRef {
  readonly id: string;
  readonly revision?: number;
  readonly sha256?: string;
}

export interface RegisteredPinState {
  /** Canonical UI selection modes derived solely from `TARGET_SELECTOR_REGISTRY` + live capabilities. */
  readonly modes: readonly RegisteredUiMode[];
  /** Currently active registered mode (undefined when the format has no UI-enabled selectors). */
  readonly activeMode: RegisteredUiMode | undefined;
  /** Stable identifier of the active mode ('' if none). */
  readonly activeModeId: string;
  /** Switch active mode (automatically invalidates in-flight captures and clears pin errors). */
  readonly setModeId: (nextId: string) => void;
  /** Target-inspection-only error message (keeps the viewer preview intact). */
  readonly pinError: string;
  readonly setPinError: (message: string) => void;
  readonly clearPinError: () => void;
  /** Concurrency guard for async target capture. */
  readonly selection: TargetSelectionController;
  /**
   * Fetches target identity metadata via the registered `inspection` contract
   * (`buildTargetInspectionRequestParams`) and verifies revision/sha256 consistency.
   */
  readonly inspectTarget: <T extends { revision?: number; sha256?: string }>(
    artifact: InspectableArtifactRef,
    rangeParams: Record<string, string | number | boolean>,
    modeOverride?: RegisteredUiMode,
  ) => Promise<T>;
}

/**
 * Shared hook connecting any format module to the canonical Target Selection
 * Registry (`shared/target-selection-registry.ts`). Eliminates format-local
 * mode lists, allowlists, transport flags, and duplicate error/invalidation plumbing.
 */
export function useRegisteredPinModes(params: {
  format: TargetSelectionFormat;
  filename?: string;
  previewKind?: string;
  view?: TargetSelectorView;
  capabilities?: CapabilitiesLike | null;
  beginWorkspaceSelection: () => () => boolean;
  /** Additional scope key (e.g. active slide/sheet/selection) that invalidates pending captures. */
  scope?: string;
}): RegisteredPinState {
  const allowedSelectorKinds = useMemo(
    () => extractSupportedSelectorKinds(params.capabilities?.operations),
    [params.capabilities?.operations],
  );
  const modes = useMemo(
    () =>
      getRegisteredUiModesForFormat(params.format, {
        filename: params.filename,
        previewKind: params.previewKind,
        view: params.view,
        allowedSelectorKinds,
      }),
    [params.format, params.filename, params.previewKind, params.view, allowedSelectorKinds],
  );

  const [selectedId, setSelectedId] = useState<string>(() => modes[0]?.id ?? '');
  const [pinError, setPinError] = useState('');

  const activeMode = useMemo(
    () => modes.find((m) => m.id === selectedId) ?? modes[0],
    [modes, selectedId],
  );
  const activeModeId = activeMode?.id ?? '';

  useEffect(() => {
    if (activeModeId && activeModeId !== selectedId) {
      setSelectedId(activeModeId);
    }
  }, [activeModeId, selectedId]);

  const selection = useTargetSelection(
    params.beginWorkspaceSelection,
    `${params.format}:${activeModeId}:${params.scope ?? ''}`,
  );

  const setModeId = (nextId: string) => {
    if (!modes.some((m) => m.id === nextId)) return;
    selection.invalidate();
    setPinError('');
    setSelectedId(nextId);
  };

  const inspectTarget = async <T extends { revision?: number; sha256?: string }>(
    artifact: InspectableArtifactRef,
    rangeParams: Record<string, string | number | boolean>,
    modeOverride?: RegisteredUiMode,
  ): Promise<T> => {
    const targetMode = modeOverride ?? activeMode;
    if (!targetMode) {
      throw new Error('この形式では対象指定を利用できません。');
    }
    const query = buildTargetInspectionRequestParams(targetMode, rangeParams);
    const result = await workspaceApi.range<T>(artifact.id, query);
    if (
      (artifact.revision !== undefined && result.revision !== undefined && result.revision !== artifact.revision) ||
      (artifact.sha256 && result.sha256 && result.sha256 !== artifact.sha256)
    ) {
      throw new Error('ファイルが更新されました。最新の状態で再度指定してください。');
    }
    return result;
  };

  return {
    modes,
    activeMode,
    activeModeId,
    setModeId,
    pinError,
    setPinError,
    clearPinError: () => setPinError(''),
    selection,
    inspectTarget,
  };
}
