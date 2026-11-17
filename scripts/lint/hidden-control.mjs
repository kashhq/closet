// A form control is never `display: none` (#674): a hidden radio or checkbox is no tab stop and has
// no role or state for VoiceOver (the filter sheet's chips were). Choices are `input.btn` chips
// (Chips, src/web/form-field.tsx). The rule reads the class the JSX can produce, not its spelling:
// a literal, every branch of a conditional or `&&`, a template literal's text, a concatenation, a
// helper's arguments and a local constant's value, so a computed `class={...}` cannot carry the
// `hidden` token past it (#1067's clear chip did, past the grep guard this replaced). Only the
// whole token counts, as in Tailwind: `lg:hidden` and `hidden-x` are other classes.

const CONTROLS = new Set(['input', 'select', 'textarea']);
// What stands in for an interpolation in a template literal: never whitespace, so `hidden${x}`
// is one token that is not `hidden`.
const HOLE = '\u0000';

function hasHiddenToken(text) {
  return text.split(/\s+/).includes('hidden');
}

/**
 * Every string the expression can contribute to the class, as far as the source says statically.
 * An identifier is followed to a `const` in scope; anything else (a call's result, a parameter)
 * is unknown and contributes nothing.
 */
function classTexts(node, scope, seen = new Set()) {
  if (!node || seen.has(node)) return [];
  seen.add(node);
  const inner = (part) => classTexts(part, scope, seen);
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? [node.value] : [];
    case 'TemplateLiteral':
      return [
        node.quasis.map((quasi) => quasi.value.cooked ?? '').join(HOLE),
        ...node.expressions.flatMap(inner),
      ];
    case 'JSXExpressionContainer':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
      return inner(node.expression);
    case 'ConditionalExpression':
      return [...inner(node.consequent), ...inner(node.alternate)];
    case 'LogicalExpression':
      return [...inner(node.left), ...inner(node.right)];
    case 'BinaryExpression':
      return node.operator === '+'
        ? [...inner(node.left), ...inner(node.right)]
        : [];
    case 'ArrayExpression':
      return node.elements.flatMap(inner);
    case 'CallExpression':
      // A helper's arguments (`cn(...)`), and the receiver of a method
      // (`[...].join(' ')`).
      return [
        ...node.arguments.flatMap(inner),
        ...(node.callee.type === 'MemberExpression'
          ? inner(node.callee.object)
          : []),
      ];
    case 'MemberExpression':
      return inner(node.object);
    case 'ObjectExpression':
      return node.properties.flatMap((property) =>
        property.type === 'Property' ? inner(property.value) : [],
      );
    case 'Identifier':
      return constantTexts(node, scope, inner);
    default:
      return [];
  }
}

function constantTexts(identifier, scope, inner) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(identifier.name);
    if (!variable) continue;
    return variable.defs.flatMap((def) =>
      def.type === 'Variable' &&
      def.parent.kind === 'const' &&
      def.node.id.type === 'Identifier'
        ? inner(def.node.init)
        : [],
    );
  }
  return [];
}

export default {
  rules: {
    'no-hidden-control': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          hidden:
            'A form control is never `hidden` (#674): it is no tab stop and has no role or state for a screen reader. Render it only when it applies, or make the choice a chip (Chips, form-field.tsx).',
        },
      },
      create(context) {
        return {
          JSXOpeningElement(element) {
            if (
              element.name.type !== 'JSXIdentifier' ||
              !CONTROLS.has(element.name.name)
            ) {
              return;
            }
            const scope = context.sourceCode.getScope(element);
            for (const attribute of element.attributes) {
              if (
                attribute.type !== 'JSXAttribute' ||
                !['class', 'className'].includes(attribute.name.name)
              ) {
                continue;
              }
              if (classTexts(attribute.value, scope).some(hasHiddenToken)) {
                context.report({ node: attribute, messageId: 'hidden' });
              }
            }
          },
        };
      },
    },
  },
};
