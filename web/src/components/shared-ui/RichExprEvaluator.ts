// Both server validation and browser evaluation use the same pure TypeScript runtime.
// These two modules have no server, filesystem or network dependencies.
export {
  createRichEvalBudget, evaluateRichAst, evaluateRichExpr, extractExprReferences,
  parseRichExpr, RichExprError, RICH_MAX_AST_STEPS,
} from '../../../../server/src/rich/rich-expr-evaluator';
export type { ExprAst, RichEvalContext, RichEvalBudget } from '../../../../server/src/rich/rich-expr-evaluator';
export {
  RICH_LIMITS, topologicalSortComputed, validateRichDocument,
  compileRichDynamicPlan, evaluateRichDynamicState,
  validateSvgAttrValue, validateRichMarkdownContent, validateRichMermaidCode,
  isValidHttpUrl, validateSafeFilename,
} from '../../../../server/src/rich/rich-validator';
export type {
  RichDynamicPlan, RichDynamicStats, RichSubtreeCache,
} from '../../../../server/src/rich/rich-validator';
