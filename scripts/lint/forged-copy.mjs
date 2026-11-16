// One type-aware ESLint rule: nothing but src/web/i18n.ts and src/web/errors.tsx makes `Translated`
// copy (#734, #1098, #1100). It judges the type an assertion produces, never its spelling, so
// `as Translated`, `<Translated>x`, `as i18n.Translated`, an alias, `as never`, `as any` and a type
// that carries the brand anywhere inside it (`as Translated[]`, `as { message: Translated }`,
// `as (s: string) => Translated`) are one case. A type predicate (`x is Translated`) forges the same
// way, so it is judged too. The config scopes the files; specs are exempt there.
import { resolve } from 'node:path';
import ts from 'typescript';

const I18N = resolve(import.meta.dirname, '../../src/web/i18n.ts');

/** `Translated` as the program declares it, once per program. */
const brands = new WeakMap();
function brandOf(program, checker) {
  if (!brands.has(program)) {
    const source = program.getSourceFile(I18N);
    const module = source && checker.getSymbolAtLocation(source);
    const symbol =
      module &&
      checker.getExportsOfModule(module).find((s) => s.name === 'Translated');
    if (!symbol) {
      throw new Error(`no-forged-copy: ${I18N} no longer exports Translated`);
    }
    brands.set(program, checker.getDeclaredTypeOfSymbol(symbol));
  }
  return brands.get(program);
}

// A library's own members are not walked (a DOM or Fastify type is large, and no library mentions
// our brand); what a program passes it, its type arguments, still is.
function declaredOutside(program, type) {
  const declarations = (type.aliasSymbol ?? type.getSymbol())?.declarations;
  return (
    declarations?.length > 0 &&
    declarations.every((declaration) => {
      const file = declaration.getSourceFile();
      return (
        program.isSourceFileDefaultLibrary(file) ||
        program.isSourceFileFromExternalLibrary(file) ||
        file.fileName.includes('/node_modules/')
      );
    })
  );
}

const UNTYPED = ts.TypeFlags.Any | ts.TypeFlags.Never;

/**
 * Whether a value of `type` could hand out copy that `t()` never made. any and never go anywhere,
 * Translated included, so they forge as the assertion's own type (`x as never`). Inside a type they
 * are not judged: the library's own defaults hold any (`AsyncIterable<T, TReturn = any>`), and
 * refusing them would refuse every iterable.
 */
function forges(program, checker, brand, type) {
  return (
    Boolean(type.flags & UNTYPED) ||
    carriesBrand(program, checker, brand, type, new Set())
  );
}

function carriesBrand(program, checker, brand, type, seen) {
  if (seen.has(type) || type.flags & UNTYPED) return false;
  seen.add(type);
  if (checker.isTypeAssignableTo(type, brand)) return true;
  const inner = (part) => carriesBrand(program, checker, brand, part, seen);
  if (type.isUnionOrIntersection() && type.types.some(inner)) return true;
  const typeArguments = [
    ...(type.aliasTypeArguments ?? []),
    ...(type.flags & ts.TypeFlags.Object &&
    type.objectFlags & ts.ObjectFlags.Reference
      ? checker.getTypeArguments(type)
      : []),
  ];
  if (typeArguments.some(inner)) return true;
  if (!(type.flags & ts.TypeFlags.Object) || declaredOutside(program, type)) {
    return false;
  }
  const signatures = [
    ...type.getCallSignatures(),
    ...type.getConstructSignatures(),
  ];
  return (
    checker.getIndexInfosOfType(type).some((info) => inner(info.type)) ||
    type.getProperties().some((p) => inner(checker.getTypeOfSymbol(p))) ||
    signatures.some(
      (signature) =>
        inner(signature.getReturnType()) ||
        signature
          .getParameters()
          .some((p) => inner(checker.getTypeOfSymbol(p))),
    )
  );
}

export default {
  rules: {
    'no-forged-copy': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          forged:
            'Only t(), joinCopy() and errors.tsx make Translated copy: this assertion produces a type that carries it (or any, or never). Build the text from lang.json keys (#1100).',
        },
      },
      create(context) {
        const services = context.sourceCode.parserServices;
        if (!services?.program) {
          throw new Error(
            'no-forged-copy needs type information (projectService)',
          );
        }
        const { program, esTreeNodeToTSNodeMap } = services;
        const checker = program.getTypeChecker();
        const brand = brandOf(program, checker);
        const judge = (node, type) => {
          if (forges(program, checker, brand, type)) {
            context.report({ node, messageId: 'forged' });
          }
        };
        // The assertion's own type, so every spelling of the target is read alike.
        // `as const` only narrows literals the expression already has, so it can never forge.
        const assertion = (node) => {
          const target = node.typeAnnotation;
          if (
            target.type === 'TSTypeReference' &&
            target.typeName.name === 'const'
          )
            return;
          judge(
            node,
            checker.getTypeAtLocation(esTreeNodeToTSNodeMap.get(node)),
          );
        };
        return {
          TSAsExpression: assertion,
          TSTypeAssertion: assertion,
          TSTypePredicate(node) {
            if (!node.typeAnnotation) return; // `asserts x` narrows to truthy only
            judge(
              node,
              checker.getTypeFromTypeNode(
                esTreeNodeToTSNodeMap.get(node.typeAnnotation.typeAnnotation),
              ),
            );
          },
        };
      },
    },
  },
};
