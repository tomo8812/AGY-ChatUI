export type RichPrimitive = string | number | boolean | null;
export type RichStateValue =
  | RichPrimitive
  | RichPrimitive[]
  | Record<string, RichPrimitive>
  | Record<string, RichPrimitive>[];

/** Static literal or permitted AST expression ($state / $computed / $item / $index / $theme) */
export type RichValue<T> = T | { expr: string };
export type RichTone = 'default' | 'muted' | 'info' | 'success' | 'warning' | 'danger';
export type RichColorToken =
  | 'primary'
  | 'secondary'
  | 'accent'
  | 'muted'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'series1'
  | 'series2'
  | 'series3'
  | 'series4'
  | 'series5'
  | 'series6';

export interface RichDocumentV1 {
  schemaVersion: 1;
  title?: RichValue<string>;
  sources?: RichSourceEntry[];
  state?: Record<string, RichStateValue>;
  computed?: Record<string, string>;
  referencedArtifactIds?: string[];
  root: RichNode;
}

export interface RichSourceEntry {
  id: string;
  name: string;
  url?: string;
  fetchedAt?: string;
  asOf?: string;
  timezone?: string;
  unit?: string;
  currency?: string;
  period?: string;
  valueStatus?: 'preliminary' | 'final' | 'delayed' | 'unavailable';
  delayNotice?: string;
}

export interface RichLayoutProps {
  span?: number | { pc?: number; mobile?: number };
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  gap?: 'none' | 'xs' | 'sm' | 'md' | 'lg';
  padding?: 'none' | 'xs' | 'sm' | 'md' | 'lg';
  minWidthPx?: number;
  maxWidthPx?: number;
  grow?: number;
  shrink?: number;
  wrap?: boolean;
  hideOn?: 'pc' | 'mobile';
}

export interface RichRepeatSpec {
  itemsExpr: string;
  as: string;
  keyField?: string;
}

export interface RichNodeBase {
  id: string;
  visibleWhen?: string;
  repeat?: RichRepeatSpec;
  layout?: RichLayoutProps;
  ariaLabel?: RichValue<string>;
}

// 1. Layout components
export type RichLayoutNode =
  | (RichNodeBase & {
      type: 'stack';
      direction: 'row' | 'col' | { pc: 'row' | 'col'; mobile: 'row' | 'col' };
      children: RichNode[];
    })
  | (RichNodeBase & {
      type: 'grid';
      columns: number | { pc: number; mobile: number } | 'auto-fit';
      minColWidthPx?: number;
      children: RichNode[];
    })
  | (RichNodeBase & {
      type: 'columns';
      ratios?: number[];
      keepRowOnMobile?: boolean;
      children: RichNode[];
    })
  | (RichNodeBase & {
      type: 'container';
      variant?: 'default' | 'subtle' | 'outline' | 'accent';
      children: RichNode[];
    })
  | (RichNodeBase & {
      type: 'card';
      title?: RichValue<string>;
      subtitle?: RichValue<string>;
      variant?: 'default' | 'subtle' | 'outline' | 'accent';
      headerAction?: RichNode;
      footer?: RichNode;
      children: RichNode[];
    })
  | (RichNodeBase & {
      type: 'divider';
      orientation?: 'horizontal' | 'vertical';
      label?: RichValue<string>;
    })
  | (RichNodeBase & {
      type: 'spacer';
      size: 'xs' | 'sm' | 'md' | 'lg';
    })
  | (RichNodeBase & {
      type: 'scroll_area';
      axis: 'x' | 'y' | 'both';
      maxHeightPx?: number;
      children: RichNode[];
    })
  | (RichNodeBase & {
      type: 'carousel';
      itemMinWidthPx?: number;
      showIndicators?: boolean;
      children: RichNode[];
    })
  | (RichNodeBase & {
      type: 'responsive_box';
      pc?: Partial<RichLayoutProps>;
      mobile?: Partial<RichLayoutProps>;
      children: RichNode[];
    });

// 2. Display components
export type RichCellObject = {
  value: RichPrimitive;
  missingReason?: string;
  sourceId?: string;
  asOf?: string;
  fetchedAt?: string;
  tone?: RichTone;
};

export type RichDisplayNode =
  | (RichNodeBase & {
      type: 'text' | 'caption' | 'note' | 'quote' | 'emphasis';
      content: RichValue<string>;
      tone?: RichTone;
      align?: 'left' | 'center' | 'right';
      mono?: boolean;
    })
  | (RichNodeBase & {
      type: 'heading';
      level: 1 | 2 | 3 | 4;
      content: RichValue<string>;
      tone?: RichTone;
    })
  | (RichNodeBase & {
      type: 'markdown';
      content: RichValue<string>;
    })
  | (RichNodeBase & {
      type: 'icon';
      name: string;
      size?: 'sm' | 'md' | 'lg';
      tone?: RichTone;
      decorative?: boolean;
    })
  | (RichNodeBase & {
      type: 'badge' | 'status';
      label: RichValue<string>;
      tone?: RichTone;
      dot?: boolean;
    })
  | (RichNodeBase & {
      type: 'stat' | 'kpi_card';
      label: RichValue<string>;
      value: RichValue<string | number | null>;
      unit?: RichValue<string>;
      delta?: RichValue<string | number | null>;
      deltaTone?: RichValue<'neutral' | 'positive' | 'negative'>;
      missingLabel?: string;
      missingReason?: RichValue<string>;
      sourceId?: string;
      asOf?: RichValue<string>;
      fetchedAt?: RichValue<string>;
      children?: RichNode[];
    })
  | (RichNodeBase & {
      type: 'progress';
      value: RichValue<number>;
      max?: RichValue<number>;
      label?: RichValue<string>;
      showPercent?: boolean;
      tone?: RichTone;
    })
  | (RichNodeBase & {
      type: 'list' | 'checklist' | 'steps' | 'timeline';
      items?: RichValue<
        Array<{
          id?: string;
          title: string;
          description?: string;
          meta?: string;
          status?: 'pending' | 'active' | 'done' | 'error' | 'missing';
          checked?: boolean;
          sourceId?: string;
          asOf?: string;
        }>
      >;
      bindKey?: string;
      children?: RichNode[];
    })
  | (RichNodeBase & {
      type: 'data_table';
      columns: Array<{
        key: string;
        label: string;
        align?: 'left' | 'center' | 'right';
        format?: 'text' | 'number' | 'currency' | 'percent' | 'date' | 'badge';
        unit?: string;
        sortable?: boolean;
        missingLabel?: string;
      }>;
      rows: RichValue<Array<Record<string, RichPrimitive | RichCellObject>>>;
      sortable?: boolean;
      searchable?: boolean;
      pageSize?: number;
      selectedRowBind?: string;
      onRowSelect?: RichStateAction[];
    })
  | (RichNodeBase & {
      type: 'source_attribution';
      sourceIds?: string[];
      compact?: boolean;
    });

// 3. Diagram & SVG components
export type RichSvgDef =
  | {
      kind: 'linearGradient';
      id: string;
      x1?: string;
      y1?: string;
      x2?: string;
      y2?: string;
      stops: Array<{ offset: string; color: RichValue<string>; opacity?: RichValue<number> }>;
    }
  | {
      kind: 'radialGradient';
      id: string;
      cx?: string;
      cy?: string;
      r?: string;
      stops: Array<{ offset: string; color: RichValue<string>; opacity?: RichValue<number> }>;
    }
  | {
      kind: 'marker';
      id: string;
      viewBox: string;
      refX: number;
      refY: number;
      markerWidth: number;
      markerHeight: number;
      orient?: 'auto' | 'auto-start-reverse' | number;
      pathD: string;
      fill?: RichValue<string>;
    }
  | {
      kind: 'clipPath';
      id: string;
      shape: 'rect' | 'circle' | 'polygon';
      attrs: Record<string, RichValue<string | number>>;
    };

export interface RichSvgElement {
  tag: 'g' | 'rect' | 'circle' | 'ellipse' | 'line' | 'polyline' | 'polygon' | 'path' | 'text' | 'tspan';
  id?: string;
  visibleWhen?: string;
  repeat?: RichRepeatSpec;
  attrs?: {
    x?: RichValue<number | string>;
    y?: RichValue<number | string>;
    width?: RichValue<number | string>;
    height?: RichValue<number | string>;
    rx?: RichValue<number>;
    ry?: RichValue<number>;
    cx?: RichValue<number>;
    cy?: RichValue<number>;
    r?: RichValue<number>;
    x1?: RichValue<number>;
    y1?: RichValue<number>;
    x2?: RichValue<number>;
    y2?: RichValue<number>;
    points?: RichValue<string>;
    d?: RichValue<string>;
    transform?: RichValue<string>;
    fill?: RichValue<string>;
    stroke?: RichValue<string>;
    strokeWidth?: RichValue<number>;
    strokeDasharray?: RichValue<string>;
    strokeLinecap?: 'butt' | 'round' | 'square';
    strokeLinejoin?: 'miter' | 'round' | 'bevel';
    opacity?: RichValue<number>;
    fillOpacity?: RichValue<number>;
    strokeOpacity?: RichValue<number>;
    fontSize?: RichValue<number>;
    fontWeight?: RichValue<string | number>;
    textAnchor?: 'start' | 'middle' | 'end';
    dominantBaseline?: 'auto' | 'middle' | 'central' | 'hanging';
    markerStart?: string;
    markerEnd?: string;
    clipPath?: string;
  };
  textContent?: RichValue<string>;
  tooltip?: RichValue<string>;
  onClick?: RichStateAction[];
  children?: RichSvgElement[];
}

export type RichDiagramNode =
  | (RichNodeBase & {
      type: 'mermaid';
      code: RichValue<string>;
      zoomable?: boolean;
    })
  | (RichNodeBase & {
      type: 'svg_scene';
      viewBox: string;
      aspectRatio?: string;
      title?: RichValue<string>;
      interactiveRole?: 'diagram' | 'wireframe' | 'interactive';
      zoomable?: boolean;
      defs?: RichSvgDef[];
      elements: RichSvgElement[];
    })
  | (RichNodeBase & {
      type: 'node_edge_diagram';
      diagramLayout: 'dag_tb' | 'dag_lr' | 'radial' | 'manual';
      nodes: RichValue<
        Array<{
          id: string;
          label: string;
          sublabel?: string;
          group?: string;
          tone?: RichTone;
          x?: number;
          y?: number;
        }>
      >;
      edges: RichValue<
        Array<{
          id?: string;
          from: string;
          to: string;
          label?: string;
          style?: 'solid' | 'dashed';
          directed?: boolean;
        }>
      >;
      selectedNodeBind?: string;
      onNodeSelect?: RichStateAction[];
      zoomable?: boolean;
    });

// 4. Chart components
export interface RichChartDatum {
  x?: string | number;
  y: number | null;
  label?: string;
  missingReason?: string;
  sourceId?: string;
  asOf?: string;
}

export interface RichChartSeries {
  key: string;
  label: RichValue<string>;
  type?: 'line' | 'bar' | 'area' | 'scatter';
  yAxisId?: 'left' | 'right';
  colorToken?: RichColorToken;
  unit?: string;
  sourceId?: string;
  asOf?: RichValue<string>;
  data: RichValue<Array<number | null | RichChartDatum>>;
}

export type RichChartNode = RichNodeBase & {
  type: 'chart';
  chartType:
    | 'line'
    | 'bar'
    | 'hbar'
    | 'pie'
    | 'donut'
    | 'scatter'
    | 'area'
    | 'stacked_bar'
    | 'stacked_area'
    | 'combo';
  title?: RichValue<string>;
  heightPx?: number;
  legend?: 'top' | 'bottom' | 'none';
  connectNulls?: boolean;
  xAxis?: { label?: string; type?: 'category' | 'number' | 'time'; unit?: string; format?: string };
  yAxis?: { label?: string; min?: RichValue<number>; max?: RichValue<number>; unit?: string; format?: string };
  yAxisRight?: { label?: string; min?: RichValue<number>; max?: RichValue<number>; unit?: string; format?: string };
  categories?: RichValue<Array<string | number>>;
  series: RichChartSeries[];
  referenceLines?: Array<{
    axis: 'x' | 'y';
    value: RichValue<number | string>;
    label?: RichValue<string>;
    tone?: RichTone;
  }>;
  selectedPointBind?: string;
  onPointSelect?: RichStateAction[];
};

// 5. Control components
export type RichControlNode =
  | (RichNodeBase & {
      type: 'button';
      label: RichValue<string>;
      variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
      icon?: string;
      disabledWhen?: string;
      onClick: [RichAction, ...RichAction[]];
    })
  | (RichNodeBase & {
      type: 'clickable' | 'selectable_card';
      selectedWhen?: string;
      onClick: [RichStateAction, ...RichStateAction[]];
      children: RichNode[];
    })
  | (RichNodeBase & {
      type: 'text_input' | 'textarea';
      bind: string;
      label?: RichValue<string>;
      placeholder?: string;
      maxLength?: number;
      onChange?: RichStateAction[];
    })
  | (RichNodeBase & {
      type: 'number_input' | 'slider';
      bind: string;
      label?: RichValue<string>;
      min: RichValue<number>;
      max: RichValue<number>;
      step?: RichValue<number>;
      unit?: string;
      onChange?: RichStateAction[];
    })
  | (RichNodeBase & {
      type: 'checkbox' | 'toggle';
      bind: string;
      label: RichValue<string>;
      onChange?: RichStateAction[];
    })
  | (RichNodeBase & {
      type: 'radio_group' | 'select' | 'segmented';
      bind: string;
      label?: RichValue<string>;
      options: RichValue<Array<{ value: string | number; label: string; disabled?: boolean }>>;
      onChange?: RichStateAction[];
    })
  | (RichNodeBase & {
      type: 'date_input';
      bind: string;
      label?: RichValue<string>;
      min?: string;
      max?: string;
      onChange?: RichStateAction[];
    })
  | (RichNodeBase & {
      type: 'tabs';
      bind?: string;
      items: Array<{ id: string; label: RichValue<string>; badge?: RichValue<string>; content: RichNode[] }>;
    })
  | (RichNodeBase & {
      type: 'collapsible';
      title: RichValue<string>;
      bind?: string;
      defaultOpen?: boolean;
      children: RichNode[];
    })
  | (RichNodeBase & {
      type: 'popover' | 'tooltip';
      trigger: RichNode;
      content: RichValue<string> | RichNode[];
    })
  | (RichNodeBase & {
      type: 'form';
      onSubmit: [RichAction, ...RichAction[]];
      children: RichNode[];
    });

// 6. Media & document components
export type RichMediaDocNode =
  | (RichNodeBase & {
      type: 'editable_draft';
      bind: string;
      label?: RichValue<string>;
      format?: 'text' | 'markdown' | 'code';
      language?: string;
      saveAction?: Extract<RichSideEffectAction, { type: 'save_to_artifact' }>;
    })
  | (RichNodeBase & {
      type: 'code_block';
      code: RichValue<string>;
      language?: string;
      copyable?: boolean;
    })
  | (RichNodeBase & {
      type: 'diff_block';
      oldText: RichValue<string>;
      newText: RichValue<string>;
      language?: string;
    })
  | (RichNodeBase & {
      type: 'math_block';
      tex: RichValue<string>;
      displayMode?: boolean;
    })
  | (RichNodeBase & {
      type: 'media_asset';
      sourceKind: 'artifact' | 'inline_svg';
      artifactId?: RichValue<string>;
      svgScene?: Extract<RichDiagramNode, { type: 'svg_scene' }>;
      alt: RichValue<string>;
      caption?: RichValue<string>;
    });

export type RichNode =
  | RichLayoutNode
  | RichDisplayNode
  | RichDiagramNode
  | RichChartNode
  | RichControlNode
  | RichMediaDocNode;

/** Side-effect-free state update actions (permitted on onChange / selection / reactive events) */
export type RichStateAction =
  | { type: 'set_state'; key: string; valueExpr: string }
  | { type: 'toggle_state'; key: string }
  | { type: 'increment_state'; key: string; deltaExpr?: string; min?: number; max?: number }
  | { type: 'reset_state'; keys?: string[] };

/** Side-effect actions (permitted ONLY on explicit user triggers: button.onClick / form.onSubmit / editable_draft.saveAction) */
export type RichSideEffectAction =
  | { type: 'copy_text'; textExpr: string }
  | { type: 'open_external_url'; urlExpr: string }
  | { type: 'open_artifact'; artifactIdExpr: string }
  | {
      type: 'save_to_artifact';
      filenameExpr: string;
      format: 'svg' | 'md' | 'txt' | 'csv' | 'json' | 'code';
      contentExpr: string;
    }
  | { type: 'submit_to_chat'; textExpr: string; requireConfirm?: boolean }
  | { type: 'start_pin_edit'; targetNodeId?: string };

export type RichAction = RichStateAction | RichSideEffectAction;

export type RichBindingState = 'unattached' | 'tentative_sole_turn' | 'confirmed_by_tool_call';

export interface RichBlockRecord {
  id: string;
  userId: string;
  chatId: string;
  confirmedMessageId: string | null;
  tentativeMessageId: string | null;
  runId: string | null;
  toolCallId: string | null;
  bindingState: RichBindingState;
  createdSeq: number;
  schemaVersion: number;
  revision: number;
  title: string;
  document: RichDocumentV1;
  uiStateSnapshot: Record<string, RichStateValue> | null;
  referencedArtifactIds: string[];
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
}
