import './pin.css';

export { useTargetSelection, type TargetSelectionController } from './useTargetSelection';
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
export { GridTargetControl, type GridPinMode, type GridTargetControlProps } from './GridTargetControl';
export { TimeRangeTargetControl, type TimeRangeTargetControlProps } from './TimeRangeTargetControl';
export {
  PreviewUnavailableFallback,
  TargetInspectionErrorBanner,
  type PreviewUnavailableFallbackProps,
  type TargetInspectionErrorBannerProps,
} from './TargetErrorFallback';

export {
  DEPRECATED_SELECTOR_KINDS,
  TARGET_SELECTOR_REGISTRY,
  getRegisteredSelectorsForFormat,
  getSelectorRegistration,
  isDeprecatedSelectorKind,
  isRegisteredSelectorKind,
  selectorHasRegisteredUi,
  selectorMatchesRegisteredFormat,
  type PinSelectionPrimitive,
  type TargetSelectionFormat,
  type TargetSelectorKind,
  type TargetSelectorRegistration,
  type TargetSelectorView,
} from '../../../../../shared/target-selection-registry';
