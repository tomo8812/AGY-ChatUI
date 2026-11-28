import './pin.css';

export {
  useRegisteredPinModes,
  useTargetSelection,
  type CapabilitiesLike,
  type RegisteredPinState,
  type TargetSelectionController,
} from './useTargetSelection';
export {
  SpatialPinOverlay,
  type NormalizedArea,
  type NormalizedPoint,
  type SpatialPinOverlayProps,
} from './SpatialPinOverlay';
export { PinModeToolbar, type PinModeOption, type PinModeToolbarProps } from './PinModeToolbar';
export { WholeTargetControl, type WholeTargetControlProps } from './WholeTargetControl';
export {
  ElementTargetControl,
  type ElementTargetControlProps,
  type SelectableElementOption,
} from './ElementTargetControl';
export { TextRangeTargetControl, type TextRangeTargetControlProps } from './TextRangeTargetControl';
export { GridTargetControl, type GridTargetControlProps } from './GridTargetControl';
export { TimeRangeTargetControl, type TimeRangeTargetControlProps } from './TimeRangeTargetControl';
export {
  PreviewUnavailableFallback,
  TargetInspectionErrorBanner,
  formatConciseErrorReason,
  type PreviewUnavailableFallbackProps,
  type TargetInspectionErrorBannerProps,
} from './TargetErrorFallback';

export {
  DEPRECATED_SELECTOR_KINDS,
  TARGET_SELECTOR_REGISTRY,
  buildTargetInspectionRequestParams,
  extractSupportedSelectorKinds,
  getRegisteredSelectorsForFormat,
  getRegisteredUiModesForFormat,
  getSelectorRegistration,
  getTargetInspectionChannelForRequest,
  isDeprecatedSelectorKind,
  isRegisteredSelectorKind,
  selectorHasRegisteredUi,
  selectorMatchesRegisteredFormat,
  type PinSelectionPrimitive,
  type RegisteredUiMode,
  type RegisteredUiModeSpec,
  type TargetInspectionChannel,
  type TargetInspectionContract,
  type TargetSelectionFormat,
  type TargetSelectorKind,
  type TargetSelectorRegistration,
  type TargetSelectorView,
} from '../../../../../shared/target-selection-registry';
